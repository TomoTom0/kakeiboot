# scripts 索引

開発・検証用スクリプトの索引。実態と常に一致させる。実行は `uv run --no-project python scripts/...`（python を直接起動しない）。

## 一覧

| スクリプト | 目的 |
|---|---|
| `scripts/design/verify-conditions.py` | テスト設計条件書（`tests/design/conditions.toml`）の機械検査。covers タグと条件 id の対応・網羅・schema 健全性・`[[excluded]]` 構造を検査し、`source_lines`（タグの実在位置）を同期する（唯一の書き込み）。詳細は test-structure skill |
