# tests 索引

テスト構成の索引。実態と常に一致させる。テストコードは各コンポーネントの慣習に従い、backend は `backend/`、frontend は `frontend/tests/` に置く。テスト設計条件書（`tests/design/conditions.toml`）がテスト内容の正本であり、各テストは `[covers:<id>]` タグで条件に紐付く。

## 実行方法

| コマンド | 内容 |
|---|---|
| `mise run verify` | 全 lint + 全テスト。失敗時は非0で終了する |
| `mise run test` | backend と frontend の全テスト |
| `mise run backend:test` | `cargo test --workspace` |
| `mise run frontend:test` | `vitest run`（frontend/） |
| `mise run lint` | rustfmt check、clippy（`-D warnings`）、ESLint、vue-tsc |
| `uv run --no-project python scripts/design/verify-conditions.py` | 条件書の機械検査（covers タグ対応・網羅・schema・source_lines 同期） |

## テスト設計条件書（tests/design/）

- `tests/design/conditions.toml` — 条件書（単一ファイルに全領域の条件を置く運用。feature 名とファイル stem は一致しない）。TASK-8 分は `docs/spec_data-model.md`、TASK-10 Phase A 分（auth-config / auth-invitation / auth-cli / auth-login / auth-passkey 等）と Phase B 分（auth-oauth / auth-mcp / auth-ledger / auth-ratelimit / auth-cleanup）は `docs/spec_auth.md` から抽出した条件が正本。TASK-11 widget 分（`widget.*`）は `docs/spec_mcp-tools.md` §11（§3-2・§6・§7・§10 の I/O を含む）から抽出した条件が正本。TASK-11 web 画面分（`web-*`）は `docs/spec_auth.md`（§2・§3・§4-2・§4-6・§4-11・§6）と `docs/spec_mcp-tools.md`（§7-8〜7-14・§11-6・§12・§13）、`docs/spec_data-model.md` §5 から抽出した条件が正本（統合後は web-data-api 条件が backend の REST adapter 実機検証、画面部品はモック DataApi で検証）。TASK-11 backend tool 分（`mcp-tools.*` ほか `mcp-account` / `mcp-catalog` / `mcp-stats` / `mcp-widget` / `mcp-registry` / `mcp-result` / `mcp-image` / `mcp-draft` / `mcp-search`）は `docs/spec_mcp-tools.md` §2〜§10・§11-1 と `docs/spec_auth.md` §5-3・§6-2・§7-4 から抽出した条件が正本（実 `/mcp` ルート経由の結合テストと src 内単体で検証）。TASK-16（家計簿表示色・default book・画面骨格・レシート連続フィード・ロゴ）、TASK-17（ラベル）、TASK-18（`mcp-draft-batch` / `mcp-approve-batch` / `mcp-config` / `widget.*` の draft_batch）分は同じ3仕様の該当節（spec_data-model §4・§6-4・§7・§15、spec_auth §3-2、spec_mcp-tools §7-21〜7-23・§11-2・§12）から抽出した条件が正本で、既存 feature に条件を追加している。検証は `scripts/design/verify-conditions.py`（test-structure skill 準拠、`source_lines` の自動同期のみ書き込み）。

## テスト一覧

