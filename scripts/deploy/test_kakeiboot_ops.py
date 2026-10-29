"""Unit tests for kakeiboot_ops.py (TASK-118).

Run via mise task `scripts:test`:
  uv run --no-project python -m unittest discover -s scripts/deploy -p 'test_*.py'
(start dir top-level, no -t flag: `from kakeiboot_ops import ...` needs scripts/deploy
on sys.path -- see tmp/tasks/tm-118/design_deploy-scripts.md section 3-2.)

Standard library only (unittest / shlex / tempfile / unittest.mock), same rule as
the script under test. Legacy run-array strings (deploy 7 lines / backup-status 4
lines) are the phase-1 comparison assets: tmp/tasks/tm-118/raw_*.before.txt.
"""

from __future__ import annotations

import io
import shlex
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from kakeiboot_ops import (
    SSH_OPTIONS,
    SSH_RSYNC_E,
    ConfigError,
    DeployConfig,
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
    "systemctl --user restart kakeiboot-stg",
    "sh -c 'for i in 1 2 3 4 5; do curl -fsS http://localhost:40282/healthz && exit 0; "
    "sleep 1; done; exit 1'",
]
PROD_DEPLOY_LEGACY = [
    f"rsync -a target/debug/budget-book {DEPLOY_ROOT}/prod/budget-book",
    f"mkdir -p {DEPLOY_ROOT}/prod/bin",
    f"rsync -a scripts/backup/kakeiboot-backup.sh {DEPLOY_ROOT}/prod/bin/kakeiboot-backup.sh",
    f"rsync -a --delete configs/prod/ {DEPLOY_ROOT}/prod/configs/prod/",
    f"rsync -a --delete frontend/dist/ {DEPLOY_ROOT}/prod/frontend/dist/",
    "systemctl --user restart kakeiboot-prod",
    "sh -c 'for i in 1 2 3 4 5; do curl -fsS http://localhost:40283/healthz && exit 0; "
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

    def test_prod_deploy_matches_legacy_run_array(self) -> None:
        cmds = build_deploy_commands(local_cfg(), "prod", 40283)
        self.assertEqual([shlex.join(c) for c in cmds], PROD_DEPLOY_LEGACY)

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
            [["systemctl", "--user", "status", "kakeiboot-stg"]],
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
            ["systemctl", "--user", "restart", "kakeiboot-stg"],
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
                "$ systemctl --user restart kakeiboot-stg",
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


if __name__ == "__main__":
    unittest.main()
