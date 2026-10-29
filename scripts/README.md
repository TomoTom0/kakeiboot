# scripts 索引

開発・検証用スクリプトの索引。実態と常に一致させる。実行は `uv run --no-project python scripts/...`（python を直接起動しない）。

## 一覧

| スクリプト | 目的 |
|---|---|
| `scripts/design/verify-conditions.py` | テスト設計条件書（`tests/design/conditions.toml`）の機械検査。covers タグと条件 id の対応・網羅・schema 健全性・`[[excluded]]` 構造を検査し、`source_lines`（タグの実在位置）を同期する（唯一の書き込み）。詳細は test-structure skill |

## 運用操作（作業repoから実行）

| スクリプト | 目的 |
|---|---|
| `scripts/deploy/kakeiboot_ops.py` | stg/prod運用操作の処理本体（TASK-118。miseタスクはthin wrapper）。`configs/deploy.toml`（+ `deploy.local.toml` 後勝ち）を読み、`transport`（ssh/local）に従ってdeploy・exec・service・backup・backup-statusを実行。healthz portは `configs/<env>/app.toml` から解決。`--dry-run` で実行計画のみ表示。詳細は docs/deploy.md |
| `scripts/deploy/test_kakeiboot_ops.py` | 上記の単体test（unittest・標準ライブラリのみ。mise task `scripts:test` で実行〔`mise run verify` 経由〕） |

## 運用配布系（repoが正本。作業repoでは実行しない）

| スクリプト | 目的 |
|---|---|
| `scripts/backup/kakeiboot-backup.sh` | kakeiboot backup構成script（TASK-83）。`admin backup`（read-only `VACUUM INTO`によるDB snapshot）→ images rsync（`--delete`なし）→ `COMPLETED`/`last_success` → 世代ローテーション（環境変数 `KEEP=<n>` でoverride可・既定30）。deployが運用dir `bin/` へ配布し、`kakeiboot-backup@<env>` unitから実行される。詳細は docs/deploy.md |
| `scripts/systemd/kakeiboot-backup@.service` | backup oneshot unit（template 1組で stg/prod 両用）。運用機の `~/.config/systemd/user/` へ配置（deploy対象外・導入手順は docs/deploy.md） |
| `scripts/systemd/kakeiboot-backup@.timer` | backup daily timer（UTC 19:30 = JST 04:30・`Persistent=true`・`RandomizedDelaySec=15m`）。配置は同上 |
