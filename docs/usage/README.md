# usage 索引

kakeiboot の利用者向け文書の索引（開発者向け）。各トピックの本文は、build 時に frontend へ取り込んで web 画面の `/usage/*` に表示する正本である（TASK-141。取り込みは `frontend/src/build/usage-docs.ts`）。

この README は web へ取り込まない。

## トピック

読む順に並べる。`order` は各ファイルの frontmatter と一致させる。

| order | ファイル | 内容 |
|---|---|---|
| 1 | [usage_getting-started.md](usage_getting-started.md) | kakeiboot の概要、登録、ログイン、既定の家計簿 |
| 2 | [usage_connect.md](usage_connect.md) | ChatGPT への接続、許可する内容、90日の期限、接続の管理 |
| 3 | [usage_send-receipt.md](usage_send-receipt.md) | レシートの送付（複数枚を含む）、内容の確認と修正、登録、破棄 |
| 4 | [usage_browse.md](usage_browse.md) | ホーム・レシート・カテゴリ・店の見方、期間の切替、詳細、検索 |
| 5 | [usage_edit-receipt.md](usage_edit-receipt.md) | レシートの修正・削除・復元、ラベルの付け外し |
| 6 | [usage_manage-catalog.md](usage_manage-catalog.md) | カテゴリ・店・ラベルの管理、店の統合 |
| 7 | [usage_share-ledger.md](usage_share-ledger.md) | 家計簿の切替と名前の変更、共有 URL、登録の招待 |
| 8 | [usage_export-import.md](usage_export-import.md) | 家計簿の書き出しと取り込み、含まれないもの |
| 9 | [usage_passkey.md](usage_passkey.md) | パスキーの追加・名前の変更・削除、機種変更、紛失時 |

## 書き方

- 読者は開発知識のない家族・知人で、主にスマホで読む。短い手順で書き、専門語を使わない
- 操作名は画面の表記をそのまま引用する
- 実装済みの機能だけを書く。今後の予定は書かない。トラブル対処は独立させず該当トピックに書く
- レシート写真の貼り直しや再試行を促さない。写真が届かない場合は、写真なしで記録される事実だけを書く
- 秘密情報、運用者の個人連絡先、実 domain を書かない（本文は web の bundle に含まれ、ログイン前でも配信される）
- 「招待」は登録の招待にだけ使い、家計簿への参加は「共有」と呼ぶ

## ファイル形式

- 先頭の frontmatter に `title`・`summary`・`order` を書く
- ファイル名の `usage_<topic>` の `<topic>` が `/usage/<topic>` の slug になる
- トピック間のリンクは相対パス（`usage_connect.md`）、アプリ画面へのリンクは route の絶対パス（`/apps`）で書く
- スクリーンショットは `frontend/src/web/assets/usage/` への相対パスで参照し、title を図の caption にする
- 画面に部品を置く箇所は次の fenced block で書く

| block | 内容 |
|---|---|
| `usage:connect-url` | 接続 URL とコピー button。値は書かない |
| `usage:connect-flow` | 接続の流れの模式図。本文は `caption:` |
| `usage:figure-pending` | 撮影待ちの図。本文は `id:`・`caption:`・`note:` |

## 運用

- 利用者が触れる機能を追加・変更したら、該当トピックを同じ変更で更新する。該当するトピックがなければ、ファイルを追加して上の表へ登録する
- 許可する内容の説明は backend の `scope_description`、「90日」は `configs/<env>/auth.toml` の `grant_absolute_days` が正本で、変更時は本文も合わせる
- 操作名の正本は frontend のテンプレートで、docs/usage とは機械同期しない。変更に気付いた時点で本文を直す
