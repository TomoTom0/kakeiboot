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

Service-account follow-up (dedicated kakeiboot account migration, design
step 3): deploy/promote place artifacts as kakeiboot:srvops -- single files
via the root-owned kakeiboot-deploy wrapper's install-file (deploy stages
them on the target first, the install-units pattern), trees via rsync/cp +
the wrapper's chown-tree. (gt430's sudo-rs accepts no wildcards in sudoers
command arguments, so the grant names only the wrapper; the wrapper itself
validates the paths and runs install/chown.) The deploy plan therefore no
longer byte-matches the legacy mise run array (the guarantee is retired
with this change and the plan is asserted as STG_DEPLOY_PLAN), promote grows
from 11 to 13 steps, and the backup unit's fixed run user becomes
User=kakeiboot.

Mode-normalization follow-up: the transferred trees' mode normalization
(directories 2770, files group-writable) moves OUT of the wrapper's
chown-tree into the ops tool (deploy_normalize_tree_modes, run as the
operator right after each transfer, before the chown -- the only moment
the operator still owns the files and can chmod them). The wrapper stays
frozen to install-file / chown-tree (ownership only), so deploy policy
changes never need a root re-run to replace it. deploy grows 12 -> 13
steps, promote 13 -> 14, and configs gains the normalization as a third
step (skipped under --preview, which must stay write-free).
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

