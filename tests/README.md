# tests 索引

テスト構成の索引。実態と常に一致させる。テストコードは各コンポーネントの慣習に従い、backend は `backend/`、frontend は `frontend/tests/` に置く。テスト設計条件書（`tests/design/conditions.toml`）がテスト内容の正本であり、各テストは `[covers:<id>]` タグで条件に紐付く。各条件の詳細（対象・期待値）は条件書の該当条件を参照。

## 実行方法

| コマンド | 内容 |
|---|---|
| `mise run verify` | 全 lint + 全テスト。失敗時は非0で終了する |
| `mise run test` | backend と frontend の全テスト |
| `mise run backend:test` | `cargo test --workspace` |
| `mise run frontend:test` | `vitest run`（frontend/） |
| `mise run lint` | rustfmt check、clippy（`-D warnings`）、ESLint、vue-tsc |
| `mise run frontend:browser` | 実ブラウザ検証・撮影（chromium headless・playwright。API は tests/browser/stub.ts の stub。`mise run verify` には組み込まず手動実行） |
| `uv run --no-project python scripts/design/verify-conditions.py` | 条件書の機械検査（covers タグ対応・網羅・schema・source_lines 同期） |

## テスト設計条件書（tests/design/）

- `tests/design/conditions.toml` — 条件書（単一ファイルに全領域の条件を置く運用。feature 名とファイル stem は一致しない）。各条件の `source` が docs/spec_*.md・docs/deploy.md の該当節を正本として指す。検証は `scripts/design/verify-conditions.py`（test-structure skill 準拠、`source_lines` の自動同期のみ書き込み）。統合後は web-data-api 条件が backend の REST adapter 実機検証、画面部品はモック DataApi で検証する。

## テスト一覧

