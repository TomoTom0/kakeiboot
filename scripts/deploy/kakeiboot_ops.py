#!/usr/bin/env python3
"""kakeiboot deploy/ops runner (TASK-118).

The mise stg:/prod: tasks are thin wrappers over this script (mise.toml). It reads
configs/deploy.toml (plus an optional configs/deploy.local.toml override, last
wins -- same rule the old mise [vars] _.file array had) and runs every operation
either locally or over ssh depending on the `transport` key:

  transport = "ssh"    every step runs on runtime_host via ssh (gt430; user/port/
                       IdentityFile resolve through ~/.ssh/config, this script only
                       pins BatchMode and ConnectTimeout)
  transport = "local"  every step runs on this machine (local verification setup,
                       enabled via configs/deploy.local.toml)

Subcommands (env is an argument; the stg/prod task prefix maps to --env):
  deploy         rsync 5 steps -> systemctl restart -> healthz retry loop
  exec           ./budget-book <args...> --config-dir configs/<env> in the runtime dir
  service        systemctl --user <verb...> kakeiboot-<env>
  backup         systemctl --user start kakeiboot-backup@<env>.service
  backup-status  last_success marker, generation dirs, list-timers, last result
  install-units  render scripts/systemd/kakeiboot-backup@.service.in with deploy_root
                 -> rsync service + timer into the user unit dir -> daemon-reload
                 (no --env: the unit is one %i template shared by both envs)

The healthz port is parsed at startup from configs/<env>/app.toml [server] port
(no port literals here -- see configs-management rule). Every subcommand takes
--dry-run to print the `$ <cmd>` plan without executing anything.

Standard library only. Run with: uv run --no-project python scripts/deploy/kakeiboot_ops.py
"""

from __future__ import annotations

import argparse
import shlex
import subprocess
import sys
import tempfile
import tomllib
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPLOY_CONFIG = REPO_ROOT / "configs" / "deploy.toml"
DEPLOY_LOCAL_CONFIG = REPO_ROOT / "configs" / "deploy.local.toml"
UNIT_IN = REPO_ROOT / "scripts" / "systemd" / "kakeiboot-backup@.service.in"

KNOWN_KEYS = frozenset({"deploy_root", "runtime_host", "transport"})
TRANSPORTS = ("local", "ssh")
# Fixed ssh options (non-interactive, fail fast on unreachable host). Everything
# else about the connection (user, port, IdentityFile) belongs to ~/.ssh/config.
SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]
SSH_RSYNC_E = "ssh " + " ".join(SSH_OPTIONS)
ENVS = ("stg", "prod")


class ConfigError(Exception):
    """deploy.toml failure (parse error, unknown key, missing/invalid value)."""


@dataclass(frozen=True)
class DeployConfig:
    deploy_root: str
    transport: str
    runtime_host: str | None

    @property
    def is_ssh(self) -> bool:
        return self.transport == "ssh"


def config_paths() -> list[Path]:
    return [DEPLOY_CONFIG, DEPLOY_LOCAL_CONFIG]


