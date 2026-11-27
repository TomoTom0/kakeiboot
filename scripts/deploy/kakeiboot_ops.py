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
  deploy         stage artifacts on the target -> sudo install the binary and
                 the backup script as kakeiboot:srvops -> rsync configs + dist
                 (dist re-owned by sudo chown -R) -> systemctl restart ->
                 healthz retry loop
                 (stg only: prod distribution goes through promote -- TASK-189)
  promote        distribute the RUNNING stg runtime-dir artifacts to prod:
                 stg prechecks (healthz + service start >= binary mtime),
                 sha256 display both sides, configs drift preview, archive the
                 previous prod artifacts to releases/<utc-timestamp>/, sudo
                 install binary + backup script and rsync dist stg->prod ON
                 the runtime host (artifacts re-owned to kakeiboot:srvops),
                 restart kakeiboot-prod, healthz. No build (repo-independent),
                 no configs distribution (that is the configs subcommand).
  configs        mkdir + rsync configs/<env>/ to the runtime dir (--checksum,
                 --delete; no restart/healthz). --preview adds rsync's own
                 --dry-run: the transfer-free itemized diff (drift check path).
  exec           ./budget-book <args...> --config-dir configs/<env> in the runtime dir
  service        systemctl <verb...> kakeiboot-<env>
  backup         systemctl --user start kakeiboot-backup@<env>.service
  backup-status  last_success marker, generation dirs, list-timers, last result
  install-units  render scripts/systemd/kakeiboot-backup@.service.in with deploy_root
                 -> stage service + timer + polkit rule on the target ->
                 sudo install into /etc/systemd/system + /etc/polkit-1/rules.d
                 (root:root 644) -> system daemon-reload -> enable --now both
                 backup timers (no --env: the unit is one %i template shared by
                 both envs; /etc writes need a sudo-capable operator)

The healthz port is parsed at startup from configs/<env>/app.toml [server] port
(no port literals here -- see configs-management rule). Every subcommand takes
--dry-run to print the `$ <cmd>` plan without executing anything.

