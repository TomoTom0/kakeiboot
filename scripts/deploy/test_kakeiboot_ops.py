"""Unit tests for kakeiboot_ops.py (TASK-118).

Run via mise task `scripts:test`:
  uv run --no-project python -m unittest discover -s scripts/deploy -p 'test_*.py'
(start dir top-level, no -t flag: `from kakeiboot_ops import ...` needs scripts/deploy
on sys.path -- see tmp/tasks/tm-118/design_deploy-scripts.md section 3-2.)

Standard library only (unittest / shlex / tempfile / unittest.mock), same rule as
the script under test. Legacy run-array strings (deploy 7 lines / backup-status 4
lines) are the phase-1 comparison assets: tmp/tasks/tm-118/raw_*.before.txt.

TASK-119 (test-first) adds: backup script relative-path derivation, the unit .in
template source, render_unit / install-units, and the mise units:install task.
New kakeiboot_ops names (render_unit, build_install_units_commands) are imported
inside the test bodies so the pre-implementation red run fails only the new
tests -- a top-level import would break the existing 36 with an ImportError.

TASK-189 (test-first) adds: the promote subcommand (stg->prod artifact
promotion, 11-step plan, runtime-dir port resolution) and the configs
subcommand (--env required, --preview); prod:deploy is removed so the
PROD_DEPLOY_LEGACY byte-match test is deleted. New names (build_promote_commands,
build_configs_commands, resolve_runtime_port) follow the same inside-body
import rule.
"""

from __future__ import annotations

import io
import os
import shlex
import shutil
import subprocess
import tempfile
import tomllib
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import kakeiboot_ops
from kakeiboot_ops import (
    SSH_OPTIONS,
    SSH_RSYNC_E,
    ConfigError,
    DeployConfig,
    REPO_ROOT,
    build_backup_status_commands,
    build_deploy_commands,
    build_exec_command,
    build_parser,
    healthz_command,
    load_config,
    main,
    passthrough_args,
    resolve_port,
    run_commands,
)

DEPLOY_ROOT = "/srv/opt/tomo/run/app/tool/kakeiboot"

# Legacy mise run arrays (phase-1 rendered values; the migration guarantee is that
# local transport reproduces them byte-for-byte via shlex.join).
STG_DEPLOY_LEGACY = [
    f"rsync -a target/debug/budget-book {DEPLOY_ROOT}/stg/budget-book",
    f"mkdir -p {DEPLOY_ROOT}/stg/bin",
    f"rsync -a scripts/backup/kakeiboot-backup.sh {DEPLOY_ROOT}/stg/bin/kakeiboot-backup.sh",
    f"rsync -a --delete configs/stg/ {DEPLOY_ROOT}/stg/configs/stg/",
    f"rsync -a --delete frontend/dist/ {DEPLOY_ROOT}/stg/frontend/dist/",
    "systemctl restart kakeiboot-stg",
    "sh -c 'for i in 1 2 3 4 5; do curl -fsS http://localhost:40282/healthz && exit 0; "
    "sleep 1; done; exit 1'",
]
STG_BACKUP_STATUS_LEGACY = [
    "sh -c 'echo \"last_success: $(cat "
    f"{DEPLOY_ROOT}/backups/stg/last_success 2>/dev/null || echo none)\"'",
    f"sh -c 'ls -1 {DEPLOY_ROOT}/backups/stg 2>/dev/null || true'",
    "systemctl --user list-timers kakeiboot-backup@stg.timer --no-pager",
    "systemctl --user show kakeiboot-backup@stg.service -p Result -p ExecMainStatus --no-pager",
]
PROD_BACKUP_STATUS_LEGACY = [
    "sh -c 'echo \"last_success: $(cat "
    f"{DEPLOY_ROOT}/backups/prod/last_success 2>/dev/null || echo none)\"'",
    f"sh -c 'ls -1 {DEPLOY_ROOT}/backups/prod 2>/dev/null || true'",
    "systemctl --user list-timers kakeiboot-backup@prod.timer --no-pager",
    "systemctl --user show kakeiboot-backup@prod.service -p Result -p ExecMainStatus --no-pager",
]

BASE_TOML = (
    f'deploy_root = "{DEPLOY_ROOT}"\n'
    'runtime_host = "gt430"\n'
    'transport = "ssh"\n'
)


def local_cfg() -> DeployConfig:
    return DeployConfig(deploy_root=DEPLOY_ROOT, transport="local", runtime_host=None)


def ssh_cfg() -> DeployConfig:
    return DeployConfig(deploy_root=DEPLOY_ROOT, transport="ssh", runtime_host="gt430")


def write(path: Path, text: str) -> Path:
    path.write_text(text, encoding="utf-8")
    return path


def load_pair(base: str, override: str | None) -> DeployConfig:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        base_path = write(root / "deploy.toml", base)
        paths = [base_path]
        if override is not None:
            paths.append(write(root / "deploy.local.toml", override))
        return load_config(paths)


# [covers:deploy-ops.config-load] deploy.toml + deploy.local.toml merge and validation
class TestConfigLoad(unittest.TestCase):
    def test_override_last_wins(self) -> None:
        cfg = load_pair(BASE_TOML, 'transport = "local"\n')
        self.assertEqual(cfg.transport, "local")
        self.assertEqual(cfg.deploy_root, DEPLOY_ROOT)
        self.assertEqual(cfg.runtime_host, "gt430")

    def test_missing_override_file_is_skipped(self) -> None:
        cfg = load_pair(BASE_TOML, None)
        self.assertEqual(cfg.transport, "ssh")

    def test_unknown_key_rejected(self) -> None:
        with self.assertRaises(ConfigError):
            load_pair(BASE_TOML + 'extra_key = "x"\n', None)

    def test_missing_transport_rejected(self) -> None:
        base = f'deploy_root = "{DEPLOY_ROOT}"\nruntime_host = "gt430"\n'
        with self.assertRaises(ConfigError):
            load_pair(base, None)

    def test_invalid_transport_rejected(self) -> None:
        base = f'deploy_root = "{DEPLOY_ROOT}"\ntransport = "ftp"\n'
        with self.assertRaises(ConfigError):
            load_pair(base, None)

    def test_ssh_requires_runtime_host(self) -> None:
        base = f'deploy_root = "{DEPLOY_ROOT}"\ntransport = "ssh"\n'
        with self.assertRaises(ConfigError):
            load_pair(base, None)

    def test_local_without_runtime_host_is_ok(self) -> None:
        base = f'deploy_root = "{DEPLOY_ROOT}"\ntransport = "local"\n'
        cfg = load_pair(base, None)
        self.assertIsNone(cfg.runtime_host)
        self.assertFalse(cfg.is_ssh)

    def test_deploy_root_trailing_slash_rejected(self) -> None:
        base = f'deploy_root = "{DEPLOY_ROOT}/"\ntransport = "local"\n'
        with self.assertRaises(ConfigError):
            load_pair(base, None)

    def test_deploy_root_relative_rejected(self) -> None:
        base = 'deploy_root = "srv/opt"\ntransport = "local"\n'
        with self.assertRaises(ConfigError):
            load_pair(base, None)

    def test_corrupt_toml_rejected_with_message(self) -> None:
        # a TOML parse failure (unterminated string) must surface as ConfigError
        # naming the file, not as a raw tomllib traceback (REVIEW-4 Low-1).
        with tempfile.TemporaryDirectory() as tmp:
            base_path = write(Path(tmp) / "deploy.toml", 'deploy_root = "/unterminated\n')
            with self.assertRaises(ConfigError) as ctx:
                load_config([base_path])
            self.assertIn(str(base_path), str(ctx.exception))
            self.assertIn("invalid TOML", str(ctx.exception))


