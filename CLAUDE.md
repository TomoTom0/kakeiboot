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

## UI設計原則

- UIは構造とメリハリ（方向・長さ・色・符号・位置）で表現する。UIを説明する文字ラベル（内容を説明する見出し・補足文・動詞toggle・実装の分岐名）を置かない。画面に残る語はデータ名（品目・店名等）と操作名（寸法切替等）と比較基準の文脈語（前月比等）のみ
- zone見出しはデータ名として可視化できる。説明文・動詞・分岐名は不可
- 増減・差分は符号+色+長さ（bar）で表す。動詞の過去形（増えた/減った等）や分岐の名前（新しく増えた等）をUI部品のラベル・見出しに使わない。動詞は生成文コンテンツ内のみで成立する
- すべての遷移・状態変化にアニメーションを伴わせる（画面遷移・期間移動・mode切替・絞り込み・開閉等、可視状態が変わるすべて）。内容が即時入れ替わるだけの変化を作らない。遷移表現も共通component・視覚文法で統一する
- 表現物ごとに専用の視覚componentを作る。汎用text部品にdataを流し込んで語で補完する構成を取らない
- 同種の表現は一つの共通componentと視覚文法で実装し、設置箇所（画面・行内・widget等）ごとの個別実装や文法分岐をしない。同種のbar・図形が既にあるのに別実装で増えることを許容しない。既存箇所への追加・変更も共通componentの拡張で担う
- 機能・表現物は要件由来（ユーザーの指示・指摘・承認）を確認してから作る。設計sessionが過去会話の「復元した指示系列」等から新機能を立ち上げない。設計reviewには出自確認を含める

## 運用

- stg・prodの操作はmiseタスクで行う（作業repoのどこからでも、運用dirへのcd不要）: deployは `mise run stg:deploy`（stgのみ。prod直接deployは無い）、prodへの成果物配布は `mise run prod:promote`（stg運用dirの検証済み現物を配布）、configs配布は `mise run prod:configs`、admin CLIは `mise run exec-stg -- admin user list` 等、service操作は `mise run stg:service -- status` 等（prodも同様）。タスクは処理本体 `scripts/deploy/kakeiboot_ops.py` のthin wrapperで、configs/deploy.toml の `transport` に従い運用機 gt430 へssh経由で実行する（gt430にrepo checkout・git操作は置かない）。実serverは configs/deploy.toml（deploy_root）配下の stg/prod 運用dir上の systemd システムサービス（kakeiboot-stg/prod、/etc/systemd/system/、User=muse-agent。backup 用の kakeiboot-backup@ だけが user service）。作業repoでのserver起動は dev（dev:backend・dev:frontend）まで。詳細は docs/ops/ops_deploy.md

## タスク運用

- 実装が完了した時点（全verify pass・stg反映）で元タスクをfinishする。ユーザー実機確認待ちのためにタスクをwipのまま駐車させ続けない。実機確認・検証は別タスクを起票してまとめて行い、元タスク番号で紐づける（不具合発見時に元タスクへ戻って参照・reviveできる）
