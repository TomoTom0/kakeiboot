# budget-book

MCP 経由（ChatGPT 等）での操作・閲覧を主とし、web 画面を補助とする家計簿 webapp（アプリ名 kakeiboot）。前提と方針は [CLAUDE.md](CLAUDE.md)、仕様は [docs/README.md](docs/README.md)、テスト構成は [tests/README.md](tests/README.md) を参照。

## 構成

| パス | 内容 |
|---|---|
| `Cargo.toml` | Cargo workspace（member: `backend`） |
| `backend/` | Rust backend（axum + rmcp + sqlx/SQLite）。`src/`、`tests/`、`migrations/` |
| `frontend/` | Vite + Vue 3 + Pinia + TypeScript（pnpm）。エントリは `web.html`（web 画面）と `widget.html`（MCP widget） |
| `configs/` | 設定の単一管理元（環境別 `configs/<env>/` の `app.toml`・`auth.toml`・`mcp.toml`）。port・パス・タイムアウト等はここで管理し、コードに直書きしない |
| `docs/` | 恒久文書（仕様） |
| `tests/` | テスト構成の索引 |
| `scripts/` | 補助スクリプト |
| `local/` | ローカル専用ファイル |
| `mise.toml` | タスク定義 |

生成物の集約先（git 管理外）: `target/`（Rust build）、`var/`（SQLite DB 等の実行時生成物）、`frontend/dist/`（frontend build）、`frontend/node_modules/`、`tmp/`（一時作業ファイル）。

## セットアップ

必要なもの: Rust（stable、edition 2024）、Node.js、pnpm、mise。

```bash
mise run frontend:install
```

## 実行

```bash
mise run dev        # backend と Vite dev server を並列起動
mise run build      # backend と frontend の build
mise run verify     # 全 lint + 全テスト（失敗時は非0で終了）
mise tasks          # タスク一覧
```

backend は環境別の `configs/<env>/`（`dev` / `stg` / `prod`）の3ファイル（`app.toml`・`auth.toml`・`mcp.toml`）を読む。環境は `--config-dir configs/<env>`（または環境変数 `BUDGET_BOOK_CONFIG_DIR`、デフォルト `configs/dev`）で選ぶ。port 固定割当（ユーザー承認済み）: dev backend=40280・Vite dev=40281・stg backend=40282・prod backend=40283。外部公開は stg が `https://kakeiboot-stg.scioj.com`・prod が `https://kakeiboot.scioj.com`（cf-tunnel → 各 backend port）。