Standard library only. Run with: uv run --no-project python scripts/deploy/kakeiboot_ops.py
"""

from __future__ import annotations

import argparse
import shlex
import shutil
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
UNIT_TIMER = REPO_ROOT / "scripts" / "systemd" / "kakeiboot-backup@.timer"

KNOWN_KEYS = frozenset({"deploy_root", "runtime_host", "transport"})
TRANSPORTS = ("local", "ssh")
# Fixed ssh options (non-interactive, fail fast on unreachable host). Everything
# else about the connection (user, port, IdentityFile) belongs to ~/.ssh/config.
SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]
SSH_RSYNC_E = "ssh " + " ".join(SSH_OPTIONS)
ENVS = ("stg", "prod")

# install-units destinations (system form, matching the gt430 host-side
# conversion script for the 2026-11-17 system-service conversion): the backup
# units live only as system units now, so the fixed run user (User=kakeiboot) is in
# the .in template and /etc writes go through `sudo install` (root:root 644 =
# the systemd/polkit default). Standard system locations, not environment
# settings -- deploy_root stays the single deploy.toml path source.
SYSTEM_UNIT_DIR = "/etc/systemd/system"
POLKIT_RULES_DIR = "/etc/polkit-1/rules.d"
BACKUP_POLKIT_RULE_NAME = "49-dual-operator-kakeiboot-backup.rules"
# Target-side staging dir PREFIX: `sudo install` reads a path on the target,
# while the rendered service / timer / polkit rule are staged in this repo's
# tmp/ tree (the repo is never checked out on the runtime host), so the staged
# dir is copied there first (mkdir -p + rsync, same transport helpers as
# deploy). The target staging dir is derived per invocation (this prefix + the
# local staged dir's basename), NOT a shared fixed path: a fixed one survives
# the first operator's run as a 0700 dir owned by them and blocks the other
# operator's rsync.
BACKUP_UNIT_STAGE_PREFIX = "/tmp/kakeiboot-units-install"

# Service-account migration (dedicated `kakeiboot` account runs stg + prod +
# backup; design: kakeiboot service-account migration, step 3): deploy/promote
# place the artifacts as kakeiboot:srvops so the run user owns what the deploy
# procedure chmods and replaces. Single files go through `sudo install` (the
# install-units pattern below, with the artifact owner/group); trees (the
# frontend dist, the releases generations) keep their rsync/cp transfer and
# are re-owned with `sudo chown -R` -- install has no recursive form. Both
# sudo forms stay inside the migration's narrow sudoers grant for the
# operator (install / chown, kakeiboot tree only), which takes effect with
# the host migration (step 4): until then these plans must not be run
# against the real host.
ARTIFACT_OWNER = "kakeiboot"
ARTIFACT_GROUP = "srvops"
# Deploy staging dir on the target (per env): the artifact sources are local
# files (build output, repo script), while `sudo install` reads a path on
# the target, so the binary and the backup script are rsynced here first and
# removed at the end of the plan -- the install-units staging pattern, with
# the env as the per-invocation discriminator instead of a local staged dir.
ARTIFACT_STAGE_PREFIX = "/tmp/kakeiboot-artifacts-install"

# Polkit rule installed alongside the units (same content as the host
# conversion script): both operators manage the backup unit instances as
# themselves. Content is fixed (instance names + the two operator names), so it
# is generated here instead of adding another template file.
BACKUP_POLKIT_RULE = (
    "// kakeiboot-backup@ の instance 群: 各運用者が自分の identity のまま "
    "manage-units できるようにする。\n"
    "polkit.addRule(function(action, subject) {\n"
    '    if (action.id == "org.freedesktop.systemd1.manage-units") {\n'
    '        var units = ["kakeiboot-backup@stg.service", "kakeiboot-backup@stg.timer", '
    '"kakeiboot-backup@prod.service", "kakeiboot-backup@prod.timer"];\n'
    '        if (units.indexOf(action.lookup("unit")) >= 0 '
    '&& (subject.user == "tomo" || subject.user == "muse-agent")) {\n'
    "            return polkit.Result.YES;\n"
    "        }\n"
    "    }\n"
    "});\n"
)


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


def resolve_runtime_port(cfg: DeployConfig, env: str) -> int:
    """Read the healthz port from the DEPLOYED runtime-dir config (TASK-189).

    <deploy_root>/<env>/configs/<env>/app.toml: direct file read for local,
    remote `cat` output captured over ssh for remote. Promote resolves both
    healthz ports this way (not via resolve_port) so every promote behavior
    stays independent of the repo configs; deploy keeps resolve_port because
    it healthz-checks right after rsyncing the repo configs (repo config =
    deployed config there).
    """
    app_path = f"{cfg.deploy_root}/{env}/configs/{env}/app.toml"
    if cfg.is_ssh:
        result = subprocess.run(
            ssh_wrap(cfg, f"cat {shlex.quote(app_path)}"),
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise ConfigError(
                f"{app_path}: remote cat exited {result.returncode} on {cfg.runtime_host}"
            )
        text = result.stdout
    else:
        try:
            text = Path(app_path).read_text(encoding="utf-8")
        except OSError as exc:
            raise ConfigError(f"{app_path}: unreadable: {exc}") from exc
    data = tomllib.loads(text)
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
    """Deploy plan: stage the single-file artifacts on the target, place them
    with sudo install as kakeiboot:srvops (service-account migration), rsync
    configs + dist (dist re-owned by sudo chown -R), restart, healthz.

    The binary and the backup script are placed by `sudo install`, not rsync:
    the operator cannot chown, so an rsynced file would stay operator-owned
    while the service (running as the dedicated kakeiboot account) is the
    identity that must own what deploy replaces and chmods. The staging dir
    follows the install-units pattern (target-side dir, removed at the end
    of the plan). The dist tree keeps its rsync --delete transfer (install
    has no recursive form) and is re-owned wholesale afterwards; configs
    keep their rsync too (their ownership form is the configs subcommand's
    concern, unchanged here).
    """
    root = cfg.deploy_root
    stage = f"{ARTIFACT_STAGE_PREFIX}-{env}"
    return [
        remote_exec(cfg, ["mkdir", "-p", stage]),
        rsync_exec(cfg, ["-a"], "target/debug/budget-book", f"{stage}/budget-book"),
        rsync_exec(
            cfg,
            ["-a"],
            "scripts/backup/kakeiboot-backup.sh",
            f"{stage}/kakeiboot-backup.sh",
        ),
        remote_exec(
            cfg,
            sudo_install_artifact(f"{stage}/budget-book", f"{root}/{env}/budget-book"),
        ),
        remote_exec(cfg, ["mkdir", "-p", f"{root}/{env}/bin"]),
        remote_exec(
            cfg,
            sudo_install_artifact(
                f"{stage}/kakeiboot-backup.sh", f"{root}/{env}/bin/kakeiboot-backup.sh"
            ),
        ),
        rsync_exec(cfg, ["-a", "--delete"], f"configs/{env}/", f"{root}/{env}/configs/{env}/"),
        rsync_exec(cfg, ["-a", "--delete"], "frontend/dist/", f"{root}/{env}/frontend/dist/"),
        remote_exec(cfg, sudo_chown_tree(f"{root}/{env}/frontend/dist")),
        remote_exec(cfg, ["rm", "-rf", stage]),
        remote_exec(cfg, ["systemctl", "restart", f"kakeiboot-{env}"]),
        remote_exec(cfg, healthz_command(port)),
    ]


def build_promote_commands(cfg: DeployConfig, stg_port: int, prod_port: int) -> list[list[str]]:
    """Promote plan (TASK-189 D-6, extended by the service-account migration):
    the 13 fixed steps, stg -> prod.

    The distribution source is the stg RUNTIME dir -- the artifacts stg is
    actually running, never the work repo; that structural identity is
    promote's whole point (D-1). Steps 1-4 are read-only (stg prechecks and
    displays: failure leaves nothing written on prod), step 5 archives the
    previous prod artifacts right before the distributing steps 7-9
    overwrite them, steps 10-11 put every placed/archived artifact under
    the dedicated service account (kakeiboot:srvops), then restart +
    healthz. configs/ and var/ are never written: configs distribution is
    the separate `configs` subcommand (D-1/D-7), var/ is runtime data.

    Placement form (service-account migration, step 3): the binary and the
    backup script are single files already on the runtime host, so they are
    placed with `sudo install -o kakeiboot -g srvops -m 770` directly (no
    staging, unlike deploy); the dist tree keeps its rsync (install has no
    recursive form) and is re-owned by `sudo chown -R`, as are the releases
    generations the archive step just copied as the operator.

    Both healthz ports come from the deployed runtime-dir configs (callers
    use resolve_runtime_port), so the whole plan is repo-config independent.
    """

    stg = f"{cfg.deploy_root}/stg"
    prod = f"{cfg.deploy_root}/prod"
    stg_bin = shlex.quote(f"{stg}/budget-book")
    prod_bin = shlex.quote(f"{prod}/budget-book")

    # D-2 (review follow-up): the running stg process must BE the on-disk
    # binary. rsync -a preserves mtimes, so a service-start >= mtime
    # comparison cannot prove identity (B distributed -> restart failed still
    # passes); hash the running process's /proc/<pid>/exe and the
    # distribution source directly instead. A failing systemctl, empty/zero
    # MainPID, unreadable /proc (permission) or any hash mismatch leaves the
    # && chain non-zero -- fail closed. kakeiboot-stg is a system service
    # whose User= matches the ssh operator on the current route, so
    # /proc/<pid>/exe is readable; an operator different from the unit's
    # run user fails closed here on /proc permission instead.
    # NOTE (service-account migration): once stg runs as the dedicated
    # kakeiboot account, NEITHER operator matches the run user, so this
    # step fails closed for both (verified: a different-uid reader gets
    # Permission denied on /proc/<pid>/exe). The precheck needs a redesign
    # that does not read another user's /proc; that is a separate follow-up
    # from the placement changes in this area and is NOT settled here.
    process_check = (
        "pid=$(systemctl show kakeiboot-stg -p MainPID --value) "
        '&& [ -n "$pid" ] && [ "$pid" != "0" ] '
        '&& a=$(sha256sum /proc/$pid/exe | cut -d" " -f1) '
        f'&& b=$(sha256sum {stg_bin} | cut -d" " -f1) '
        '&& [ "$a" = "$b" ]'
    )
    # D-3: show the binary hash on both sides. A failing stg-side sha256sum
    # stops promote; an absent prod binary (first deployment) prints and
    # continues.
    sha_display = (
        f"sha256sum {stg_bin} && "
        f"if [ -f {prod_bin} ]; then sha256sum {prod_bin}; "
        'else echo "prod: budget-book not deployed yet"; fi'
    )
    # D-6 step 5: archive the previous artifacts (binary, bin/, frontend/ --
    # dist's only restoration source) to releases/<utc-timestamp>/ before the
    # distributing rsyncs overwrite them. Skipped when prod has no binary yet.
    # Every command is &&-chained so a failed date/mkdir/cp makes the whole
    # step non-zero (a trailing echo must not mask an archive failure).
    archive = (
        f"if [ -f {prod_bin} ]; then "
        f"rel={shlex.quote(f'{prod}/releases')}/$(date -u +%Y%m%dT%H%M%SZ) "
        '&& mkdir -p "$rel" '
        f'&& cp -a {prod_bin} "$rel"/ '
        f'&& cp -a {shlex.quote(f"{prod}/bin")} "$rel"/ '
        f'&& cp -a {shlex.quote(f"{prod}/frontend")} "$rel"/ '
        '&& echo "archived previous prod artifacts to $rel"; fi'
    )

    # Step 11: the archive step's copies are operator-owned (cp -a cannot
    # preserve another user's ownership unprivileged); re-own all releases
    # generations to kakeiboot:srvops. Guarded: a first deployment has no
    # releases dir yet and must not fail here.
    releases_chown = (
        f"if [ -d {shlex.quote(f'{prod}/releases')} ]; then "
        f"{shlex.join(sudo_chown_tree(f'{prod}/releases'))}; fi"
    )

    return [
        remote_exec(cfg, healthz_command(stg_port)),
        remote_exec(cfg, ["sh", "-c", process_check]),
        remote_exec(cfg, ["sh", "-c", sha_display]),
        rsync_exec(
            cfg,
            ["-a", "--delete", "--checksum", "-i", "--dry-run"],
            "configs/prod/",
            f"{prod}/configs/prod/",
        ),
        remote_exec(cfg, ["sh", "-c", archive]),
        remote_exec(
            cfg,
            ["mkdir", "-p", f"{prod}/bin", f"{prod}/frontend", f"{prod}/configs/prod"],
        ),
        remote_exec(
            cfg, sudo_install_artifact(f"{stg}/budget-book", f"{prod}/budget-book")
        ),
        remote_exec(
            cfg,
            sudo_install_artifact(
                f"{stg}/bin/kakeiboot-backup.sh", f"{prod}/bin/kakeiboot-backup.sh"
            ),
        ),
        remote_exec(
            cfg,
            ["rsync", "-a", "--delete", "-i", f"{stg}/frontend/dist/", f"{prod}/frontend/dist/"],
        ),
        remote_exec(cfg, sudo_chown_tree(f"{prod}/frontend/dist")),
        remote_exec(cfg, ["sh", "-c", releases_chown]),
        remote_exec(cfg, ["systemctl", "restart", "kakeiboot-prod"]),
        remote_exec(cfg, healthz_command(prod_port)),
    ]


def build_configs_commands(cfg: DeployConfig, env: str, preview: bool = False) -> list[list[str]]:
    """configs plan (TASK-189 D-7-1): mkdir + checksum rsync, repo -> runtime dir.

    File distribution only -- no restart/healthz step: the backend loads its
    config once at startup (no reload mechanism), so a restart inside configs
    would mechanically create old-binary x new-configs startup windows;
    reflection belongs to promote's restart or an explicit service operation
    (D-7-2). --preview adds rsync's own --dry-run (the transfer-free itemized
    diff, the regular drift-check path) -- unlike the script's --dry-run,
    which only prints the plan without touching rsync.
    """
    opts = ["-a", "--delete", "--checksum", "-i"]
    if preview:
        opts.append("--dry-run")
    dst = f"{cfg.deploy_root}/{env}/configs/{env}"
    return [
        remote_exec(cfg, ["mkdir", "-p", dst]),
        rsync_exec(cfg, opts, f"configs/{env}/", f"{dst}/"),
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
    return [remote_exec(cfg, ["systemctl", *verbs, f"kakeiboot-{env}"])]


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


def sudo_install(
    src: str, dst: str, owner: str = "root", group: str = "root", mode: str = "644"
) -> list[str]:
    """Place one file with sudo install (owner/group/mode set in one step).

    The defaults are the /etc form (root:root 644, the systemd/polkit
    default) used by install-units; sudo_install_artifact passes the
    service-account form instead.
    """
    return ["sudo", "install", "-o", owner, "-g", group, "-m", mode, src, dst]


def sudo_install_artifact(src: str, dst: str, mode: str = "770") -> list[str]:
    """Place one deploy artifact as kakeiboot:srvops (service-account
    migration): the dedicated run user owns the binary and the backup
    script it executes. Mode 770 is the design's artifact mode (binary and
    bin/ row); the caller passes another mode only for a non-executable
    artifact."""
    return sudo_install(src, dst, owner=ARTIFACT_OWNER, group=ARTIFACT_GROUP, mode=mode)


def sudo_chown_tree(path: str) -> list[str]:
    """Re-own a placed tree (frontend dist, releases generations) to
    kakeiboot:srvops. The tree transfers themselves stay rsync/cp (install
    has no recursive form); this is the ownership half of the placement,
    inside the same narrow sudoers grant (chown -R, kakeiboot tree only)."""
    return ["sudo", "chown", "-R", f"{ARTIFACT_OWNER}:{ARTIFACT_GROUP}", path]


def build_install_units_commands(cfg: DeployConfig, staged_dir: str) -> list[list[str]]:
    """install-units plan (system form): stage on the target, sudo install
    units + polkit rule, system daemon-reload, enable both timers, cleanup.

    The backup units follow the 2026-11-17 gt430 system-service conversion:
    they exist only as system units now, so the destination is
    /etc/systemd/system (service + timer) and /etc/polkit-1/rules.d (the
    dual-operator rule), and every /etc write needs root -- each file goes
    through `sudo install -o root -g root -m 644` instead of rsync. sudo
    install reads a path on the TARGET, while staged_dir is this repo's tmp/
    staging tree holding the three files (rendered service, timer copy,
    generated polkit rule); the plan therefore mkdir -p's a target staging
    dir and rsyncs the staged dir there first (remote_exec / rsync_exec, the
    same transport helpers every other subcommand uses). That target staging
    dir is per invocation (BACKUP_UNIT_STAGE_PREFIX + the local staged dir's
    basename): a shared fixed path would survive the first operator's run as
    a 0700 dir owned by them and block the other operator's rsync. The plan
    ends with rm -rf of the per-invocation dir so nothing is left behind.

    daemon-reload and the timer enables are system-scope systemctl under sudo
    as well; enable --now runs for both env timers, matching the host
    conversion script's end state. No --env: one %i template serves both envs.
    """
    stage = f"{BACKUP_UNIT_STAGE_PREFIX}-{Path(staged_dir).name}"
    return [
        remote_exec(cfg, ["mkdir", "-p", stage]),
        rsync_exec(cfg, ["-a"], f"{staged_dir}/", f"{stage}/"),
        remote_exec(
            cfg,
            sudo_install(
                f"{stage}/kakeiboot-backup@.service",
                f"{SYSTEM_UNIT_DIR}/kakeiboot-backup@.service",
            ),
        ),
        remote_exec(
            cfg,
            sudo_install(
                f"{stage}/kakeiboot-backup@.timer",
                f"{SYSTEM_UNIT_DIR}/kakeiboot-backup@.timer",
            ),
        ),
        remote_exec(
            cfg,
            sudo_install(
                f"{stage}/{BACKUP_POLKIT_RULE_NAME}",
                f"{POLKIT_RULES_DIR}/{BACKUP_POLKIT_RULE_NAME}",
            ),
        ),
        remote_exec(cfg, ["sudo", "systemctl", "daemon-reload"]),
        *(
            remote_exec(
                cfg, ["sudo", "systemctl", "enable", "--now", f"kakeiboot-backup@{env}.timer"]
            )
            for env in ENVS
        ),
        remote_exec(cfg, ["rm", "-rf", stage]),
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


def cmd_promote(args: argparse.Namespace) -> int:
    """Promote the running stg runtime-dir artifacts to prod (TASK-189).

    Both healthz ports resolve from the deployed runtime-dir configs, so the
    whole run is independent of the repo configs. Failures report the executed
    steps like cmd_deploy (every step is idempotent; the recovery rule is
    re-run the same command after investigating).
    """
    cfg = load_config(config_paths())
    stg_port = resolve_runtime_port(cfg, "stg")
    prod_port = resolve_runtime_port(cfg, "prod")
    cmds = build_promote_commands(cfg, stg_port, prod_port)
    executed, rc = run_commands(cmds, args.dry_run, cwd=REPO_ROOT)
    if rc != 0:
        print("steps executed before failure:", file=sys.stderr)
        for argv in cmds[:executed]:
            print(f"  - {shlex.join(argv)}", file=sys.stderr)
        return rc
    if not args.dry_run:
        print(
            "promote ok: stg runtime artifacts -> prod, kakeiboot-prod restarted "
            f"and /healthz answered (port {prod_port})"
        )
    return 0


def cmd_configs(args: argparse.Namespace) -> int:
    """Distribute (or preview) configs/<env>/ to the runtime dir (TASK-189)."""
    cfg = load_config(config_paths())
    cmds = build_configs_commands(cfg, args.env, preview=args.preview)
    executed, rc = run_commands(cmds, args.dry_run, cwd=REPO_ROOT)
    if rc != 0:
        print("steps executed before failure:", file=sys.stderr)
        for argv in cmds[:executed]:
            print(f"  - {shlex.join(argv)}", file=sys.stderr)
        return rc
    if not args.dry_run:
        dst = f"{cfg.deploy_root}/{args.env}/configs/{args.env}/"
        if args.preview:
            print(
                f"configs preview: configs/{args.env}/ -> {dst} "
                "(no transfer; run without --preview to distribute)"
            )
        else:
            print(
                f"configs ok: configs/{args.env}/ -> {dst} "
                "(no restart: promote's restart or a service restart applies them)"
            )
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
    """Render the .in source and install the units + polkit rule as system files.

    The rendered text and the deploy_root it was rendered with go to stdout
    first (which value produced the installed unit stays traceable), followed
    by the polkit rule content (both /etc payloads are reviewable from the
    output alone). Dry-run prints both plus the plan and creates no file. A
    real run stages the rendered service, the timer and the polkit rule under
    the repo tmp/ tree (tempfile, removed on exit) so the staged files keep
    their real names for the target-side staging rsync and the sudo installs.
    """
    cfg = load_config(config_paths())
    rendered = render_unit(UNIT_IN.read_text(encoding="utf-8"), cfg.deploy_root)
    print(f"# rendered from {UNIT_IN.relative_to(REPO_ROOT)} (deploy_root={cfg.deploy_root})")
    print(rendered, end="")
    print(f"# polkit rule -> {POLKIT_RULES_DIR}/{BACKUP_POLKIT_RULE_NAME}")
    print(BACKUP_POLKIT_RULE, end="")
    if args.dry_run:
        # Plan-only: the staged path below is a display placeholder; a real run
        # stages the three files in a fresh tmp/units-*/ dir (never this path).
        staged_dir = REPO_ROOT / "tmp" / "units-render"
        print(
            "# dry-run plan only: a real run stages the rendered unit, the timer "
            "and the polkit rule in a fresh tmp/units-* dir first"
        )
        run_commands(build_install_units_commands(cfg, str(staged_dir)), dry_run=True, cwd=REPO_ROOT)
        return 0
    tmp_root = REPO_ROOT / "tmp"
    tmp_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="units-", dir=tmp_root) as stage:
        staged = Path(stage)
        (staged / "kakeiboot-backup@.service").write_text(rendered, encoding="utf-8")
        shutil.copyfile(UNIT_TIMER, staged / "kakeiboot-backup@.timer")
        (staged / BACKUP_POLKIT_RULE_NAME).write_text(BACKUP_POLKIT_RULE, encoding="utf-8")
        cmds = build_install_units_commands(cfg, str(staged))
        executed, rc = run_commands(cmds, dry_run=False, cwd=REPO_ROOT)
    if rc != 0:
        # Same recovery report as cmd_deploy: install-units is a multi-step
        # stage+install+reload+enable sequence, so a failure must list which
        # steps already ran (e.g. the units landed but the polkit rule did not).
        print("steps executed before failure:", file=sys.stderr)
        for argv in cmds[:executed]:
            print(f"  - {shlex.join(argv)}", file=sys.stderr)
        return rc
    print(
        f"units installed to {SYSTEM_UNIT_DIR}/ and "
        f"{POLKIT_RULES_DIR}/{BACKUP_POLKIT_RULE_NAME} "
        "(daemon-reload done, both timers enabled)"
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="kakeiboot_ops.py",
        description="kakeiboot stg/prod operations (transport per configs/deploy.toml)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add_env(p: argparse.ArgumentParser, envs: tuple[str, ...] = ENVS) -> None:
        p.add_argument("--env", required=True, choices=envs)
        p.add_argument(
            "--dry-run",
            action="store_true",
            help="print the '$ <cmd>' plan and exit 0 without executing anything",
        )

    # TASK-189 D-4: --env prod is structurally excluded -- the only prod write
    # path is promote.
    p = sub.add_parser(
        "deploy",
        help="rsync repo artifacts, restart service, wait for healthz (stg only)",
    )
    add_env(p, envs=("stg",))
    p.set_defaults(func=cmd_deploy)

    p = sub.add_parser(
        "promote",
        help="distribute the running stg runtime-dir artifacts to prod "
        "(prechecks, sha256 display, drift preview, archive, restart, healthz; no build, no configs)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="print the '$ <cmd>' plan and exit 0 without executing anything",
    )
    p.set_defaults(func=cmd_promote)

    p = sub.add_parser(
        "configs",
        help="rsync configs/<env>/ to the runtime dir (checksum, --delete; no restart)",
    )
    add_env(p)
    p.add_argument(
        "--preview",
        action="store_true",
        help="add rsync's own --dry-run: show the itemized transfer-free diff (drift check)",
    )
    p.set_defaults(func=cmd_configs)

    p = sub.add_parser("exec", help="run ./budget-book <args...> in the runtime dir")
    add_env(p)
    p.add_argument(
        "args", nargs=argparse.REMAINDER, help="arguments after -- pass through verbatim"
    )
    p.set_defaults(func=cmd_exec)

    p = sub.add_parser("service", help="systemctl <verb...> kakeiboot-<env>")
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
        help="render the backup .in unit with deploy_root, sudo install service+timer+polkit "
        "rule as system units, daemon-reload, enable --now both timers",
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