# Deploy plan (service-account follow-up form): the single-file artifacts are
# staged on the target and placed via the kakeiboot-deploy wrapper (which
# installs them as kakeiboot:srvops); the dist tree keeps rsync and is
# re-owned via the wrapper's chown-tree. Until the
# follow-up, this list byte-matched the legacy mise run array
# (STG_DEPLOY_LEGACY, 7 lines); that guarantee is retired with the placement
# change, so the plan is asserted in its new shape directly.
STG_STAGE = "/tmp/kakeiboot-artifacts-install-stg"
STG_DEPLOY_PLAN = [
    f"mkdir -p {STG_STAGE}",
    f"rsync -a target/debug/budget-book {STG_STAGE}/budget-book",
    f"rsync -a scripts/backup/kakeiboot-backup.sh {STG_STAGE}/kakeiboot-backup.sh",
    f"sudo /usr/local/sbin/kakeiboot-deploy install-file {STG_STAGE}/budget-book "
    f"{DEPLOY_ROOT}/stg/budget-book",
    f"mkdir -p {DEPLOY_ROOT}/stg/bin",
    f"sudo /usr/local/sbin/kakeiboot-deploy install-file {STG_STAGE}/kakeiboot-backup.sh "
    f"{DEPLOY_ROOT}/stg/bin/kakeiboot-backup.sh",
    f"rsync -a --no-perms --omit-dir-times --delete configs/stg/ {DEPLOY_ROOT}/stg/configs/stg/",
    f"rsync -a --no-perms --omit-dir-times --delete frontend/dist/ {DEPLOY_ROOT}/stg/frontend/dist/",
    f"sh -c 'find {DEPLOY_ROOT}/stg/frontend/dist -type d -exec chmod 2770 {{}} + "
    f"&& find {DEPLOY_ROOT}/stg/frontend/dist -type f -exec chmod g+rw {{}} +'",
    f"sudo /usr/local/sbin/kakeiboot-deploy chown-tree {DEPLOY_ROOT}/stg/frontend/dist",
    f"rm -rf {STG_STAGE}",
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


# [covers:deploy-ops.transport-local] local transport: backup-status reproduces
# the legacy run arrays; the deploy plan is asserted in its service-account
# follow-up shape (STG_DEPLOY_PLAN)
class TestTransportLocal(unittest.TestCase):
    def test_stg_deploy_matches_service_account_plan(self) -> None:
        cmds = build_deploy_commands(local_cfg(), "stg", 40282, STG_STAGE)
        self.assertEqual([shlex.join(c) for c in cmds], STG_DEPLOY_PLAN)

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
        cmds = build_deploy_commands(ssh_cfg(), "stg", 40282, STG_STAGE)
        # rsync steps: the two artifact stagings, configs, dist (indices 1,2,6,7)
        for idx in (1, 2, 6, 7):
            cmd = cmds[idx]
            self.assertEqual(cmd[0], "rsync")
            self.assertEqual(cmd[cmd.index("-e") + 1], SSH_RSYNC_E)
            self.assertTrue(cmd[-1].startswith("gt430:"))
        self.assertEqual(cmds[1][-1], f"gt430:{STG_STAGE}/budget-book")
        # the two --delete rsyncs keep their options plus the ssh transport
        for idx in (6, 7):
            self.assertIn("--delete", cmds[idx])

    def test_non_rsync_steps_wrapped_in_ssh(self) -> None:
        local_cmds = build_deploy_commands(local_cfg(), "stg", 40282, STG_STAGE)
        ssh_cmds = build_deploy_commands(ssh_cfg(), "stg", 40282, STG_STAGE)
        # mkdir x2, sudo install x2, normalize, sudo chown, rm -rf,
        # systemctl restart, healthz
        for idx in (0, 3, 4, 5, 8, 9, 10, 11, 12):
            self.assert_ssh_wrapped(ssh_cmds[idx], local_cmds[idx])

    def test_every_step_is_host_mediated(self) -> None:
        for cmds in (
            build_deploy_commands(ssh_cfg(), "stg", 40282, STG_STAGE),
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

    def test_deploy_last_element_is_healthz(self) -> None:
        cmds = build_deploy_commands(local_cfg(), "stg", 40282, STG_STAGE)
        self.assertEqual(cmds[-1], healthz_command(40282))
        joined = shlex.join(cmds[-1])
        self.assertEqual(joined, STG_DEPLOY_PLAN[-1])
        self.assertIn("1 2 3 4 5", joined)
        self.assertIn("sleep 1", joined)


# TASK-119 shared fixtures (design: tmp/tasks/tm-119/design_backup_paths.md v2).
# The backup units are system units now (2026-11-17 gt430 system-service
# conversion; install-units matches the host conversion script's end state):
# /etc destinations + the target-side staging dir, asserted as literals so the
# tests do not import the values they check. The target staging dir is derived
# per invocation from the local staged dir name (BACKUP_UNIT_STAGE_PREFIX +
# the staged dir basename), so UNIT_STAGE_DIR below is the derived value for
# the fixtures' "units-render" staged dir -- never a shared fixed path.
SYSTEMD_DIR = REPO_ROOT / "scripts" / "systemd"
UNIT_IN_PATH = SYSTEMD_DIR / "kakeiboot-backup@.service.in"
UNIT_TIMER_PATH = SYSTEMD_DIR / "kakeiboot-backup@.timer"
SYSTEM_UNIT_DIR = "/etc/systemd/system"
POLKIT_RULES_DIR = "/etc/polkit-1/rules.d"
POLKIT_RULE_NAME = "49-dual-operator-kakeiboot-backup.rules"
UNIT_STAGE_DIR = "/tmp/kakeiboot-units-install-units-render"
SUDO_INSTALL = ["sudo", "install", "-o", "root", "-g", "root", "-m", "644"]
# Service-account form (migration follow-up): artifacts are placed through
# the root-owned kakeiboot-deploy wrapper (literal path asserted, not
# imported, like the other values here): install-file installs as
# kakeiboot:srvops 770 inside the wrapper; chown-tree re-owns recursively.
DEPLOY_WRAPPER_PATH = "/usr/local/sbin/kakeiboot-deploy"
WRAPPER_INSTALL_FILE = ["sudo", DEPLOY_WRAPPER_PATH, "install-file"]
WRAPPER_CHOWN_TREE = ["sudo", DEPLOY_WRAPPER_PATH, "chown-tree"]

# Same shape as the repo .in source (D-2): leading no-direct-scp comment,
# {{deploy_root}} placeholders, %i template instances the render must preserve.
UNIT_IN_FIXTURE = (
    "# render source template: do not scp directly -- use mise run units:install\n"
    "[Unit]\n"
    "Description=kakeiboot %i backup (SQLite online backup via admin CLI + images rsync)\n"
    "\n"
    "[Service]\n"
    "Type=oneshot\n"
    "User=kakeiboot\n"
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
        # system form only: the fixed run user lives in the template itself
        # (the unit no longer exists in user scope where the user was implicit)
        self.assertIn("User=kakeiboot", text)

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
        self.assertIn("User=kakeiboot\n", rendered)

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


# [covers:deploy-ops.install-units-plan] system-form plan: stage on the target
# -> sudo install service+timer+polkit rule under /etc -> system daemon-reload
# -> enable --now both timers; no user-scope remnant; no --env argument
class TestInstallUnitsPlan(unittest.TestCase):
    STAGED_DIR = "/tmp/units-render"

    def test_local_plan_installs_system_units_with_sudo(self) -> None:
        from kakeiboot_ops import build_install_units_commands

        cmds = build_install_units_commands(local_cfg(), self.STAGED_DIR)
        self.assertEqual(len(cmds), 9)
        (
            mkdir,
            stage_rsync,
            service_install,
            timer_install,
            rule_install,
            reload_cmd,
            enable_stg,
            enable_prod,
            cleanup,
        ) = cmds
        # the target-side staging dir may not exist on a fresh runtime host, so
        # mkdir -p leads; sudo install reads a path on the target, so the staged
        # dir (rendered service + timer + polkit rule) is copied there first
        self.assertEqual(mkdir, ["mkdir", "-p", UNIT_STAGE_DIR])
        self.assertEqual(stage_rsync[0], "rsync")
        self.assertEqual(stage_rsync[-2], f"{self.STAGED_DIR}/")
        self.assertEqual(stage_rsync[-1], f"{UNIT_STAGE_DIR}/")
        # /etc writes are root:root 644 via sudo install -- never rsync or --user
        self.assertEqual(
            service_install,
            [
                *SUDO_INSTALL,
                f"{UNIT_STAGE_DIR}/kakeiboot-backup@.service",
                f"{SYSTEM_UNIT_DIR}/kakeiboot-backup@.service",
            ],
        )
        self.assertEqual(
            timer_install,
            [
                *SUDO_INSTALL,
                f"{UNIT_STAGE_DIR}/kakeiboot-backup@.timer",
                f"{SYSTEM_UNIT_DIR}/kakeiboot-backup@.timer",
            ],
        )
        self.assertEqual(
            rule_install,
            [
                *SUDO_INSTALL,
                f"{UNIT_STAGE_DIR}/{POLKIT_RULE_NAME}",
                f"{POLKIT_RULES_DIR}/{POLKIT_RULE_NAME}",
            ],
        )
        self.assertEqual(reload_cmd, ["sudo", "systemctl", "daemon-reload"])
        self.assertEqual(
            enable_stg,
            ["sudo", "systemctl", "enable", "--now", "kakeiboot-backup@stg.timer"],
        )
        self.assertEqual(
            enable_prod,
            ["sudo", "systemctl", "enable", "--now", "kakeiboot-backup@prod.timer"],
        )
        # the per-invocation target staging dir is removed once the installs
        # and enables are done, so no 0700 dir survives for the next operator
        self.assertEqual(cleanup, ["rm", "-rf", UNIT_STAGE_DIR])
        for cmd in cmds:
            # system form only: the user unit dir and --user must be gone
            joined = " ".join(cmd)
            self.assertNotIn("--user", joined)
            self.assertNotIn(".config/systemd/user", joined)
            self.assertNotIn(str(Path.home()), joined)

    def test_ssh_plan_prefixes_host_and_wraps_sudo_steps(self) -> None:
        from kakeiboot_ops import build_install_units_commands

        cmds = build_install_units_commands(ssh_cfg(), self.STAGED_DIR)
        self.assertEqual(len(cmds), 9)
        (
            mkdir,
            stage_rsync,
            service_install,
            _timer_install,
            _rule_install,
            reload_cmd,
            enable_stg,
            enable_prod,
            cleanup,
        ) = cmds
        self.assertEqual(mkdir, ["ssh", *SSH_OPTIONS, "gt430", "--", f"mkdir -p {UNIT_STAGE_DIR}"])
        self.assertEqual(stage_rsync[stage_rsync.index("-e") + 1], SSH_RSYNC_E)
        self.assertEqual(stage_rsync[-1], f"gt430:{UNIT_STAGE_DIR}/")
        # sudo runs on the runtime host (the operator's own sudo rights), not here
        self.assertEqual(
            service_install,
            [
                "ssh",
                *SSH_OPTIONS,
                "gt430",
                "--",
                f"sudo install -o root -g root -m 644 "
                f"{UNIT_STAGE_DIR}/kakeiboot-backup@.service "
                f"{SYSTEM_UNIT_DIR}/kakeiboot-backup@.service",
            ],
        )
        self.assertEqual(
            reload_cmd,
            ["ssh", *SSH_OPTIONS, "gt430", "--", "sudo systemctl daemon-reload"],
        )
        self.assertEqual(
            enable_stg,
            [
                "ssh",
                *SSH_OPTIONS,
                "gt430",
                "--",
                "sudo systemctl enable --now kakeiboot-backup@stg.timer",
            ],
        )
        self.assertEqual(
            enable_prod,
            [
                "ssh",
                *SSH_OPTIONS,
                "gt430",
                "--",
                "sudo systemctl enable --now kakeiboot-backup@prod.timer",
            ],
        )
        # the per-invocation target staging dir cleanup runs on the host too
        self.assertEqual(
            cleanup, ["ssh", *SSH_OPTIONS, "gt430", "--", f"rm -rf {UNIT_STAGE_DIR}"]
        )

    def test_polkit_rule_covers_both_operators_and_all_instances(self) -> None:
        # the rule is generated in the tool (no extra template file): both
        # operators manage every backup unit instance as themselves
        from kakeiboot_ops import BACKUP_POLKIT_RULE

        self.assertIn('action.id == "org.freedesktop.systemd1.manage-units"', BACKUP_POLKIT_RULE)
        for unit in (
            "kakeiboot-backup@stg.service",
            "kakeiboot-backup@stg.timer",
            "kakeiboot-backup@prod.service",
            "kakeiboot-backup@prod.timer",
        ):
            self.assertIn(f'"{unit}"', BACKUP_POLKIT_RULE)
        self.assertIn('subject.user == "tomo"', BACKUP_POLKIT_RULE)
        self.assertIn('subject.user == "muse-agent"', BACKUP_POLKIT_RULE)
        self.assertIn("return polkit.Result.YES;", BACKUP_POLKIT_RULE)

    def test_subcommand_parses_without_env(self) -> None:
        # the unit is one %i template shared by both envs: no --env argument (D-2)
        args = build_parser().parse_args(["install-units"])
        self.assertFalse(args.dry_run)
        dry = build_parser().parse_args(["install-units", "--dry-run"])
        self.assertTrue(dry.dry_run)


# [covers:deploy-ops.install-units-dry-run] --dry-run prints the rendered unit and
# the polkit rule, executes nothing; a (mocked) real run stages, sudo installs,
# reloads, enables both timers, reports the deploy_root
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
        self.assertIn("User=kakeiboot", printed)
        self.assertIn("WorkingDirectory=/custom/root/%i", printed)
        self.assertIn("ExecStart=/custom/root/%i/bin/kakeiboot-backup.sh %i", printed)
        # the polkit rule payload and the /etc-only sudo plan are both shown
        self.assertIn(POLKIT_RULE_NAME, printed)
        self.assertIn("polkit.addRule", printed)
        self.assertIn(f"sudo install -o root -g root -m 644 {UNIT_STAGE_DIR}/", printed)
        self.assertIn(f"{POLKIT_RULES_DIR}/{POLKIT_RULE_NAME}", printed)
        self.assertIn("sudo systemctl daemon-reload", printed)
        self.assertIn("sudo systemctl enable --now kakeiboot-backup@stg.timer", printed)
        self.assertIn("sudo systemctl enable --now kakeiboot-backup@prod.timer", printed)
        # system form only: the user unit dir and --user must be gone
        self.assertNotIn(".config/systemd/user", printed)
        self.assertNotIn("--user", printed)

    def test_run_stages_installs_reloads_and_enables(self) -> None:
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
        self.assertEqual(
            [argv[0] for argv in argvs],
            ["mkdir", "rsync", "sudo", "sudo", "sudo", "sudo", "sudo", "sudo", "rm"],
        )
        # the staging rsync copies the tmp/units-* dir (service+timer+rule);
        # the target stage dir is derived per invocation from that dir's name
        # (the real run stages in a fresh tmp/units-* dir, not the fixture)
        staged_src = argvs[1][-2]
        self.assertTrue(staged_src.endswith("/"), "staged dir src must be a dir path")
        self.assertIn("tmp/units-", staged_src)
        expected_stage = f"/tmp/kakeiboot-units-install-{Path(staged_src.rstrip('/')).name}"
        self.assertEqual(argvs[0], ["mkdir", "-p", expected_stage])
        self.assertEqual(argvs[1][-1], f"{expected_stage}/")
        self.assertEqual(
            argvs[2],
            [
                *SUDO_INSTALL,
                f"{expected_stage}/kakeiboot-backup@.service",
                f"{SYSTEM_UNIT_DIR}/kakeiboot-backup@.service",
            ],
        )
        self.assertEqual(
            argvs[3],
            [
                *SUDO_INSTALL,
                f"{expected_stage}/kakeiboot-backup@.timer",
                f"{SYSTEM_UNIT_DIR}/kakeiboot-backup@.timer",
            ],
        )
        self.assertEqual(
            argvs[4],
            [
                *SUDO_INSTALL,
                f"{expected_stage}/{POLKIT_RULE_NAME}",
                f"{POLKIT_RULES_DIR}/{POLKIT_RULE_NAME}",
            ],
        )
        self.assertEqual(argvs[5], ["sudo", "systemctl", "daemon-reload"])
        self.assertEqual(
            argvs[6], ["sudo", "systemctl", "enable", "--now", "kakeiboot-backup@stg.timer"]
        )
        self.assertEqual(
            argvs[7], ["sudo", "systemctl", "enable", "--now", "kakeiboot-backup@prod.timer"]
        )
        # the per-invocation target staging dir is removed after the enables
        self.assertEqual(argvs[8], ["rm", "-rf", expected_stage])
        # D-4: the deploy_root value used for rendering stays in the output
        self.assertIn("/custom/root", out.getvalue())

    # [covers:deploy-ops.install-units-plan] (review: failure reporting parity
    # with cmd_deploy -- install-units is a multi-step stage+install+reload+enable
    # sequence, so a mid-plan failure must report which steps already ran)
    def test_failure_lists_executed_steps(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = self.make_config(tmp)
            with mock.patch("kakeiboot_ops.config_paths", return_value=[cfg_path]):
                results = [
                    subprocess.CompletedProcess(args=[], returncode=0),  # mkdir staging
                    subprocess.CompletedProcess(args=[], returncode=0),  # rsync staged dir
                    subprocess.CompletedProcess(args=[], returncode=1),  # sudo install fails
                ]
                with mock.patch.object(kakeiboot_ops.subprocess, "run", side_effect=results):
                    out, err = io.StringIO(), io.StringIO()
                    with redirect_stdout(out), redirect_stderr(err):
                        rc = main(["install-units"])
        self.assertEqual(rc, 1)
        err_text = err.getvalue()
        self.assertIn("steps executed before failure:", err_text)
        # the steps up to and including the failed sudo install are listed
        # (same executed-count rule as cmd_deploy's recovery report); the
        # target stage dir is derived from the fresh tmp/units-* dir, so only
        # its per-invocation prefix is assertable here
        self.assertIn("mkdir -p /tmp/kakeiboot-units-install-", err_text)
        self.assertIn(f"{SYSTEM_UNIT_DIR}/kakeiboot-backup@.service", err_text)
        # the never-reached daemon-reload / timer enables are not
        self.assertNotIn("daemon-reload", err_text)
        self.assertNotIn("enable --now", err_text)


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
# [covers:deploy-ops.artifact-placement-owner]
class TestPromotePlan(unittest.TestCase):
    """D-6 fixed 14-step plan (11 steps through TASK-189, +2 ownership steps
    in the service-account follow-up, +1 mode-normalization step when the
    normalization moved into the ops tool). Local form is the raw
    remote_exec argv list; the ssh form (D-5) runs the stg->prod
    distribution ON gt430 (ssh-wrapped, no host: destination prefix) and
    only the configs preview goes repo->host via rsync_exec."""

    def build(self, cfg):
        from kakeiboot_ops import build_promote_commands

        return build_promote_commands(cfg, 40282, 40283)

    def test_local_plan_is_fourteen_steps_in_design_order(self) -> None:
        cmds = self.build(local_cfg())
        self.assertEqual(len(cmds), 14)
        (
            healthz_stg,
            _process,
            _sha,
            _preview,
            _archive,
            mkdir,
            install_bin,
            install_script,
            rs_dist,
            normalize_dist,
            chown_dist,
            chown_releases,
            restart,
            healthz_prod,
        ) = cmds
        # step 1: stg healthz (port resolved from the stg RUNTIME-DIR config)
        self.assertEqual(healthz_stg, healthz_command(40282))
        # step 6: prerequisite dirs (rsync/install never create intermediate dirs)
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
        # steps 7/8: single-file artifacts are placed via the
        # kakeiboot-deploy wrapper's install-file (as kakeiboot:srvops 770
        # inside the wrapper; service-account follow-up; they are already
        # on the runtime host, so no staging and no rsync)
        self.assertEqual(
            install_bin,
            [*WRAPPER_INSTALL_FILE, f"{STG_DIR}/budget-book", f"{PROD_DIR}/budget-book"],
        )
        self.assertEqual(
            install_script,
            [
                *WRAPPER_INSTALL_FILE,
                f"{STG_DIR}/bin/kakeiboot-backup.sh",
                f"{PROD_DIR}/bin/kakeiboot-backup.sh",
            ],
        )
        # step 9: dist keeps its rsync -- no --checksum (D-3), --delete only
        self.assertEqual(
            rs_dist,
            ["rsync", "-a", "--no-perms", "--omit-dir-times", "--delete", "-i", f"{STG_DIR}/frontend/dist/", f"{PROD_DIR}/frontend/dist/"],
        )
        # step 10: the rsynced dist's modes are normalized by the operator
        # (still the owner at this point) right before the re-owning
        self.assertEqual(
            normalize_dist,
            [
                "sh",
                "-c",
                f"find {PROD_DIR}/frontend/dist -type d -exec chmod 2770 {{}} + "
                f"&& find {PROD_DIR}/frontend/dist -type f -exec chmod g+rw {{}} +",
            ],
        )
        # steps 11/12: ownership of the rsynced dist and of the archived
        # releases generations moves to kakeiboot:srvops (the wrapper's
        # chown-tree -- install has no recursive form; the releases step
        # normalizes modes inside the same guard, before its chown, and
        # is guarded so a first deployment without a releases dir does
        # not fail)
        self.assertEqual(chown_dist, [*WRAPPER_CHOWN_TREE, f"{PROD_DIR}/frontend/dist"])
        self.assertEqual(chown_releases[:2], ["sh", "-c"])
        self.assertIn(f"{PROD_DIR}/releases", chown_releases[2])
        self.assertIn("sudo /usr/local/sbin/kakeiboot-deploy chown-tree", chown_releases[2])
        self.assertIn("if", chown_releases[2])
        self.assertLess(
            chown_releases[2].index("chmod 2770"),
            chown_releases[2].index("chown-tree"),
        )
        # steps 13/14: restart prod, then healthz on the prod runtime-dir port
        self.assertEqual(restart, ["systemctl", "restart", "kakeiboot-prod"])
        self.assertEqual(healthz_prod, healthz_command(40283))

    # [covers:deploy-ops.promote-configs-preview]
    def test_configs_drift_preview_step_is_transfer_free(self) -> None:
        cmds = self.build(local_cfg())
        preview = cmds[3]
        self.assertEqual(preview[0], "rsync")
        self.assertEqual(preview[1:8], ["-a", "--no-perms", "--omit-dir-times", "--delete", "--checksum", "-i", "--dry-run"])
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
        self.assertEqual(len(ssh_cmds), 14)
        # step 4 is the only repo->host rsync (rsync_exec: -e option + host:)
        preview = ssh_cmds[3]
        self.assertEqual(preview[preview.index("-e") + 1], SSH_RSYNC_E)
        self.assertEqual(preview[-1], f"gt430:{PROD_DIR}/configs/prod/")
        # every other step is one ssh-wrapped remote string of the local argv
        for idx in (0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13):
            self.assertEqual(
                ssh_cmds[idx],
                ["ssh", *SSH_OPTIONS, "gt430", "--", shlex.join(local_cmds[idx])],
            )
        # the stg->prod distribution (steps 7-9) runs ON gt430: the wrapped
        # remote strings carry no host: destination prefix
        for idx in (6, 7, 8):
            self.assertNotIn("gt430:", ssh_cmds[idx][-1])


# [covers:deploy-ops.artifact-placement-owner]
class TestArtifactPlacementOwner(unittest.TestCase):
    """Service-account follow-up: the placement helpers route through the
    root-owned kakeiboot-deploy wrapper (which installs/re-owns as the
    dedicated kakeiboot account, owner kakeiboot group srvops), while the
    /etc helper keeps its root:root 644 default (install-units parity)."""

    def test_sudo_install_defaults_stay_root_form(self) -> None:
        from kakeiboot_ops import sudo_install

        self.assertEqual(sudo_install("src", "dst"), [*SUDO_INSTALL, "src", "dst"])

    def test_deploy_install_artifact_goes_through_wrapper(self) -> None:
        from kakeiboot_ops import deploy_install_artifact

        self.assertEqual(
            deploy_install_artifact("src", "dst"), [*WRAPPER_INSTALL_FILE, "src", "dst"]
        )

    def test_deploy_chown_tree_goes_through_wrapper(self) -> None:
        from kakeiboot_ops import deploy_chown_tree

        self.assertEqual(deploy_chown_tree("/some/tree"), [*WRAPPER_CHOWN_TREE, "/some/tree"])

    def test_deploy_places_binary_and_script_via_wrapper(self) -> None:
        cmds = build_deploy_commands(local_cfg(), "stg", 40282, STG_STAGE)
        self.assertEqual(
            cmds[3],
            [
                *WRAPPER_INSTALL_FILE,
                f"{STG_STAGE}/budget-book",
                f"{DEPLOY_ROOT}/stg/budget-book",
            ],
        )
        self.assertEqual(
            cmds[5],
            [
                *WRAPPER_INSTALL_FILE,
                f"{STG_STAGE}/kakeiboot-backup.sh",
                f"{DEPLOY_ROOT}/stg/bin/kakeiboot-backup.sh",
            ],
        )
        # the dist tree is mode-normalized by the operator right after its
        # rsync, then re-owned wholesale via the wrapper's chown-tree
        self.assertEqual(
            cmds[8],
            [
                "sh",
                "-c",
                f"find {DEPLOY_ROOT}/stg/frontend/dist -type d -exec chmod 2770 {{}} + "
                f"&& find {DEPLOY_ROOT}/stg/frontend/dist -type f -exec chmod g+rw {{}} +",
            ],
        )
        self.assertEqual(cmds[9], [*WRAPPER_CHOWN_TREE, f"{DEPLOY_ROOT}/stg/frontend/dist"])


# [covers:deploy-ops.mode-normalization]
class TestNormalizeTreeModes(unittest.TestCase):
    """Mode normalization lives in the ops tool, not in the root-owned
    wrapper: deploy_normalize_tree_modes is an operator-run find/chmod
    step placed after each tree transfer and before the wrapper's
    chown-tree (after the re-owning the operator could no longer chmod).
    The wrapper's chown-tree stays ownership-only."""

    def test_helper_is_operator_find_chmod(self) -> None:
        from kakeiboot_ops import deploy_normalize_tree_modes

        self.assertEqual(
            deploy_normalize_tree_modes("/some/tree"),
            [
                "sh",
                "-c",
                "find /some/tree -type d -exec chmod 2770 {} + "
                "&& find /some/tree -type f -exec chmod g+rw {} +",
            ],
        )

    def test_deploy_normalizes_dist_right_before_chown(self) -> None:
        from kakeiboot_ops import deploy_normalize_tree_modes

        cmds = build_deploy_commands(local_cfg(), "stg", 40282, STG_STAGE)
        normalize = deploy_normalize_tree_modes(f"{DEPLOY_ROOT}/stg/frontend/dist")
        idx = cmds.index(normalize)
        # right after the dist rsync, right before the wrapper chown-tree
        self.assertEqual(cmds[idx - 1][0], "rsync")
        self.assertTrue(cmds[idx - 1][-1].endswith("/stg/frontend/dist/"))
        self.assertEqual(
            cmds[idx + 1], [*WRAPPER_CHOWN_TREE, f"{DEPLOY_ROOT}/stg/frontend/dist"]
        )

    def test_promote_normalizes_dist_and_releases_before_chown(self) -> None:
        from kakeiboot_ops import build_promote_commands, deploy_normalize_tree_modes

        cmds = build_promote_commands(local_cfg(), 40282, 40283)
        normalize = deploy_normalize_tree_modes(f"{PROD_DIR}/frontend/dist")
        idx = cmds.index(normalize)
        self.assertEqual(
            cmds[idx + 1], [*WRAPPER_CHOWN_TREE, f"{PROD_DIR}/frontend/dist"]
        )
        # releases: normalization is inside the guarded step, before chown
        releases_step = cmds[idx + 2][2]
        self.assertIn("chmod 2770", releases_step)
        self.assertIn("chmod g+rw", releases_step)
        self.assertLess(releases_step.index("chmod 2770"), releases_step.index("chown-tree"))

    def test_execution_normalizes_modes(self) -> None:
        from kakeiboot_ops import deploy_normalize_tree_modes

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "tree"
            sub = root / "sub"
            sub.mkdir(parents=True)
            plain = root / "a.txt"
            plain.write_text("a", encoding="utf-8")
            nested = sub / "b.txt"
            nested.write_text("b", encoding="utf-8")
            os.chmod(root, 0o755)
            os.chmod(sub, 0o755)
            os.chmod(plain, 0o644)
            os.chmod(nested, 0o600)
            result = subprocess.run(
                deploy_normalize_tree_modes(str(root)),
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(root.stat().st_mode & 0o7777, 0o2770)
            self.assertEqual(sub.stat().st_mode & 0o7777, 0o2770)
            self.assertEqual(plain.stat().st_mode & 0o777, 0o664)
            self.assertEqual(nested.stat().st_mode & 0o777, 0o660)


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
        self.assertEqual(cmds[12], ["systemctl", "restart", "kakeiboot-prod"])
        self.assertEqual(cmds[13], healthz_command(40283))


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
    """D-7-1/D-7-2: file distribution only (mkdir + checksum rsync + the
    operator-side mode normalization); no restart."""

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
                    "--no-perms",
                    "--omit-dir-times",
                    "--delete",
                    "--checksum",
                    "-i",
                    "configs/prod/",
                    f"{PROD_DIR}/configs/prod/",
                ],
                [
                    "sh",
                    "-c",
                    f"find {PROD_DIR}/configs/prod -type d -exec chmod 2770 {{}} + "
                    f"&& find {PROD_DIR}/configs/prod -type f -exec chmod g+rw {{}} +",
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
        # the normalization step is a remote_exec step (ssh-wrapped)
        local_cmds = build_configs_commands(local_cfg(), "prod")
        self.assertEqual(
            cmds[2],
            ["ssh", *SSH_OPTIONS, "gt430", "--", shlex.join(local_cmds[2])],
        )

    # [covers:deploy-ops.configs-preview-flag]
    def test_preview_adds_rsync_dry_run(self) -> None:
        from kakeiboot_ops import build_configs_commands

        preview_cmds = build_configs_commands(local_cfg(), "prod", preview=True)
        self.assertEqual(len(preview_cmds), 2)
        self.assertIn("--dry-run", preview_cmds[1])  # rsync's own dry run
        # preview writes nothing: no mode-normalization step either
        self.assertNotIn("chmod", " ".join(preview_cmds[-1]))
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
