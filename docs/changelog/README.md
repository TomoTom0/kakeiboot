# Changelog

kakeiboot の全バージョンの変更履歴です。利用者に見える変更を中心に記録します。作業履歴・経緯はここに置きません（タスク管理に記録します）。

## 構成

```
docs/changelog/
├── README.md       # このファイル（索引と運用規則）
├── unreleased.md   # 次期バージョン（未リリース）の変更
└── v0.1.0.md       # バージョン 0.1.0 の変更
```

## バージョン一覧

- [unreleased.md](unreleased.md) - 次期バージョン（未リリース）
- **[v0.1.0](v0.1.0.md)** - **現在のバージョン**（`Cargo.toml` / `frontend/package.json` の `version = "0.1.0"`）

## 書き方

- 1バージョン1ファイルとし、ファイル名は `v<version>.md` とする
- 各ファイルの見出しは `# v<version> (YYYY-MM-DD)`（日付はリリース日）とし、区分は次の見出しを使う。該当する変更がない区分は版別ファイルでは省略する
  - `New Features` / `Bug Fixes` / `Changes` / `Performance` / `Refactoring` / `Repository Management` / `Internal Improvements` / `Known Issues`
- 変更はまず `unreleased.md` に追記する。利用者が触れる機能の追加・変更は、該当する `docs/usage/` トピックの更新と同じ変更で記録する
- 事実だけを書く。実装していない予定は書かない

## リリース時の手順

1. `unreleased.md` の内容を `v<version>.md` へ移し、見出しにリリース日を付ける
2. バージョンを上げる（`Cargo.toml` と `frontend/package.json` の `version`）
3. `unreleased.md` を空のテンプレートに戻す
4. このファイルのバージョン一覧へ新しい版を追加し、最新の版に印を移す
