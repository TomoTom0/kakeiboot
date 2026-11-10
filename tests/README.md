# tests 索引

テスト構成の索引。実態と常に一致させる。テストコードは各コンポーネントの慣習に従い、backend は `backend/`、frontend は `frontend/tests/` に置く。テスト設計条件書（`tests/design/conditions.toml`）がテスト内容の正本であり、各テストは `[covers:<id>]` タグで条件に紐付く。各条件の詳細（対象・期待値）は条件書の該当条件を参照。

## 実行方法

| コマンド | 内容 |
|---|---|
| `mise run verify` | 全 lint + 全テスト。失敗時は非0で終了する |
| `mise run test` | backend と frontend の全テスト |
| `mise run backend:test` | `cargo test --workspace --features budget-book/test-hooks`（test 専用 hook `backend/src/test_hooks.rs` を有効化。release build には含めない [TASK-147]） |
| `mise run frontend:test` | `vitest run`（frontend/） |
| `mise run scripts:test` | `unittest discover`（scripts/deploy/。deploy運用操作script・backup構成〔script相対導出・unit render配布〕の単体test [TASK-118] [TASK-119]） |
| `mise run lint` | rustfmt check、clippy（`-D warnings`。feature なし・`test-hooks` 有効の2回）、ESLint、vue-tsc |
| `mise run frontend:browser` | 実ブラウザ検証・撮影（chromium headless・playwright。API は tests/browser/stub.ts の stub。`mise run verify` には組み込まず手動実行） |
| `uv run --no-project python scripts/design/verify-conditions.py` | 条件書の機械検査（covers タグ対応・網羅・schema・source_lines 同期） |

## テスト設計条件書（tests/design/）