def load_config(paths: list[Path]) -> DeployConfig:
    """Load deploy.toml then deploy.local.toml (shallow merge, later file wins).

    A missing override file is skipped silently (same behavior as the old mise
    [vars] _.file array). A TOML parse failure is re-raised as ConfigError (so
    main reports it as a one-line `error:` + exit 2, not a traceback). Unknown
    keys are rejected like the backend config (backend/src/config.rs
    deny_unknown_fields) to catch typos.
    """
    merged: dict = {}
    for path in paths:
        if not path.exists():
            continue
        try:
            data = tomllib.loads(path.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as exc:
            raise ConfigError(f"{path}: invalid TOML: {exc}") from exc
        unknown = sorted(set(data) - KNOWN_KEYS)
        if unknown:
            raise ConfigError(f"{path}: unknown key(s) {', '.join(unknown)}")
        merged.update(data)

    deploy_root = merged.get("deploy_root")
    if not isinstance(deploy_root, str) or not deploy_root:
        raise ConfigError("deploy_root is required (configs/deploy.toml)")
    if not deploy_root.startswith("/"):
        raise ConfigError(f"deploy_root must be an absolute path: {deploy_root!r}")
    if deploy_root.endswith("/"):
        raise ConfigError(f"deploy_root must not end with '/': {deploy_root!r}")

    transport = merged.get("transport")
    if transport is None:
        raise ConfigError('transport is required (configs/deploy.toml): "local" or "ssh"')
    if transport not in TRANSPORTS:
        raise ConfigError(f"transport must be one of {TRANSPORTS}: {transport!r}")

    runtime_host = merged.get("runtime_host")
    if transport == "ssh":
        if not isinstance(runtime_host, str) or not runtime_host:
            raise ConfigError("runtime_host is required when transport = \"ssh\"")
    # transport = "local": a recorded runtime_host is kept as-is but unused
    # (only is_ssh branches read it).

    return DeployConfig(deploy_root=deploy_root, transport=transport, runtime_host=runtime_host)


def resolve_port(repo_root: Path, env: str) -> int:
    """Read the healthz port from configs/<env>/app.toml [server] port."""
    app_path = repo_root / "configs" / env / "app.toml"
    data = tomllib.loads(app_path.read_text(encoding="utf-8"))
    port = data.get("server", {}).get("port")
    if not isinstance(port, int):
        raise ConfigError(f"{app_path}: [server] port is missing")
    return port


def healthz_command(port: int) -> list[str]:
    """Legacy retry loop from the old mise run array, port resolved (5 tries, sleep 1)."""
    loop = (
        f"for i in 1 2 3 4 5; do curl -fsS http://localhost:{port}/healthz "
        "&& exit 0; sleep 1; done; exit 1"
    )
    return ["sh", "-c", loop]


def ssh_wrap(cfg: DeployConfig, remote: str) -> list[str]:
    """Wrap a single remote command string (already quoted) in an ssh argv."""
    assert cfg.runtime_host is not None
    return ["ssh", *SSH_OPTIONS, cfg.runtime_host, "--", remote]


def remote_exec(cfg: DeployConfig, argv: list[str]) -> list[str]:
    """Run argv on the target (identity for local, ssh-wrapped for remote)."""
    if cfg.is_ssh:
        return ssh_wrap(cfg, shlex.join(argv))
    return argv


def rsync_exec(cfg: DeployConfig, opts: list[str], src: str, dst: str) -> list[str]:
    """rsync with transport handling: -e ssh options and host: prefix for remote."""
    if cfg.is_ssh:
        assert cfg.runtime_host is not None
        return ["rsync", *opts, "-e", SSH_RSYNC_E, src, f"{cfg.runtime_host}:{dst}"]
    return ["rsync", *opts, src, dst]


def build_deploy_commands(cfg: DeployConfig, env: str, port: int) -> list[list[str]]:
    """Deploy plan, same order and strings as the legacy mise run array (local mode)."""
    root = cfg.deploy_root
    return [
        rsync_exec(cfg, ["-a"], "target/debug/budget-book", f"{root}/{env}/budget-book"),
        remote_exec(cfg, ["mkdir", "-p", f"{root}/{env}/bin"]),
        rsync_exec(
            cfg,
            ["-a"],
            "scripts/backup/kakeiboot-backup.sh",
            f"{root}/{env}/bin/kakeiboot-backup.sh",
        ),
        rsync_exec(cfg, ["-a", "--delete"], f"configs/{env}/", f"{root}/{env}/configs/{env}/"),
        rsync_exec(cfg, ["-a", "--delete"], "frontend/dist/", f"{root}/{env}/frontend/dist/"),
        remote_exec(cfg, ["systemctl", "--user", "restart", f"kakeiboot-{env}"]),
        remote_exec(cfg, healthz_command(port)),
    ]


def build_exec_command(cfg: DeployConfig, env: str, args: list[str]) -> tuple[list[str], str | None]:
    """budget-book run in the runtime dir. Returns (argv, cwd).

    Local mode keeps argv as a list (no shell) with cwd = the runtime dir (the
    old mise task's `dir` attribute). Ssh mode builds one remote string with an
    explicit cd; spaced args survive via shlex quoting.
    """
    run_argv = ["./budget-book", *args, "--config-dir", f"configs/{env}"]
    if cfg.is_ssh:
        remote = f"cd {shlex.quote(f'{cfg.deploy_root}/{env}')} && {shlex.join(run_argv)}"
        return ssh_wrap(cfg, remote), None
    return run_argv, f"{cfg.deploy_root}/{env}"


def build_service_commands(cfg: DeployConfig, env: str, verbs: list[str]) -> list[list[str]]:
    return [remote_exec(cfg, ["systemctl", "--user", *verbs, f"kakeiboot-{env}"])]


def build_backup_commands(cfg: DeployConfig, env: str) -> list[list[str]]:
    return [remote_exec(cfg, ["systemctl", "--user", "start", f"kakeiboot-backup@{env}.service"])]


def build_backup_status_commands(cfg: DeployConfig, env: str) -> list[list[str]]:
    """Legacy 4 lines: marker (or none), generation dirs, timer, last run result."""
    # shlex.quote: a deploy_root with spaces must not break the sh -c string.
    # The current space-free value quotes to itself, so the legacy run-array
    # byte-match (tmp/tasks/tm-118/raw_*.before.txt) is unchanged.
    backup_dir = shlex.quote(f"{cfg.deploy_root}/backups/{env}")
    return [
        remote_exec(
            cfg,
            ["sh", "-c", f'echo "last_success: $(cat {backup_dir}/last_success 2>/dev/null || echo none)"'],
        ),
        remote_exec(cfg, ["sh", "-c", f"ls -1 {backup_dir} 2>/dev/null || true"]),
        remote_exec(
            cfg,
            ["systemctl", "--user", "list-timers", f"kakeiboot-backup@{env}.timer", "--no-pager"],
        ),
        remote_exec(
            cfg,
            [
                "systemctl",
                "--user",
                "show",
                f"kakeiboot-backup@{env}.service",
                "-p",
                "Result",
                "-p",
                "ExecMainStatus",
                "--no-pager",
            ],
        ),
    ]


def render_unit(text: str, deploy_root: str) -> str:
    """Render the .in unit template: {{deploy_root}} -> the resolved deploy_root.

    A template with no {{deploy_root}} at all means the source is no longer the
    .in contract (hardcoded paths are back); any `{{...}}` left after the
    substitution is an unknown placeholder (a typo or a future key). Both must
    surface as ConfigError here instead of becoming a unit file with a broken
    or unrendered path.
    """
    if "{{deploy_root}}" not in text:
        raise ConfigError("unit template has no {{deploy_root}} placeholder (hardcoded paths?)")
    rendered = text.replace("{{deploy_root}}", deploy_root)
    if "{{" in rendered:
        raise ConfigError("unit template has an unknown placeholder; only {{deploy_root}} is supported")
    return rendered


def build_install_units_commands(cfg: DeployConfig, rendered_src: str) -> list[list[str]]:
    """install-units plan: mkdir user unit dir, rsync rendered service + timer, reload.

    The destination is the home-expanded absolute path (Path.home()): local
    rsync does not go through a shell, so a literal `~` would create a real
    directory named `~` instead of the user config dir. The dir itself may not
    exist on a fresh runtime host, so mkdir -p leads the plan (remote_exec, so
    ssh mode creates it on the host). The timer carries no paths and is copied
    as-is; daemon-reload also goes through remote_exec.
    """
    unit_dir = f"{Path.home()}/.config/systemd/user"
    return [
        remote_exec(cfg, ["mkdir", "-p", unit_dir]),
        rsync_exec(cfg, ["-a"], rendered_src, f"{unit_dir}/kakeiboot-backup@.service"),
        rsync_exec(
            cfg,
            ["-a"],
            "scripts/systemd/kakeiboot-backup@.timer",
            f"{unit_dir}/kakeiboot-backup@.timer",
        ),
        remote_exec(cfg, ["systemctl", "--user", "daemon-reload"]),
    ]


def run_commands(
    cmds: list[list[str]], dry_run: bool, cwd: Path | None = None
) -> tuple[int, int]:
    """Run commands sequentially, echoing `$ <cmd>` before each.

    Returns (executed_count, returncode). Dry-run echoes the whole plan and
    executes nothing. A non-zero command stops the sequence immediately. A
    missing command (argv[0] not on PATH / not an executable file) or a missing
    working directory raises FileNotFoundError from subprocess; it is reported
    like a failed command (127, the shell's command-not-found code) instead of
    a traceback.
    """
    executed = 0
    for argv in cmds:
        line = shlex.join(argv)
        print(f"$ {line}", flush=True)
        if dry_run:
            executed += 1
            continue
        try:
            rc = subprocess.run(argv, cwd=cwd).returncode
        except FileNotFoundError:
            print(f"error: {line}: command or working directory not found", file=sys.stderr)
            return executed + 1, 127
        executed += 1
        if rc != 0:
            print(f"error: {line} exited {rc}", file=sys.stderr)
            return executed, rc
    return executed, 0


def cmd_deploy(args: argparse.Namespace) -> int:
    cfg = load_config(config_paths())
    port = resolve_port(REPO_ROOT, args.env)
    cmds = build_deploy_commands(cfg, args.env, port)
    executed, rc = run_commands(cmds, args.dry_run, cwd=REPO_ROOT)
    if rc != 0:
        print("steps executed before failure:", file=sys.stderr)
        for argv in cmds[:executed]:
            print(f"  - {shlex.join(argv)}", file=sys.stderr)
        return rc
    if not args.dry_run:
        print(f"deploy ok: kakeiboot-{args.env} restarted and /healthz answered (port {port})")
    return 0


def passthrough_args(rest: list[str]) -> list[str]:
    """Drop the leading `--` that argparse.REMAINDER keeps from the command line."""
    return rest[1:] if rest and rest[0] == "--" else rest


def cmd_exec(args: argparse.Namespace) -> int:
    cfg = load_config(config_paths())
    argv, cwd = build_exec_command(cfg, args.env, passthrough_args(args.args))
    run_dir = Path(cwd) if cwd is not None else REPO_ROOT
    _, rc = run_commands([argv], args.dry_run, cwd=run_dir)
    return rc


def cmd_service(args: argparse.Namespace) -> int:
    cfg = load_config(config_paths())
    _, rc = run_commands(
        build_service_commands(cfg, args.env, passthrough_args(args.verbs)), args.dry_run
    )
    return rc


def cmd_backup(args: argparse.Namespace) -> int:
    cfg = load_config(config_paths())
    _, rc = run_commands(build_backup_commands(cfg, args.env), args.dry_run)
    return rc


def cmd_backup_status(args: argparse.Namespace) -> int:
    cfg = load_config(config_paths())
    _, rc = run_commands(build_backup_status_commands(cfg, args.env), args.dry_run)
    return rc


def cmd_install_units(args: argparse.Namespace) -> int:
    """Render the .in source and install both units into the user unit dir.

    The rendered text and the deploy_root it was rendered with go to stdout
    first (which value produced the installed unit stays traceable). Dry-run
    prints the rendered unit plus the plan and creates no file. A real run
    stages the rendered service under the repo tmp/ tree (tempfile, removed on
    exit) so the staged file keeps the real unit name for the rsync.
    """
    cfg = load_config(config_paths())
    rendered = render_unit(UNIT_IN.read_text(encoding="utf-8"), cfg.deploy_root)
    print(f"# rendered from {UNIT_IN.relative_to(REPO_ROOT)} (deploy_root={cfg.deploy_root})")
    print(rendered, end="")
    if args.dry_run:
        # Plan-only: the staged path below is a display placeholder; a real run
        # stages the render in a fresh tmp/units-*/ dir (never this path).
        staged_src = REPO_ROOT / "tmp" / "units-render" / "kakeiboot-backup@.service"
        print("# dry-run plan only: a real run stages the rendered unit in a fresh tmp/units-* dir first")
        run_commands(build_install_units_commands(cfg, str(staged_src)), dry_run=True, cwd=REPO_ROOT)
        return 0
    tmp_root = REPO_ROOT / "tmp"
    tmp_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="units-", dir=tmp_root) as stage:
        staged = Path(stage) / "kakeiboot-backup@.service"
        staged.write_text(rendered, encoding="utf-8")
        _, rc = run_commands(
            build_install_units_commands(cfg, str(staged)), dry_run=False, cwd=REPO_ROOT
        )
    if rc != 0:
        return rc
    print(f"units installed to {Path.home()}/.config/systemd/user/ (daemon-reload done)")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="kakeiboot_ops.py",
        description="kakeiboot stg/prod operations (transport per configs/deploy.toml)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add_env(p: argparse.ArgumentParser) -> None:
        p.add_argument("--env", required=True, choices=ENVS)
        p.add_argument(
            "--dry-run",
            action="store_true",
            help="print the '$ <cmd>' plan and exit 0 without executing anything",
        )

    p = sub.add_parser("deploy", help="rsync artifacts, restart service, wait for healthz")
    add_env(p)
    p.set_defaults(func=cmd_deploy)

    p = sub.add_parser("exec", help="run ./budget-book <args...> in the runtime dir")
    add_env(p)
    p.add_argument(
        "args", nargs=argparse.REMAINDER, help="arguments after -- pass through verbatim"
    )
    p.set_defaults(func=cmd_exec)

    p = sub.add_parser("service", help="systemctl --user <verb...> kakeiboot-<env>")
    add_env(p)
    p.add_argument("verbs", nargs=argparse.REMAINDER)
    p.set_defaults(func=cmd_service)

    p = sub.add_parser("backup", help="start the backup oneshot unit now")
    add_env(p)
    p.set_defaults(func=cmd_backup)

    p = sub.add_parser("backup-status", help="last_success, generations, timer, last result")
    add_env(p)
    p.set_defaults(func=cmd_backup_status)

    p = sub.add_parser(
        "install-units",
        help="render the backup .in unit with deploy_root, rsync service+timer to the user unit dir, daemon-reload",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="print the rendered unit and the '$ <cmd>' plan without creating or copying anything",
    )
    p.set_defaults(func=cmd_install_units)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
