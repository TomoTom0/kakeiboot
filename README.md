# kakeiboot

ChatGPT や Claude にレシート画像を渡して記録し、会話で修正・承認して、web 画面で閲覧・管理する家計簿。

## できること

- ChatGPT に貼ったレシート画像から、下書きを作って記録する（複数枚の一括作成を含む）
- 会話や ChatGPT 内の widget で、下書きを修正・承認して確定する
- 記録したレシートの検索・修正・削除と、支出の集計を会話で行う
- web 画面で、集計、カテゴリ・店ごとの詳細、レシート一覧、検索を閲覧する
- レシートに色ラベルを付けて、分類・絞り込みをする
- 家計簿を複数持ち、他の利用者と共有する
- 家計簿をファイルへ書き出し、取り込む
- パスキーでログインし、ChatGPT・Claude との接続を web 画面で管理する

## 使い始め方

利用は招待制で、運用者の知人の範囲に限る。招待 URL からパスキーを登録し、ログイン後に web 画面の `/usage` の手順で ChatGPT・Claude へ接続する。

## 開発

必要なもの: Rust（stable、edition 2024）、Node.js、pnpm、mise。

```bash
mise run frontend:install
mise run dev
mise run verify
```

詳細は [docs/dev/dev_setup.md](docs/dev/dev_setup.md)、文書の索引は [docs/README.md](docs/README.md)、使い方の本文の正本は [docs/usage/README.md](docs/usage/README.md) を参照。
