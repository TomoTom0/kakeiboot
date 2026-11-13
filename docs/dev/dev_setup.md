# 開発環境

開発者向けの構成と実行手順。stg・prod の運用操作は [ops/ops_deploy.md](../ops/ops_deploy.md)、文書の索引は [docs/README.md](../README.md)、テスト構成は [tests/README.md](../../tests/README.md) を参照。

## 構成

| パス | 内容 |
|---|---|
| `Cargo.toml` | Cargo workspace（member: `backend`） |
| `backend/` | Rust backend（axum + rmcp + sqlx/SQLite）。`src/`、`tests/`、`migrations/` |
| `frontend/` | Vite + Vue 3 + Pinia + TypeScript（pnpm）。エントリは `web.html`（web 画面）と `widget.html`（MCP widget） |
| `assets/` | README 用の画面画像（`img/shot_home.png`・`img/shot_receipt.png`。`frontend/tests/browser/capture.readme.spec.ts` が showcase seed から配置） |
| `configs/` | 設定の単一管理元（環境別 `configs/<env>/` の `app.toml`・`auth.toml`・`mcp.toml` と、deploy 先の `deploy.toml`）。port・パス・タイムアウト等はここで管理し、コードに直書きしない |
| `docs/` | 恒久文書（利用者向け・仕様・運用・開発）。`docs/usage/` は web 画面の使い方の本文の正本 |
| `tests/` | テスト構成の索引と条件書 |
| `scripts/` | 補助スクリプト |
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

## 環境別 configs

backend は環境別の `configs/<env>/`（`dev` / `stg` / `prod`）の3ファイル（`app.toml`・`auth.toml`・`mcp.toml`）を読む。環境は `--config-dir configs/<env>`（または環境変数 `BUDGET_BOOK_CONFIG_DIR`、デフォルト `configs/dev`）で選ぶ。

## port 割当

ユーザー承認済みの固定割当。

| 用途 | port |
|---|---|
| dev backend | 40280 |
| Vite dev | 40281 |
| stg backend | 40282 |
| prod backend | 40283 |

## 外部公開 URL

cf-tunnel から各 backend port へ接続する。

| 環境 | URL |
|---|---|
| stg | `https://kakeiboot-stg.scioj.com` |
| prod | `https://kakeiboot.scioj.com` |

## migrations のコメント

`backend/migrations/*.sql` のコメントは適用済み checksum を保持するため旧 docs パスのまま残している。新パスは `docs/spec/`。
