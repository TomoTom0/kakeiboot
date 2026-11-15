# docs 索引

docs 配下の恒久文書（仕様・運用手順・索引・参照資料・changelog）の索引。実態と常に一致させる。作業履歴・経緯は docs に置かない（`tmp/tasks/tm-<id>/` と tm タスクの body に記録する）。

## 配置規則

- docs 直下は README.md のみとし、文書は用途別のディレクトリに置く
- `usage/`: 利用者向け
- `spec/`: 仕様
- `ops/`: 運用
- `dev/`: 開発

## usage

| ファイル | 目的 | 正本となる範囲 |
|---|---|---|
| [usage/README.md](usage/README.md) | 利用者向け文書の索引（開発者向け） | トピック一覧と読む順、本文の書き方、ファイル形式（frontmatter・`usage:*` fenced block）、機能追加時の更新運用 |
| [usage/usage_getting-started.md](usage/usage_getting-started.md) | はじめに | 概要、アカウント登録、ログイン、既定の家計簿 |
| [usage/usage_connect.md](usage/usage_connect.md) | ChatGPT に接続 | 接続手順、許可する内容、90日の期限、接続の管理 |
| [usage/usage_send-receipt.md](usage/usage_send-receipt.md) | レシートを送る | 写真の送付（複数枚を含む）、会話での確認・修正・登録・破棄 |
| [usage/usage_browse.md](usage/usage_browse.md) | 支出を見る | 閲覧画面の見方、期間の切替、詳細、絞り込み、検索 |
| [usage/usage_edit-receipt.md](usage/usage_edit-receipt.md) | レシートを修正する | 修正・削除・復元、ラベルの付け外し |
| [usage/usage_manage-catalog.md](usage/usage_manage-catalog.md) | カテゴリ・店・ラベルを管理する | 名前の管理、アーカイブ、店の統合 |
| [usage/usage_share-ledger.md](usage/usage_share-ledger.md) | 家計簿を共有する | 家計簿の切替・名前の変更、権限、共有 URL、登録の招待 |
| [usage/usage_export-import.md](usage/usage_export-import.md) | 書き出しと取り込み | 書き出し・取り込みの手順、含まれないもの |
| [usage/usage_passkey.md](usage/usage_passkey.md) | パスキー | 追加・名前の変更・削除、機種変更、紛失時の再登録 |

## spec