# [covers:deploy-ops.config-load] ConfigError reaches the CLI as exit 2 + one error line
class TestConfigErrorExitCode(unittest.TestCase):
    def test_corrupt_toml_exits_2_with_error_line(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base_path = write(Path(tmp) / "deploy.toml", 'deploy_root = "/unterminated\n')
            with mock.patch("kakeiboot_ops.config_paths", return_value=[base_path]):
                out, err = io.StringIO(), io.StringIO()
                with redirect_stdout(out), redirect_stderr(err):
                    rc = main(["backup-status", "--env", "stg"])
        self.assertEqual(rc, 2)
        self.assertIn("error: ", err.getvalue())
        self.assertIn("invalid TOML", err.getvalue())
        self.assertEqual(out.getvalue(), "")  # no plan printed: config failed first


# [covers:deploy-ops.transport-local] local transport reproduces the legacy run arrays
class TestTransportLocal(unittest.TestCase):
    def test_stg_deploy_matches_legacy_run_array(self) -> None:
        cmds = build_deploy_commands(local_cfg(), "stg", 40282)
        self.assertEqual([shlex.join(c) for c in cmds], STG_DEPLOY_LEGACY)

    def test_stg_backup_status_matches_legacy_run_array(self) -> None:
        cmds = build_backup_status_commands(local_cfg(), "stg")
        self.assertEqual([shlex.join(c) for c in cmds], STG_BACKUP_STATUS_LEGACY)

    def test_prod_backup_status_matches_legacy_run_array(self) -> None:
        cmds = build_backup_status_commands(local_cfg(), "prod")
        self.assertEqual([shlex.join(c) for c in cmds], PROD_BACKUP_STATUS_LEGACY)

    def test_backup_status_quotes_spaced_deploy_root(self) -> None:
        # backup_dir is shlex.quote-d into the sh -c strings (REVIEW-4 Low-3):
        # a deploy_root containing spaces stays one shell word. The legacy
        # byte-match above is unaffected because the current space-free value
        # quotes to itself.
        cfg = DeployConfig(deploy_root="/srv/my dir/run/app", transport="local", runtime_host=None)
        cmds = build_backup_status_commands(cfg, "stg")
        self.assertEqual(
            cmds[0],
            [
                "sh",
                "-c",
                "echo \"last_success: $(cat '/srv/my dir/run/app/backups/stg'/last_success "
                '2>/dev/null || echo none)"',
            ],
        )
        self.assertEqual(
            cmds[1],
            ["sh", "-c", "ls -1 '/srv/my dir/run/app/backups/stg' 2>/dev/null || true"],
        )

    def test_service_and_backup_shapes(self) -> None:
        from kakeiboot_ops import build_backup_commands, build_service_commands

        self.assertEqual(
            build_service_commands(local_cfg(), "stg", ["status"]),
            [["systemctl", "status", "kakeiboot-stg"]],
        )
        self.assertEqual(
            build_backup_commands(local_cfg(), "prod"),
            [["systemctl", "--user", "start", "kakeiboot-backup@prod.service"]],
        )


# [covers:deploy-ops.transport-ssh] every operation goes through the runtime host
class TestTransportSsh(unittest.TestCase):
    def assert_ssh_wrapped(self, ssh_cmd: list[str], local_cmd: list[str]) -> None:
        self.assertEqual(
            ssh_cmd,
            ["ssh", *SSH_OPTIONS, "gt430", "--", shlex.join(local_cmd)],
        )

    def test_rsync_gets_ssh_e_and_host_prefix(self) -> None:
        cmds = build_deploy_commands(ssh_cfg(), "stg", 40282)
        first = cmds[0]
        self.assertEqual(first[0], "rsync")
        self.assertEqual(first[first.index("-e") + 1], SSH_RSYNC_E)
        self.assertEqual(first[-1], f"gt430:{DEPLOY_ROOT}/stg/budget-book")
        # the two --delete rsyncs keep their options plus the ssh transport
        for idx in (3, 4):
            cmd = cmds[idx]
            self.assertEqual(cmd[cmd.index("-e") + 1], SSH_RSYNC_E)
            self.assertTrue(cmd[-1].startswith("gt430:"))

    def test_non_rsync_steps_wrapped_in_ssh(self) -> None:
        local_cmds = build_deploy_commands(local_cfg(), "stg", 40282)
        ssh_cmds = build_deploy_commands(ssh_cfg(), "stg", 40282)
        for idx in (1, 5, 6):  # mkdir, systemctl restart, healthz sh -c
            self.assert_ssh_wrapped(ssh_cmds[idx], local_cmds[idx])

    def test_every_step_is_host_mediated(self) -> None:
        for cmds in (
            build_deploy_commands(ssh_cfg(), "stg", 40282),
            build_backup_status_commands(ssh_cfg(), "prod"),
        ):
            for cmd in cmds:
                self.assertIn(cmd[0], ("rsync", "ssh"))
                if cmd[0] == "rsync":
                    self.assertIn("-e", cmd)
                    self.assertRegex(cmd[-1], r"^gt430:")
                else:
                    self.assertEqual(cmd[1:3], ["-o", "BatchMode=yes"])
                    self.assertIn("ConnectTimeout=10", cmd)
                    self.assertEqual(cmd[5], "gt430")
                    self.assertEqual(cmd[6], "--")
                    self.assertEqual(len(cmd), 8)  # one joined remote string

    def test_backup_status_remote_strings_are_legacy_sh_c(self) -> None:
        local_cmds = build_backup_status_commands(local_cfg(), "stg")
        ssh_cmds = build_backup_status_commands(ssh_cfg(), "stg")
        for idx in (0, 1):  # cat last_success / ls -1, old strings verbatim remote
            self.assert_ssh_wrapped(ssh_cmds[idx], local_cmds[idx])


# [covers:deploy-ops.port-from-app-config] healthz port resolved from app.toml
class TestPortResolution(unittest.TestCase):
    def test_resolves_server_port(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env_dir = root / "configs" / "stg"
            env_dir.mkdir(parents=True)
            write(
                env_dir / "app.toml",
                "[server]\nhosts = [\"::\"]\nport = 40282\n",
            )
            self.assertEqual(resolve_port(root, "stg"), 40282)

    def test_missing_port_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env_dir = root / "configs" / "prod"
            env_dir.mkdir(parents=True)
            write(env_dir / "app.toml", "[server]\nhosts = [\"::\"]\n")
            with self.assertRaises(ConfigError):
                resolve_port(root, "prod")


# [covers:deploy-ops.exec-args-passthrough] args after -- reach budget-book intact
class TestExecPassthrough(unittest.TestCase):
    ARGS = ["admin", "token", "issue", "--note", "家族 用"]

    def test_remainder_separator_is_stripped(self) -> None:
        # argparse.REMAINDER keeps the leading "--" (probe: 2026-10-28); the
        # command layer must drop it so args pass through verbatim.
        self.assertEqual(passthrough_args(["--", "admin", "user", "list"]), ["admin", "user", "list"])
        self.assertEqual(passthrough_args(["admin", "user", "list"]), ["admin", "user", "list"])
        self.assertEqual(passthrough_args([]), [])
        self.assertEqual(
            passthrough_args(["--", "enable", "--now"]), ["enable", "--now"]
        )

    def test_local_argv_and_cwd(self) -> None:
        argv, cwd = build_exec_command(local_cfg(), "stg", self.ARGS)
        self.assertEqual(
            argv,
            ["./budget-book", *self.ARGS, "--config-dir", "configs/stg"],
        )
        self.assertEqual(cwd, f"{DEPLOY_ROOT}/stg")

    def test_ssh_remote_string_quotes_spaced_arg(self) -> None:
        argv, cwd = build_exec_command(ssh_cfg(), "prod", self.ARGS)
        self.assertIsNone(cwd)
        self.assertEqual(argv[:7], ["ssh", *SSH_OPTIONS, "gt430", "--"])
        self.assertEqual(
            argv[7],
            f"cd {DEPLOY_ROOT}/prod && "
            "./budget-book admin token issue --note '家族 用' --config-dir configs/prod",
        )

    # [covers:deploy-ops.exec-args-passthrough]
    # [covers:deploy-ops.dry-run-plan]
    def test_dry_run_coexists_with_args_without_separator(self) -> None:
        # mise task run strings carry no "--" (TASK-118 follow-up):
        # `mise run exec-stg -- --dry-run admin user list` reaches the script
        # as `exec --env stg --dry-run admin user list`, where the leading
        # --dry-run is consumed as the script's flag and the rest is the
        # remainder passed through to budget-book.
        args = build_parser().parse_args(
            ["exec", "--env", "stg", "--dry-run", "admin", "user", "list"]
        )
        self.assertTrue(args.dry_run)
        self.assertEqual(passthrough_args(args.args), ["admin", "user", "list"])

    # [covers:deploy-ops.dry-run-plan]
    def test_service_dry_run_coexists_with_verbs_without_separator(self) -> None:
        # same shape for `mise run stg:service -- --dry-run status`
        args = build_parser().parse_args(["service", "--env", "stg", "--dry-run", "status"])
        self.assertTrue(args.dry_run)
        self.assertEqual(passthrough_args(args.verbs), ["status"])

    # [covers:deploy-ops.exec-args-passthrough]
    def test_separator_form_passes_dry_run_through(self) -> None:
        # legacy direct-invocation form with "--" keeps parsing, but a
        # --dry-run placed after "--" falls into REMAINDER and is passed
        # through to budget-book instead of enabling dry-run.
        args = build_parser().parse_args(
            ["exec", "--env", "stg", "--", "--dry-run", "admin", "user", "list"]
        )
        self.assertFalse(args.dry_run)
        self.assertEqual(passthrough_args(args.args), ["--dry-run", "admin", "user", "list"])


# [covers:deploy-ops.dry-run-plan] --dry-run prints the plan and executes nothing
class TestDryRun(unittest.TestCase):
    def test_dry_run_prints_plan_without_executing(self) -> None:
        cmds = [
            ["rsync", "-a", "target/debug/budget-book", f"{DEPLOY_ROOT}/stg/budget-book"],
            ["systemctl", "restart", "kakeiboot-stg"],
        ]
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(__import__("kakeiboot_ops").subprocess, "run") as run:
            with redirect_stdout(out), redirect_stderr(err):
                executed, rc = run_commands(cmds, dry_run=True)
        run.assert_not_called()
        self.assertEqual(rc, 0)
        self.assertEqual(executed, 2)
        self.assertEqual(
            out.getvalue().splitlines(),
            [
                f"$ rsync -a target/debug/budget-book {DEPLOY_ROOT}/stg/budget-book",
                "$ systemctl restart kakeiboot-stg",
            ],
        )

    def test_failure_stops_and_reports(self) -> None:
        cmds = [["sh", "-c", "exit 3"], ["echo", "never"]]
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            executed, rc = run_commands(cmds, dry_run=False)
        self.assertEqual(rc, 3)
        self.assertEqual(executed, 1)
        self.assertIn("error: sh -c 'exit 3' exited 3", err.getvalue())
        self.assertEqual(out.getvalue().splitlines(), ["$ sh -c 'exit 3'"])


# [covers:deploy-ops.command-not-found] missing command/cwd reports error 127, no traceback
class TestMissingCommandOrCwd(unittest.TestCase):
    """subprocess FileNotFoundError (argv[0] or cwd missing) becomes an error
    report + 127 instead of a traceback (REVIEW-4 Low-2). 127 is the shell's
    command-not-found code; both cases fail before any process runs."""

    def assert_127(self, cmds: list[list[str]], cwd: Path | None, line: str) -> None:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            executed, rc = run_commands(cmds, dry_run=False, cwd=cwd)
        self.assertEqual(rc, 127)
        self.assertEqual(executed, 1)
        self.assertIn(f"error: {line}: command or working directory not found", err.getvalue())
        self.assertEqual(out.getvalue().splitlines(), [f"$ {line}"])

    def test_missing_command_reports_127(self) -> None:
        # argv[0] resolves to nothing on PATH: nothing executes, no traceback
        self.assert_127(
            [["kakeiboot-no-such-command-xyz", "--flag"]], None, "kakeiboot-no-such-command-xyz --flag"
        )

    def test_missing_cwd_reports_127(self) -> None:
        # exec-local shape: run_dir (deploy_root/<env>) does not exist on this machine
        self.assert_127(
            [["true"]],
            Path("/nonexistent-kakeiboot-cwd/stg"),
            "true",
        )


# [covers:deploy-ops.healthz-retry] healthz loop keeps the legacy string shape
class TestHealthz(unittest.TestCase):
    LEGACY_LOOP = (
        "for i in 1 2 3 4 5; do curl -fsS http://localhost:{port}/healthz && exit 0; "
        "sleep 1; done; exit 1"
    )

    def test_stg_loop_string(self) -> None:
        self.assertEqual(
            healthz_command(40282),
            ["sh", "-c", self.LEGACY_LOOP.format(port=40282)],
        )

    def test_prod_loop_string(self) -> None:
        self.assertEqual(
            healthz_command(40283),
            ["sh", "-c", self.LEGACY_LOOP.format(port=40283)],
        )

    def test_deploy_seventh_element_is_healthz(self) -> None:
        cmds = build_deploy_commands(local_cfg(), "stg", 40282)
        self.assertEqual(cmds[6], healthz_command(40282))
        joined = shlex.join(cmds[6])
        self.assertEqual(joined, STG_DEPLOY_LEGACY[6])
        self.assertIn("1 2 3 4 5", joined)
        self.assertIn("sleep 1", joined)


# TASK-119 shared fixtures (design: tmp/tasks/tm-119/design_backup_paths.md v2).
SYSTEMD_DIR = REPO_ROOT / "scripts" / "systemd"
UNIT_IN_PATH = SYSTEMD_DIR / "kakeiboot-backup@.service.in"
UNIT_TIMER_PATH = SYSTEMD_DIR / "kakeiboot-backup@.timer"
USER_UNIT_DIR = f"{Path.home()}/.config/systemd/user"

# Same shape as the repo .in source (D-2): leading no-direct-scp comment,
# {{deploy_root}} placeholders, %i template instances the render must preserve.
UNIT_IN_FIXTURE = (
    "# render source template: do not scp directly -- use mise run units:install\n"
    "[Unit]\n"
    "Description=kakeiboot %i backup (SQLite online backup via admin CLI + images rsync)\n"
    "\n"
    "[Service]\n"
    "Type=oneshot\n"
    "WorkingDirectory={{deploy_root}}/%i\n"
    "ExecStart={{deploy_root}}/%i/bin/kakeiboot-backup.sh %i\n"
    "Nice=10\n"
    "IOSchedulingClass=idle\n"
)


# [covers:deploy-ops.backup-script-derives-paths-from-location] SRC/DEST derive
# from the script location (bin/ two levels up = deploy_root); repo source runs as-is
class TestBackupScriptRelativePaths(unittest.TestCase):
    """TASK-119 D-1. A temp deploy layout <root>/<env>/bin/kakeiboot-backup.sh
    (copy of the repo source) plus a stub budget-book that records its cwd and
    argv and creates the --dest file (so the stat/rotation steps proceed; the
    images dir stays absent = the documented skip path). Running the repo source
    with bash must resolve everything under <root> -- never under /srv/opt."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        # realpath basis (review L-6): the stub records its cwd with `pwd -P`
        # while the script derives paths logically, so a symlinked TMPDIR
        # (e.g. /tmp -> /private/tmp) would fail the comparison on either
        # side. Pinning the whole layout to the resolved path keeps the
        # expected values comparable with the recorded physical cwd.
        self.root = Path(tmp.name).resolve()

    def make_layout(self, env: str) -> None:
        env_dir = self.root / env
        (env_dir / "bin").mkdir(parents=True)
        shutil.copyfile(
            REPO_ROOT / "scripts" / "backup" / "kakeiboot-backup.sh",
            env_dir / "bin" / "kakeiboot-backup.sh",
        )
        stub = env_dir / "budget-book"
        stub.write_text(
            "#!/bin/sh\n"
            "{\n"
            '  echo "cwd:$(pwd -P)"\n'
            '  for a in "$@"; do echo "arg:$a"; done\n'
            '} > "$RECORD"\n'
            "while [ $# -gt 0 ]; do\n"
            '  if [ "$1" = "--dest" ]; then : > "$2"; shift 2; else shift; fi\n'
            "done\n",
            encoding="utf-8",
        )
        stub.chmod(0o755)

    def run_backup_script(self, env: str) -> tuple[subprocess.CompletedProcess[str], set[str]]:
        # stamp candidates before and after: the script stamps with `date -u +%F`,
        # so a run across UTC midnight still matches one of the two.
        record = self.root / f"record-{env}"
        before = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        proc = subprocess.run(
            ["bash", str(self.root / env / "bin" / "kakeiboot-backup.sh"), env],
            capture_output=True,
            text=True,
            env={**os.environ, "RECORD": str(record), "KEEP": "30"},
        )
        after = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        return proc, {before, after}

    def assert_derived_under_layout_root(self, env: str) -> None:
        self.make_layout(env)
        proc, stamps = self.run_backup_script(env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = (self.root / f"record-{env}").read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines[0], f"cwd:{self.root}/{env}")
        args = [line[len("arg:") :] for line in lines[1:]]
        self.assertEqual(args[:2], ["admin", "backup"])
        dest = args[args.index("--dest") + 1]
        self.assertIn(
            dest,
            {f"{self.root}/backups/{env}/{stamp}/db.sqlite" for stamp in stamps},
        )
        # markers land under the derived DEST, proving DEST (not just the argument)
        self.assertTrue((Path(dest).parent / "COMPLETED").exists())
        self.assertTrue((self.root / "backups" / env / "last_success").exists())
        self.assertEqual(args[-2:], ["--config-dir", f"configs/{env}"])

    def test_stg_paths_derive_from_script_location(self) -> None:
        self.assert_derived_under_layout_root("stg")

    def test_prod_paths_derive_from_script_location(self) -> None:
        self.assert_derived_under_layout_root("prod")

    def test_repo_source_has_no_srv_opt_literal(self) -> None:
        # the goal is removing the /srv/opt duplication: the repo source must not
        # carry the absolute path anywhere (the deploy contract carries it instead)
        text = (REPO_ROOT / "scripts" / "backup" / "kakeiboot-backup.sh").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("/srv/opt", text)


# [covers:deploy-ops.backup-unit-in-template] repo source of the unit is the .in
# placeholder template; the plain (hardcoded) service file is gone; timer stays as-is
class TestUnitTemplateSource(unittest.TestCase):
    def test_service_in_has_placeholders_and_leading_comment(self) -> None:
        text = UNIT_IN_PATH.read_text(encoding="utf-8")
        self.assertTrue(
            text.splitlines()[0].startswith("#"),
            "leading comment (no direct scp, use units:install) required",
        )
        self.assertIn("WorkingDirectory={{deploy_root}}/%i", text)
        self.assertIn("ExecStart={{deploy_root}}/%i/bin/kakeiboot-backup.sh %i", text)

    def test_plain_service_file_is_gone(self) -> None:
        # leaving both would reintroduce a second (unrendered) source of truth
        self.assertFalse((SYSTEMD_DIR / "kakeiboot-backup@.service").exists())

    def test_timer_stays_plain(self) -> None:
        # the timer has no paths -> not a render target (D-2)
        self.assertFalse((SYSTEMD_DIR / "kakeiboot-backup@.timer.in").exists())
        self.assertNotIn("{{", UNIT_TIMER_PATH.read_text(encoding="utf-8"))

    def test_comment_lines_carry_no_placeholder_literal(self) -> None:
        # review L-1: the render substitutes every placeholder occurrence in the
        # file, comments included -- mentioning the placeholder syntax inside the
        # leading comment would leave the installed unit's comment garbled, so
        # the comment must describe it without the literal braces.
        comment_lines = [
            ln
            for ln in UNIT_IN_PATH.read_text(encoding="utf-8").splitlines()
            if ln.startswith("#")
        ]
        self.assertTrue(comment_lines, "leading comment required")
        for ln in comment_lines:
            self.assertNotIn("{{", ln)


# [covers:deploy-ops.render-unit-resolves-deploy-root] render_unit substitutes
# {{deploy_root}} with the load_config-resolved deploy_root; %i and comments stay
class TestRenderUnit(unittest.TestCase):
    def test_substitutes_resolved_deploy_root(self) -> None:
        from kakeiboot_ops import render_unit

        cfg = load_pair('deploy_root = "/custom/root"\ntransport = "local"\n', None)
        rendered = render_unit(UNIT_IN_FIXTURE, cfg.deploy_root)
        self.assertNotIn("{{", rendered)
        self.assertIn("WorkingDirectory=/custom/root/%i\n", rendered)
        self.assertIn("ExecStart=/custom/root/%i/bin/kakeiboot-backup.sh %i\n", rendered)

    def test_preserves_i_and_comment_lines(self) -> None:
        from kakeiboot_ops import render_unit

        rendered = render_unit(UNIT_IN_FIXTURE, DEPLOY_ROOT)
        self.assertIn(f"WorkingDirectory={DEPLOY_ROOT}/%i\n", rendered)
        self.assertIn("Description=kakeiboot %i backup", rendered)
        self.assertEqual(rendered.splitlines()[0], UNIT_IN_FIXTURE.splitlines()[0])
        self.assertTrue(rendered.splitlines()[0].startswith("#"))

    def test_renders_the_repo_in_source(self) -> None:
        from kakeiboot_ops import render_unit

        rendered = render_unit(UNIT_IN_PATH.read_text(encoding="utf-8"), DEPLOY_ROOT)
        self.assertNotIn("{{", rendered)
        self.assertIn(f"WorkingDirectory={DEPLOY_ROOT}/%i\n", rendered)
        self.assertIn(f"ExecStart={DEPLOY_ROOT}/%i/bin/kakeiboot-backup.sh %i\n", rendered)

    # [covers:deploy-ops.render-unit-rejects-leftover-placeholder]
    def test_leftover_placeholder_raises_config_error(self) -> None:
        from kakeiboot_ops import render_unit

        text = UNIT_IN_FIXTURE.replace("Nice=10", "Nice={{unknown}}")
        with self.assertRaises(ConfigError):
            render_unit(text, DEPLOY_ROOT)

    # [covers:deploy-ops.render-unit-rejects-leftover-placeholder]
    # (review L-2 extends the same .in-contract guard: no placeholder at all
    # means hardcoded paths are back -- reject before anything is distributed.)
    def test_missing_placeholder_raises_config_error(self) -> None:
        from kakeiboot_ops import render_unit

        text = UNIT_IN_FIXTURE.replace("{{deploy_root}}", DEPLOY_ROOT)
        with self.assertRaises(ConfigError):
            render_unit(text, DEPLOY_ROOT)


# [covers:deploy-ops.install-units-plan] mkdir user unit dir -> render ->
# rsync (service, timer) -> daemon-reload; destination is the home-expanded
# user unit dir; no --env argument
class TestInstallUnitsPlan(unittest.TestCase):
    RENDERED_SRC = "/tmp/kakeiboot-units-render/kakeiboot-backup@.service"

    def test_local_plan_uses_home_expanded_destination(self) -> None:
        from kakeiboot_ops import build_install_units_commands

        cmds = build_install_units_commands(local_cfg(), self.RENDERED_SRC)
        self.assertEqual(len(cmds), 4)
        mkdir, service_rsync, timer_rsync, reload_cmd = cmds
        # review L-4: rsync does not create the destination dir -- a fresh
        # runtime host has no ~/.config/systemd/user yet, so mkdir -p leads
        self.assertEqual(mkdir, ["mkdir", "-p", USER_UNIT_DIR])
        self.assertEqual(service_rsync[0], "rsync")
        self.assertEqual(service_rsync[-2], self.RENDERED_SRC)
        self.assertEqual(service_rsync[-1], f"{USER_UNIT_DIR}/kakeiboot-backup@.service")
        self.assertEqual(timer_rsync[0], "rsync")
        self.assertEqual(timer_rsync[-2], "scripts/systemd/kakeiboot-backup@.timer")
        self.assertEqual(timer_rsync[-1], f"{USER_UNIT_DIR}/kakeiboot-backup@.timer")
        for cmd in (mkdir, service_rsync, timer_rsync):
            # local rsync does not go through a shell: a literal `~` would create
            # a real directory named "~" (D-2 step 3) -- the path must be expanded
            self.assertNotIn("~", " ".join(cmd))
        self.assertEqual(reload_cmd, ["systemctl", "--user", "daemon-reload"])

    def test_ssh_plan_prefixes_host_and_wraps_reload(self) -> None:
        from kakeiboot_ops import build_install_units_commands

        cmds = build_install_units_commands(ssh_cfg(), self.RENDERED_SRC)
        mkdir, service_rsync, timer_rsync, reload_cmd = cmds
        self.assertEqual(
            mkdir,
            ["ssh", *SSH_OPTIONS, "gt430", "--", f"mkdir -p {USER_UNIT_DIR}"],
        )
        self.assertEqual(service_rsync[service_rsync.index("-e") + 1], SSH_RSYNC_E)
        self.assertEqual(
            service_rsync[-1], f"gt430:{USER_UNIT_DIR}/kakeiboot-backup@.service"
        )
        self.assertEqual(timer_rsync[-1], f"gt430:{USER_UNIT_DIR}/kakeiboot-backup@.timer")
        self.assertEqual(
            reload_cmd,
            ["ssh", *SSH_OPTIONS, "gt430", "--", "systemctl --user daemon-reload"],
        )

    def test_subcommand_parses_without_env(self) -> None:
        # the unit is one %i template shared by both envs: no --env argument (D-2)
        args = build_parser().parse_args(["install-units"])
        self.assertFalse(args.dry_run)
        dry = build_parser().parse_args(["install-units", "--dry-run"])
        self.assertTrue(dry.dry_run)


# [covers:deploy-ops.install-units-dry-run] --dry-run prints the rendered unit and
# executes nothing; a (mocked) real run rsyncs twice, reloads, reports the deploy_root
class TestInstallUnitsCli(unittest.TestCase):
    def make_config(self, tmp: str) -> Path:
        return write(
            Path(tmp) / "deploy.toml", 'deploy_root = "/custom/root"\ntransport = "local"\n'
        )

    def test_dry_run_prints_rendered_unit_without_executing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = self.make_config(tmp)
            with mock.patch("kakeiboot_ops.config_paths", return_value=[cfg_path]):
                with mock.patch.object(kakeiboot_ops.subprocess, "run") as run:
                    out, err = io.StringIO(), io.StringIO()
                    with redirect_stdout(out), redirect_stderr(err):
                        rc = main(["install-units", "--dry-run"])
        run.assert_not_called()
        self.assertEqual(rc, 0)
        printed = out.getvalue()
        self.assertNotIn("{{", printed)
        self.assertIn("WorkingDirectory=/custom/root/%i", printed)
        self.assertIn("ExecStart=/custom/root/%i/bin/kakeiboot-backup.sh %i", printed)

    def test_run_rsyncs_then_reloads_and_reports_deploy_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = self.make_config(tmp)
            with mock.patch("kakeiboot_ops.config_paths", return_value=[cfg_path]):
                with mock.patch.object(
                    kakeiboot_ops.subprocess,
                    "run",
                    mock.Mock(return_value=subprocess.CompletedProcess(args=[], returncode=0)),
                ) as run:
                    out, err = io.StringIO(), io.StringIO()
                    with redirect_stdout(out), redirect_stderr(err):
                        rc = main(["install-units"])
        self.assertEqual(rc, 0)
        argvs = [call.args[0] for call in run.call_args_list]
        self.assertEqual([argv[0] for argv in argvs], ["mkdir", "rsync", "rsync", "systemctl"])
        self.assertEqual(argvs[0], ["mkdir", "-p", USER_UNIT_DIR])
        # rsync 1 source is the rendered tempfile carrying the unit file name
        self.assertEqual(Path(argvs[1][-2]).name, "kakeiboot-backup@.service")
        self.assertEqual(argvs[1][-1], f"{USER_UNIT_DIR}/kakeiboot-backup@.service")
        self.assertEqual(argvs[2][-2], "scripts/systemd/kakeiboot-backup@.timer")
        self.assertEqual(argvs[2][-1], f"{USER_UNIT_DIR}/kakeiboot-backup@.timer")
        self.assertEqual(argvs[3], ["systemctl", "--user", "daemon-reload"])
        # D-4: the deploy_root value used for rendering stays in the output
        self.assertIn("/custom/root", out.getvalue())

    # [covers:deploy-ops.install-units-plan] (review: failure reporting parity
    # with cmd_deploy -- install-units is a multi-step rsync+reload sequence,
    # so a mid-plan failure must report which steps already ran)
    def test_failure_lists_executed_steps(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = self.make_config(tmp)
            with mock.patch("kakeiboot_ops.config_paths", return_value=[cfg_path]):
                results = [
                    subprocess.CompletedProcess(args=[], returncode=0),  # mkdir
                    subprocess.CompletedProcess(args=[], returncode=0),  # rsync service
                    subprocess.CompletedProcess(args=[], returncode=23),  # rsync timer fails
                ]
                with mock.patch.object(kakeiboot_ops.subprocess, "run", side_effect=results):
                    out, err = io.StringIO(), io.StringIO()
                    with redirect_stdout(out), redirect_stderr(err):
                        rc = main(["install-units"])
        self.assertEqual(rc, 23)
        err_text = err.getvalue()
        self.assertIn("steps executed before failure:", err_text)
        # the two steps that ran before the failure are listed
        self.assertIn(f"mkdir -p {USER_UNIT_DIR}", err_text)
        self.assertIn(f"{USER_UNIT_DIR}/kakeiboot-backup@.service", err_text)
        # the failed timer rsync and the never-reached daemon-reload are not
        self.assertNotIn("daemon-reload", err_text)


# [covers:deploy-ops.units-install-task] mise task units:install wraps install-units
class TestUnitsInstallTask(unittest.TestCase):
    def test_task_runs_install_units_subcommand(self) -> None:
        data = tomllib.loads((REPO_ROOT / "mise.toml").read_text(encoding="utf-8"))
        run = data["tasks"]["units:install"]["run"]
        run_text = run if isinstance(run, str) else " ".join(run)
        self.assertIn("kakeiboot_ops.py", run_text)
        self.assertIn("install-units", run_text)


# ---- TASK-189 (test-first): promote / configs subcommands --------------------
# Design: tmp/tasks/tm-189/design_promote.md (D-1..D-7). New kakeiboot_ops names
# are imported inside the test bodies (TASK-119 rule) so the pre-implementation
# red run fails only these tests.

STG_DIR = f"{DEPLOY_ROOT}/stg"
PROD_DIR = f"{DEPLOY_ROOT}/prod"


# [covers:deploy-ops.promote-plan]
# [covers:deploy-ops.promote-rsync-flags]
class TestPromotePlan(unittest.TestCase):
    """D-6 fixed 11-step plan. Local form is the raw remote_exec argv list; the
    ssh form (D-5) runs the stg->prod rsyncs ON gt430 (ssh-wrapped rsync, no
    host: destination prefix) and only the configs preview goes repo->host via
    rsync_exec."""

    def build(self, cfg):
        from kakeiboot_ops import build_promote_commands

        return build_promote_commands(cfg, 40282, 40283)

    def test_local_plan_is_eleven_steps_in_design_order(self) -> None:
        cmds = self.build(local_cfg())
        self.assertEqual(len(cmds), 11)
        (
            healthz_stg,
            _mtime,
            _sha,
            _preview,
            _archive,
            mkdir,
            rs_bin,
            rs_script,
            rs_dist,
            restart,
            healthz_prod,
        ) = cmds
        # step 1: stg healthz (port resolved from the stg RUNTIME-DIR config)
        self.assertEqual(healthz_stg, healthz_command(40282))
        # step 6: prerequisite dirs (rsync never creates intermediate dirs)
        self.assertEqual(
            mkdir,
            [
                "mkdir",
                "-p",
                f"{PROD_DIR}/bin",
                f"{PROD_DIR}/frontend",
                f"{PROD_DIR}/configs/prod",
            ],
        )
        # steps 7/8: single-file rsyncs carry --checksum (mtime-only drift must
        # not pass); step 9: dist is --delete only, no --checksum (D-3)
        self.assertEqual(
            rs_bin,
            ["rsync", "-a", "--checksum", "-i", f"{STG_DIR}/budget-book", f"{PROD_DIR}/budget-book"],
        )
        self.assertEqual(
            rs_script,
            [
                "rsync",
                "-a",
                "--checksum",
                "-i",
                f"{STG_DIR}/bin/kakeiboot-backup.sh",
                f"{PROD_DIR}/bin/",
            ],
        )
        self.assertEqual(
            rs_dist,
            ["rsync", "-a", "--delete", "-i", f"{STG_DIR}/frontend/dist/", f"{PROD_DIR}/frontend/dist/"],
        )
        # step 10/11: restart prod, then healthz on the prod runtime-dir port
        self.assertEqual(restart, ["systemctl", "restart", "kakeiboot-prod"])
        self.assertEqual(healthz_prod, healthz_command(40283))

    # [covers:deploy-ops.promote-configs-preview]
    def test_configs_drift_preview_step_is_transfer_free(self) -> None:
        cmds = self.build(local_cfg())
        preview = cmds[3]
        self.assertEqual(preview[0], "rsync")
        self.assertEqual(preview[1:6], ["-a", "--delete", "--checksum", "-i", "--dry-run"])
        self.assertEqual(preview[-2:], ["configs/prod/", f"{PROD_DIR}/configs/prod/"])

    def test_plan_does_not_distribute_configs_or_touch_var(self) -> None:
        # D-1: configs are NOT a promote target -- the only step with a prod
        # configs destination is the transfer-free preview above.
        for cmd in self.build(local_cfg()):
            joined = " ".join(cmd)
            if cmd[0] == "rsync" and cmd[-1].endswith("/configs/prod/"):
                self.assertIn("--dry-run", cmd)
            self.assertNotIn("/var/", joined)

    def test_ssh_plan_runs_remote_steps_on_runtime_host(self) -> None:
        local_cmds = self.build(local_cfg())
        ssh_cmds = self.build(ssh_cfg())
        self.assertEqual(len(ssh_cmds), 11)
        # step 4 is the only repo->host rsync (rsync_exec: -e option + host:)
        preview = ssh_cmds[3]
        self.assertEqual(preview[preview.index("-e") + 1], SSH_RSYNC_E)
        self.assertEqual(preview[-1], f"gt430:{PROD_DIR}/configs/prod/")
        # every other step is one ssh-wrapped remote string of the local argv
        for idx in (0, 1, 2, 4, 5, 6, 7, 8, 9, 10):
            self.assertEqual(
                ssh_cmds[idx],
                ["ssh", *SSH_OPTIONS, "gt430", "--", shlex.join(local_cmds[idx])],
            )
        # stg->prod rsyncs (steps 7-9) run ON gt430: no host: destination prefix
        for idx in (6, 7, 8):
            self.assertNotIn("gt430:", ssh_cmds[idx][-1])


# [covers:deploy-ops.promote-stg-precheck]
class TestPromoteStgPrecheck(unittest.TestCase):
    """D-2: healthz + service-start>=mtime precede any prod write, fail-closed."""

    def test_first_step_is_stg_healthz(self) -> None:
        from kakeiboot_ops import build_promote_commands

        cmds = build_promote_commands(local_cfg(), 40282, 40283)
        self.assertEqual(cmds[0], healthz_command(40282))

    def test_second_step_hashes_running_process_exe_against_disk(self) -> None:
        from kakeiboot_ops import build_promote_commands

        cmds = build_promote_commands(local_cfg(), 40282, 40283)
        self.assertEqual(cmds[1][:2], ["sh", "-c"])
        script = cmds[1][2]
        self.assertIn("systemctl show kakeiboot-stg", script)
        self.assertIn("MainPID", script)
        self.assertIn("/proc/$pid/exe", script)
        self.assertIn("sha256sum", script)
        self.assertIn(f"{STG_DIR}/budget-book", script)


# [covers:deploy-ops.promote-sha256-display]
class TestPromoteSha256Display(unittest.TestCase):
    def test_sha_step_shows_both_sides_and_tolerates_undeployed_prod(self) -> None:
        from kakeiboot_ops import build_promote_commands

        cmds = build_promote_commands(local_cfg(), 40282, 40283)
        self.assertEqual(cmds[2][:2], ["sh", "-c"])
        script = cmds[2][2]
        # stg side: hash shown; a sha256sum failure stops promote (non-zero)
        self.assertIn(f"sha256sum {STG_DIR}/budget-book", script)
        # prod side: hash when present, "not deployed yet" + continue when absent
        self.assertIn(f"sha256sum {PROD_DIR}/budget-book", script)
        self.assertIn("not deployed yet", script)
        self.assertIn("if", script)  # the prod lookup is conditional


# [covers:deploy-ops.promote-archive-previous]
class TestPromoteArchivePrevious(unittest.TestCase):
    def test_archive_step_copies_previous_artifacts_to_timestamped_release(self) -> None:
        from kakeiboot_ops import build_promote_commands

        cmds = build_promote_commands(local_cfg(), 40282, 40283)
        self.assertEqual(cmds[4][:2], ["sh", "-c"])
        script = cmds[4][2]
        self.assertIn(f"{PROD_DIR}/releases/", script)
        # UTC timestamp is decided at run time inside the remote shell
        self.assertIn("date -u", script)
        # binary, bin/ and frontend/ (dist's only restoration source) archived
        self.assertIn(f"{PROD_DIR}/budget-book", script)
        self.assertIn(f"{PROD_DIR}/bin", script)
        self.assertIn(f"{PROD_DIR}/frontend", script)
        # skipped when the prod binary is absent (first deployment)
        self.assertIn("if", script)


# [covers:deploy-ops.promote-restart-healthz]
class TestPromoteRestartHealthz(unittest.TestCase):
    def test_restart_and_prod_healthz_close_the_plan(self) -> None:
        from kakeiboot_ops import build_promote_commands

        cmds = build_promote_commands(local_cfg(), 40282, 40283)
        self.assertEqual(cmds[9], ["systemctl", "restart", "kakeiboot-prod"])
        self.assertEqual(cmds[10], healthz_command(40283))


# [covers:deploy-ops.promote-shell-execution]
class TestPromoteShellSteps(unittest.TestCase):
    """Review follow-up (code review): the safety-critical sh -c steps are
    EXECUTED here -- a stub systemctl leading PATH, real sha256sum/cp/date on
    a tmp deploy layout -- and their exit codes asserted. Substring matching
    alone cannot prove a shell chain fails closed, and the archive step once
    masked cp failures behind a trailing echo (`;` chaining)."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        self.cfg = DeployConfig(deploy_root=str(self.root), transport="local", runtime_host=None)
        for env in ("stg", "prod"):
            (self.root / env / "configs" / env).mkdir(parents=True)
        self.env: dict[str, str] | None = None

    def plan(self) -> list[list[str]]:
        from kakeiboot_ops import build_promote_commands

        return build_promote_commands(self.cfg, 40282, 40283)

    def write_stub_systemctl(self, body: str) -> None:
        # leads PATH: `systemctl show kakeiboot-stg -p MainPID --value`
        # resolves to this stub, whose stdout stands in for the real answer.
        stub_dir = self.root / "stub-bin"
        stub_dir.mkdir()
        stub = stub_dir / "systemctl"
        stub.write_text("#!/bin/sh\n" + body, encoding="utf-8")
        stub.chmod(0o755)
        self.env = {**os.environ, "PATH": f"{stub_dir}{os.pathsep}{os.environ['PATH']}"}

    def run_step(self, cmd: list[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(cmd, capture_output=True, text=True, env=self.env)

    def start_sleeper(self) -> subprocess.Popen:
        # a live process whose /proc/<pid>/exe is the `sleep` binary itself
        proc = subprocess.Popen(["sleep", "30"])
        self.addCleanup(proc.wait)
        self.addCleanup(proc.terminate)
        return proc

    # (b) process-identity precheck: success / empty PID / hash mismatch
    def test_process_check_passes_when_running_exe_matches_disk(self) -> None:
        if shutil.which("sha256sum") is None or shutil.which("sleep") is None:
            self.skipTest("sha256sum/sleep not on PATH")
        sleeper = self.start_sleeper()
        self.write_stub_systemctl(f"echo {sleeper.pid}\n")
        shutil.copyfile(shutil.which("sleep"), self.root / "stg" / "budget-book")
        proc = self.run_step(self.plan()[1])
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_process_check_fails_on_empty_pid(self) -> None:
        # MainPID empty (service not running): must stop, not date-parse ""
        self.write_stub_systemctl("printf '\\n'\n")
        (self.root / "stg" / "budget-book").write_bytes(b"whatever")
        proc = self.run_step(self.plan()[1])
        self.assertNotEqual(proc.returncode, 0)

    def test_process_check_fails_on_hash_mismatch(self) -> None:
        if shutil.which("sleep") is None:
            self.skipTest("sleep not on PATH")
        sleeper = self.start_sleeper()
        self.write_stub_systemctl(f"echo {sleeper.pid}\n")
        # disk carries a NEW binary the running process is not made of
        # (distributed but not restarted -- exactly the state to reject)
        (self.root / "stg" / "budget-book").write_bytes(b"new-binary-not-running")
        proc = self.run_step(self.plan()[1])
        self.assertNotEqual(proc.returncode, 0)

    # (a) archive step: success / cp failure / skip
    def make_prod_artifacts(self) -> None:
        prod = self.root / "prod"
        (prod / "bin").mkdir(parents=True)
        (prod / "frontend" / "dist").mkdir(parents=True)
        (prod / "budget-book").write_bytes(b"old-binary")
        (prod / "bin" / "kakeiboot-backup.sh").write_text("# backup\n", encoding="utf-8")
        (prod / "frontend" / "dist" / "index.html").write_text("shell\n", encoding="utf-8")

    def test_archive_step_succeeds_and_archives_all_three(self) -> None:
        self.make_prod_artifacts()
        proc = self.run_step(self.plan()[4])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        releases = list((self.root / "prod" / "releases").iterdir())
        self.assertEqual(len(releases), 1)
        archived = releases[0]
        self.assertTrue((archived / "budget-book").is_file())
        self.assertTrue((archived / "bin" / "kakeiboot-backup.sh").is_file())
        self.assertTrue((archived / "frontend" / "dist" / "index.html").is_file())

    def test_archive_step_fails_nonzero_when_a_copy_fails(self) -> None:
        # binary present, frontend/ missing: the && chain must surface the cp
        # failure (the review's original bug: `;` + trailing echo masked it)
        prod = self.root / "prod"
        (prod / "budget-book").write_bytes(b"old-binary")
        proc = self.run_step(self.plan()[4])
        self.assertNotEqual(proc.returncode, 0)

    def test_archive_step_skips_cleanly_when_prod_not_deployed(self) -> None:
        # setUp already created <root>/prod (configs/ layout): no binary in it
        proc = self.run_step(self.plan()[4])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse((self.root / "prod" / "releases").exists())

    # (c) sha256 display step: stg absent / prod absent / both present
    def test_sha_step_fails_when_stg_binary_absent(self) -> None:
        proc = self.run_step(self.plan()[2])
        self.assertNotEqual(proc.returncode, 0)

    def test_sha_step_continues_with_marker_when_prod_undeployed(self) -> None:
        (self.root / "stg" / "budget-book").write_bytes(b"stg-binary")
        proc = self.run_step(self.plan()[2])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("prod: budget-book not deployed yet", proc.stdout)
        self.assertNotIn("prod-binary-hash", proc.stdout)

    def test_sha_step_shows_both_hashes_when_both_present(self) -> None:
        (self.root / "stg" / "budget-book").write_bytes(b"stg-binary")
        (self.root / "prod" / "budget-book").write_bytes(b"prod-binary")
        proc = self.run_step(self.plan()[2])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("not deployed yet", proc.stdout)


# [covers:deploy-ops.port-from-runtime-config]
class TestRuntimePortResolution(unittest.TestCase):
    """D-6 port split: promote resolves ports from the DEPLOYED runtime-dir
    config, not the repo config (repo independence is promote's core value)."""

    def make_cfg_with_app(self, text: str) -> DeployConfig:
        tmp_obj = tempfile.TemporaryDirectory()
        self.addCleanup(tmp_obj.cleanup)
        root = Path(tmp_obj.name)
        env_dir = root / "stg" / "configs" / "stg"
        env_dir.mkdir(parents=True)
        write(env_dir / "app.toml", text)
        return DeployConfig(deploy_root=str(root), transport="local", runtime_host=None)

    def test_local_reads_runtime_dir_config(self) -> None:
        from kakeiboot_ops import resolve_runtime_port

        cfg = self.make_cfg_with_app("[server]\nport = 40299\n")
        self.assertEqual(resolve_runtime_port(cfg, "stg"), 40299)

    def test_missing_port_rejected(self) -> None:
        from kakeiboot_ops import resolve_runtime_port

        cfg = self.make_cfg_with_app('[server]\nhosts = ["::"]\n')
        with self.assertRaises(ConfigError):
            resolve_runtime_port(cfg, "stg")

    def test_ssh_captures_remote_cat_output(self) -> None:
        from kakeiboot_ops import resolve_runtime_port

        app = "[server]\nport = 40283\n"
        result = subprocess.CompletedProcess(args=[], returncode=0, stdout=app)
        with mock.patch.object(kakeiboot_ops.subprocess, "run", return_value=result) as run:
            self.assertEqual(resolve_runtime_port(ssh_cfg(), "prod"), 40283)
        argv = run.call_args.args[0]
        self.assertEqual(argv[:7], ["ssh", *SSH_OPTIONS, "gt430", "--"])
        self.assertIn("cat", argv[-1])
        self.assertIn(f"{PROD_DIR}/configs/prod/app.toml", argv[-1])

    # [covers:deploy-ops.promote-dry-run-port-resolution]
    def test_promote_dry_run_still_resolves_both_runtime_ports(self) -> None:
        # documented spec (review follow-up): --dry-run distributes nothing,
        # but port resolution is a read-only plan-construction prerequisite and
        # DOES run -- both remote cats happen even though no step executes.
        # An unreachable host therefore fails the dry-run (early discovery).
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = write(Path(tmp) / "deploy.toml", BASE_TOML)
            results = [
                subprocess.CompletedProcess(args=[], returncode=0, stdout="[server]\nport = 40282\n"),
                subprocess.CompletedProcess(args=[], returncode=0, stdout="[server]\nport = 40283\n"),
            ]
            with mock.patch("kakeiboot_ops.config_paths", return_value=[cfg_path]):
                with mock.patch.object(kakeiboot_ops.subprocess, "run", side_effect=results) as run:
                    out, err = io.StringIO(), io.StringIO()
                    with redirect_stdout(out), redirect_stderr(err):
                        rc = main(["promote", "--dry-run"])
        self.assertEqual(rc, 0)
        # exactly the two resolution cats ran; the 11 plan steps executed none
        self.assertEqual(run.call_count, 2)
        plan = out.getvalue()
        self.assertIn("localhost:40282/healthz", plan)
        self.assertIn("localhost:40283/healthz", plan)


# [covers:deploy-ops.deploy-env-stg-only]
class TestDeployEnvRestricted(unittest.TestCase):
    def test_deploy_accepts_stg_only(self) -> None:
        args = build_parser().parse_args(["deploy", "--env", "stg"])
        self.assertEqual(args.env, "stg")
        # prod is structurally excluded: the only prod write path is promote
        err = io.StringIO()
        with redirect_stderr(err):
            with self.assertRaises(SystemExit):
                build_parser().parse_args(["deploy", "--env", "prod"])


# [covers:deploy-ops.promote-plan] (parser half: promote takes no --env)
class TestPromoteParser(unittest.TestCase):
    def test_promote_parses_without_env(self) -> None:
        args = build_parser().parse_args(["promote"])
        self.assertFalse(args.dry_run)
        dry = build_parser().parse_args(["promote", "--dry-run"])
        self.assertTrue(dry.dry_run)

    def test_promote_rejects_env(self) -> None:
        err = io.StringIO()
        with redirect_stderr(err):
            with self.assertRaises(SystemExit):
                build_parser().parse_args(["promote", "--env", "stg"])


# [covers:deploy-ops.configs-command]
class TestConfigsCommandPlan(unittest.TestCase):
    """D-7-1/D-7-2: file distribution only (mkdir + checksum rsync); no restart."""

    def test_local_plan_is_mkdir_then_checksum_rsync_without_restart(self) -> None:
        from kakeiboot_ops import build_configs_commands

        cmds = build_configs_commands(local_cfg(), "prod")
        self.assertEqual(
            cmds,
            [
                ["mkdir", "-p", f"{PROD_DIR}/configs/prod"],
                [
                    "rsync",
                    "-a",
                    "--delete",
                    "--checksum",
                    "-i",
                    "configs/prod/",
                    f"{PROD_DIR}/configs/prod/",
                ],
            ],
        )
        for cmd in cmds:
            self.assertNotIn("systemctl", " ".join(cmd))

    def test_ssh_plan_uses_rsync_exec_transport(self) -> None:
        from kakeiboot_ops import build_configs_commands

        cmds = build_configs_commands(ssh_cfg(), "prod")
        self.assertEqual(
            cmds[0],
            ["ssh", *SSH_OPTIONS, "gt430", "--", f"mkdir -p {PROD_DIR}/configs/prod"],
        )
        rsync = cmds[1]
        self.assertEqual(rsync[rsync.index("-e") + 1], SSH_RSYNC_E)
        self.assertEqual(rsync[-1], f"gt430:{PROD_DIR}/configs/prod/")

    # [covers:deploy-ops.configs-preview-flag]
    def test_preview_adds_rsync_dry_run(self) -> None:
        from kakeiboot_ops import build_configs_commands

        preview_cmds = build_configs_commands(local_cfg(), "prod", preview=True)
        self.assertEqual(len(preview_cmds), 2)
        self.assertIn("--dry-run", preview_cmds[1])  # rsync's own dry run
        plain_cmds = build_configs_commands(local_cfg(), "prod", preview=False)
        self.assertNotIn("--dry-run", plain_cmds[1])


# [covers:deploy-ops.configs-command]
# [covers:deploy-ops.configs-preview-flag]
class TestConfigsParser(unittest.TestCase):
    def test_env_is_required(self) -> None:
        err = io.StringIO()
        with redirect_stderr(err):
            with self.assertRaises(SystemExit):
                build_parser().parse_args(["configs"])

    def test_env_choices_and_preview_flag(self) -> None:
        args = build_parser().parse_args(["configs", "--env", "prod", "--preview"])
        self.assertEqual(args.env, "prod")
        self.assertTrue(args.preview)
        args = build_parser().parse_args(["configs", "--env", "stg"])
        self.assertEqual(args.env, "stg")
        self.assertFalse(args.preview)


# [covers:deploy-ops.promote-mise-tasks]
class TestPromoteMiseTasks(unittest.TestCase):
    def tasks(self) -> dict:
        return tomllib.loads((REPO_ROOT / "mise.toml").read_text(encoding="utf-8"))["tasks"]

    @staticmethod
    def run_text(task: dict) -> str:
        run = task["run"]
        return run if isinstance(run, str) else " ".join(run)

    def test_prod_promote_task_has_no_build_dependency(self) -> None:
        task = self.tasks()["prod:promote"]
        run_text = self.run_text(task)
        self.assertIn("kakeiboot_ops.py promote", run_text)
        # depends must be absent: promote never builds (repo independence)
        self.assertNotIn("depends", task)

    def test_prod_configs_task_runs_configs_subcommand(self) -> None:
        run_text = self.run_text(self.tasks()["prod:configs"])
        self.assertIn("kakeiboot_ops.py configs", run_text)
        self.assertIn("--env prod", run_text)

    def test_prod_deploy_task_is_removed(self) -> None:
        self.assertNotIn("prod:deploy", self.tasks())

    def test_stg_deploy_task_unchanged(self) -> None:
        task = self.tasks()["stg:deploy"]
        self.assertEqual(
            task["run"],
            "uv run --no-project python scripts/deploy/kakeiboot_ops.py deploy --env stg",
        )
        self.assertEqual(task["depends"], ["build"])


# [covers:deploy-ops.promote-failure-report]
class TestPromoteFailureReport(unittest.TestCase):
    def test_failure_lists_executed_steps(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            # runtime-dir configs feed both healthz ports (local file reads)
            for env, port in (("stg", 40282), ("prod", 40283)):
                env_dir = Path(tmp) / env / "configs" / env
                env_dir.mkdir(parents=True)
                write(env_dir / "app.toml", f"[server]\nport = {port}\n")
            cfg_path = write(
                Path(tmp) / "deploy.toml",
                f'deploy_root = "{tmp}"\ntransport = "local"\n',
            )
            with mock.patch("kakeiboot_ops.config_paths", return_value=[cfg_path]):
                results = [
                    subprocess.CompletedProcess(args=[], returncode=0),  # stg healthz
                    subprocess.CompletedProcess(args=[], returncode=0),  # mtime check
                    subprocess.CompletedProcess(args=[], returncode=7),  # sha256 step fails
                ]
                with mock.patch.object(kakeiboot_ops.subprocess, "run", side_effect=results):
                    out, err = io.StringIO(), io.StringIO()
                    with redirect_stdout(out), redirect_stderr(err):
                        rc = main(["promote"])
        self.assertEqual(rc, 7)
        self.assertIn("steps executed before failure:", err.getvalue())
        # only the three executed read-only steps are listed; the prod restart
        # (step 10) never ran and must not appear
        self.assertNotIn("kakeiboot-prod", err.getvalue())


if __name__ == "__main__":
    unittest.main()