- `tests/design/conditions.toml` — 条件書（単一ファイルに全領域の条件を置く運用。feature 名とファイル stem は一致しない）。各条件の `source` が docs/spec/spec_*.md・docs/ops/ops_deploy.md の該当節を正本として指す。検証は `scripts/design/verify-conditions.py`（test-structure skill 準拠、`source_lines` の自動同期のみ書き込み）。統合後は web-data-api 条件が backend の REST adapter 実機検証、画面部品はモック DataApi で検証する。

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
| `backend/src/mcp/widget_resource.rs`（`mod tests`） | 単体 | receipt_web_url の origin 結合・resource URI の内容非依存（安定 URI）と read の URI エコー [TASK-106] |
| `backend/tests/config_load.rs` | 結合 | 実 `configs/` 読込・全環境 mcp.toml の一括 tool キーと `[limits]` 検証 [TASK-73] [TASK-20]・app.toml `[data_io]` 上限検証 [TASK-58]・auth.toml 招待/登録 TTL=168h 検証 [TASK-46]・port 固定割当・config dir 解決 |
| `backend/tests/healthz.rs` | 結合 | `/healthz`・DB 停止時 503・SQLite 作成と migration 適用 |
| `backend/tests/request_log.rs` | 結合 | 運用ログ（request INFO・429 WARN・login_mismatch・tool 呼び出し・TTL） [TASK-15] |
| `backend/tests/mcp_ping.rs` | 結合 | `/mcp` の initialize・tools/list・tools/call・Host/認証 401 |
| `backend/tests/auth_register.rs` | 結合 | 登録フロー（setup/invite/recovery）の token 検証・kind 別完了 tx・ceremony 1回限り |
| `backend/tests/auth_login_session.rs` | 結合 | ログイン（不正・counter 逆行）・web session・CSRF・同一 credential の並行ログイン（test hook で BEGIN IMMEDIATE 直前に停止: counter 巻き戻り防止・停止中の user 無効化。`test-hooks` feature 必須のケースあり） [TASK-147] |
| `backend/tests/auth_passkeys.rs` | 結合 | パスキー管理（追加は step-up 不要 [TASK-46]・削除は step-up 必須）・step-up 再認証（counter 鮮度・tx 集約・ceremony 1 回限り [TASK-154]）・web からの招待発行（owner 検証・ledger 指定 [TASK-78]） |
| `backend/tests/admin_cli.rs` | 結合 | 運用者 CLI Phase A（user/token/passkey/disable・audit） |
| `backend/tests/oauth_flow.rs` | 結合 | OAuth メタデータ・authorize・同意・decision（CIMD/JWKS はローカルモック） |
| `backend/tests/oauth_token.rs` | 結合 | 認可コード交換・client 認証（private_key_jwt・JWKS キャッシュ）・revoke |
| `backend/tests/oauth_refresh.rs` | 結合 | refresh rotation・60秒猶予・失効規則・scope 絞り込み・差し替え済み旧子の失効と提示時の family 失効（S1/S2・孫世代・3回再発行・期限切れ旧子・判定順・再試行の非誤検知）・refresh_reuse の診断 kind ログ・失効 UPDATE 失敗の 500 [TASK-140] |
| `backend/tests/oauth_race.rs` | 結合 | token endpoint 並行競合（BEGIN IMMEDIATE）・同時 refresh で差し替えられた子の refresh 行失効 [TASK-140] |
| `backend/tests/mcp_auth.rs` | 結合 | MCP Bearer 検証・ledger service（list/switch/whoami）・接続中のアプリ API |
| `backend/tests/mcp_tools_account.rs` | 結合 | アカウント系 tool（whoami/list/switch・rename_ledger [TASK-20]）・resources 配信の安定 URI・旧 hash URI エイリアス（安定 URI 応答と同一 text/_meta・形式外は未知 URI） [TASK-106]・検索語上限 [TASK-73] |
| `backend/tests/mcp_tools_catalog.rs` | 結合 | get_catalog・manage_category/manage_store・summarize_spending・filters 上限 [TASK-73] |
| `backend/tests/mcp_tools_labels.rs` | 結合 | label_receipts と検索・集計の label_colors [TASK-17]・summarize_spending の `_meta.trend_matrix`（monthly_overview・monthly_trend・filters 同条件） [TASK-116] |
| `backend/tests/mcp_tools_drafts_batch.rs` | 結合 | 一括 tool（create/approve_receipt_drafts） [TASK-18]・障害注入 [TASK-25] |
| `backend/tests/mcp_tools_draft_labels.rs` | 結合 | draft 段階ラベル（payload.label_colors 取込: schema 5色 enum・正規化と DraftView.labels タイトル結合・不正色の isError・承認時 receipt_labels 引き継ぎと audit 一元化） [TASK-21] |
| `backend/tests/rate_limit.rs` | 結合 | アプリ内 rate limit の経路別 429 |
| `backend/tests/web_data_api.rs` | 結合 | web 補助データ REST と静的配信（catalog/stores/receipts/labels・家計簿名変更 [TASK-20]・query 上限 [TASK-73]・時刻順 cursor 3要素 [TASK-63]・payment_method 絞り込み [TASK-65]・SPA 配信・/analysis 3 endpoint〔breakdown〔現期間のみ・TASK-93〕・積み上げ trend・品目stats・ラベル軸・入力検証。ドメイン単体は domain::stats mod tests〕） |
| `backend/tests/web_export_import.rs` | 結合 | データの書き出し・取り込み（export: viewer 含む member の一貫 snapshot・version 1 構造・audit。import: 新規 ledger 復元・ID remap・round-trip 一致。guard: 401・403・非所属 404 同一視。上限: export/import_too_large・413・import_invalid は rollback・画像 file 残存なし [TASK-58]） |
| `backend/tests/web_media.rs` | 結合 | `GET /media/img/<token>` の配信時再検査と IP rate limit |
| `backend/tests/admin_cli_phaseb.rs` | 結合 | 運用者 CLI Phase B（grant/session/recovery/resolve/reject/cleanup） |
| `backend/tests/admin_cli_concurrent_families.rs` | 結合 | 運用者 CLI 並存 refresh family 照会 `grant concurrent-families`（tip 2本検出・孤児/使用済み/失効済みtip除外・期限切れtip算定・失効/期限切れgrant出力・--user絞り込み・0件・親行削除で検出不能 [TASK-155]） |
| `backend/tests/admin_cli_backup.rs` | 結合 | 運用者 CLI backup（VACUUM INTO snapshot・read-only open・稼働中一貫性・失敗系 exit・tmp 冪等性 [TASK-83]） |
| `backend/tests/common/oauth.rs` | 補助 | OAuth テスト用モック（CIMD/JWKS サーバ・RSA 署名・PKCE・grant fixture・フルフロー） |
| `backend/tests/common/logcap.rs` | 補助 | tracing 出力の buffer capture（log assertion 用。request_log・oauth_refresh が使用） |
| `backend/tests/db_schema.rs` | 結合 | migration 全適合・FK・ラベル表・drafts.batch_id・認証系・catalog・images・FTS・v_item_facts・audit・色 0008・0012 の孤児旧子 refresh 失効補正 [TASK-140] |
| `backend/tests/db_drafts.rs` | 結合 | drafts CHECK 群・library 層 draft 操作・承認トランザクション・reopen・一括作成 |
| `backend/tests/db_seed_ttl.rs` | 結合 | カテゴリ seed・ラベル seed・TTL 掃除の対象別 |
| `backend/tests/store_member_color.rs` | 結合 | 所属作成時のメンバー色の自動割当 |
| `backend/tests/common/mod.rs` | 補助 | テスト用 app 起動（in-memory DB）と DB fixture |
| `backend/tests/common/auth.rs` | 補助 | 認証テスト用 router・cookie 保持クライアント（SoftPasskey）・フローヘルパ・test hook 付き file DB setup（`auth_setup_file_with_hooks` [TASK-147]） |
| `frontend/tests/unit/widget/helpers.ts` | 補助 | widget テスト用 fake host・Pinia 初期化 + mount・callTool 結果生成 |
| `frontend/tests/unit/widget/approve.test.ts` | 単体 | 承認ボタンの状態遷移と widgetState |
| `frontend/tests/unit/widget/draft.test.ts` | 単体 | draft / receipt 画面（重複帯・画像・bbox・XSS・明細・削除済み）・TASK-161 で BarHChart の labelChars 固定字数を幅budget切り詰めへ改訂（XSS 検証目的は維持）・TASK-170（明細3層+明細合計行〔折りたたみ中も全品目合計〕・inline カテゴリ・頭部の再構成〔日時行 inline・.receipt-total・運用meta行廃止〕・note .receipt-note） |
| `frontend/tests/unit/widget/draftBatch.test.ts` | 単体 | draft_batch 画面（行状態・すべて登録・承認済み map） [TASK-18]・TASK-170（.data-row 2行文法・状態 chip 副行右端） |
| `frontend/tests/unit/widget/labels.test.ts` | 単体 | widget のラベル表示 [TASK-26]・TASK-170（詳細頭部の LabelChip は日時行末尾へ inline） |
| `frontend/tests/unit/widget/navigation.test.ts` | 単体 | view ルーティング・一覧→詳細・widgetState stack・TASK-170（一覧行 .data-row 2行・top_items 副行・item_count/matched_items 表示廃止） |
| `frontend/tests/unit/widget/stats.test.ts` | 単体 | 集計ダッシュボード（SVG グラフ・軸ラベル両端 [TASK-67] [TASK-68]・期間切替・bar_v 積み上げと `_meta.trend_matrix`・bar_h/bar_v 同key同色・matrix 無し/不一致 fallback・_meta 載せ替わり [TASK-116]・bar_v 幾何の TASK-123 改訂〔上位3+ほか・viewBox unit stroke 縁取り・最上段上端角丸 path・clipPath 廃止〕・TASK-129〔報告単位 scale 集約・bar_h 幾何〔stroke・データ端 cap・rx=2 廃止〕・ShareBar 絶対scale/composition モード/凡例合算追従・共通 renderer BarSegs 直接 mount〕・TASK-170〔合計カード 1.9rem・table fallback の金額 w700 tabular〕） |
| `frontend/tests/unit/widget/host.test.ts` | 単体 | host adapter 選択・dark mode（系列 palette --series-1..7/--series-rest の light/dark と --bb-series-* 廃止 [TASK-116]・palette 実値が web と同値の TASK-123 候補値と --seg-outline 定義） |
| `frontend/tests/unit/widget/format.test.ts` | 単体 | 金額表記・画像 URL 検証・ISO 日付ラベル [TASK-68] |
| `frontend/tests/unit/widget/source-guard.test.ts` | 単体 | widget/shared の直接通信・不使用 API・HTML 挿入・絵文字の不在・TASK-170（行文法 wiring の静的検査: row-grammar.css/motion.css 実体+両 main.ts import・hover guard・bb-appear 参照・旧語彙〔bb-list 等〕削除） |
| `frontend/tests/unit/web/helpers.ts` | 補助 | fetch スタブ・memory history での mount・フィード用スクロール test double |
| `frontend/tests/unit/web/http.test.ts` | 単体 | fetch ラッパ（401・403・204・reauth_required の step-up 再送・requestBlob の blob 化と error 共有 [TASK-58]） |
| `frontend/tests/unit/web/webauthn.test.ts` | 単体 | webauthn-rs JSON と navigator.credentials の変換 |
| `frontend/tests/unit/web/data-api.test.ts` | 単体 | 補助データ API の HTTP 契約（renameLedger [TASK-20]・export/import の POST 2 route と blob [TASK-58]・/analysis 3 endpoint [TASK-89]） |
| `frontend/tests/unit/web/data-export-import.test.ts` | 単体 | 設定データtab の書き出し・取り込み UI（select+download・2step 取り込み・code 別文言・me 再取得 [TASK-58]） |
| `frontend/tests/unit/web/vite-proxy.test.ts` | 単体 | Vite dev proxy 構成・dev spa fallback・strictPort [TASK-29] |
| `frontend/tests/unit/web/auth-pages.test.ts` | 単体 | ルーター・ログイン・登録受付・同意（色 chip [TASK-20]・me 確定 [TASK-39]） |
| `frontend/tests/unit/web/frame.test.ts` | 単体 | iframe 内の操作部品の非描画・favicon.svg の実色 |
| `frontend/tests/unit/web/dashboard-shell.test.ts` | 単体 | ホーム再構築 [TASK-89]（期間ヘッダ〔TASK-93 で対比部を欠く形へ〕・積み上げ推移〔TASK-95 で金額1形固定・語tabなし〕・zone見出しsr-only+icon link [TASK-95]・内訳残余行・日棒のレシート遷移）・PeriodHeader/RankedList 部品単体・アプリ骨格（drawer 初期 closed [TASK-89]・メニュー・route.meta 化 [TASK-74]）・期間ヘッダ/週カードの trend 呼び出し回数は prefetch 込み期待 [TASK-115]・週行の行内 bar（TASK-123 で DOM 積み上げ bar 化・TASK-129 で共通 DOM bar〔.row-bar/.row-seg〕+絶対scale化: title・0円週 bar なし・内訳行と同key同色・画面scale=barScale 集約の同一尺度担保）・TASK-146（週行の7日化〔月跨ぎ拡張range fetch・label・当週継続〕・未来月の空表示・ContentSwap の commit 時発火〔appear fade・mode切替 fade・chart fade 抑止〕）・TASK-161（PeriodStep による「の支出」除去+step pair・期間stepの pane 不変・内訳zone の header 直下全幅化+絶対目盛り5段階+share列なし・週行 segment の bar内label未測定fallback・trend 呼び出し回数は ±span両側+±1移動窓 prefetch 込みへ更新）・TASK-162（内訳zone の BreakdownBar 1本bar化期待へ全面書換: 行list廃止・segment button と「ほか」title・空状態）・in-bar label の fit 推計へ tracking 込み〔LABEL_PITCH=11×1.02〕 [TASK-171] |
| `frontend/tests/unit/web/account-pages.test.ts` | 単体 | 設定（一般tab の家計簿名変更 [TASK-20]・既定 badge と⋯の「既定の家計簿にする」[TASK-13]・パスキー・共有/登録 dialog（FormDialog）と発行済み行・招待 ledger 選択 [TASK-46] [TASK-78]・4tab）・接続中のアプリ [TASK-20]・ラベル管理 [TASK-26] |
| `frontend/tests/unit/web/usage-pages.test.ts` | 単体 | 使い方画面群 [TASK-37]: 導線（アカウントメニュー・usage 節）・接続URLコピー（icon 切替 + sr-only status）・図解・/apps 導線。TASK-141 テスト先行: トピック一覧の frontmatter 由来生成（9件・order 昇順）・/usage/:topic 動的route（section: usage・meta.public なし・/usage/connect URL 維持）・全トピックの本文描画・本文リンクの router 解決・未知 slug の空状態表示 [TASK-171] |
| `frontend/tests/unit/web/data-pages.test.ts` | 単体 | カテゴリ・店管理 [TASK-40]・レシート（編集・削除・画像・明細リンク [TASK-74]・絞り込み [TASK-44] [TASK-76]）・XSS・管理画面の行内状態変化と一覧「さらに表示」の出現fade [TASK-146] |
| `frontend/tests/unit/web/view-pages.test.ts` | 単体 | 閲覧画面（カテゴリ/店一覧の期間ヘッダ+積み上げ推移〔TASK-95 で語tabなし〕+全量ランキング・5軸統一の /axes/* 軸詳細 [TASK-89]・旧詳細URLの / redirect・行1行化 [TASK-75]・絞り込み popover [TASK-76]・ラベル絞り込み [TASK-17] [TASK-44]・レシート一覧 [TASK-57]・日別/週別/月別棒の系列積み上げと limit=5 [TASK-116]・上位3+ほか・縁取り・配分規則への記述改訂 [TASK-123]・RankedList 行bar の TASK-129 改訂〔共通 DOM bar .row-bar/.row-seg・width=value/scale×track・--rank-fill 廃止・/categories 画面単位 scale・支払方法 button 行の bar〕）・Categories の ContentSwap commit 時発火 [TASK-146]・TASK-161（期間stepの pane 不変〔committedKey から期間成分除去〕・Receipts kpi の step pair と「の支出」除去） |
| `frontend/tests/unit/web/trend-axis.test.ts` | 単体 | axisMonthLabels・axisTickIndices ヘルパ（軸ラベルの間引きと書式） [TASK-42] [TASK-100]・compactYen（千帯は百円step丸めで小数1桁保持〔1500→1.5千〕） [TASK-122]・TASK-162（items 常に短形式+年tick years 配列〔先頭の年+1月境界・月間引き独立〕への書換） |
| `frontend/tests/unit/web/trend-window.test.ts` | 単体 | トレンド窓移動 [TASK-104]（useTrendWindow composable: 窓計算〔month=trendQuery(5)・year=period.range 無後退〕・offset 操作・refresh 冪等ガード・ledger 未確定 fetch なし・stacked 組立集約・全0窓の過去側打ち切り・TrendWindow 前次button・窓移動は trend API のみ再fetch）・cacheヒット経路/prefetch/flush・slide連結とトリム〔prev=[新,旧]・next=[旧,新]〕・連打の即時トリム→再開始・focus変更の同tick trim [TASK-115]・stacked 組立の上位3+ほか・5%合算と allocateStack 配分純関数〔規則A/B/C/F〕 [TASK-123]・TASK-129 の composition モード〔規則A/B/F・規則C 不適用・rest フラグ識別・rest.label 新設・総和保存〕・#14 chart fade〔windowKey 単独変化で発火・slide 中抑止・bars DOM 不変〕 [TASK-146]・TASK-161 絶対窓（E2a 窓保持/E2b 最小slide〔union連結・moveCols〕/E2c 正規窓reset・対称全0 floor・prefetch ±span両側+±1移動窓・offset 直読みの windowKey/window 観測化・スライド中focus中断の in-place 化）・TASK-162（slide 検証への .axis-years 追従拡張+stackedOfRows〔残余=合計−保持系列和・件数=分類数・5%fold〕・系列key保持・allocateStack opts.labelMin の新規 block）・PR#4 review 追加分 [TASK-171]（規則C ladder/terminal の bar長基準化〔rest過半barの単色化解消・最後の生存系列は data比のまま・pct整合〕・失敗移動の lastMove 残留が E4/refresh の all-zero commit で chevron を誤 disableしない） |
| `frontend/tests/unit/web/series-color.test.ts` | 単体 | 系列色の決定的割当 seriesColor（number は (id-1) mod 7 循環 slot・null=--series-rest・string は FNV-1a % 7・label 軸は管理色固定表 red〜purple と範囲外 fallback・追加不変） [TASK-105]（TASK-116 で shared/lib 移設・期待値不変） |
| `frontend/tests/unit/web/period-days.test.ts` | 単体 | periodDays ヘルパ（1日あたりの除数） [TASK-66] |
| `frontend/tests/unit/web/catalog-store.test.ts` | 単体 | catalog store のキャッシュと破棄 [TASK-74] |
| `frontend/tests/unit/web/receipt-feed.test.ts` | 単体 | レシート連続フィード（文脈・URL 同期・着地・優越判定 [TASK-77]・世代ガード [TASK-61]）・Feed の ContentSwap fade〔文脈変更・ページroot remount なし〕と末尾追加panelの出現fade [TASK-146] |
| `frontend/tests/unit/web/receipt-panel.test.ts` | 単体 | ReceiptPanel の labels slot 契約と明細リンク [TASK-74]・支払方法タグのリンク [TASK-65] |
| `frontend/tests/unit/web/receipt-context.test.ts` | 単体 | 文脈 query ↔ ReceiptListQuery の対称変換 [TASK-17]（payment_method は9キー検証で不明値を落とす [TASK-65]） |
| `frontend/tests/unit/web/ledger-switcher.test.ts` | 単体 | 家計簿の色と切替（初期選択・チップ・色帯） |
| `frontend/tests/unit/web/brand-logo.test.ts` | 単体 | BrandLogo の2形態（full/compact・word prop・role=img） |
| `frontend/tests/unit/web/styles.test.ts` | 単体 | styles.css の静的検査（grid・パレット・topbar・toolbar・密度・popover 化・系列token/--dash-cols/.zone--list/swatch の実装後検査 block〔skip 形式〕） [TASK-44] [TASK-75] [TASK-76] [TASK-105]・palette 実値・--seg-outline 縁取り・角規則・週行 DOM bar の TASK-123 block・TASK-129 block（.ranked-row gradient 廃止+絶対配置 track・共通 .row-bar/.row-seg 規則1組・旧 .week-bar/.week-seg 廃止・:last-child cap・文法の surface 別上書きなし）・TASK-130 block（旧棒色強調2規則と .bar transition の廃止・.bar-col radius 6px/transition・hover wash --bb-hover は @media (hover: hover) 内のみで current 規則より後置・current wash --bb-accent-soft + .bar-val 前景強調） [TASK-130]・TASK-146 block（.zone.is-loading fade・scrim/dialog-backdrop の opacity 遷移と reduced-motion・出現fade語彙 bb-appear 1組）・TASK-161 block（--row-bar-h 12px 一元・gap 4px・radius 0 2px 2px 0・width transition と reduced-motion 無効）・TASK-162 block（--row-bar-h 16px へのguard更新+--trend-bar-w 48px 一元・.bar-seg-label 直立縦書き・label type token〔--bar-label-*/--tick-label-*〕直置きなし）・TASK-171 review block（tick 値 end-flush・.row-seg-move FLIP〔width+transform・reduced-motion は既存規則で無効〕・.daily-col:hover の @media (hover: hover) 合流・rule F fill-only の ::before outline 抑制・.sub-rows 廃止の反転検査・bb-appear -move〔transform・fade同grade〕） |
| `frontend/tests/unit/web/bar-scale.test.ts` | 単体 | TASK-129 の共通 scale 純関数 barScale（nice 1/2/5 段階切上げ・0/負/非有限は 1・niceMax と全定義域で同値）・TASK-161 の axisTicksOf（steps 4/2 の昇順両端 ladder・compactYen label）とテキスト幅 utility（estimateTextWidth・truncateLabelWidth） |
| `frontend/tests/unit/web/filter-bar.test.ts` | 単体 | topbar 中央絞り込みバー [TASK-44]（時期 dialog の tab は週/月/年/Custom の自然昇順 [TASK-89]・› の未来送り [TASK-146]）と検索チップ [TASK-41]（dialog からの /search push は q のみ [TASK-145]）・時期dialogの開閉 appear fade [TASK-146] |
| `frontend/tests/unit/web/period-store.test.ts` | 単体 | period store の週モード [TASK-53]（月曜始まりの7日 range・ラベル・labelShort・urlQuery week=・step ±7日）・step の未来解放と year 9999 上限 [TASK-146]・canPrev 対称化（year 1900 下限で ‹ 無効・month/week 常時有効） [TASK-171] |
| `frontend/tests/unit/web/trend-granularity.test.ts` | 単体 | 推移粒度ヘルパ [TASK-55/57]（trendGranularity の週モード=日・range の62/366日閾値・weekStart・shortTime。bucket 生成は /analysis/trend 側へ移行 [TASK-89]） |
| `frontend/tests/unit/web/search-page.test.ts` | 単体 | /search 検索tab（debounce・2タブ・行リンク・URL 復元・scope toggle の期間 keys は period のみ載る [TASK-145]） [TASK-41]・さらに表示の追加行出現fade [TASK-146]・scope 切替で committedKey が bump し ContentSwap が発火 [TASK-171] |
| `frontend/tests/unit/web/transition.test.ts` | 単体 | 遷移のアトミック化とアニメーション・slide 方向判定 [TASK-39] [TASK-74]・方向なしpushのfade化（同depth・depth未設定route・navKind 区分・reduced-motion） [TASK-146]・page 語彙の in-flow caller（Receipts kpi-sub の Transition は mode="out-in"） [TASK-171] |
| `frontend/tests/unit/web/content-swap.test.ts` | 単体 | ContentSwap 共通component契約 [TASK-146]（swapKey/dir・swapKey切替の語彙別class・初回appear・reduced-motion 無効・periodMove の方向確定・reducedMotion 判定の一元化）・TASK-161 で periodMove.ts 廃止の fs 検査へ改訂（slide 語彙は shell 専用）・useTweenNumber の出現特例（firstChange）廃止〔初回変化もtween・mount時初期値のみ即時〕 [TASK-171] |
| `frontend/tests/unit/web/url-sync.test.ts` | 単体 | 閲覧系 URL 双方向同期と topbar ‹ [TASK-124]（shell composable: 期間 mode keys・labels= の5画面+/search 同期・keys 無し流入の store 継続と直ちの書戻し・pop での entry 復元・feed 除外・/search scope=all は期間 keys 非載せ・差分ガード。tabbar 外11画面の ‹ は brand 直後・表題直前の icon-only 44px で親マップの親へ up 语义で戻る・閲覧系/Axis/feed には置かない）・未来月への送りの URL 書戻し [TASK-146]・/search 期間 keys は書き両面で scope=period 時のみ（carry 廃止・stray 流入の strip・scope toggle）と AxisDetail の echo 非再取得・‹ の現在値追従 [TASK-145] |
| `frontend/tests/unit/web/label-dots.test.ts` | 単体 | LabelDots と読み上げ名ヘルパ [TASK-17] [TASK-26] |
| `frontend/tests/unit/web/label-chip.test.ts` | 単体 | 管理ラベル UI 部品（LabelChip・LabelToggleGroup・LabelFilter） [TASK-26] |
| `frontend/tests/unit/web/label-picker.test.ts` | 単体 | LabelPicker（レシート詳細副行右端ボタン + popover・差分・rollback） [TASK-17] [TASK-26] |
| `frontend/tests/unit/web/popover-panel.test.ts` | 単体 | PopoverPanel（role=dialog・フォーカス・sheet-narrow） [TASK-27] |
| `frontend/tests/unit/stores.test.ts` | 単体 | web / widget の Pinia store が独立していること |
| `frontend/tests/unit/inline-widget-html.test.ts` | 単体 | widget 単一 HTML 化 build plugin（TASK-50: 偽 bundle で script/stylesheet の inline・modulepreload 除去・`</script` エスケープ・chunk の非放出・postcondition の error〔bundle に無い asset・CSS の url()/@import・残存 src/href〕・package.json build script と vite.widget.config.ts〔単一 entry + codeSplitting: false + emptyOutDir: false + inline plugin〕・web pass が web.html のみを input に持つことの文本検証） |
| `frontend/tests/unit/usage-docs.test.ts` | 単体 | docs/usage 取り込み build plugin [TASK-141 テスト先行]（frontend/src/build/usage-docs.ts: frontmatter 必須項目〔title・summary・order〕と欠落例外・トピック一覧〔slug・順序〕と docs/usage/README.md 表の一致・fenced block 3種の部品列写像〔connect-url・connect-flow・figure-pending の属性保持〕・未知 usage:* block の変換失敗・生 HTML 無効化・画像参照の assets/usage 実在解決・本文の内部語彙不在〔TASK-数字・chat_upload・registry.rs の tool 名〕・許可語彙が backend scope_description と一致・「90日」が configs/{dev,stg,prod}/auth.toml grant_absolute_days と一致・vite.config.ts の plugin 登録。node 環境で docs/usage・configs・backend ソースを読む）・PR#4 review 追加分 [TASK-171]（frontmatter order 空値拒否・public key 受理除外・image line は top level standalone line のみ〔container 内・段落混入・inline `<img>` の違反別 error〕・dev watcher の add event・load() の .md 本体 addWatchFile） |
| `frontend/tests/unit/eslint-rules.test.ts` | 単体 | ESLint 設定で `vue/no-v-html` がエラーになること |
| `scripts/deploy/test_kakeiboot_ops.py` | 単体 | deploy運用操作script（kakeiboot_ops.py）の config読取（deploy.toml+local後勝ちmerge・validation）・transport別command構成（local=旧run配列と同一・ssh=host経由）・healthz port解決・exec引数透過・dry-run・healthz retry形状 [TASK-118]・backup script SRC/DEST相対導出（repo正本を一時layoutで単体実行し /srv/opt 直書き不在を検証）・unit .in正本（{{deploy_root}} placeholder・冒頭comment・旧直書きfile不在・timer対象外）・render_unit（deploy_root置換・%i保持・残存placeholder error）・install-units（render→rsync→daemon-reload・home展開・dry-runのrender内容表示・mise units:install task） [TASK-119]・install-units 失敗時の実行済み step 一覧報告 [TASK-171] |
| `frontend/tests/browser/capture.spec.ts` | 撮影 | 全画面（/axes 軸詳細を含む [TASK-89]）の png・metrics.json を幅別に出力 |
| `frontend/tests/browser/capture.usage.spec.ts` | 撮影 | 使い方ページ用の login/consent 画像（asset へ配置） |
| `frontend/tests/browser/verify.spec.ts` | 実ブラウザ検証 | 実レイアウト実測（着地・補正・幅・軸・境界値・検索チップ） [TASK-19] [TASK-42] [TASK-44] [TASK-41] [TASK-77]・zone 見出し可視・セグメント/swatch 同色・2列/1列・zone--list 38rem・768px trend 収まり [TASK-105]・trend 窓 slide 連続実測（360px・旧bar要素再利用・dense gridline・reduced motion） [TASK-115]・積み上げ棒の実測（daily セグメント幾何・実色・360px fit） [TASK-116]・TASK-123 文法の実測（全周 1px 縁取り light/dark・中段角丸なしと cap 式角・配分規則D/F の 1円月 route override・週行 DOM 積み上げ bar の高さ・fill 比実測）・TASK-129 の実測（ランキング行bar 6px・縁取り4辺・右端cap・bar/track=value/scale・share欠落「ほか」行も value/scale・週行との同一尺度・規則Fの3px未満行・resize 再計測・支払方法 button 行 44px・押下トグル回帰）・TASK-131 の実測（全 bar-col 下端=zero baseline・最大棒は max gridline を越えない・高比率 ladder 窓〔100/95/90% 同居 route override〕で棒高設計式の直接検出）・TASK-124 の実測（時期チップ送りの URL period key 置換=履歴非積算と browser戻るの entry 期間復元・直リンク labels+期間の復元・topbar ‹ の 44px/brand直後/親section遷移） [TASK-124]・週行7日化のlabel/fetch実測 [TASK-146]・TASK-161 の実測（絶対窓: 9月focus後も10月bar/step pair 44px・内訳zone の絶対目盛り5段階ratio配置・bar内系列名label・--row-bar-h 12px・radius 2px・初期窓の trend-next 有効化・E2a/E2b仕様の窓観測）・TASK-162 の実測（BreakdownBar 1本bar: 上位5+「ほか」の残余=合計基準・累積右端=tick位置・resize再計算・segment button の Tab/focus/遷移・row bar 文法の実測は /categories ranking 行へ移設+16px・縦棒全segmentの直立縦書きlabel〔labelMin fold・例外A・Receipts day/week/month〕・年tick行〔先頭の年+1月境界・年月非交差・slide後一致〕・bar幅48px/nav中列外/余白分類実測・series色対応の3者化〔trend・BreakdownBar・/categories〕） |
| `frontend/tests/browser/verify-shell.spec.ts` | 実ブラウザ検証 | shell 系実測（名前併記・popover 補正・sheet 切替・drawer〔初期 closed・scrim 外タップ [TASK-89]〕・grant chip・表題中央寄せ） [TASK-60] [TASK-20] [TASK-69]・series token の dark 切替 [TASK-105] |
| `frontend/tests/browser/verify-labels.spec.ts` | 実ブラウザ検証 | ラベル系実測（行幅・popover 収まり・チップ・コントラスト・picker の色 tap で閉じ） [TASK-60] [TASK-51] |
| `frontend/tests/browser/verify-usage.spec.ts` | 実ブラウザ検証 | /usage/connect のコピー button icon 切替と URL box 高さ不変（reduced-motion 対応） [TASK-48] |
| `frontend/tests/browser/measure.ts` | 補助 | WCAG コントラスト比計算・viewport 内判定 [TASK-60] |
| `frontend/tests/browser/stub.ts` | 補助 | browser 実行用の API stub（seed 差し替え option 付き。`mise run frontend:browser` が使用） |