| 場所 | 種別 | 対象 |
|---|---|---|
| `backend/src/config.rs`（`mod tests`） | 単体 | `app.toml`・`auth.toml` の parse・起動時検証（未知キー拒否・rp_id/origin/resource/issuer 整合・パス解決） |
| `backend/src/auth/tokens.rs`（`mod tests`） | 単体 | アカウント番号生成（Crockford）・base64url codec・UA 既定ラベル |
| `backend/src/admin.rs`（`mod tests`） | 単体 | 運用者 CLI の引数検証・JST 日時フォーマット |
| `backend/src/auth/oauth/cimd.rs`（`mod tests`） | 単体 | CIMD client_id 静的検証・dev loopback 緩和・client_secret 系フィールド拒否 |
| `backend/src/auth/oauth/net.rs`（`mod tests`） | 単体 | Cache-Control parse/clamp・禁止 IP 分類・URL host 制限 |
| `backend/src/ratelimit.rs`（`mod tests`） | 単体 | GCRA 窓と Retry-After・分境界の二重バースト防止・失敗ブロック・CF-Connecting-IP 採用条件 |
| `backend/src/maintenance.rs`（`mod tests`） | 単体 | TTL 掃除の JST cutoff 表記 |
| `backend/src/domain/actor.rs`（`mod tests`） | 単体 | Actor 種別と audit の actor_kind の対応 |
| `backend/src/domain/drafts.rs`（`mod tests`） | 単体 | draft payload の検証と patch 規則 |
| `backend/src/domain/images.rs`（`mod tests`） | 単体 | 画像取得 URL 規則・Content-Disposition・画素数上限・デコードゲート |
| `backend/src/domain/labels.rs`（`mod tests`） | 単体 | ラベル色 `LABEL_COLORS` の正規順 |
| `backend/src/domain/search.rs`（`mod tests`） | 単体 | 検索 cursor 往復・検索系 query の長さ上限ヘルパ [TASK-73] |
| `backend/src/domain/stats.rs`（`mod tests`） | 単体 | 集計期間の算出と分析系の Axis/Metric/Granularity parse・auto 閾値〔TASK-93 で比較系は削除〕 |
| `backend/src/domain/util.rs`（`mod tests`） | 単体 | LIKE エスケープ規則と日付ヘルパ |
| `backend/src/mcp/auth.rs`（`mod tests`） | 単体 | Bearer 厳格解析・scope 不足の _meta challenge・401 ヘッダ形状 |
| `backend/src/mcp/file_arg.rs`（`mod tests`） | 単体 | FileArg の寛容な分類（chat_upload 等） |
| `backend/src/mcp/registry.rs`（`mod tests`） | 単体 | tool descriptor の一覧表適合・一括 tool の schema 形状 |
| `backend/src/mcp/result.rs`（`mod tests`） | 単体 | envelope と ledger の content text |
| `backend/src/mcp/tools/account.rs`（`mod tests`） | 単体 | switch_ledger の応答形状と role 表記 |
| `backend/src/mcp/tools/catalog.rs`（`mod tests`） | 単体 | manage_store の category 三値・get_catalog の include 値 |
| `backend/src/mcp/tools/stats.rs`（`mod tests`） | 単体 | summarize_spending の要約 text・_meta ゲート・既定期間 |
| `backend/src/mcp/tools/widget.rs`（`mod tests`） | 単体 | refresh_widget_images の ref キー |
| `backend/tests/config_load.rs` | 結合 | 実 `configs/` 読込・全環境 mcp.toml の一括 tool キーと `[limits]` 検証 [TASK-73] [TASK-20]・app.toml `[data_io]` 上限検証 [TASK-58]・auth.toml 招待/登録 TTL=168h 検証 [TASK-46]・port 固定割当・config dir 解決 |
| `backend/tests/healthz.rs` | 結合 | `/healthz`・DB 停止時 503・SQLite 作成と migration 適用 |
| `backend/tests/request_log.rs` | 結合 | 運用ログ（request INFO・429 WARN・login_mismatch・tool 呼び出し・TTL） [TASK-15] |
| `backend/tests/mcp_ping.rs` | 結合 | `/mcp` の initialize・tools/list・tools/call・Host/認証 401 |
| `backend/tests/auth_register.rs` | 結合 | 登録フロー（setup/invite/recovery）の token 検証・kind 別完了 tx・ceremony 1回限り |
| `backend/tests/auth_login_session.rs` | 結合 | ログイン（不正・counter 逆行）・web session・CSRF |
| `backend/tests/auth_passkeys.rs` | 結合 | パスキー管理（追加は step-up 不要 [TASK-46]・削除は step-up 必須）・step-up 再認証・web からの招待発行（owner 検証・ledger 指定 [TASK-78]） |
| `backend/tests/admin_cli.rs` | 結合 | 運用者 CLI Phase A（user/token/passkey/disable・audit） |
| `backend/tests/oauth_flow.rs` | 結合 | OAuth メタデータ・authorize・同意・decision（CIMD/JWKS はローカルモック） |
| `backend/tests/oauth_token.rs` | 結合 | 認可コード交換・client 認証（private_key_jwt・JWKS キャッシュ）・revoke |
| `backend/tests/oauth_refresh.rs` | 結合 | refresh rotation・60秒猶予・失効規則・scope 絞り込み |
| `backend/tests/oauth_race.rs` | 結合 | token endpoint 並行競合（BEGIN IMMEDIATE） |
| `backend/tests/mcp_auth.rs` | 結合 | MCP Bearer 検証・ledger service（list/switch/whoami）・接続中のアプリ API |
| `backend/tests/mcp_tools_account.rs` | 結合 | アカウント系 tool（whoami/list/switch・rename_ledger [TASK-20]・resources 配信）・検索語上限 [TASK-73] |
| `backend/tests/mcp_tools_catalog.rs` | 結合 | get_catalog・manage_category/manage_store・summarize_spending・filters 上限 [TASK-73] |
| `backend/tests/mcp_tools_labels.rs` | 結合 | label_receipts と検索・集計の label_colors [TASK-17] |
| `backend/tests/mcp_tools_drafts_batch.rs` | 結合 | 一括 tool（create/approve_receipt_drafts） [TASK-18]・障害注入 [TASK-25] |
| `backend/tests/mcp_tools_draft_labels.rs` | 結合 | draft 段階ラベル（payload.label_colors 取込: schema 5色 enum・正規化と DraftView.labels タイトル結合・不正色の isError・承認時 receipt_labels 引き継ぎと audit 一元化） [TASK-21] |
| `backend/tests/rate_limit.rs` | 結合 | アプリ内 rate limit の経路別 429 |
| `backend/tests/web_data_api.rs` | 結合 | web 補助データ REST と静的配信（catalog/stores/receipts/labels・家計簿名変更 [TASK-20]・query 上限 [TASK-73]・時刻順 cursor 3要素 [TASK-63]・payment_method 絞り込み [TASK-65]・SPA 配信・/analysis 3 endpoint〔breakdown〔現期間のみ・TASK-93〕・積み上げ trend・品目stats・ラベル軸・入力検証。ドメイン単体は domain::stats mod tests〕） |
| `backend/tests/web_export_import.rs` | 結合 | データの書き出し・取り込み（export: viewer 含む member の一貫 snapshot・version 1 構造・audit。import: 新規 ledger 復元・ID remap・round-trip 一致。guard: 401・403・非所属 404 同一視。上限: export/import_too_large・413・import_invalid は rollback・画像 file 残存なし [TASK-58]） |
| `backend/tests/web_media.rs` | 結合 | `GET /media/img/<token>` の配信時再検査と IP rate limit |
| `backend/tests/admin_cli_phaseb.rs` | 結合 | 運用者 CLI Phase B（grant/session/recovery/resolve/reject/cleanup） |
| `backend/tests/common/oauth.rs` | 補助 | OAuth テスト用モック（CIMD/JWKS サーバ・RSA 署名・PKCE・grant fixture・フルフロー） |
| `backend/tests/db_schema.rs` | 結合 | migration 全適合・FK・ラベル表・drafts.batch_id・認証系・catalog・images・FTS・v_item_facts・audit・色 0008 |
| `backend/tests/db_drafts.rs` | 結合 | drafts CHECK 群・library 層 draft 操作・承認トランザクション・reopen・一括作成 |
| `backend/tests/db_seed_ttl.rs` | 結合 | カテゴリ seed・ラベル seed・TTL 掃除の対象別 |
| `backend/tests/store_member_color.rs` | 結合 | 所属作成時のメンバー色の自動割当 |
| `backend/tests/common/mod.rs` | 補助 | テスト用 app 起動（in-memory DB）と DB fixture |
| `backend/tests/common/auth.rs` | 補助 | 認証テスト用 router・cookie 保持クライアント（SoftPasskey）・フローヘルパ |
| `frontend/tests/unit/widget/helpers.ts` | 補助 | widget テスト用 fake host・Pinia 初期化 + mount・callTool 結果生成 |
| `frontend/tests/unit/widget/approve.test.ts` | 単体 | 承認ボタンの状態遷移と widgetState |
| `frontend/tests/unit/widget/draft.test.ts` | 単体 | draft / receipt 画面（重複帯・画像・bbox・XSS・明細・削除済み） |
| `frontend/tests/unit/widget/draftBatch.test.ts` | 単体 | draft_batch 画面（行状態・すべて登録・承認済み map） [TASK-18] |
| `frontend/tests/unit/widget/labels.test.ts` | 単体 | widget のラベル表示 [TASK-26] |
| `frontend/tests/unit/widget/navigation.test.ts` | 単体 | view ルーティング・一覧→詳細・widgetState stack |
| `frontend/tests/unit/widget/stats.test.ts` | 単体 | 集計ダッシュボード（SVG グラフ・軸ラベル両端 [TASK-67] [TASK-68]・期間切替） |
| `frontend/tests/unit/widget/host.test.ts` | 単体 | host adapter 選択・dark mode |
| `frontend/tests/unit/widget/format.test.ts` | 単体 | 金額表記・画像 URL 検証・ISO 日付ラベル [TASK-68] |
| `frontend/tests/unit/widget/source-guard.test.ts` | 単体 | widget/shared の直接通信・不使用 API・HTML 挿入・絵文字の不在 |
| `frontend/tests/unit/web/helpers.ts` | 補助 | fetch スタブ・memory history での mount・フィード用スクロール test double |
| `frontend/tests/unit/web/http.test.ts` | 単体 | fetch ラッパ（401・403・204・reauth_required の step-up 再送・requestBlob の blob 化と error 共有 [TASK-58]） |
| `frontend/tests/unit/web/webauthn.test.ts` | 単体 | webauthn-rs JSON と navigator.credentials の変換 |
| `frontend/tests/unit/web/data-api.test.ts` | 単体 | 補助データ API の HTTP 契約（renameLedger [TASK-20]・export/import の POST 2 route と blob [TASK-58]・/analysis 3 endpoint [TASK-89]） |
| `frontend/tests/unit/web/data-export-import.test.ts` | 単体 | 設定データtab の書き出し・取り込み UI（select+download・2step 取り込み・code 別文言・me 再取得 [TASK-58]） |
| `frontend/tests/unit/web/vite-proxy.test.ts` | 単体 | Vite dev proxy 構成・dev spa fallback・strictPort [TASK-29] |
| `frontend/tests/unit/web/auth-pages.test.ts` | 単体 | ルーター・ログイン・登録受付・同意（色 chip [TASK-20]・me 確定 [TASK-39]） |
| `frontend/tests/unit/web/frame.test.ts` | 単体 | iframe 内の操作部品の非描画・favicon.svg の実色 |
| `frontend/tests/unit/web/dashboard-shell.test.ts` | 単体 | ホーム再構築 [TASK-89]（期間ヘッダ〔TASK-93 で対比部を欠く形へ〕・積み上げ推移〔TASK-95 で金額1形固定・語tabなし〕・zone見出しsr-only+icon link [TASK-95]・内訳残余行・日棒のレシート遷移）・PeriodHeader/RankedList 部品単体・アプリ骨格（drawer 初期 closed [TASK-89]・メニュー・route.meta 化 [TASK-74]） |
| `frontend/tests/unit/web/account-pages.test.ts` | 単体 | 設定（一般tab の家計簿名変更 [TASK-20]・既定 badge と⋯の「既定の家計簿にする」[TASK-13]・パスキー・共有/登録 dialog（FormDialog）と発行済み行・招待 ledger 選択 [TASK-46] [TASK-78]・4tab）・接続中のアプリ [TASK-20]・ラベル管理 [TASK-26] |
| `frontend/tests/unit/web/usage-pages.test.ts` | 単体 | 使い方ページ群 [TASK-37] |
| `frontend/tests/unit/web/data-pages.test.ts` | 単体 | カテゴリ・店管理 [TASK-40]・レシート（編集・削除・画像・明細リンク [TASK-74]・絞り込み [TASK-44] [TASK-76]）・XSS |
| `frontend/tests/unit/web/view-pages.test.ts` | 単体 | 閲覧画面（カテゴリ/店一覧の期間ヘッダ+積み上げ推移〔TASK-95 で語tabなし〕+全量ランキング・5軸統一の /axes/* 軸詳細 [TASK-89]・旧詳細URLの / redirect・行1行化 [TASK-75]・絞り込み popover [TASK-76]・ラベル絞り込み [TASK-17] [TASK-44]・レシート一覧 [TASK-57]） |
| `frontend/tests/unit/web/trend-axis.test.ts` | 単体 | axisMonthLabels ヘルパ（軸両端ラベルの書式） [TASK-42] |
| `frontend/tests/unit/web/period-days.test.ts` | 単体 | periodDays ヘルパ（1日あたりの除数） [TASK-66] |
| `frontend/tests/unit/web/catalog-store.test.ts` | 単体 | catalog store のキャッシュと破棄 [TASK-74] |
| `frontend/tests/unit/web/receipt-feed.test.ts` | 単体 | レシート連続フィード（文脈・URL 同期・着地・優越判定 [TASK-77]・世代ガード [TASK-61]） |
| `frontend/tests/unit/web/receipt-panel.test.ts` | 単体 | ReceiptPanel の labels slot 契約と明細リンク [TASK-74]・支払方法タグのリンク [TASK-65] |
| `frontend/tests/unit/web/receipt-context.test.ts` | 単体 | 文脈 query ↔ ReceiptListQuery の対称変換 [TASK-17]（payment_method は9キー検証で不明値を落とす [TASK-65]） |
| `frontend/tests/unit/web/ledger-switcher.test.ts` | 単体 | 家計簿の色と切替（初期選択・チップ・色帯） |
| `frontend/tests/unit/web/brand-logo.test.ts` | 単体 | BrandLogo の2形態（full/compact・word prop・role=img） |
| `frontend/tests/unit/web/styles.test.ts` | 単体 | styles.css の静的検査（grid・パレット・topbar・toolbar・密度・popover 化） [TASK-44] [TASK-75] [TASK-76] |
| `frontend/tests/unit/web/filter-bar.test.ts` | 単体 | topbar 中央絞り込みバー [TASK-44]（時期 dialog の tab は週/月/年/Custom の自然昇順 [TASK-89]）と検索チップ [TASK-41] |
| `frontend/tests/unit/web/period-store.test.ts` | 単体 | period store の週モード [TASK-53]（月曜始まりの7日 range・ラベル・labelShort・urlQuery week=・step ±7日） |
| `frontend/tests/unit/web/trend-granularity.test.ts` | 単体 | 推移粒度ヘルパ [TASK-55/57]（trendGranularity の週モード=日・range の62/366日閾値・weekStart・shortTime。bucket 生成は /analysis/trend 側へ移行 [TASK-89]） |
| `frontend/tests/unit/web/search-page.test.ts` | 単体 | /search 検索tab（debounce・2タブ・行リンク・URL 復元） [TASK-41] |
| `frontend/tests/unit/web/transition.test.ts` | 単体 | 遷移のアトミック化とアニメーション・slide 方向判定 [TASK-39] [TASK-74] |
| `frontend/tests/unit/web/label-dots.test.ts` | 単体 | LabelDots と読み上げ名ヘルパ [TASK-17] [TASK-26] |
| `frontend/tests/unit/web/label-chip.test.ts` | 単体 | 管理ラベル UI 部品（LabelChip・LabelToggleGroup・LabelFilter） [TASK-26] |
| `frontend/tests/unit/web/label-picker.test.ts` | 単体 | LabelPicker（tags 行末ボタン + popover・差分・rollback） [TASK-17] [TASK-26] |
| `frontend/tests/unit/web/popover-panel.test.ts` | 単体 | PopoverPanel（role=dialog・フォーカス・sheet-narrow） [TASK-27] |
| `frontend/tests/unit/stores.test.ts` | 単体 | web / widget の Pinia store が独立していること |
| `frontend/tests/unit/inline-widget-html.test.ts` | 単体 | widget 単一 HTML 化 build plugin（TASK-50: 偽 bundle で script/stylesheet の inline・modulepreload 除去・`</script` エスケープ・chunk の非放出・postcondition の error〔bundle に無い asset・CSS の url()/@import・残存 src/href〕・package.json build script と vite.widget.config.ts〔単一 entry + codeSplitting: false + emptyOutDir: false + inline plugin〕・web pass が web.html のみを input に持つことの文本検証） |
| `frontend/tests/unit/eslint-rules.test.ts` | 単体 | ESLint 設定で `vue/no-v-html` がエラーになること |
| `frontend/tests/browser/capture.spec.ts` | 撮影 | 全画面（/axes 軸詳細を含む [TASK-89]）の png・metrics.json を幅別に出力 |
| `frontend/tests/browser/capture.usage.spec.ts` | 撮影 | 使い方ページ用の login/consent 画像（asset へ配置） |
| `frontend/tests/browser/verify.spec.ts` | 実ブラウザ検証 | 実レイアウト実測（着地・補正・幅・軸・境界値・検索チップ） [TASK-19] [TASK-42] [TASK-44] [TASK-41] [TASK-77] |
| `frontend/tests/browser/verify-shell.spec.ts` | 実ブラウザ検証 | shell 系実測（名前併記・popover 補正・sheet 切替・drawer〔初期 closed・scrim 外タップ [TASK-89]〕・grant chip・表題中央寄せ） [TASK-60] [TASK-20] [TASK-69] |
| `frontend/tests/browser/verify-labels.spec.ts` | 実ブラウザ検証 | ラベル系実測（行幅・popover 収まり・チップ・コントラスト・picker の色 tap で閉じ） [TASK-60] [TASK-51] |
| `frontend/tests/browser/verify-usage.spec.ts` | 実ブラウザ検証 | /usage/connect のコピー button icon 切替と URL box 高さ不変（reduced-motion 対応） [TASK-48] |
| `frontend/tests/browser/measure.ts` | 補助 | WCAG コントラスト比計算・viewport 内判定 [TASK-60] |
| `frontend/tests/browser/stub.ts` | 補助 | browser 実行用の API stub（seed 差し替え option 付き。`mise run frontend:browser` が使用） |