| ファイル | 目的 | 正本となる範囲 |
|---|---|---|
| [spec/spec_data-model.md](spec/spec_data-model.md) | データモデル（SQLite）の仕様 | テーブル構成と制約、DDL、ledger スコープと越境防止、draft のライフサイクル・作成手順（画像は届いた時だけ保存）・承認トランザクション・冪等性、receipts.source の決定規則、画像アクセス token の保存、TTL 掃除、金額・税換算・端数処理、日時・ID 方針、検索（FTS5 trigram + LIKE フォールバック）と集計（v_item_facts）、カテゴリ初期セット、家計簿の利用者別表示色（ledger_members.color）と ledger 名の変更（個人 ledger 名 default book・web/MCP からの改名と制約）、レシートラベル（ledger_labels / receipt_labels の固定5色・任意タイトル・付け外しの差分規則と audit・draft の作成時指定 label_colors の承認時引き継ぎ）、一括作成の draft（drafts.batch_id）、データの書き出し・取り込み（ledger 単位の export/import の位置づけ・audit action）、認証系テーブルの構造と保存規則 |
| [spec/spec_auth.md](spec/spec_auth.md) | 認証・認可の仕様 | 全体構成（RP / 認可サーバー / リソースサーバー）、パスキー登録・ログイン・step-up・回復（CLI 発行の再登録 URL）、web セッションと CSRF 対策、web 認証 API（me の default_ledger_id を含む）、OAuth 2.1 認可サーバー（エンドポイント、CIMD、private_key_jwt、PKCE、resource / iss、同意、scope と tool の対応、有効期限と refresh rotation、不正検知時の失効規則）、MCP リソースサーバー（Bearer 検証、匿名例外 request_recovery と実装ゲート、AuthContext 解決順、stateless セッション）、ledger 切替と未選択時の扱い、アカウント特定と回復依頼の処理・rate limit、運用者 CLI と確認規則、セキュリティ規則（rate limit、ログのマスク、configs/<env>/auth.toml）、シーケンス、TASK-7 実機確認の前提（認証まわり）。テーブル構造は spec/spec_data-model.md、tool の入出力は spec/spec_mcp-tools.md を正とする |
| [spec/spec_mcp-tools.md](spec/spec_mcp-tools.md) | MCP tool・widget の仕様 | tool 一覧（可視性・annotations・scope・securitySchemes）、各 tool の入出力（draft payload の serde 型・draft 段階のラベル指定〔payload.label_colors〕、whoami / list_ledgers / switch_ledger / rename_ledger / request_recovery / label_receipts / 一括の create_receipt_drafts・approve_receipt_drafts / widget 専用 refresh_widget_images を含む）、isError 規則、画像の扱いと draft の画像状態の遷移、重複検知、tool description の方針、集計 report（ラベル絞り込みを含む）、widget（画面 view・draft_batch・callTool・画像表示・XSS 対策・CSP）、web 画面とのサービス層共有（web API・データの書き出し・取り込み（設定データtab・export ファイル形式 version 1・[data_io] 上限）・画面骨格・閲覧系の階層ドリル（カテゴリ/店の詳細ページ・クロス集計・レシート明細からのリンク・slide 遷移）・使い方ページ・レシート連続フィード・管理ラベルの表示規則（LabelChip・付与/絞り込み popover・管理画面）と絞り込み・検索画面（/search・topbar 検索チップ）・アプリ名 kakeiboot とロゴ・家計簿表示色）、プロンプトインジェクション対策、TASK-7 実機確認の前提（tool・widget） |

## ops

| ファイル | 目的 | 正本となる範囲 |
|---|---|---|
| [ops/ops_deploy.md](ops/ops_deploy.md) | stg・prod 運用環境の構成と運用操作（miseタスク・`scripts/deploy/kakeiboot_ops.py`） | 運用dir・systemd unit・portの構成（healthz portは `configs/<env>/app.toml` が正本）、deploy先の設定（configs/deploy.toml: deploy_root・transport〔ssh/local・TASK-118〕・runtime_host・local override）、運用操作の仕組み（transport切替・ssh実行形・dry-run直接実行）、deploy（`stg:deploy`: build → rsync → restart・healthz確認。対象・除外含む）、promote（`prod:promote`: stg運用dirの検証済み成果物をprodへ配布。stg前段チェック・sha256表示・configs乖離preview・旧成果物の `releases/` 退避とrollback手順 [TASK-189]）、configs配布（`prod:configs`: repo configs/prod → prod運用dir。restart不含・`--preview` で差分確認）、admin CLI（`exec-stg` / `exec-prod`）、service操作（`stg:service` / `prod:service`）、backup unitのrender配布（`.in` 正本の `{{deploy_root}}` 置換と `units:install` による user config dirへの配布・scriptのpath相対導出 [TASK-119]）、データの所在とbackup・復元（WAL 運用の注意・online backup・復元手順・web の書き出し/取り込みとの責務分離・timer による自動 backup と世代管理 [TASK-83]）、prodの運用、linger によるマシン起動時の自動起動 |

## dev

| ファイル | 目的 | 正本となる範囲 |
|---|---|---|
| [dev/dev_setup.md](dev/dev_setup.md) | 開発環境の構成と実行手順 | repo の構成、生成物の集約先、セットアップ、実行、環境別 configs の選択、port 割当、外部公開 URL、backend/migrations コメントの旧 docs パスの扱い |
