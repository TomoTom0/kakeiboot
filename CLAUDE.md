# budget-book

MCP経由（ChatGPT等）での操作・閲覧を主とし、web画面を補助とする家計簿webapp。

## 技術スタック

- backend: Rust（axum / rmcp / sqlx / webauthn-rs）+ SQLite
- frontend: TypeScript + Vite + Vue + Pinia（pnpm）。ログイン・登録、補助操作画面、MCP widget
- 認証: パスキー（WebAuthn）。backendがRelying Party兼OAuth 2.1認可サーバー（MCPクライアント向け）を担う
- OAuth: クライアント登録はCIMD（chatgpt.comのみallowlist）、トークンはopaque+DB保存（hash）、refresh tokenはrotation。PKCE(S256)・resource/aud検証・Bearer検証は自前実装（rmcpは未提供）
- 画像: WebPに圧縮しファイルシステムへ保存、DBにはパスとメタ情報。デコード・向き補正・リサイズはimage crate、lossyエンコードはwebp crate（libwebp）。変換前にEXIFを抽出する

## 要件上の前提

- レシートのOCRはChatGPT側で行う。画像内座標はおおよそでよい
- 画像はChatGPTに貼る1回で取り込む（`openai/fileParams`）。別途の手動画像アップロードや会話内での貼り直しをユーザーに求めない
- 画像は届いた時だけ保存する。届かない場合（スマホアプリで `"chat_upload"` 文字列のみ届く openai-apps-sdk-examples#185、画像引数キーの欠落#237等）は特別な処理をせず画像なしで扱う（再試行の促し・既存draftへの連結・重複統合はしない）
- draftとメタデータは最初のtool呼び出しで必ずstagingに保存する
- 元ファイル名・撮影日時等の画像メタデータは、画像本体の成否に関わらずdraft作成の最初のtool呼び出しで渡させる。ただしschema上はnullableとし、値の出所（モデル申告 / 画像EXIF）を記録する。EXIFが取れた場合はEXIFを正とする
- 画像取得の`download_url`はhost allowlist・サイズ上限・redirect非追従で取得する（SSRF対策）
- 主な利用環境はChatGPTスマホアプリ（web/desktopも使用）
- 利用者は開発者（運用者）が直接知っている範囲（本人・家族・知人）。パスキー紛失時は運用者が帯域外で本人確認し、CLIで再登録URLを発行する
- 会話内での修正指示・承認は可
- 画像入力はstaging（一時DB）に保存し、修正・承認後に本DBへ確定する

## 運用

- stg・prodの操作はmiseタスクで行う（作業repoのどこからでも、運用dirへのcd不要）: deployは `mise run stg:deploy` / `prod:deploy`、admin CLIは `mise run stg:admin -- user list` 等、service操作は `mise run stg:service -- status` 等（prodも同様）。実serverは /srv/opt/tomo/run/app/tool/kakeiboot/{stg,prod} の systemd user service（kakeiboot-stg/prod）。作業repoでのserver起動は dev（dev:backend・dev:frontend）まで。詳細は docs/deploy.md
