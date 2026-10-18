# docs 索引

docs 配下の恒久文書（仕様・運用手順・索引・参照資料・changelog）の索引。実態と常に一致させる。作業履歴・経緯は docs に置かない（`tmp/tasks/tm-<id>/` と tm タスクの body に記録する）。

## 文書一覧

| ファイル | 目的 | 正本となる範囲 |
|---|---|---|
| [spec_data-model.md](spec_data-model.md) | データモデル（SQLite）の仕様 | テーブル構成と制約、DDL、ledger スコープと越境防止、draft のライフサイクル・作成手順（画像は届いた時だけ保存）・承認トランザクション・冪等性、receipts.source の決定規則、画像アクセス token の保存、TTL 掃除、金額・税換算・端数処理、日時・ID 方針、検索（FTS5 trigram + LIKE フォールバック）と集計（v_item_facts）、カテゴリ初期セット、家計簿の利用者別表示色（ledger_members.color）と個人 ledger 名 default book、レシートラベル（ledger_labels / receipt_labels の固定5色・任意タイトル・付け外しの差分規則と audit）、一括作成の draft（drafts.batch_id）、認証系テーブルの構造と保存規則 |
| [spec_auth.md](spec_auth.md) | 認証・認可の仕様 | 全体構成（RP / 認可サーバー / リソースサーバー）、パスキー登録・ログイン・step-up・回復（CLI 発行の再登録 URL）、web セッションと CSRF 対策、web 認証 API（me の default_ledger_id を含む）、OAuth 2.1 認可サーバー（エンドポイント、CIMD、private_key_jwt、PKCE、resource / iss、同意、scope と tool の対応、有効期限と refresh rotation、不正検知時の失効規則）、MCP リソースサーバー（Bearer 検証、匿名例外 request_recovery と実装ゲート、AuthContext 解決順、stateless セッション）、ledger 切替と未選択時の扱い、アカウント特定と回復依頼の処理・rate limit、運用者 CLI と確認規則、セキュリティ規則（rate limit、ログのマスク、configs/<env>/auth.toml）、シーケンス、TASK-7 実機確認の前提（認証まわり）。テーブル構造は spec_data-model.md、tool の入出力は spec_mcp-tools.md を正とする |
| [spec_mcp-tools.md](spec_mcp-tools.md) | MCP tool・widget の仕様 | tool 一覧（可視性・annotations・scope・securitySchemes）、各 tool の入出力（draft payload の serde 型、whoami / list_ledgers / switch_ledger / request_recovery / label_receipts / 一括の create_receipt_drafts・approve_receipt_drafts / widget 専用 refresh_widget_images を含む）、isError 規則、画像の扱いと draft の画像状態の遷移、重複検知、tool description の方針、集計 report（ラベル絞り込みを含む）、widget（画面 view・draft_batch・callTool・画像表示・XSS 対策・CSP）、web 画面とのサービス層共有（web API・画面骨格・閲覧系の階層ドリル（カテゴリ/店の詳細ページ・クロス集計・レシート明細からのリンク・slide 遷移）・使い方ページ・レシート連続フィード・管理ラベルの表示規則（LabelChip・付与/絞り込み popover・管理画面）と絞り込み・検索画面（/search・topbar 検索チップ）・アプリ名 kakeiboot とロゴ・家計簿表示色）、プロンプトインジェクション対策、TASK-7 実機確認の前提（tool・widget） |
| [deploy.md](deploy.md) | stg・prod 運用環境の構成とmiseタスクによる運用操作 | 運用dir・systemd unit・portの構成、deploy（`stg:deploy` / `prod:deploy`: build → rsync → restart・healthz確認。対象・除外含む）、admin CLI（`stg:admin` / `prod:admin`）、service操作（`stg:service` / `prod:service`）、prodの運用、linger によるマシン起動時の自動起動 |