| 場所 | 種別 | 対象 |
|---|---|---|
| `backend/src/config.rs`（`mod tests`） | 単体 | `configs/dev/app.toml` と `configs/dev/auth.toml` の parse・検証（未知キー拒否、必須セクション欠落、`mcp.path`・`allowed_hosts` の検証、auth の rp_id/origin 一致・resource 導出・issuer 一致・profile 欠落、相対パスの project root 基準解決、ファイル欠落時のエラー） |
| `backend/src/auth/tokens.rs`（`mod tests`） | 単体 | アカウント番号の生成（Crockford 形式・正規化）、base64url codec（RFC 4648 ベクトル・往復）、UA 由来の既定ラベル、hex |
| `backend/src/admin.rs`（`mod tests`） | 単体 | 運用者 CLI の引数検証（setup の --note 必須・recovery の --user 必須・invite 拒否・--ttl parse）、JST 日時フォーマット |
| `backend/src/auth/oauth/cimd.rs`（`mod tests`） | 単体 | CIMD の client_id 静的検証・dev loopback 緩和・文書検証・client_secret 系フィールドの拒否 |
| `backend/src/auth/oauth/net.rs`（`mod tests`） | 単体 | Cache-Control max-age の parse と clamp、禁止 IP の分類、URL host の制限 |
| `backend/src/ratelimit.rs`（`mod tests`） | 単体 | rate limit の窓と Retry-After、分境界での二重バースト防止、token 受理失敗のブロック、信頼時のみの CF-Connecting-IP 採用 |
| `backend/src/maintenance.rs`（`mod tests`） | 単体 | TTL 掃除の JST cutoff 表記 |
| `backend/src/domain/actor.rs`（`mod tests`） | 単体 | Actor 種別と audit の actor_kind の対応 |
| `backend/src/domain/drafts.rs`（`mod tests`） | 単体 | draft payload の検証（問題の列挙）と patch 規則 |
| `backend/src/domain/images.rs`（`mod tests`） | 単体 | 画像取得 URL の規則、Content-Disposition のファイル名、画素数上限、デコードゲート（同時数上限・期限・1件版用の枠確保） |
| `backend/src/domain/labels.rs`（`mod tests`） | 単体 | ラベル色 `LABEL_COLORS` の正規順 |
| `backend/src/domain/search.rs`（`mod tests`） | 単体 | 検索 cursor の往復 |
| `backend/src/domain/stats.rs`（`mod tests`） | 単体 | 集計期間と前期比較の算出 |
| `backend/src/domain/util.rs`（`mod tests`） | 単体 | LIKE エスケープ規則と日付ヘルパ |
| `backend/src/mcp/auth.rs`（`mod tests`） | 単体 | Bearer ヘッダの厳格解析、scope 不足時の _meta challenge、401 ヘッダ形状 |
| `backend/src/mcp/file_arg.rs`（`mod tests`） | 単体 | FileArg の寛容な分類（chat_upload 文字列等） |
| `backend/src/mcp/registry.rs`（`mod tests`） | 単体 | tool descriptor が tool 一覧表に従うこと、一括 tool の schema 形状 |
| `backend/src/mcp/result.rs`（`mod tests`） | 単体 | envelope と ledger の content text |
| `backend/src/mcp/tools/account.rs`（`mod tests`） | 単体 | switch_ledger の応答形状と role 表記 |
| `backend/src/mcp/tools/catalog.rs`（`mod tests`） | 単体 | manage_store の category 三値（指定・null 解除・省略）、get_catalog の include 値 |
| `backend/src/mcp/tools/stats.rs`（`mod tests`） | 単体 | summarize_spending の要約 text と _meta ゲート、既定期間 |
| `backend/src/mcp/tools/widget.rs`（`mod tests`） | 単体 | refresh_widget_images の ref キー |
| `backend/tests/config_load.rs` | 結合 | リポジトリの実 `configs/`（app.toml + auth.toml）の読込、全環境の mcp.toml の一括 tool 用キーと起動時検証、`port = 40280` 固定割り当て（ユーザー承認済み 40280-40284 範囲）の検証、config dir の解決順、port 0 で OS 自動割当の bind |
| `backend/tests/healthz.rs` | 結合 | `/healthz`（Router oneshot・実 TCP）、DB 停止時の 503、SQLite ファイル作成と migration 適用 |
| `backend/tests/mcp_ping.rs` | 結合 | `/mcp`（Streamable HTTP、stateless、JSON 応答）の initialize・tools/list・tools/call `ping`（Bearer 必須化後は grant + access token を直接投入）、許可外 Host の拒否、Authorization なし/未知 token の 401 と WWW-Authenticate。port は OS 自動割当 |
| `backend/tests/auth_register.rs` | 結合 | 登録フロー（setup / invite / recovery）: token 検証（未知・期限切れ・使用済み・無効化 user・display_name 規則）、受付画面用 info API、residentKey=required 上書き、kind 別完了 tx（user・個人 ledger・seed・招待参加と系譜・recovery は session 全失効）、招待と ceremony の 1 回限り、ceremony 期限、UA 既定ラベル、excludeCredentials |
| `backend/tests/auth_login_session.rs` | 結合 | discoverable ログイン（成功・不一致 401 と audit・無効化 user・counter 逆行と audit・passkey_json/last_used 更新・持込み session cookie の失効・req の authz_request_hash 保存）、web session（cookie 属性・idle/absolute/revoked/disabled の拒否・last_seen の 5 分 throttling・me・logout / logout-all）、CSRF（Origin 強制・JSON Content-Type 強制） |
| `backend/tests/auth_passkeys.rs` | 結合 | パスキー管理（一覧の session 必須・追加の step-up 必須・追加完了・改名・最後の 1 本 409・削除の step-up 必須）、step-up 再認証（auth_at 更新・他 user のパスキー拒否・ceremony user 不一致 403）、web からの招待発行（owner と step-up・role 検証） |
| `backend/tests/admin_cli.rs` | 結合 | 運用者 CLI Phase A（user list の検索軸・user show の系譜と一覧、recovery 発行の表示名再入力・--yes、token revoke の prefix 識別、passkey revoke の最後の 1 本規則、user disable の再入力と grant/session 失効、audit への actor_kind=system 記録と token 平文不在、recovery は user につき 1 本） |
| `backend/tests/oauth_flow.rs` | 結合 | OAuth 2.1 メタデータ（AS・protected-resource 両パス・openid-configuration 404・Cache-Control）、/oauth/authorize（ログイン状態別の redirect・不正 client/redirect_uri の 400 エラー画面・パラメータ別の error redirect + state + iss・重複パラメータ）、同意 API（session/user バインディング・404・payload 形状）、decision POST（allow の code 発行 60 秒・grant_id NULL・deny の access_denied・Origin 強制・他 user の req 400）。CIMD/JWKS はローカルモック HTTP サーバ |
| `backend/tests/oauth_token.rs` | 結合 | 認可コード交換（応答形状・no-store・PKCE 成功/不一致/形式違反での code 消費・code 再利用で code_reuse 失効の COMMIT 後観測・期限切れ/redirect_uri・resource 不一致/無効化 user・superseded と active_ledger 引継ぎ・grant_create audit・初期 ledger 解決）、client 認証（none 方式・private_key_jwt・claim 別の拒否・jti 単一使用・JWKS kid 不一致の 60 秒スロットルと再取得）、CIMD キャッシュ（TTL 内再取得なし・304 で文書保持・stale-if-error 24 時間）、safe_fetch（redirect/oversize/private 拒否）、/oauth/revoke（refresh・access 両方で grant 失効・未知 200・認証なし 401） |
| `backend/tests/oauth_refresh.rs` | 結合 | refresh rotation（初回 rotation の子ペア発行と used_at/child_hash・ledger 維持、60 秒猶予内の再発行で旧子と対の access 失効と child 差し替え、猶予超過・子使用済みで refresh_reuse 失効の COMMIT 後観測、scope の絞り込みと invalid_scope・grant 不変、未知/期限切れ/無効化/resource 不一致/client 不一致の invalid_grant と client_mismatch 失効） |
| `backend/tests/oauth_race.rs` | 結合 | token endpoint の並行競合（実 SQLite ファイル + 複数接続 pool、第三接続が書込ロックを握る中での BEGIN IMMEDIATE 競合と一方の失敗） |
| `backend/tests/mcp_auth.rs` | 結合 | MCP リソースサーバー（Authorization なし・複数・query token の 401 と WWW-Authenticate、未知/期限切れ/失効/resource 不一致/無効化 user の invalid_token、AuthContext が ping まで到達、ledger 未選択・所属外の通過、last_used_at の 5 分 throttling、params._meta の openai/subject hash 記録と 1 時間 throttling）、ledger service（list_ledgers・switch_ledger の tx/audit/非所属同一エラー・whoami）、接続中のアプリ API（一覧の active_ledger_name・削除の reason=user と token 失効・切替 API・他 user 404） |
| `backend/tests/mcp_tools_account.rs` | 結合 | TASK-11 tool 群のうちアカウント・サービス接続（tools/list の登録 tool 一式 + ping のマウントと _meta ペア、resources/list・read の widget テンプレート配信、whoami・list_ledgers・switch_ledger の envelope・grant 更新・audit・非所属同一エラー、refresh_widget_images の URL 発行と権限無し null・refs 上限、tool 失敗時も subject hash 記録） |
| `backend/tests/mcp_tools_catalog.rs` | 結合 | TASK-11 tool 群のうちカタログ・集計（get_catalog の既定 include・category_paths・store_query・不正 include、manage_category の親なし 2 段階 create・冪等・rename・archive・viewer 拒否、manage_store の空変更・before・category null 解除・他 ledger 404、summarize_spending の by_category・未分類・前期比較・不正 report・item_price_history の item_query 必須） |
| `backend/tests/mcp_tools_labels.rs` | 結合 | TASK-17 の label tool 群（label_receipts の一括追加/削除・スキップ・権限と入力エラー、search_receipts・summarize_spending の label_colors フィルタ） |
| `backend/tests/mcp_tools_drafts_batch.rs` | 結合 | TASK-18 の一括 tool（create_receipt_drafts の schema・権限・要素単位の rejected と上限超過・共通 batch_id・画像取得前の保存・file_id 共有画像と並列上限・期限後の画像不保存・重複規則、approve_receipt_drafts の要素別結果と ledger 分離、1件版 tool の挙動不変） |
| `backend/tests/rate_limit.rs` | 結合 | アプリ内 rate limit（/api/webauthn の 429 + Retry-After、/oauth/authorize の IP 別、/mcp の user 別と他 user への無影響、/oauth/token の client 別） |
| `backend/tests/web_data_api.rs` | 結合 | web 補助データ REST API と静的配信（session・ledger スコープの 401/同一 404/viewer 403、catalog ツリーの archived/children 整形、categories の create 冪等・name_conflict・archive、stores の一覧・before 付き更新・merge の別名登録と旧店削除、receipts の from/to/store/cursor・deleted_at・合計、revision 衝突の 409 と削除済み 409、削除の preview/confirm/restore、詳細の image_url 発行（/media/img/ 形式・hash 保存・削除済みは null）、家計簿メンバー色の変更 API（PUT /api/ledgers/{l}/membership/color）、ラベル API（定義一覧・タイトル更新・付け外し差分）と一覧・集計の label_colors 絞り込み・詳細の labels、SPA 配信の CSP/X-Frame-Options・immutable assets・予約パスの JSON 404・dist 無しでも API 稼働・ルートの favicon.svg 配信） |
| `backend/tests/web_media.rs` | 結合 | 画像配信 route GET /media/img/<token>（応答ヘッダ一式・ボディ一致・TTL 内再利用、配信時再検査の不通過: 期限切れ・未知 token・不正形式・user 無効化・所属喪失・レシート論理削除→draft 参照で復活→draft close で 404・ファイル不在はすべて 404、IP rate limit の 429 + Retry-After） |
| `backend/tests/admin_cli_phaseb.rs` | 結合 | 運用者 CLI Phase B（grant list/revoke の再入力と reason=admin・audit・token 失効・--all-of、session list/revoke の hash prefix 識別、recovery list/show の overflow 表示と候補根拠、resolve の token 発行・resolved 遷移・audit・候補外理由必須、reject の close_note と二重拒否、cleanup ループの起動時掃除） |
| `backend/tests/common/oauth.rs` | 補助 | OAuth テスト用: ローカル CIMD/JWKS モックサーバ（301/500/oversize 切替・etag 304・kid 差し替え・fetch カウンタ）、RSA クライアント署名（PKCS#1 鍵・claim override・署名破壊）、PKCE ペア、grant/access/refresh の直接投入 fixture、authorize→同意→decision→交換のフルフロー実行 |
| `backend/tests/db_schema.rs` | 結合 | migration 0000〜0010 の適合（適用・`foreign_key_check`）、ラベル表（seed トリガ・色列挙と Rust enum の一致・backfill・未知色と越境の拒否・UPDATE 禁止・ledger 削除の CASCADE）、drafts.batch_id と部分索引、users / ledger_members / 認証系（oauth_grants の選択中 ledger 越境防止、invitations の kind 整合、refresh token の used/child、recovery の status/closed、ceremony の後方参照 FK）、catalog（カテゴリ深さ・親の ledger 一致・ledger_id 不変・名前一意・自己参照、店・別名の越境）、images の出所整合、image_access_tokens / receipts / receipt_items の越境トリガと CHECK（値引の親・金額・bbox・不変列）、FTS 同期トリガ、v_item_facts（論理削除除外・大分類畳み込み）、audit の json_valid、レシート削除・復元の revision、ledger_members の color CHECK と 0008 の backfill・「default book」改名 |
| `backend/tests/db_drafts.rs` | 結合 | drafts の CHECK 群（status・closed_at 整合・approved 系・payload 必須・attached と image_id の同値・unavailable と理由・画像越境）、library 層の draft 操作（作成・修正の revision+1・画像確定 I3a/I3b・破棄）、承認トランザクション（receipts/receipt_items への展開・source 決定・冪等・レシート物理削除後の冪等 conflict・stale revision・conflict・role 検証・店名寄せ・user 指定店カテゴリの保護・カテゴリ解決と警告・bbox の `[number x4]` 配列往復・amount_incl 換算と差額寄せ・明細合計警告・値引のカテゴリ複写・audit 記録）、reopen（新 pending・元不変・audit・対象外 status 拒否）、一括作成の原子性と共通 batch_id |
| `backend/tests/db_seed_ttl.rs` | 結合 | カテゴリ初期 seed（品目 10 大分類+12 小分類・店 8 大分類・ledger ごとの独立性）、ラベル定義の seed と purge 時の receipt_labels CASCADE、TTL 掃除（pending の expire・closed 30 日削除・approved payload 90 日 NULL 化・論理削除レシート 90 日物理削除と FTS・孤立画像のファイル削除後行削除・画像 token・認証系 artefacts・invitations・recovery の 3 段階・subject hash と overflow） |
| `backend/tests/store_member_color.rs` | 結合 | 所属作成時のメンバー色の自動割当（そのユーザーの未使用パレット先頭色、全色使用済み時の循環） |
| `backend/tests/common/mod.rs` | 補助 | テスト用 app 起動（in-memory DB、port 0）と DB fixture（user / ledger / member / image / receipt / item / category / draft の最小行、SQLite エラー assertion） |
| `backend/tests/common/auth.rs` | 補助 | 認証テスト用: router 構築（repo の configs/）、cookie 保持 HTTP クライアント（SoftPasskey による WebAuthn クライアント。discoverable assert のエミュレーション含む）、token 登録・ログインのフローヘルパー、user 直 insert fixture |
| `frontend/tests/unit/widget/helpers.ts` | 補助 | widget テスト用: spy 付きの fake host（window.openai 相当の WidgetHost）、Pinia 初期化 + App mount、callTool 結果の生成、制御可能な deferred |
| `frontend/tests/unit/widget/approve.test.ts` | 単体 | 承認ボタンの状態遷移（draft_id + revision 送信と登録中、成功・冪等成功のメッセージと widgetState 保存、stale_revision の描き直しと自動再承認なし、conflict のボタン非表示、その他エラーの再有効化、widgetState による承認済み復元） |
| `frontend/tests/unit/widget/draft.test.ts` | 単体 | draft / receipt 画面（重複帯、unknown カテゴリの警告色、画像なし表示、画像の折りたたみと行タップの bbox オーバーレイ、画像 URL の refresh_widget_images による再発行、XSS 文字列のテキスト描画、明細 8 行 + さらに表示、ledger バッジ、削除済みレシート） |
| `frontend/tests/unit/widget/draftBatch.test.ts` | 単体 | draft_batch 画面（件数と行状態、callTool なしの詳細と初期画像 URL、すべて登録の送信と行別反映・stale 行の描き直し・再承認なし、承認済み map の復元、送信中の行タップ無効） |
| `frontend/tests/unit/widget/labels.test.ts` | 単体 | widget のラベル表示（receipt / receipt_list の色ドット・操作なし、stats のラベル絞り込みチップと再 callTool での引継ぎ） |
| `frontend/tests/unit/widget/navigation.test.ts` | 単体 | view ルーティング、初期表示と不正 structuredContent、一覧→詳細（get_receipt_drafts / get_receipt の callTool・戻る・widgetState の stack）、下書き一覧の行表示 |
| `frontend/tests/unit/widget/stats.test.ts` | 単体 | 集計ダッシュボード（自作 SVG グラフの値反映: bar_h / bar_v / stacked_bar / line / table / scatter_line、合計カードの前期比、期間・report 切替の summarize_spending 呼び出しと ledger_id・filters 引継ぎ、全画面切替） |
| `frontend/tests/unit/widget/host.test.ts` | 単体 | host adapter（window.openai / 開発時モック / null host の選択、callTool 戻り値の正規化）、dark mode（theme と prefers-color-scheme、style.css の配色変数） |
| `frontend/tests/unit/widget/format.test.ts` | 単体 | 金額表記（ja-JP・負数の符号と色）、画像 URL の /media/img/ prefix 検証と不正 URL の非描画 |
| `frontend/tests/unit/widget/source-guard.test.ts` | 単体 | widget / shared ソースに直接通信・不使用ホスト API（sendFollowUpMessage・getFileDownloadUrl・toolInput）・HTML 挿入 API・絵文字が無いこと |
| `frontend/tests/unit/web/helpers.ts` | 補助 | web テスト用: "METHOD /path" で応答を返す fetch スタブ（呼び出し記録・順次応答）、memory history での App mount（遅延ページの事前読込・HTTP hook 設定）、me・WebAuthn の fixture、フィード用スクロール test double（IntersectionObserver 手動発火・scrollIntoView 記録・scrollBy spy・matchMedia stub） |
| `frontend/tests/unit/web/http.test.ts` | 単体 | fetch ラッパ（同一 origin・credentials・JSON、401 の onUnauthorized と authOptional、reauth_required の step-up 後1回再送とキャンセル時の非再送、403 のコード、204） |
| `frontend/tests/unit/web/webauthn.test.ts` | 単体 | webauthn-rs JSON と navigator.credentials の変換（creation / request options の base64url → ArrayBuffer、attestation / assertion の base64url 化） |
| `frontend/tests/unit/web/data-api.test.ts` | 単体 | 補助データ API が常に HTTP 実装（モック切替は削除済み）、HTTP クライアントの backend 接続契約（パス・メソッド・body） |
| `frontend/tests/unit/web/vite-proxy.test.ts` | 単体 | Vite dev proxy の構成（/api,/oauth,/.well-known,/mcp を configs/dev/app.toml の backend port へ。port 直書きなし） |
| `frontend/tests/unit/web/auth-pages.test.ts` | 単体 | ルーター（未ログインのログイン誘導・公開画面）、ログイン（案内・conditional UI と req・next による遷移・401 文言）、登録受付（token の URL 除去・表示名検証・recovery・invite の既定家計簿選択・完了遷移・無効 token）、同意（表示内容・許可/拒否の redirect_to 遷移・401 のログイン誘導・期限切れ） |
| `frontend/tests/unit/web/frame.test.ts` | 単体 | iframe 内でのログイン・同意画面の操作部品の非描画（isFramed）、favicon.svg の実色・var() 不使用 |
| `frontend/tests/unit/web/dashboard-shell.test.ts` | 単体 | ホーム（月次サマリ・期間切替）とアプリ骨格（ナビ・topbar 下ドロワーの menu ボタン開閉トグル〔aria・フォーカス移動・inert・Escape/scrim/遷移/900px リサイズで閉じる〕・右上メニュー・PopoverMenu・topbar logo の出し分け〔full は wordmark Kakei・compact は kb〕、query 変化・receipt ルート内 id 変化でメニューが閉じない） |
| `frontend/tests/unit/web/account-pages.test.ts` | 単体 | ホーム（アカウント番号・パスキー一覧と同期状態、最後の1本の 409、step-up ダイアログと再送・キャンセル、追加・改名・ログアウト・招待発行）、接続中のアプリ（一覧と未選択表示・JST 日時、画面内確認後の解除、家計簿切替と 409） |
| `frontend/tests/unit/web/data-pages.test.ts` | 単体 | カテゴリ（2階層表示・作成と親なしエラー・改名/移動/アーカイブ・アーカイブ済みの表示切替）、店（更新と過去分反映の注記・確認後の統合と件数移動・同一店の拒否）、レシート（一覧と詳細・revision 付き保存・revision 不一致の読み直し・preview → confirm 削除・復元・詳細の画像表示（/media/img/ prefix 以外の URL は非採用・期限切れの再取得・画像なしは省略））、XSS 文字列のテキスト描画 |
| `frontend/tests/unit/web/view-pages.test.ts` | 単体 | 閲覧画面（レシート一覧ダッシュボード・他画面からの絞り込みリンク・最近のレシートの文脈引き継ぎ・詳細の既定閲覧表示、カテゴリ・店のダッシュボード、長い店名の省略、設定のデータ管理リンク、label 絞り込み [TASK-17]） |
| `frontend/tests/unit/web/receipt-feed.test.ts` | 単体 | レシート連続フィード（文脈 query からの並び・直リンクの購入月フォールバック・戻るリンク・URL 同期（replace）・外部ナビ・家計簿切替で一覧へ・ページングと前後2件の描画窓・上方向展開のスクロール補正・snap なし〔snapFeed.ts 不在〕・前後ボタンと矢印キー〔ドロワー開放中は無効〕・修正中の停止） |
| `frontend/tests/unit/web/receipt-panel.test.ts` | 単体 | ReceiptPanel の labels slot 契約（receipt・ledgerId・canEdit・editing・applyReceipt・changed、TASK-17 差し込み口） |
| `frontend/tests/unit/web/receipt-context.test.ts` | 単体 | 文脈 query ↔ ReceiptListQuery の対称変換（CONTEXT_FIELDS の網羅、labels ↔ label_colors [TASK-17]） |
| `frontend/tests/unit/web/ledger-switcher.test.ts` | 単体 | 家計簿の色と切替（me.default_ledger_id からの初期選択・LedgerSwitcher のチップと一覧・topbar 色帯・設定画面の色 radiogroup） |
| `frontend/tests/unit/web/brand-logo.test.ts` | 単体 | BrandLogo の2形態（full/compact のマーク SVG + HTML テキスト wordmark・既定テキスト kakeiboot/kb と word prop による上書き・role=img・アクセシブルネーム kakeiboot・SVG 属性に var() 無し） |
| `frontend/tests/unit/web/styles.test.ts` | 単体 | styles.css の静的検査（ダッシュボード grid・kpi-sub・sub-row の可変トラックの minmax(0)、家計簿6色パレット変数、topbar 色帯・表題 1 行 ellipsis・ドロワーの topbar 下配置と z-index・menu ボタンの desktop 非表示〔記述順〕と狭幅 44px、520px ロゴ切替、snap 系の不在と .receipt-panel の scroll-margin-top） |
| `frontend/tests/unit/web/label-dots.test.ts` | 単体 | LabelDots とラベル文字列ヘルパ（TASK-17: 色点の aria・compact 表示・色名テキスト変換） |
| `frontend/tests/unit/web/label-picker.test.ts` | 単体 | LabelPicker（TASK-17: labels slot への実装・トグルの即時反映と直列化・差分合成・色別 rollback・applyReceipt 書き戻し） |
| `frontend/tests/unit/web/popover-panel.test.ts` | 単体 | PopoverPanel（TASK-27: role=dialog・aria-label・trigger slot の aria-expanded/controls 契約・data-autofocus フォーカス・Escape/外側押下で閉じトリガへフォーカス・sheet-narrow の狭幅クラス） |
| `frontend/tests/unit/stores.test.ts` | 単体 | web / widget の Pinia store が独立していること |
| `frontend/tests/unit/eslint-rules.test.ts` | 単体 | ESLint 設定で `vue/no-v-html` がエラーになること |
