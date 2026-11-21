# 仕様: データモデル（SQLite）

budget-book の永続データ構造の正本。テーブル構成・制約・draft のライフサイクル・冪等性・TTL・金額/日時/ID の規則・検索と集計を定める。DDL は本書末尾の「DDL」節を正とする。

## 1. 前提

- MCP クライアントは初版 ChatGPT のみ。web 画面は補助（ログイン・登録・補助操作）。web 画面での事後画像紐付けは初版で持たない。
- レシートの OCR は ChatGPT 側で行い、修正・承認は会話経由の tool 呼び出しと widget の承認ボタンで行う。
- 想定規模は個人〜家族（レシート年数千件、明細年数万行。全 ledger 合計で明細数十万行まで）。この規模では索引付き JOIN の都度集計で足りるため、事前集計テーブルは持たない。
- 通貨は JPY、日時の現地時刻は JST に固定する（通貨列・UTC オフセット列は持たない。外貨・海外利用が要件化した時点で migration で列追加する）。

## 2. 全体構成

| 区分 | テーブル | 目的 |
|---|---|---|
| ユーザー・家計簿 | users / ledgers / ledger_members | 認証主体と、データのスコープ単位である家計簿（ledger）、そのメンバーシップ（ユーザーごとの表示色を含む） |
| 認証 | webauthn_credentials / webauthn_ceremonies / web_sessions / invitations / register_invitations | パスキー、web 画面セッション、登録・回復用の1回限り token（setup / invite / recovery）と登録招待（register） |
| 認可（OAuth） | oauth_clients / oauth_jwks_cache / oauth_authorization_requests / oauth_grants / oauth_auth_codes / oauth_access_tokens / oauth_refresh_tokens / oauth_client_assertion_jtis | MCP クライアント向け OAuth 2.1 認可サーバー |
| アカウント特定・回復依頼 | user_subject_hashes / recovery_requests / recovery_request_candidates / recovery_overflow_daily | 運用者がアカウントを特定するための手がかりと、MCP からの回復依頼 |
| カタログ | item_categories / store_categories / stores / store_aliases | 品目カテゴリ・店カテゴリ（各2階層）、店マスタと名寄せ用別名 |
| 確定データ | images / image_access_tokens / receipts / receipt_items | 画像と widget 表示用の短命アクセス token、レシート（ヘッダ）、明細 |
| ラベル | ledger_labels / receipt_labels | ledger 単位の固定5色ラベル定義（任意タイトル）とレシートへの付与（複数可） |
| 作業領域 | drafts | 会話中の未確定レシート（staging） |
| 検索・集計 | receipt_items_fts / v_item_facts | 品目の全文検索索引、集計用ファクトビュー |
| 監査 | audit_events | 変更前後の記録 |

migration は次の粒度で分割する: `0001_users_ledgers.sql` / `0002_auth.sql` / `0003_catalog.sql` / `0004_images_receipts.sql` / `0005_drafts.sql` / `0006_search.sql` / `0007_audit.sql` / `0008_ledger_ui.sql` / `0009_labels.sql` / `0010_drafts_batch.sql` / `0011_register_invitations.sql` / `0012_revoke_superseded_refresh_children.sql` / `0013_ledger_share_tickets.sql`。

- 0001 はユーザー・家計簿（users のアカウント特定用の列を含む）。
- 0002 は認証・認可・招待（WebAuthn、web セッション、invitations、OAuth、アカウント特定・回復依頼のテーブル、`oauth_grants.active_ledger_id` の越境防止トリガと ledger_members の所属変更トリガ）。0001 の users / ledgers / ledger_members を参照するため 0001 の後に置く。
- 0008 は家計簿 UI（`ledger_members.color` の追加と backfill、当時「<表示名>の家計簿」で作られていた個人 ledger の `default book` 改名。登録経路の命名は TASK-79 で「<表示名>の家計簿」に戻った）。
- 0009 はラベル（`ledger_labels` / `receipt_labels`、seed トリガ、既存 ledger への backfill）。
- 0010 は一括作成（`drafts.batch_id` の追加と部分索引 `drafts_batch`。TASK-18）。
- 0011 は登録招待（`register_invitations`。CREATE TABLE のみ。TASK-32）。
- 0012 は既存データ補正のみ（猶予内再発行で差し替えられたが失効していなかった旧の子 refresh 行に `revoked_at` を設定。テーブル変更なし。TASK-140）。
- 0013 は家計簿の参加チケット（`ledger_share_tickets`。CREATE TABLE のみ）。

## 3. SQLite 共通規則

- 全テーブル `STRICT`。真偽値は INTEGER 0/1。
- 接続時に `PRAGMA foreign_keys=ON; journal_mode=WAL; busy_timeout=5000; synchronous=NORMAL` を設定する（sqlx の `SqliteConnectOptions`）。
- 書き込み tx はすべて `BEGIN IMMEDIATE` で開始する。sqlx の `pool.begin()`（DEFERRED）は使わず `begin_with("BEGIN IMMEDIATE")` を使う（使えない場合は手動 `BEGIN IMMEDIATE` と drop 時 ROLLBACK のガード型）。IMMEDIATE tx 内の条件付き UPDATE が `changes()=0` になった場合は再試行せず、不変条件違反（内部エラー）として ROLLBACK する。
- CHECK で値を固定するのは、値の追加が設計変更を伴う状態機械・構造区分（`drafts.status`、`drafts.image_status`、`receipt_items.line_kind`、`receipts.source`、`receipts.tax_mode`、`webauthn_ceremonies.kind`、`invitations.kind`、`recovery_requests.status`）と、範囲・形式・整合の制約に限る。増えうる列挙（支払方法、`image_unavailable_reason`、`category_source`、`revoked_reason`、audit の `action`/`entity_type`/`actor_kind`、`token_endpoint_auth_method`、`role`、画像メタデータの `*_source`、`users.invited_via_kind`、`user_subject_hashes.issuer`、`recovery_request_candidates.source`、`ledger_labels.color` / `receipt_labels.color`）は TEXT とし、Rust 側の enum で検証する。
- ラベル色（red / yellow / green / blue / purple）の正本は Rust の `domain::labels::LABEL_COLORS`（`backend/src/domain/labels.rs`）で、migration 0009 の seed トリガと backfill の SQL にも同じ列挙が現れる（2か所管理）。色の増減は migration とコードの両方を揃える設計変更で、一致は条件 `db-schema.ledger-labels-match-enum` で検査する。`*_labels.color` の妥当性は DB では seed 定義行への複合 FK で保証する（6-4）。

## 4. 家計簿（ledger）スコープと越境防止

- データ行は `ledger_id` でスコープし、作成者は `created_by` / `user_id` に保持する。全データ行は ledger_id 経由または user_id 直接で認証主体に辿れる。
- ユーザー作成時に個人 ledger を1つ自動作成し、`users.default_ledger_id` に設定する（`ledger_members.role='owner'`）。家族共有はメンバー追加で行う。個人 ledger の名前は「<表示名>の家計簿」（`store::personal_ledger_name`。TASK-79。0008 で一斉 `default book` 化された後、登録経路は同式に戻った。trim 後空の表示名と `max_ledger_name_chars` に接尾が入らない設定値のみ定数 `default book` へ fallback し、表示名側を切詰めて全体を上限内に収める）。名前は web 画面と MCP（`rename_ledger`）から変更できる（`ledgers.name`。trim 後 1〜100 字〔`max_ledger_name_chars`〕。同一ユーザーの所属内での重複は申告レベルで拒否し DB 制約は持たない。別ユーザー間の同名は可。import〔spec_mcp-tools §12 の取り込み〕は取り込み元の名前をそのまま使うためこの重複検査の対象外で、同名の家計簿が並ぶことがある）。
- `ledger_members.color` はユーザーごとの家計簿表示色。6色パレット（teal / orange / pink / brown / slate / graphite）のキーを保存（CHECK、NOT NULL DEFAULT 'teal'）。所属行の作成時にそのユーザーで未使用のパレット先頭キーを自動割当し、全色使用済みなら所属数 mod 6 のキーにする（TASK-34。ユーザー操作での変更 UI・API は持たない）。
- 認可は「認証主体の user_id → 対象 ledger → `ledger_members` で所属と role を確認」で解決し、全データクエリは `ledger_id = ?` で絞る。書き込み（承認等）は role が editor 以上であることを確認する。対象 ledger は次の順で決める（詳細は `spec_auth.md` §5-3・§6）。
  - web 画面: `users.default_ledger_id`。
  - MCP: grant の選択中 ledger `oauth_grants.active_ledger_id`（所属を毎回確認。NULL・所属外は未選択として tool が選び直しを促す）。tool の任意引数 `ledger_id` があれば一回限りその ledger（所属・role を同様に確認。`active_ledger_id` は変えない）。
  - draft 系 tool（修正・承認・破棄・reopen、draft_id 指定の取得）: draft の `ledger_id` で解決し（引数 `ledger_id` と矛盾すればエラー）、その ledger の所属と role を再検証する。
- 「`ledger_id = ?` で絞る」の例外（いずれも所属 ledger の範囲に限る）:
  - 自分の draft 一覧（`get_receipt_drafts` の一覧）: `WHERE user_id = ?` で全所属 ledger を横断する。
  - widget 用の画像 URL 発行と配信（`refresh_widget_images`、`/media/img/<token>`）: `ledger_id IN (所属 ledger)` で絞り、配信時に所属・レシートの削除状態・draft の状態と user を再検査する（`spec_mcp-tools.md` §11-5）。
- データの書き出し・取り込み（TASK-58）: 書き出し（`POST /api/ledgers/{l}/export`）は対象 ledger 1件の確定データ（labels・categories・stores・images・live receipts+items+labels。drafts・論理削除済み・members・認証系を除く）を単一 JSON ファイルに書き出し、取り込み（`POST /api/ledgers/import`）はそれを**新規 ledger** として復元する（既存 ledger には触れない・id は置換・正規化導出列は再計算。形式・上限・検証の詳細は `spec_mcp-tools.md` §12）。利用者向けのデータ持ち出し・復帰であって、運用 backup の代替ではない。
- `oauth_grants.active_ledger_id` には grant の user が所属する ledger しか設定できない（トリガ）。メンバーから外れると、その user の grant の選択はトリガで NULL に戻る。`ledger_members` の `ledger_id` / `user_id` は変更不可（所属変更は DELETE + INSERT）。
- tool / web 入力の ID は必ず `WHERE id = ? AND ledger_id = ?` で解決する。
- 最終防衛線として、別 ledger を参照しうる FK（明細の `category_id`、レシートの `store_id`/`image_id`、店の `category_id`、別名の `store_id`、draft の `image_id`、画像アクセス token の `image_id`、カテゴリの `parent_id`、明細の `receipt_id`、ラベル付与の `receipt_id`）は BEFORE INSERT / BEFORE UPDATE トリガで ledger 一致を強制し、`ledger_id` の変更も禁止する。複合 FK は ON DELETE SET NULL が NOT NULL の `ledger_id` と衝突するため使わない。唯一の例外は `receipt_labels` の `(ledger_id, color) → ledger_labels` 複合 FK（0009）で、ON DELETE CASCADE のためこの衝突が起きない（定義行が消えるのは ledger 削除時のみ）。
- draft は `user_id`（会話主体）と `ledger_id`（確定先）の両方を持つ。

## 5. カタログ（カテゴリ・店）

### 5-1 カテゴリ

- 品目カテゴリ（item_categories）と店カテゴリ（store_categories）は同形の別テーブル（FK で種類の取り違えを防ぐ）。CRUD は Rust 側で共通化する。
- ledger ごとのユーザー定義。ledger 作成時に初期セット（9節）を投入する。新カテゴリの作成は明示操作のみ（モデル推定値から自動作成しない）。
- 2階層（大分類 / 小分類）。`parent_id` で表し、深さ3以上・自己参照・他 ledger の親はトリガ/CHECK で拒否する。名前は `(ledger_id, 親, name)` で一意。不要カテゴリは `archived_at` で非表示にする。
- 明細は大分類・小分類のどちらにも付けられる。大分類集計は `COALESCE(parent_id, id)` で畳み、大分類だけ付いた明細もそのまま合算する。

### 5-2 店マスタと名寄せ

- stores は店舗（支店）単位。チェーン単位の集計は持たない（必要時に store_chains を追加）。
- receipts は `store_id`（名寄せ結果）と `store_name_raw`（印字どおり）の両方を持ち、名寄せの誤りを後から直せる。
- 自動名寄せは正規化（NFKC・小文字化・空白除去・ひらがな→カタカナ）後の完全一致のみ。`store_aliases(ledger_id, alias_norm)` → `stores.name_norm` の順で解決し、未知なら店と別名を新規作成する。
- 曖昧一致の統合（merge）は web 画面の明示操作で行う（元に戻せないため MCP tool には持たせない。`spec_mcp-tools.md` §13）: 参照を付け替え、旧店の表記を統合先の別名として登録し、旧店を削除する。
- 店カテゴリは店に1つ持ち、レシートへ複製しない（店のカテゴリ変更は過去分の集計にも反映される）。

### 5-3 モデル推定カテゴリ

- tool はカテゴリ一覧を返し、モデルは既存カテゴリから選ぶ。draft では文字列（`"大分類/小分類"`）で保持する。
- 承認時に名前で解決し、未知名は未分類（`category_id` NULL）として警告を返す。
- サーバーは過去の同名品目（`name_norm` 一致、`category_source='user'` を優先、次に購入日の新しい順）のカテゴリを提案する。
- 明細の `category_source` は `model` / `history` / `user`。会話・web でユーザーが直したものは `user`。

## 6. 確定データ（images / receipts / receipt_items）

### 6-1 receipts

- 1レシート＝1回の購入。店・購入日時・支払方法・画像を持つ。
- `source` は `image`（画像入力由来）/ `manual`（手動入力）。入力経路の規則: MCP 経由は手動入力（画像なし、会話で金額を伝えるもの）も含め draft→承認で確定する。web 画面のフォーム入力は draft を経ず直接確定する。画像が無いレシートは `image_id` NULL。
- `source` は draft の入力種別で決める: `drafts.image_status='none'`（手動入力）なら `manual`、それ以外（attached / unavailable）は `image`。画像が保存できなかった画像入力（chat_upload 等）も `image` とし、画像の有無は `image_id` で判定する。web フォームの直接確定は `manual`。
- 印字値として `tax_mode`（`inclusive`/`exclusive`/NULL=不明）、`total_amount`、`tax_amount`、`payment_method` を任意で持つ。支払方法はアプリ側の固定 enum: `cash` / `credit_card` / `debit_card` / `e_money` / `qr_code` / `point` / `gift_card` / `bank_transfer` / `other`。ポイント利用は支払方法側で扱い、値引にしない。
- 編集の楽観ロック用に `revision` を持つ。内容の編集に加え、論理削除・復元でも +1 する（削除・復元の UPDATE と同じ文で）。ラベルの付け外し（6-4）は `receipts` 行を更新しないため `revision` も `updated_at` も変えない。
- 論理削除（`deleted_at`）。明細はレシートと一体で論理削除扱いになる。論理削除から90日で物理削除する（明細・FTS はカスケード/トリガで消え、画像は孤立画像掃除で消える）。

### 6-2 receipt_items

- 1行＝印字された1行。`line_kind` は `item`（品目）/ `discount`（値引）。
- 値引は独立行（`amount <= 0`）。対象品目がある場合は `parent_item_id` で同一レシートの item 行を参照する（トリガで強制。値引を持つ行は item から変更不可）。値引行の `category_id` は対象品目のカテゴリをアプリが複写し、品目のカテゴリ変更時に同じ tx で更新する。全体値引（parent なし）は未分類として集計に出る。
- `name`（表示名）/ `name_raw`（印字名）と、それぞれの正規化 `name_norm` / `name_raw_norm`（NFKC・小文字・ひらがな→カタカナ、Rust 側で生成）。
- `quantity` は REAL（既定1、量り売り対応）+ 任意の `unit`。`unit_price` は任意。金額計算には使わず、`amount` を正とする。
- `ledger_id` を非正規化して持つ（名前索引・認可用。receipts との一致と不変をトリガで強制）。
- 画像内座標は正規化 bbox（`bbox_x/y/w/h`、0〜1、EXIF 向き補正後の保存画像基準）。4列すべて NULL かすべて範囲内。表示補助のみに用い、ずれても機能は壊れない。店名・合計欄の座標は持たない。
- 明細の編集・個別削除は物理で行い、変更前後を audit_events に記録する。

### 6-3 images

- WebP に変換してファイルシステムへ保存し、DB にはパスとメタ情報を持つ。ファイル名は ULID（`file_key`、パス推測防止と日付ディレクトリ分割）。`storage_path` は画像ルートからの相対パス。
- `sha256` は取得バイト列（変換前）の hash。`(ledger_id, sha256)` で索引する。
- `source_file_id`（openai file id）と取得元 `source_host` を監査・重複検知用に残す（`images(ledger_id, source_file_id)` 索引。一意ではない）。`download_url` は失効する一時値のため保存しない。
- 承認時の警告（approve_receipt_draft の warnings）は、同一 file_id・同一画像 sha256・（店, 購入日, 合計）一致の3種の重複検知で返す（拒否はしない。照合基準は `spec_mcp-tools.md` §6）。
- widget 表示用の短命アクセス token は `image_access_tokens` に保存する（256bit 乱数の SHA-256 hash を PK、`image_id`・`ledger_id`（画像と一致をトリガで強制）・発行先 `user_id`・`expires_at`。TTL は `configs/<env>/mcp.toml`、初期値15分。期限内は複数回使える）。配信時の再検査は `spec_mcp-tools.md` §11-5。
- 確定メタデータ（出所付き）:
  - 撮影日時: `taken_at_local`（'YYYY-MM-DDTHH:MM:SS'）+ `taken_at_offset`（EXIF の OffsetTimeOriginal があれば）+ `taken_at_source`。EXIF があれば `exif`、無ければモデル申告値を `model`。
  - 元ファイル名: `original_filename` + `original_filename_source`。取得応答の Content-Disposition にあれば `download`、無ければモデル申告値を `model`。
  - `exif_json` は抽出した EXIF 生値。GPS 情報は保存しない。

### 6-4 レシートラベル（ledger_labels / receipt_labels）

- 固定5色（red / yellow / green / blue / purple）・ledger 単位の共有ラベル。1色=1定義行（`ledger_labels`、PK `(ledger_id, color)`、WITHOUT ROWID）。既定は色だけで、タイトルは任意（`title` nullable TEXT。trim 後 1〜20字・Unicode scalar、空文字は NULL、一意制約なし。上限は `configs/<env>/mcp.toml` の `max_label_title_chars`）。色の増減は migration を伴う設計変更（3節）。
- 定義行は `AFTER INSERT ON ledgers` トリガ（0009）で5行 seed する。`store::create_ledger_with_seed`・登録 ceremony の直接 INSERT・テスト helper の直接 INSERT など作成経路に依らない。既存 ledger へは 0009 の backfill で投入した。`ledger_id` / `color` はトリガで不変（`title` のみ UPDATE 可）。ledger 行の削除（アプリ経路は無い）で CASCADE する。
- 付与は `receipt_labels(receipt_id, color)` の関連行（insert / delete only。行の UPDATE はトリガで禁止）。1レシートに複数色を付与できる。`receipt_id` の ledger 一致はトリガで強制し、色の妥当性は `(ledger_id, color) → ledger_labels` の複合 FK（CASCADE）で保証する（`color` に CHECK を付けない）。
- 付け外しは差分（add / remove）で冪等・可換（add は `INSERT OR IGNORE`、remove は `DELETE`）。`receipts.revision` / `updated_at` は変えない（楽観ロックと独立に失われる更新がない）。変化したレシートにのみ audit（entity_type `receipt` / action `label`、before・after は色キーの配列）。タイトル変更は entity_type `ledger_label` / action `update`（同値の再設定は記録しない）。draft の作成時指定（`payload.label_colors`・TASK-21）の承認時付与も `INSERT OR IGNORE` で行い、作成時付与の証跡は draft 承認の audit（`after_json` = payload_json）に一元化して receipt/label の audit 行は重複して残さない（§7-5）。
- 論理削除しても付与は保持し、復元でそのまま戻る。削除中の付け外しは不可（web は 409 `deleted`、MCP は skipped）。90日の物理削除（purge）で FK CASCADE によりレシートと共に消える。
- 書き込み（付与・解除・タイトル設定）は editor 以上。定義一覧の読み取りと検索・集計のラベル絞り込みは member 全員。

## 7. draft（staging）

### 7-1 構造

- drafts テーブル1つに JSON payload（receipt + items）を持ち、承認時に本テーブルへ展開する。本テーブルは確定データのみとなり、集計・検索の条件漏れで未承認データが混入しない。
- payload の JSON 形は MCP tool I/O スキーマと共有する serde 型1つで定義する。未解決値（店名・店カテゴリ名・品目カテゴリ名の文字列）をそのまま持つ。概形:

```json
{
  "store_name": "イオン○○店", "store_name_raw": "AEON ○○", "store_category": "スーパー",
  "purchased_on": "2026-10-11", "purchased_time": "18:42",
  "tax_mode": "inclusive", "total_amount": 1234, "tax_amount": 91,
  "payment_method": "credit_card", "note": null,
  "label_colors": ["red", "blue"],
  "items": [
    {"line_no": 1, "line_kind": "item", "name": "牛乳", "name_raw": "ｷﾞｭｳﾆｭｳ1L",
     "quantity": 1, "unit_price": 198, "amount": 198, "tax_rate": 8,
     "category": "食費/食料品", "bbox": [0.08, 0.31, 0.6, 0.03]},
    {"line_no": 2, "line_kind": "discount", "parent_line_no": 1, "name": "値引", "amount": -20}
  ]
}
```

- モデル申告メタデータの生値は `reported_filename` / `reported_taken_at` に保持する（出所は常に model）。確定値と出所は画像の保存時に images 側へ書く。申告値と確定値の両方が残るため食い違いを後から確認できる。画像なしで承認されたレシートでは申告メタデータは draft 行にのみ残る。
- draft とメタデータは最初の tool 呼び出しで必ず保存する。画像はその呼び出しで届いた時だけ保存し、届かなければ画像なしで扱う。
- 購入日が読めない場合、draft 段階で撮影日時（EXIF 優先）の日付を初期値に入れる。承認時は `purchased_on` 必須。
- revision 履歴テーブルは持たない（承認時の最終 payload は audit_events に残る）。
- `batch_id`（TEXT、NULL 可）: 同じ `create_receipt_drafts` 呼び出しで作った draft（兄弟）の共通 ID（ULID）。1件版の作成と reopen は NULL。用途は重複検知の file_id 照合から兄弟を除外することだけ（`spec_mcp-tools.md` §6）。reopen は batch_id をコピーしない。
- `label_colors`（TASK-21）: 作成時（#1 / #20 の payload）と `update_receipt_draft` の `set` で指定する draft 段階ラベルの色キー配列。保存前に重複を除き定義順（red / yellow / green / blue / purple）へ正規化し、null と空配列は「なし」（None）として保存するため、保存済み payload は常に正規形。reopen は `payload_json` のコピーでそのまま引き継ぐ。承認時に `receipt_labels` へ引き継がれる（§7-5）。

### 7-2 ライフサイクル

| status | 意味 | 遷移 |
|---|---|---|
| pending | 会話中。修正・承認・破棄が可能（画像は作成時の呼び出しの中でのみ確定し、後から付与しない） | 作成時 |
| approved | 承認済み。`approved_receipt_id` / `approved_revision` を持つ | pending → 承認 tx |
| discarded | 破棄 | pending → 破棄操作 |
| expired | 期限切れ | pending → TTL ジョブ（最終更新から14日） |

- pending 以外は `closed_at` 非NULL。close（approve/discard/expire）時に `image_id` を NULL 化する（CHECK で強制）。`image_status`・`image_unavailable_reason` は close 前の値を保持する。これにより画像の参照元は receipts と pending draft のみになる。
- 破棄・期限切れの後に作り直す場合は明示的な reopen 操作（`spec_mcp-tools.md` §7-6）。reopen は元 draft を変更せず新しい pending draft を INSERT する: `payload_json`・`reported_*` は元の値、`source_file_id`・`image_id` は NULL、`revision` 1、`expires_at` = now + 14日、画像状態は元が `none` なら `none`、それ以外は `unavailable` + reason `reopened`。元 draft の ID は audit_events（`entity_type=draft`、`action=reopen`、`entity_id` = 新 draft、`after_json` に `reopened_from`）に記録する（列は持たない）。対象は行が残っている間（close から30日）。

`image_status`（遷移の正本は `spec_mcp-tools.md` §5）:

| 値 | 意味 |
|---|---|
| none | 画像を伴わない draft（手動入力） |
| attached | 画像付与済み（pending 中は `image_id` 非NULL と同値） |
| unavailable | 画像なし。理由を `image_unavailable_reason` に記録する |

- `unavailable` は `image_unavailable_reason` 必須、それ以外は NULL（CHECK）。
- `image_unavailable_reason`（アプリ側 enum）: `fetch_interrupted`（作成直後の取得前・取得中、または取得が中断されたまま）/ `chat_upload` / `missing_arg`（画像キー欠落・null・その他の文字列）/ `fetch_failed` / `too_large` / `decode_failed` / `fetch_timeout` / `reopened`。

### 7-3 revision

- `drafts.revision` は payload・画像・メタデータのいずれかが変わるたびに +1（作成時の画像確定 = attached または失敗理由への更新も widget 表示を変えるため含む）。
- 修正 tool は revision を要求せず、サーバー側で現在値に patch を当てて +1 する。承認 tool は revision 必須で、不一致なら拒否して現在の revision と内容を返す（widget は表示中の revision を渡し、古い表示からの承認を拒否する）。

```sql
-- 修正
UPDATE drafts SET payload_json = ?1, revision = revision + 1, updated_at = ?2, expires_at = ?3
WHERE id = ?4 AND user_id = ?5 AND status = 'pending'
RETURNING revision;
-- 破棄
UPDATE drafts SET status='discarded', image_id=NULL, closed_at=?1, updated_at=?1
WHERE id=?2 AND user_id=?3 AND status='pending';
```

### 7-4 作成と冪等性

- 作成 tool は呼ぶたびに新しい draft を作る。file_id・draft_id による冪等・既存 draft への統合や連結は持たない（`drafts.source_file_id` は一意ではない）。
- `chat_upload` 文字列（#185）・画像キー欠落・null・その他の文字列（#237 等）・取得失敗は、いずれも isError にせず画像なし draft として正常応答し、理由を `image_unavailable_reason` に記録するだけとする（再試行の促しはしない）。
- 同じ画像・同じ内容の重複は防がず、承認時の警告と draft の応答・一覧で検知して知らせる（同一 file_id・同一 sha256・（店, 購入日, 合計）一致。`spec_mcp-tools.md` §6）。
- 承認の二重呼び出しは 7-5 の冪等成功。

作成手順:

```
0. 前処理（DB 書込前）: payload を serde で検証（失敗は入力検証エラーで draft を作らない）。
   対象 ledger は引数 ledger_id か選択中 ledger（どちらも無ければ isError）。
1. BEGIN IMMEDIATE で INSERT INTO drafts（status='pending', revision=1, payload_json, reported_*, expires_at=now+14日）:
   - 手動入力: image_status='none'、reason NULL
   - 画像入力でファイルオブジェクトが届いた: image_status='unavailable', reason='fetch_interrupted',
     source_file_id=:fid（取得前に保存する）
   - 画像入力でファイルオブジェクト以外: image_status='unavailable', reason='chat_upload' または 'missing_arg'
   COMMIT。
2. ファイルオブジェクトが届いた場合のみ、tx の外で download_url を1回だけ取得・EXIF 抽出・WebP 変換する
   （safe_fetch、fetch_timeout_secs の期限内。デコードはプロセス共有の DecodeGate の permit を取って行う。`spec_mcp-tools.md` §5-3）。
3. 別の短い BEGIN IMMEDIATE tx（期限の外で必ず実行）:
   - 成功: INSERT INTO images (..., source_file_id=:fid, ...);
           UPDATE drafts SET image_id=:img, image_status='attached', image_unavailable_reason=NULL,
                  revision=revision+1, updated_at=:now WHERE id=:draft_id AND status='pending';
   - 失敗: UPDATE drafts SET image_unavailable_reason=:r, revision=revision+1, updated_at=:now
           WHERE id=:draft_id AND status='pending';   -- r = fetch_failed / too_large / decode_failed / fetch_timeout
```

- 手順3の UPDATE が0行（その間に close 済み）の場合、画像は孤立画像として掃除される。
- 手順2・3に到達しなかった draft（要求キャンセル・プロセス停止）は `unavailable(fetch_interrupted)` のまま残り、画像なし draft として通常どおり修正・承認できる。中間状態を DB に持たないため起動時の回収処理は無い。

一括作成手順（`create_receipt_drafts`、TASK-18）:

```
0. 呼び出し全体の前処理（1件版と同じ条件だけ isError）: 引数の parse、対象 ledger の解決と writer 権限。
1. 要素ごとの前処理（DB 書込前）: 先頭 batch_max_drafts 件だけを対象にし、1件版の前処理で isError になる
   条件の要素だけを保存しない（rejected）。それを超える拒否は作らない。保存する要素が0件なら isError。
2. receipt_images の分類と、保存する draft ごとの画像状態の決定（image_index の解決。spec_mcp-tools.md §5-3）。
3. 1つの BEGIN IMMEDIATE で保存する全 draft を entry 順に INSERT（共通の batch_id、source_file_id は
   参照画像の file_id）→ COMMIT（store::create_drafts。途中の制約違反は全件 ROLLBACK）。
4. tx の外で、参照される有効なファイルオブジェクトを file_id ごとに1回だけ取得・変換
   （batch_fetch_concurrency 並列、batch_fetch_deadline_secs の全体期限）。
5. ファイルごとに短い tx: 成功は images を1行 INSERT して参照する各 draft を attached に、失敗は各 draft に理由を記録。
6. draft ごとに EXIF 優先の購入日補正（1件版と同じ規則）。
```

- 「呼ぶたびに新しい draft」「統合・連結なし」は一括作成でも同じ。同じ写真を複数 draft が参照する場合も draft は統合せず、image 行を共有するだけとする。
- どの保存対象 draft からも参照されない画像は取得も保存もしない（孤立画像を作らない）。

一括作成の未決事項（実装後・stg 実機確認後に決める。`spec_mcp-tools.md` §14 T19〜T23）:

- D1 `batch_fetch_deadline_secs`・同時数の最終値（T21。ChatGPT の tool 実行時間上限は未判明）。
- D2 #20 の structuredContent を DraftView 全件のままにするか、件数が多い時に要約行 + `get_receipt_drafts` に分けるか（T23）。
- D3 `get_receipt_drafts` に `batch_id` 指定を足して batch を再表示できるようにするか（今回は入れない）。
- D4 description の共通断片の連結方式（現行は registry の `full_description` で `_payload_rules.md` を連結）。
- D5 1件版 `create_receipt_draft` を #20 に統合するか（T19 の結果後）。

### 7-5 承認トランザクション

```
BEGIN IMMEDIATE;
1. SELECT id, status, revision, approved_revision, approved_receipt_id, payload_json, image_id, ledger_id
     FROM drafts WHERE id = :draft_id AND user_id = :uid;
   - 無し → not_found
   - status='approved' AND approved_revision = :rev → 既存 approved_receipt_id を返して COMMIT（冪等成功）
   - status<>'pending' → conflict(status)
   - revision <> :rev → stale_revision(current revision と payload を返す)
   - ledger の editor 以上か確認（ledger_members）
2. payload を serde で検証。店名 → name_norm → store_aliases / stores（WHERE ledger_id = :lid）で解決、無ければ
     INSERT INTO stores ... ; INSERT INTO store_aliases ...（store_category 名は store_categories で解決、未知は NULL + 警告）
3. INSERT INTO receipts (ledger_id, created_by, source, image_id, store_id, store_name_raw, purchased_on, ...)
     VALUES (..., 'image' or 'manual', ...) RETURNING id;   -- source は image_status='none' なら manual、それ以外は image（6-1）
3b. payload.label_colors の各色を INSERT OR IGNORE INTO receipt_labels (receipt_id, ledger_id, color, created_by, created_at)
     で引き継ぐ（TASK-21。冪等再承認は手順1で return するためここへ来ない。FK 先の定義行は seed 済みで常に存在。
     作成時付与の証跡は手順6の draft 承認 audit〔after_json = payload_json が label_colors を含む〕に一元化し、
     receipt/label の audit 行は書かない。label_receipts による後からの付け外しは従来どおり audit を残す）
4. 各明細: カテゴリ名 → item_categories（WHERE ledger_id = :lid）で解決（未知は NULL + 警告、category_source='model'）、
   tax_mode と tax_rate から amount_incl を算出。item 行を先に INSERT し、値引行は parent_line_no → parent_item_id と category 複写。
     INSERT INTO receipt_items (...)   -- FTS はトリガで同期
5. UPDATE drafts SET status='approved', approved_receipt_id=:rid, approved_revision=:rev,
          image_id=NULL, closed_at=:now, updated_at=:now
     WHERE id=:draft_id AND status='pending' AND revision=:rev;
   IMMEDIATE tx 内で 1. の読み取りから状態は変わらないため changes()=1 は不変条件。0 なら内部エラーで ROLLBACK（再試行しない）
6. INSERT INTO audit_events (..., 'draft', :draft_id, 'approve', NULL, :payload, :now);
COMMIT;
返却: receipt_id、警告（明細合計 ≠ total_amount の差額、未知カテゴリ、重複検知3種 = 同一 file_id・同一画像 sha256・（店, 購入日, 合計）一致の draft / レシート、選択中 ledger と異なる確定先）
```

- draft とレシートの関連は `drafts.approved_receipt_id` の片方向のみ。レシートの出所 draft は `drafts_receipt` 索引で引く。
- `approved_receipt_id` は ON DELETE SET NULL。レシートの物理削除後も draft 行（申告メタデータの証跡）は残る。
- レシート物理削除により approved draft の `approved_receipt_id` が NULL になっている場合の再承認は、冪等成功とせず conflict エラーとして扱う。
- 一括承認（`approve_receipt_drafts`、TASK-18）は件ごとに上の承認 tx を実行する（全体 tx は持たない）。1件の stale・検証失敗で他を巻き戻さない。

## 8. 金額・税・端数処理

- 金額はすべて円単位の INTEGER。
- `receipt_items.amount` は印字どおりの行金額（値引前）。値引は別行の負の金額。
- `amount_incl` は税込換算額で、集計の正とする。承認時・編集時にサーバーが再計算する:
  - `tax_mode='inclusive'` または不明（NULL）: `amount_incl = amount`。
  - `tax_mode='exclusive'`: 各行を `amount × (100 + tax_rate) / 100` で換算し、行ごとに切り捨てる。印字税額（`tax_amount`）がある場合、換算後合計と「税抜合計 + 印字税額」の差額を金額最大の行に寄せて一致させる。
- `tax_rate` は税率%（10 / 8 / 0）、NULL は不明。軽減税率マーク（※、軽）の判定結果を記録する。
- レシート合計（`total_amount`）・消費税額（`tax_amount`）は印字値の保存のみで、集計には明細合計を使う。承認時に明細合計との差額を警告する。

## 9. カテゴリ初期セット

ledger 作成時に投入する。2階層（大分類 / 小分類）。小分類を持たない大分類は大分類のみで使う。

品目カテゴリ:

| 大分類 | 小分類 |
|---|---|
| 食費 | 食料品、外食、飲料、菓子 |
| 日用品 | 消耗品、衛生用品 |
| 住居・光熱 | （なし） |
| 交通 | 電車、バス、タクシー、燃料 |
| 医療・健康 | 薬、通院 |
| 衣服・美容 | （なし） |
| 趣味・娯楽 | （なし） |
| 教育・書籍 | （なし） |
| 交際 | （なし） |
| その他 | （なし） |

店カテゴリ（大分類のみ。小分類は利用者が追加する）:

スーパー、コンビニ、ドラッグストア、飲食店、百貨店・専門店、ネット通販、交通機関、その他

ラベル定義はこの初期セットに含めない: `ledger_labels` の5色（title すべて NULL）は 0009 の `AFTER INSERT ON ledgers` トリガで、ledger の作成経路によらず自動投入する（カテゴリ seed がアプリ関数経由なのと異なる点）。

## 10. 日時・ID

### 10-1 日時

| 種別 | 形式 |
|---|---|
| システム時刻（作成・更新・期限・失効） | INTEGER unix ミリ秒 UTC。表示時にアプリ層で JST へ変換する |
| 購入日 | `purchased_on` TEXT 'YYYY-MM-DD'（必須、印字された JST 現地日付）。月は生成列 `purchased_month`（先頭7文字、VIRTUAL） |
| 購入時刻 | `purchased_time` TEXT 'HH:MM[:SS]'（任意） |
| 撮影日時 | `images.taken_at_local` TEXT + `taken_at_offset`（任意）+ `taken_at_source` |
| 入力日時 | `receipts.created_at` |

月・日集計は印字された現地日付で行う（UTC 変換すると深夜の購入が前日に落ちるため）。

### 10-2 ID

- ドメイン行（receipts / receipt_items / drafts / stores / categories / images 等）は `INTEGER PRIMARY KEY`（短くモデルが正確に扱える）。推測可能だが、全クエリの `ledger_id` 条件で漏洩を防ぐ。
- 画像ファイル名は ULID（`images.file_key`）。
- トークン・セッション・コード・ceremony は 256bit 乱数を発行し、SHA-256 hash を PK として保存する（平文は保存しない）。
- `users.webauthn_user_handle` は UUID v4（ランダム 16byte。webauthn-rs の user unique id）。内部 ID を WebAuthn に露出しない。
- `users.account_number` は `BB-XXXX-XXXX`（Crockford base32 の8文字、ランダム、UNIQUE）。運用者がアカウントを特定するための番号で、推測困難である必要はない。回復依頼の受付番号 `recovery_requests.request_number` は `R-XXXX`（Crockford base32 4文字）。

## 11. 監査

- 全ドメイン行に `created_at` / `updated_at`。
- audit_events に actor（`actor_kind`: web / mcp / mcp_anonymous / system、`client_id`）、対象（`entity_type` / `entity_id`）、`action`（create / update / delete / restore / approve / discard / reopen / merge / label ...）、変更前後の JSON を記録する。MCP 経由の変更を後から追え、明細の誤編集は before_json から戻せる。ラベル操作の記録は `entity_type=receipt` / `action=label`（before・after は色キー配列）と `entity_type=ledger_label` / `action=update`（タイトル設定。entity_id は ledger_id、before・after に色とタイトル）。draft の作成時ラベル付与（`payload.label_colors`・TASK-21）の承認時確定は draft 承認の audit（`after_json` = payload_json）で証跡化し、receipt/label の audit 行は重複して残さない（§6-4・§7-5）。家計簿名の変更は `entity_type=ledger` / `action=rename_ledger`（entity_id は ledger_id、before・after に名前。TASK-20）。既定家計簿の変更は `entity_type=user` / `action=default_ledger`（entity_id は user_id、after に before/after の ledger_id。TASK-13）。データの書き出し・取り込みは同じく `entity_type=ledger` で `action=export`（after に件数・bytes。誰がいつ何を書き出したかの記録）/ `action=import`（新規 ledger 作成。after に名前・件数。TASK-58）。
- 認証系の記録: `actor_kind=mcp_anonymous` は匿名の MCP 呼び出し（`request_recovery` の受付）。`entity_type` に `user` / `webauthn_credential` / `invitation` / `oauth_grant` / `recovery_request` 等、`action` に `switch_ledger` / `grant_create` / `consent` / `login_mismatch` / `counter_regression` / `token_issue` / `token_revoke` / `token_use` / `passkey_revoke` / `user_disable` / `user_note` / `recovery_resolve` / `recovery_reject` / `grant_revoke` / `session_revoke` 等を加える（アプリ側 enum。一覧の正本は `spec_auth.md`）。

## 12. TTL 掃除

定期ジョブ（tokio interval。起動時にも1回）で実行する。

| 対象 | 規則 |
|---|---|
| pending draft | 最終更新から14日（`expires_at`）で `expired` に遷移し `image_id` を NULL 化 |
| expired / discarded draft | close から30日で行削除 |
| approved draft | 行は保持。payload は close から90日で NULL 化 |
| 論理削除レシート | 削除から90日で物理削除（`receipt_labels` の付与も CASCADE で消える。定義 `ledger_labels` は残る） |
| 孤立画像（receipts にも pending draft にも参照されない） | 作成から24時間経過でファイル削除 → 成功後に行削除。逆方向（行の無いファイル）は週次でディレクトリ走査。一括作成で複数 draft・レシートが共有する画像は、参照元が1つでも残る間は孤立画像にならない（既存の判定のままで成立） |
| image_access_tokens | 期限（`expires_at`）で削除。画像の行削除時は CASCADE |
| 認証系（auth code / access・refresh token / session / jti / ceremony） | 期限 + 1日で削除（jti・ceremony は期限で削除）。ただし失効済み（`revoked_at` 非NULL）の refresh token は、属する grant が有効（未失効かつ絶対期限内）な間は残し、grant が失効・絶対期限切れ（または grant 行なし）になってから期限 + 1日の規則で削除する（差し替え済みの旧の子の提示を reuse として検知し続けるため。TASK-140）。grant は失効・期限切れから30日で削除（CASCADE でトークンも削除） |
| invitations | 未使用は期限 + 1日で削除。使用済みは使用から30日で削除 |
| register_invitations | invitations と同じ規則: 未使用は期限 + 1日で削除。使用済みは使用から30日で削除 |
| ledger_share_tickets | invitations と同じ規則: 未受諾は期限 + 1日で削除。受諾済みは受諾から30日で削除 |
| oauth_authorization_requests | 期限（10分）で削除 |
| user_subject_hashes | `last_seen_at` から400日で削除 |
| recovery_requests | `ip_hash` は作成24時間後に NULL 化。open は作成から90日で自動 `rejected`。close から180日で削除（候補は CASCADE） |
| recovery_overflow_daily | 90日で削除 |

```sql
UPDATE drafts SET status='expired', image_id=NULL, closed_at=:now
WHERE status='pending' AND expires_at < :now;
DELETE FROM drafts WHERE status IN ('expired','discarded') AND closed_at < :now - 30*86400000;
UPDATE drafts SET payload_json=NULL WHERE status='approved' AND closed_at < :now - 90*86400000 AND payload_json IS NOT NULL;
-- 論理削除から90日のレシートを物理削除（明細・FTS・ラベル付与はカスケード/トリガ、画像はこの後の孤立画像掃除で消える）
DELETE FROM receipts WHERE deleted_at IS NOT NULL AND deleted_at < :now - 90*86400000;
-- 孤立画像の候補（ファイル削除成功後に行を削除）
SELECT id, storage_path FROM images im
WHERE im.created_at < :now - 86400000
  AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.image_id = im.id)
  AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.image_id = im.id);   -- image_id を持つのは pending のみ
DELETE FROM image_access_tokens WHERE expires_at < :now;
DELETE FROM oauth_auth_codes WHERE expires_at < :now - 86400000;
DELETE FROM oauth_client_assertion_jtis WHERE expires_at < :now;
DELETE FROM webauthn_ceremonies WHERE expires_at < :now;
-- access/refresh/session も期限 + 1日で削除。grant は revoked/expired の後 30日で削除（CASCADE でトークンも消える）
-- refresh は失効済み行を grant が有効な間は残す（TASK-140）:
DELETE FROM oauth_refresh_tokens WHERE expires_at < :now - 86400000
  AND (revoked_at IS NULL OR grant_id NOT IN
       (SELECT id FROM oauth_grants WHERE revoked_at IS NULL AND absolute_expires_at > :now));
DELETE FROM invitations WHERE (used_at IS NULL AND expires_at < :now - 86400000)
                           OR (used_at IS NOT NULL AND used_at < :now - 30*86400000);
DELETE FROM register_invitations WHERE (used_at IS NULL AND expires_at < :now - 86400000)
                                   OR (used_at IS NOT NULL AND used_at < :now - 30*86400000);
DELETE FROM ledger_share_tickets WHERE (accepted_at IS NULL AND expires_at < :now - 86400000)
                                   OR (accepted_at IS NOT NULL AND accepted_at < :now - 30*86400000);
DELETE FROM oauth_authorization_requests WHERE expires_at < :now;
DELETE FROM user_subject_hashes WHERE last_seen_at < :now - 400*86400000;
UPDATE recovery_requests SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at < :now - 86400000;
UPDATE recovery_requests SET status = 'rejected', closed_at = :now, close_note = 'auto: expired'
WHERE status = 'open' AND created_at < :now - 90*86400000;
DELETE FROM recovery_requests WHERE closed_at IS NOT NULL AND closed_at < :now - 180*86400000;
DELETE FROM recovery_overflow_daily WHERE day < :cutoff_day;   -- JST 日付で90日前
```

## 13. 検索と集計

### 13-1 索引方針

- 集計の入口は `receipts(ledger_id, purchased_on) WHERE deleted_at IS NULL`（部分索引）。月指定も `purchased_on` の範囲検索で同じ索引を使う（月専用索引は置かない）。
- 店別は `receipts(ledger_id, store_id, purchased_on)`。品目名検索・履歴提案は `receipt_items(ledger_id, name_norm)`。
- ラベル絞り込み（一覧・集計とも OR）は `receipt_labels` の PK `(receipt_id, color)` で受ける EXISTS / IN 参照に `receipt_labels(ledger_id, color, receipt_id)` 索引を足す。

### 13-2 品目検索（FTS5 trigram + LIKE フォールバック）

- `receipt_items_fts` は `receipt_items` を external content とする FTS5（tokenizer `trigram`）。対象列は `name_norm` / `name_raw_norm`。トリガで同期し、壊れても作り直せる構成とする。
- クエリはアプリ側で格納時と同じ正規化を適用する。正規化後の長さが3文字以上なら MATCH（`"` を `""` にエスケープし全体を `"..."` で囲んだ phrase）、2文字以下なら `name_norm` / `name_raw_norm` の LIKE で検索する。LIKE に渡す入力は `\` `%` `_` を `\` でエスケープし `ESCAPE '\'` を付ける。
- 店名検索は stores への LIKE で行う。
- FTS の MATCH は全 ledger の一致行を拾ってから `ledger_id` で絞る。多数の ledger を収容する規模になった場合は ledger ごとの FTS 分割等を検討する。

```sql
-- 正規化後のクエリ長 >= 3
SELECT f.item_id AS "item_id!", f.purchased_on AS "purchased_on!", f.store_name, f.name AS "name!", f.amount_incl AS "amount_incl!"
FROM receipt_items_fts x
JOIN v_item_facts f ON f.item_id = x.rowid
WHERE receipt_items_fts MATCH ?1
  AND f.ledger_id = ?2
  AND f.purchased_on BETWEEN ?3 AND ?4
ORDER BY f.purchased_on DESC
LIMIT 50;

-- 正規化後のクエリ長 <= 2
SELECT f.item_id AS "item_id!", f.purchased_on AS "purchased_on!", f.store_name, f.name AS "name!", f.amount_incl AS "amount_incl!"
FROM receipt_items i
JOIN v_item_facts f ON f.item_id = i.id
WHERE i.ledger_id = ?1
  AND (i.name_norm LIKE '%' || ?2 || '%' ESCAPE '\' OR i.name_raw_norm LIKE '%' || ?2 || '%' ESCAPE '\')
ORDER BY f.purchased_on DESC
LIMIT 50;
```

### 13-3 集計（v_item_facts）

- 集計は都度実行し、事前集計テーブルは持たない。集計 tool は明細×レシート×店×カテゴリのファクトビュー `v_item_facts` を使う。論理削除レシートはビューで除外される。
- 金額は `amount_incl` を合算する。品目カテゴリの大分類は `category_top_id`、店カテゴリの大分類は `store_category_top_id`。
- ラベル絞り込み（`filters.label_colors`、OR・空配列は絞り込みなし）は `v_item_facts.receipt_id` への `EXISTS (SELECT 1 FROM receipt_labels rl WHERE rl.receipt_id = f.receipt_id AND rl.color IN (...))` で表す。全 report と前期比較が共有する filter 条件の1つのため、どの report にも同じ意味（「いずれかのラベルを持つレシートの明細をすべて集計」）で掛かる。
- sqlx のオフライン検査はビュー列の NULL 可否を推論できないため、非NULL列は `AS "col!"` で上書きする（LEFT JOIN 由来の列は `Option` のまま）。

```sql
-- 月別 × 品目カテゴリ（大分類）
SELECT f.purchased_month AS "ym!",
       f.category_top_id,
       c.name AS category_name,
       SUM(f.amount_incl) AS "total!: i64",
       COUNT(DISTINCT f.receipt_id) AS "receipts!: i64"
FROM v_item_facts f
LEFT JOIN item_categories c ON c.id = f.category_top_id
WHERE f.ledger_id = ?1
  AND f.purchased_on >= ?2 AND f.purchased_on < ?3
GROUP BY 1, f.category_top_id
ORDER BY 1, 4 DESC;
```

カテゴリ履歴提案:

```sql
SELECT i.category_id
FROM receipt_items i JOIN receipts r ON r.id = i.receipt_id AND r.deleted_at IS NULL
WHERE i.ledger_id = ?1 AND i.name_norm = ?2 AND i.category_id IS NOT NULL
ORDER BY (i.category_source = 'user') DESC, r.purchased_on DESC
LIMIT 1;
```

分析系 web API（TASK-89。`spec_mcp-tools.md` §12 の /analysis 3 endpoint）の軸集計も `v_item_facts` 上の都度集計（事前集計テーブル無しの維持）:

- 軸キーは category→`category_top_id`（category filter 指定時はその `category_id`）/ store→`store_id` / item→`name`（品名。同名品目=1品目〔`/analysis/item` の item_query と同じ品名概念。REVIEW-13 M-3〕）/ payment_method→`payment_method` / label は `receipt_labels` への JOIN（下記 SQL）。count 系指標は `COUNT(DISTINCT receipt_id)`（レシート件数ベース。「1件あたり」=1レシート平均）。
- ラベル軸（axis=label）は 1レシート複数ラベルで明細が複数軸値に重複計上され、軸合計が全体金額を超えうる（OR 絞り込みと同型）。share の分母はこの重複込みの軸合計とし、内訳の合計が100%になることを保証する。行名は `ledger_labels.title` 優先（空文字・無題はパレットの既定表示名）、無ラベル行は「ラベルなし」（key NULL の別行）。
- 積み上げ推移は2段クエリ: 期間全体の軸値合計（`GROUP BY key`）で上位 N 系列を確定してから、`GROUP BY bucket_expr, key` を IN 句で絞り込む。bucket 式は day=`f.purchased_on` / week=月曜アンカーの `date(f.purchased_on, '-' || ((strftime('%w', f.purchased_on)+6)%7) || ' days')` / month=生成列 `f.purchased_month`。bucket 合計（bucket_totals）は系列絞りなしの別クエリ（ラベル軸は重複込みの labeled 分 + unlabeled 分の和）。
- 品目stats の単価規約は item_price_history と同一（`unit_price` ないし `round(amount_incl / quantity)`）。SQL 内で MIN/MAX/AVG に使うときは `CAST(... AS INTEGER)` を付ける（SQLite の ROUND は REAL を返すため）。

```sql
-- ラベル軸の軸値集計（重複計上）と無ラベル行（key NULL）
SELECT rl.color AS "k!: String", SUM(f.amount_incl) AS "a!: i64", COUNT(DISTINCT f.receipt_id) AS "c!: i64"
FROM v_item_facts f JOIN receipt_labels rl ON rl.receipt_id = f.receipt_id
WHERE f.ledger_id = ?1 AND f.purchased_on BETWEEN ?2 AND ?3
GROUP BY rl.color ORDER BY 2 DESC;
SELECT COALESCE(SUM(f.amount_incl), 0), COUNT(DISTINCT f.receipt_id)
FROM v_item_facts f
WHERE f.ledger_id = ?1 AND f.purchased_on BETWEEN ?2 AND ?3
  AND NOT EXISTS (SELECT 1 FROM receipt_labels rl WHERE rl.receipt_id = f.receipt_id);

-- 積み上げ行列（週 bucket・上位系列を IN 句で絞り込む2段目）
SELECT date(f.purchased_on, '-' || ((strftime('%w', f.purchased_on)+6)%7) || ' days') AS "b!: String",
       CAST(f.category_top_id AS TEXT) AS k,
       SUM(f.amount_incl) AS "a!: i64", COUNT(DISTINCT f.receipt_id) AS "c!: i64"
FROM v_item_facts f
WHERE f.ledger_id = ?1 AND f.purchased_on BETWEEN ?2 AND ?3
  AND f.category_top_id IN (?4)
GROUP BY 1, 2;
```

## 14. 認証系テーブル

認証・認可フローの詳細は `spec_auth.md` を正本とし、本書はテーブル構造と保存規則を定める。

| テーブル | 役割と保存規則 |
|---|---|
| users | `webauthn_user_handle`（UUID 16byte）、`default_ledger_id`（web 画面の対象 ledger）。`disabled_at` 非NULLなら全認証経路で拒否。アカウント特定用に `account_number`、`admin_note`（運用者メモ）、`invite_note`（招待者メモ）、`invited_by` / `invited_via_kind`（招待の系譜。setup / invite / register）を持つ。メモは運用者 CLI のみで表示し、web・MCP に出さない |
| webauthn_credentials | `credential_id` 一意、webauthn-rs の `Passkey` を JSON で保存（認証成功時に更新） |
| webauthn_ceremonies | 登録/認証の途中状態を JSON 保存。TTL 5分、1回使用で削除。ログイン中の ceremony（step-up・パスキー追加）は `user_id` を持つ。OAuth 途中のログインは `authz_request_hash` で authorization request を参照する（平文の request ID は DB に置かない） |
| web_sessions | cookie はランダム32byte、DB は SHA-256 hash。idle 期限・絶対期限・`revoked_at`。`auth_at` は最後のパスキー認証時刻（ログイン時 = `created_at`、step-up で更新） |
| invitations | setup / invite / recovery の1回限り token（hash 保存）。kind ごとに必須列を CHECK で固定。setup は `operator_note` 必須、`inviter_note` は invite のみ。未使用の recovery token は user ごとに1本（部分 UNIQUE。失効は行削除）。使用は `used_at` の条件付き UPDATE で二重使用を防ぐ |
| register_invitations | web から発行される登録専用の1回限り token（hash 保存）。`created_by`（発行者・CASCADE）・`inviter_note` 必須。未使用は発行者ごとに5本（アプリ側検証）。失効は行削除。使用は `used_at` の条件付き UPDATE |
| ledger_share_tickets | web から発行される家計簿参加専用の1回限り token（hash 保存）。対象 `ledger_id`・`role`（editor / viewer）・`created_by`（発行者・CASCADE）を持つ。アカウントは作らない。消費は参加受諾時の `accepted_at` の条件付き UPDATE のみで、照会・開封では消費しない。失効は行削除 |
| oauth_clients | CIMD 文書キャッシュ（PK = client_id URL）。`expires_at` は Cache-Control 由来（上限あり） |
| oauth_jwks_cache | client の JWKS キャッシュ。`kid` 不一致時は最短間隔で抑制しつつ即時再取得 |
| oauth_authorization_requests | 検証済み authorize パラメータ（PK = request ID の hash）。TTL 10分。同意画面表示時に `user_id` を設定し、決定 POST のセッション user と一致を必須とする。同意 POST で削除 |
| oauth_grants | 同意 + refresh token family。認可コードの交換成功時に作成する。絶対期限90日。family 失効 = `revoked_at`。同じ (user_id, client_id, resource) の有効な旧 grant は新 grant 作成と同じ tx で `revoked_reason='superseded'` で失効。`active_ledger_id` は MCP の選択中 ledger（作成時は旧 grant から引き継ぎ、なければ `users.default_ledger_id`、所属が無ければ NULL）。`last_used_at` は Bearer 検証時に5分間隔で更新 |
| oauth_auth_codes | hash 保存、60秒、1回限り。同意 POST では `grant_id` NULL で作成し、交換成功時に grant を作成して `grant_id` を設定する。使用済みコードの再提示で `grant_id` の grant を失効（失効を COMMIT してからエラー） |
| oauth_access_tokens | hash 保存、期限1時間（grant の絶対期限を超えない）。`refresh_hash` に同時発行の refresh token を持つ |
| oauth_refresh_tokens | hash 保存、スライディング30日（`expires_at = min(発行時刻 + 30日, grant.absolute_expires_at)`）。`child_hash` / `used_at` で rotation を管理（`used_at` と `child_hash` は同時に設定）。`parent_hash` は未使用（常に NULL。TASK-153） |
| oauth_client_assertion_jtis | PK(client_id, jti)。INSERT 衝突 = 再利用として拒否 |
| user_subject_hashes | 認証済み tools/call の `openai/subject` の hash と user の対応（運用者の特定用の手がかり。認可には使わない）。`last_seen_at` は1時間以上経過時のみ更新 |
| recovery_requests | MCP tool `request_recovery` の回復依頼。受付番号 `request_number`、`status`（open / resolved / rejected）、subject hash、IP hash（24時間で NULL 化）、note（追記は連結）。subject hash ごとに open は1件（部分 UNIQUE） |
| recovery_request_candidates | 依頼の候補 user と根拠（`source`: subject / bearer） |
| recovery_overflow_daily | 全体上限を超えて受付できなかった件数（JST 日付ごと） |

- token は opaque のため署名鍵・JWKS は公開しない。scope は空白区切り TEXT。
- Bearer 検証・web セッション検証は users を JOIN し `disabled_at IS NULL` を必須とする。ユーザー無効化時は同 tx で grant と web session も失効させる。

```sql
SELECT g.id AS grant_id, g.user_id, g.scope, g.resource, g.client_id,
       m.ledger_id AS active_ledger_id, l.name AS active_ledger_name, m.role AS active_ledger_role
FROM oauth_access_tokens t
JOIN oauth_grants g ON g.id = t.grant_id
JOIN users u        ON u.id = g.user_id
LEFT JOIN ledger_members m ON m.ledger_id = g.active_ledger_id AND m.user_id = g.user_id
LEFT JOIN ledgers l        ON l.id = m.ledger_id
WHERE t.token_hash = ?1 AND t.revoked_at IS NULL AND t.expires_at > ?2
  AND g.revoked_at IS NULL AND g.absolute_expires_at > ?2
  AND u.disabled_at IS NULL;
-- アプリ側で g.resource = canonical URI、scope 充足を確認。active_ledger_id が NULL（未選択・所属外）なら ledger 未選択として扱う
```

refresh rotation（`BEGIN IMMEDIATE` 内。client 認証と jti 登録は tx 前に完了させる）:

1. 判定順: token 行なし・token の期限切れ（失効済みでない行）・grant の失効・grant の絶対期限切れ・`disabled_at` 非NULL → 要求 `resource` と `g.resource` の不一致 → `g.client_id` と認証済み client の不一致 → token の失効（reuse） → scope。いずれも `invalid_grant`（scope は `invalid_scope`）。`resource` は要求にある場合のみ検査し、省略時は `g.resource` とみなす。client 不一致は grant を `client_mismatch` で失効させ、token の失効（`revoked_at` 非NULL = 手順3で差し替えられた旧の子）は盗用とみなして grant を `revoked_reason='refresh_reuse'` で失効させ、いずれも失効を COMMIT してから `invalid_grant` を返す（それ以外は ROLLBACK）。失効済みの判定は期限切れより先に行い、grant が有効なら期限切れの旧の子も reuse とする（このため TTL 掃除は grant が有効な間、失効済みの refresh 行を削除しない。§12）。行・grant・user の読み取り失敗と失効 UPDATE の失敗は fail closed とする（`spec_auth.md` §4-9 手順1）。
2. `used_at IS NULL` → 子 refresh R1 と access A1（`refresh_hash=R1`）を発行し、`used_at=now, child_hash=R1` を記録する。
3. `used_at` から60秒以内、かつ現行の子が未使用・未失効 → 旧の子の refresh 行（`revoked_at=now`）と、その子と対の access token をともに失効させ、新しい子を発行して `child_hash` を差し替える（`used_at` は更新しない）。生きている子は常に1本。差し替えた旧の子が後から提示されたら手順1で family を失効させる。
4. それ以外（猶予超過、子が使用済み）→ grant を `revoked_reason='refresh_reuse'` で失効させ、失効を COMMIT してから `invalid_grant` を返す。

失効させてからエラーを返す処理（手順1の client 不一致と token の失効、手順3の子が使用済み、手順4、認可コードの再提示）は、エラーを早期 return して tx の drop で ROLLBACK すると失効が消えるため、失効を COMMIT した後にエラーへ変換する（`spec_auth.md` §4-10）。

## 15. DDL

全 migration（0001〜0013）の連結表記（0002 の `webauthn_ceremonies.authz_request_hash` は同じ migration 内で後に定義する `oauth_authorization_requests` を参照する。SQLite の FK は DML 時に検査されるため定義順の制約はない）。時刻列はすべて unix ms UTC（INTEGER）、金額はすべて円（INTEGER）。ledger 一致トリガは子テーブルの BEFORE INSERT と BEFORE UPDATE OF <参照列>, ledger_id の両方に展開して記載する。0012 はデータ補正のみでスキーマを変えないため、連結表記に含めず末尾に別記する。

### 0001 users / ledgers
```sql
CREATE TABLE users (
  id                    INTEGER PRIMARY KEY,
  webauthn_user_handle  BLOB    NOT NULL UNIQUE CHECK (length(webauthn_user_handle) = 16),  -- UUID v4（webauthn-rs の user unique id）
  account_number        TEXT    NOT NULL UNIQUE
                        CHECK (account_number GLOB 'BB-[0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z]-[0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z]'),  -- Crockford base32
  display_name          TEXT    NOT NULL,
  default_ledger_id     INTEGER REFERENCES ledgers(id),   -- web 画面の対象 ledger。作成時は NULL → ledger 作成後に UPDATE
  admin_note            TEXT,                             -- 運用者メモ（setup 発行時の --note、admin user note）。web・MCP に出さない
  invite_note           TEXT,                             -- 招待者メモ（web の招待発行時に招待者が入力）。運用者 CLI のみ表示
  invited_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- 招待の系譜（setup は NULL）
  invited_via_kind      TEXT,                             -- setup / invite / register（アプリ側 enum）
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  disabled_at           INTEGER                           -- 非NULLなら全認証経路で拒否
) STRICT;
CREATE INDEX users_invited_by ON users(invited_by) WHERE invited_by IS NOT NULL;   -- ON DELETE SET NULL 用

CREATE TABLE ledgers (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE ledger_members (
  ledger_id   INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  role        TEXT    NOT NULL,                 -- owner / editor / viewer（アプリ側 enum）
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (ledger_id, user_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX ledger_members_user ON ledger_members(user_id);
```

### 0002 auth
```sql
CREATE TABLE webauthn_credentials (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  BLOB    NOT NULL UNIQUE,
  passkey_json   TEXT    NOT NULL CHECK (json_valid(passkey_json)),  -- webauthn_rs::prelude::Passkey
  label          TEXT,
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER,
  updated_at     INTEGER NOT NULL
) STRICT;
CREATE INDEX webauthn_credentials_user ON webauthn_credentials(user_id);

CREATE TABLE webauthn_ceremonies (
  id_hash     BLOB    PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK (kind IN ('register','authenticate')),
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,   -- discoverable 認証では NULL
  state_json  TEXT    NOT NULL CHECK (json_valid(state_json)),
  authz_request_hash  BLOB REFERENCES oauth_authorization_requests(id_hash) ON DELETE SET NULL,  -- OAuth 途中のログイン（平文の request ID は保存しない）
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX webauthn_ceremonies_expires ON webauthn_ceremonies(expires_at);
CREATE INDEX webauthn_ceremonies_authz ON webauthn_ceremonies(authz_request_hash) WHERE authz_request_hash IS NOT NULL;

CREATE TABLE web_sessions (
  id_hash             BLOB    PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at          INTEGER NOT NULL,
  auth_at             INTEGER NOT NULL,             -- 最後のパスキー認証時刻（ログイン時 = created_at、step-up で更新）
  last_seen_at        INTEGER NOT NULL,
  idle_expires_at     INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at          INTEGER,
  user_agent          TEXT
) STRICT, WITHOUT ROWID;
CREATE INDEX web_sessions_user ON web_sessions(user_id);
CREATE INDEX web_sessions_expires ON web_sessions(absolute_expires_at);

CREATE TABLE invitations (                    -- setup / invite / recovery の1回限り token
  token_hash      BLOB    PRIMARY KEY,
  kind            TEXT    NOT NULL CHECK (kind IN ('setup','invite','recovery')),
  created_by      INTEGER REFERENCES users(id) ON DELETE CASCADE,    -- invite のみ（setup/recovery は CLI 発行で NULL）
  target_user_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,    -- recovery のみ
  ledger_id       INTEGER REFERENCES ledgers(id) ON DELETE CASCADE,  -- invite のみ
  role            TEXT,                                              -- invite のみ（editor / viewer。アプリ側 enum）
  operator_note   TEXT,                                              -- 運用者メモ（setup は必須、recovery は任意）。登録時に users.admin_note へ複製
  inviter_note    TEXT,                                              -- 招待者メモ（invite のみ、任意）。登録時に users.invite_note へ複製
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER,
  used_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((kind = 'recovery') = (target_user_id IS NOT NULL)),
  CHECK ((kind = 'invite') = (ledger_id IS NOT NULL AND role IS NOT NULL)),
  CHECK ((kind = 'invite') = (created_by IS NOT NULL)),
  CHECK (kind <> 'setup' OR operator_note IS NOT NULL),
  CHECK (kind = 'invite' OR inviter_note IS NULL),
  CHECK (kind <> 'invite' OR operator_note IS NULL)
) STRICT, WITHOUT ROWID;
CREATE INDEX invitations_expires ON invitations(expires_at);
-- 未使用の recovery token は user ごとに1本（失効は行削除なので used_at だけを条件にする。発行 CLI は同 user の未使用行を同じ tx で削除してから INSERT する）
CREATE UNIQUE INDEX invitations_recovery_open ON invitations(target_user_id) WHERE kind = 'recovery' AND used_at IS NULL;

CREATE TABLE oauth_clients (                  -- CIMD 文書キャッシュ
  client_id                   TEXT    PRIMARY KEY,
  metadata_json               TEXT    NOT NULL CHECK (json_valid(metadata_json)),
  client_name                 TEXT,
  redirect_uris_json          TEXT    NOT NULL CHECK (json_valid(redirect_uris_json)),
  token_endpoint_auth_method  TEXT    NOT NULL,      -- none / private_key_jwt（アプリ側 enum）
  jwks_uri                    TEXT,
  etag                        TEXT,
  fetched_at                  INTEGER NOT NULL,
  expires_at                  INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE oauth_jwks_cache (
  jwks_uri     TEXT    PRIMARY KEY,
  jwks_json    TEXT    NOT NULL CHECK (json_valid(jwks_json)),
  etag         TEXT,
  fetched_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE oauth_authorization_requests (   -- 検証済み authorize パラメータ（ログイン往復と同意 POST の結び付け）
  id_hash         BLOB    PRIMARY KEY,
  client_id       TEXT    NOT NULL REFERENCES oauth_clients(client_id),
  redirect_uri    TEXT    NOT NULL,
  state           TEXT,
  code_challenge  TEXT    NOT NULL,
  scope           TEXT    NOT NULL,
  resource        TEXT    NOT NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- 同意画面表示時に設定。決定 POST のセッション user と一致必須
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL                                  -- 10分
) STRICT, WITHOUT ROWID;
CREATE INDEX oauth_authz_requests_expires ON oauth_authorization_requests(expires_at);

CREATE TABLE oauth_grants (                   -- 同意 + refresh token family（認可コードの交換成功時に作成）
  id                   INTEGER PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id            TEXT    NOT NULL REFERENCES oauth_clients(client_id),
  scope                TEXT    NOT NULL,
  resource             TEXT    NOT NULL,
  active_ledger_id     INTEGER REFERENCES ledgers(id) ON DELETE SET NULL,  -- MCP の選択中 ledger。作成時 = 旧 grant から引き継ぎ、なければ users.default_ledger_id。NULL = 未選択
  created_at           INTEGER NOT NULL,
  absolute_expires_at  INTEGER NOT NULL,
  last_used_at         INTEGER,                 -- Bearer 検証時に5分間隔で更新（接続一覧の表示用）
  revoked_at           INTEGER,
  revoked_reason       TEXT                     -- user / refresh_reuse / code_reuse / superseded / admin ...（アプリ側 enum）
) STRICT;
CREATE INDEX oauth_grants_user ON oauth_grants(user_id);
CREATE INDEX oauth_grants_user_client ON oauth_grants(user_id, client_id, resource) WHERE revoked_at IS NULL;   -- superseded 対象の検索
CREATE INDEX oauth_grants_active_ledger ON oauth_grants(active_ledger_id) WHERE active_ledger_id IS NOT NULL;   -- ON DELETE SET NULL 用

-- 越境防止: 選択できるのは grant の user が所属する ledger のみ
CREATE TRIGGER oauth_grants_active_ledger_ins BEFORE INSERT ON oauth_grants
WHEN NEW.active_ledger_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM ledger_members m WHERE m.ledger_id = NEW.active_ledger_id AND m.user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'active_ledger_id: not a member'); END;
CREATE TRIGGER oauth_grants_active_ledger_upd BEFORE UPDATE OF active_ledger_id, user_id ON oauth_grants
WHEN NEW.active_ledger_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM ledger_members m WHERE m.ledger_id = NEW.active_ledger_id AND m.user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'active_ledger_id: not a member'); END;

-- ledger_members の PK 列の UPDATE を禁止（削除トリガを迂回して所属を付け替えられないように。所属変更は DELETE + INSERT）
CREATE TRIGGER ledger_members_no_pk_update BEFORE UPDATE OF ledger_id, user_id ON ledger_members
BEGIN SELECT RAISE(ABORT, 'ledger_members: ledger_id/user_id are immutable'); END;

-- メンバーから外れたら、その user の grant の選択を解除（default へは戻さない）
CREATE TRIGGER ledger_members_del_clear_active AFTER DELETE ON ledger_members
BEGIN
  UPDATE oauth_grants SET active_ledger_id = NULL
  WHERE user_id = OLD.user_id AND active_ledger_id = OLD.ledger_id;
END;

CREATE TABLE oauth_auth_codes (
  code_hash       BLOB    PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id       TEXT    NOT NULL REFERENCES oauth_clients(client_id),
  redirect_uri    TEXT    NOT NULL,
  code_challenge  TEXT    NOT NULL,
  scope           TEXT    NOT NULL,
  resource        TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER,
  grant_id        INTEGER REFERENCES oauth_grants(id) ON DELETE CASCADE   -- 同意 POST 時は NULL、交換成功時に作成した grant を設定
) STRICT, WITHOUT ROWID;
CREATE INDEX oauth_auth_codes_expires ON oauth_auth_codes(expires_at);

CREATE TABLE oauth_access_tokens (
  token_hash   BLOB    PRIMARY KEY,
  grant_id     INTEGER NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  refresh_hash BLOB,                             -- 同時に発行した refresh token（猶予内再発行で旧ペアの access も失効させる）
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER
) STRICT, WITHOUT ROWID;
CREATE INDEX oauth_access_tokens_grant ON oauth_access_tokens(grant_id);
CREATE INDEX oauth_access_tokens_refresh ON oauth_access_tokens(refresh_hash) WHERE refresh_hash IS NOT NULL;
CREATE INDEX oauth_access_tokens_expires ON oauth_access_tokens(expires_at);

CREATE TABLE oauth_refresh_tokens (
  token_hash   BLOB    PRIMARY KEY,
  grant_id     INTEGER NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  parent_hash  BLOB,                            -- 未使用（常に NULL。TASK-153）
  child_hash   BLOB,                            -- この token の使用で発行した現行の子（猶予内再発行で差し替え）
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,                -- min(発行時刻 + 30日, grant.absolute_expires_at)
  used_at      INTEGER,                         -- 最初に rotation に使われた時刻（猶予60秒の起点。再発行で更新しない）
  revoked_at   INTEGER,                         -- 猶予内再発行で差し替えられた旧の子のみ設定（grant の失効は oauth_grants 側）
  CHECK ((used_at IS NULL) = (child_hash IS NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX oauth_refresh_tokens_grant ON oauth_refresh_tokens(grant_id);
CREATE INDEX oauth_refresh_tokens_expires ON oauth_refresh_tokens(expires_at);

CREATE TABLE oauth_client_assertion_jtis (
  client_id   TEXT    NOT NULL,
  jti         TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  PRIMARY KEY (client_id, jti)
) STRICT, WITHOUT ROWID;
CREATE INDEX oauth_jtis_expires ON oauth_client_assertion_jtis(expires_at);

-- アカウント特定・回復依頼
CREATE TABLE user_subject_hashes (
  subject_hash   BLOB    NOT NULL,          -- v1 = SHA-256("budget-book/openai-subject/v1:" + subject)
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer         TEXT    NOT NULL,          -- 'openai'（アプリ側 enum）
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (subject_hash, user_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX user_subject_hashes_user ON user_subject_hashes(user_id);
CREATE INDEX user_subject_hashes_last_seen ON user_subject_hashes(last_seen_at);

CREATE TABLE recovery_requests (
  id               INTEGER PRIMARY KEY,
  request_number   TEXT    NOT NULL UNIQUE,                 -- 'R-XXXX'
  status           TEXT    NOT NULL CHECK (status IN ('open','resolved','rejected')),
  subject_hash     BLOB,                                     -- openai/subject が無ければ NULL
  ip_hash          BLOB,                                     -- IPv4 /32・IPv6 /64 の SHA-256。作成24時間後に NULL 化
  note             TEXT    CHECK (note IS NULL OR length(note) <= 1000),  -- 1回200文字、追記は区切って連結。合計1000文字を超える追記は行わない
  append_count     INTEGER NOT NULL DEFAULT 0 CHECK (append_count >= 0),
  created_at       INTEGER NOT NULL,
  closed_at        INTEGER,
  close_note       TEXT,
  CHECK ((status = 'open') = (closed_at IS NULL))
) STRICT;
CREATE INDEX recovery_requests_subject ON recovery_requests(subject_hash, created_at) WHERE subject_hash IS NOT NULL;
CREATE INDEX recovery_requests_ip ON recovery_requests(ip_hash, created_at) WHERE ip_hash IS NOT NULL;
CREATE INDEX recovery_requests_created ON recovery_requests(created_at);
CREATE UNIQUE INDEX recovery_requests_open_subject ON recovery_requests(subject_hash) WHERE status = 'open' AND subject_hash IS NOT NULL;

CREATE TABLE recovery_request_candidates (
  request_id  INTEGER NOT NULL REFERENCES recovery_requests(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      TEXT    NOT NULL,          -- subject / bearer（アプリ側 enum）
  PRIMARY KEY (request_id, user_id, source)
) STRICT, WITHOUT ROWID;
CREATE INDEX recovery_request_candidates_user ON recovery_request_candidates(user_id);

CREATE TABLE recovery_overflow_daily (       -- 全体上限超過で受付できなかった件数
  day    TEXT    PRIMARY KEY,                 -- JST 日付 'YYYY-MM-DD'
  count  INTEGER NOT NULL CHECK (count >= 0)
) STRICT, WITHOUT ROWID;
```

### 0003 catalog（カテゴリ・店）
```sql
CREATE TABLE item_categories (
  id          INTEGER PRIMARY KEY,
  ledger_id   INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES item_categories(id) ON DELETE RESTRICT,
  name        TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;
CREATE UNIQUE INDEX item_categories_name ON item_categories(ledger_id, COALESCE(parent_id, 0), name);
CREATE INDEX item_categories_parent ON item_categories(parent_id) WHERE parent_id IS NOT NULL;

-- 深さ2・親の ledger 一致（INSERT と UPDATE の両方）
CREATE TRIGGER item_categories_guard_ins BEFORE INSERT ON item_categories
WHEN NEW.parent_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'category depth exceeds 2')
  WHERE (SELECT parent_id FROM item_categories WHERE id = NEW.parent_id) IS NOT NULL;
  SELECT RAISE(ABORT, 'category ledger mismatch')
  WHERE (SELECT ledger_id FROM item_categories WHERE id = NEW.parent_id) <> NEW.ledger_id;
END;
CREATE TRIGGER item_categories_guard_upd BEFORE UPDATE OF parent_id, ledger_id ON item_categories BEGIN
  SELECT RAISE(ABORT, 'category depth exceeds 2')
  WHERE NEW.parent_id IS NOT NULL
    AND ((SELECT parent_id FROM item_categories WHERE id = NEW.parent_id) IS NOT NULL
         OR EXISTS (SELECT 1 FROM item_categories WHERE parent_id = NEW.id));
  SELECT RAISE(ABORT, 'category ledger mismatch')
  WHERE NEW.parent_id IS NOT NULL
    AND (SELECT ledger_id FROM item_categories WHERE id = NEW.parent_id) <> NEW.ledger_id;
  SELECT RAISE(ABORT, 'ledger_id is immutable') WHERE NEW.ledger_id <> OLD.ledger_id;
END;

CREATE TABLE store_categories (               -- item_categories と同形
  id          INTEGER PRIMARY KEY,
  ledger_id   INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES store_categories(id) ON DELETE RESTRICT,
  name        TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;
CREATE UNIQUE INDEX store_categories_name ON store_categories(ledger_id, COALESCE(parent_id, 0), name);
CREATE INDEX store_categories_parent ON store_categories(parent_id) WHERE parent_id IS NOT NULL;
CREATE TRIGGER store_categories_guard_ins BEFORE INSERT ON store_categories
WHEN NEW.parent_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'category depth exceeds 2')
  WHERE (SELECT parent_id FROM store_categories WHERE id = NEW.parent_id) IS NOT NULL;
  SELECT RAISE(ABORT, 'category ledger mismatch')
  WHERE (SELECT ledger_id FROM store_categories WHERE id = NEW.parent_id) <> NEW.ledger_id;
END;
CREATE TRIGGER store_categories_guard_upd BEFORE UPDATE OF parent_id, ledger_id ON store_categories BEGIN
  SELECT RAISE(ABORT, 'category depth exceeds 2')
  WHERE NEW.parent_id IS NOT NULL
    AND ((SELECT parent_id FROM store_categories WHERE id = NEW.parent_id) IS NOT NULL
         OR EXISTS (SELECT 1 FROM store_categories WHERE parent_id = NEW.id));
  SELECT RAISE(ABORT, 'category ledger mismatch')
  WHERE NEW.parent_id IS NOT NULL
    AND (SELECT ledger_id FROM store_categories WHERE id = NEW.parent_id) <> NEW.ledger_id;
  SELECT RAISE(ABORT, 'ledger_id is immutable') WHERE NEW.ledger_id <> OLD.ledger_id;
END;

CREATE TABLE stores (
  id              INTEGER PRIMARY KEY,
  ledger_id       INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  name_norm       TEXT    NOT NULL,
  category_id     INTEGER REFERENCES store_categories(id) ON DELETE SET NULL,
  category_source TEXT,                         -- model / user（アプリ側 enum）
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX stores_name ON stores(ledger_id, name_norm);
CREATE INDEX stores_category ON stores(category_id) WHERE category_id IS NOT NULL;
CREATE TRIGGER stores_guard_ins BEFORE INSERT ON stores WHEN NEW.category_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'store category ledger mismatch')
  WHERE (SELECT ledger_id FROM store_categories WHERE id = NEW.category_id) <> NEW.ledger_id;
END;
CREATE TRIGGER stores_guard_upd BEFORE UPDATE OF category_id, ledger_id ON stores BEGIN
  SELECT RAISE(ABORT, 'store category ledger mismatch')
  WHERE NEW.category_id IS NOT NULL
    AND (SELECT ledger_id FROM store_categories WHERE id = NEW.category_id) <> NEW.ledger_id;
  SELECT RAISE(ABORT, 'ledger_id is immutable') WHERE NEW.ledger_id <> OLD.ledger_id;
END;

CREATE TABLE store_aliases (                  -- 名寄せ用の別名（正規化済み）
  ledger_id   INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  alias_norm  TEXT    NOT NULL,
  store_id    INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (ledger_id, alias_norm)
) STRICT, WITHOUT ROWID;
CREATE INDEX store_aliases_store ON store_aliases(store_id);
CREATE TRIGGER store_aliases_guard_ins BEFORE INSERT ON store_aliases BEGIN
  SELECT RAISE(ABORT, 'alias ledger mismatch')
  WHERE (SELECT ledger_id FROM stores WHERE id = NEW.store_id) <> NEW.ledger_id;
END;
CREATE TRIGGER store_aliases_guard_upd BEFORE UPDATE OF store_id, ledger_id ON store_aliases BEGIN
  SELECT RAISE(ABORT, 'alias ledger mismatch')
  WHERE (SELECT ledger_id FROM stores WHERE id = NEW.store_id) <> NEW.ledger_id;
END;
```

### 0004 images / receipts / receipt_items
```sql
CREATE TABLE images (
  id                        INTEGER PRIMARY KEY,
  ledger_id                 INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  uploaded_by               INTEGER NOT NULL REFERENCES users(id),
  file_key                  TEXT    NOT NULL UNIQUE,   -- ULID
  storage_path              TEXT    NOT NULL UNIQUE,   -- 画像ルートからの相対パス
  mime_type                 TEXT    NOT NULL DEFAULT 'image/webp',
  width                     INTEGER NOT NULL CHECK (width > 0),
  height                    INTEGER NOT NULL CHECK (height > 0),
  byte_size                 INTEGER NOT NULL CHECK (byte_size > 0),
  sha256                    BLOB    NOT NULL,          -- 取得バイト列（変換前）の hash
  source_file_id            TEXT,
  source_host               TEXT,
  -- 確定値（出所付き）。モデル申告の生値は drafts.reported_* に別途残る
  original_filename         TEXT,
  original_filename_source  TEXT,                      -- model / download（取得応答の Content-Disposition）。EXIF にファイル名は無い
  taken_at_local            TEXT,                      -- 'YYYY-MM-DDTHH:MM:SS'
  taken_at_offset           TEXT,
  taken_at_source           TEXT,                      -- exif / model（EXIF があれば exif を正）
  exif_json                 TEXT CHECK (exif_json IS NULL OR json_valid(exif_json)),  -- 抽出した EXIF 生値（GPS 除外）
  created_at                INTEGER NOT NULL,
  CHECK ((original_filename IS NULL) = (original_filename_source IS NULL)),
  CHECK ((taken_at_local IS NULL) = (taken_at_source IS NULL))
) STRICT;
CREATE INDEX images_sha ON images(ledger_id, sha256);
CREATE INDEX images_source_file ON images(ledger_id, source_file_id) WHERE source_file_id IS NOT NULL;   -- 重複検知（一意ではない）
CREATE INDEX images_created ON images(created_at);

CREATE TABLE image_access_tokens (            -- widget 表示用の短命アクセス token（/media/img/<token>）
  token_hash  BLOB    PRIMARY KEY,            -- 256bit 乱数の SHA-256
  image_id    INTEGER NOT NULL REFERENCES images(id)  ON DELETE CASCADE,
  ledger_id   INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,   -- 画像の ledger と一致（トリガ）
  user_id     INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,   -- 発行先。配信時に所属・無効化を再検査
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL                -- TTL は configs/<env>/mcp.toml（初期値15分）
) STRICT, WITHOUT ROWID;
CREATE INDEX image_access_tokens_image   ON image_access_tokens(image_id);
CREATE INDEX image_access_tokens_ledger  ON image_access_tokens(ledger_id);
CREATE INDEX image_access_tokens_user    ON image_access_tokens(user_id);
CREATE INDEX image_access_tokens_expires ON image_access_tokens(expires_at);
CREATE TRIGGER image_access_tokens_guard_ins BEFORE INSERT ON image_access_tokens BEGIN
  SELECT RAISE(ABORT, 'image ledger mismatch')
  WHERE (SELECT ledger_id FROM images WHERE id = NEW.image_id) <> NEW.ledger_id;
END;
CREATE TRIGGER image_access_tokens_guard_upd BEFORE UPDATE OF image_id, ledger_id ON image_access_tokens BEGIN
  SELECT RAISE(ABORT, 'ledger_id is immutable') WHERE NEW.ledger_id <> OLD.ledger_id;
  SELECT RAISE(ABORT, 'image ledger mismatch')
  WHERE (SELECT ledger_id FROM images WHERE id = NEW.image_id) <> NEW.ledger_id;
END;

CREATE TABLE receipts (
  id                    INTEGER PRIMARY KEY,
  ledger_id             INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  created_by            INTEGER NOT NULL REFERENCES users(id),
  source                TEXT    NOT NULL CHECK (source IN ('image','manual')),
  image_id              INTEGER REFERENCES images(id) ON DELETE RESTRICT,
  store_id              INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  store_name_raw        TEXT,
  purchased_on          TEXT    NOT NULL CHECK (purchased_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),  -- JST の現地日付
  purchased_time        TEXT    CHECK (purchased_time IS NULL OR purchased_time GLOB '[0-2][0-9]:[0-5][0-9]*'),
  purchased_month       TEXT    GENERATED ALWAYS AS (substr(purchased_on, 1, 7)) VIRTUAL,
  tax_mode              TEXT    CHECK (tax_mode IN ('inclusive','exclusive')),   -- NULL=不明
  total_amount          INTEGER,
  tax_amount            INTEGER,
  payment_method        TEXT,                    -- cash / credit_card / ...（アプリ側 enum）
  note                  TEXT,
  revision              INTEGER NOT NULL DEFAULT 1,
  created_at            INTEGER NOT NULL,        -- = 入力日時
  updated_at            INTEGER NOT NULL,
  deleted_at            INTEGER
) STRICT;
CREATE INDEX receipts_ledger_date  ON receipts(ledger_id, purchased_on) WHERE deleted_at IS NULL;
CREATE INDEX receipts_ledger_store ON receipts(ledger_id, store_id, purchased_on) WHERE deleted_at IS NULL;
CREATE INDEX receipts_store        ON receipts(store_id) WHERE store_id IS NOT NULL;   -- ON DELETE SET NULL 用
CREATE INDEX receipts_image        ON receipts(image_id) WHERE image_id IS NOT NULL;
CREATE INDEX receipts_deleted      ON receipts(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE TRIGGER receipts_guard_ins BEFORE INSERT ON receipts BEGIN
  SELECT RAISE(ABORT, 'store ledger mismatch')
  WHERE NEW.store_id IS NOT NULL AND (SELECT ledger_id FROM stores WHERE id = NEW.store_id) <> NEW.ledger_id;
  SELECT RAISE(ABORT, 'image ledger mismatch')
  WHERE NEW.image_id IS NOT NULL AND (SELECT ledger_id FROM images WHERE id = NEW.image_id) <> NEW.ledger_id;
END;
CREATE TRIGGER receipts_guard_upd BEFORE UPDATE OF store_id, image_id, ledger_id ON receipts BEGIN
  SELECT RAISE(ABORT, 'ledger_id is immutable') WHERE NEW.ledger_id <> OLD.ledger_id;
  SELECT RAISE(ABORT, 'store ledger mismatch')
  WHERE NEW.store_id IS NOT NULL AND (SELECT ledger_id FROM stores WHERE id = NEW.store_id) <> NEW.ledger_id;
  SELECT RAISE(ABORT, 'image ledger mismatch')
  WHERE NEW.image_id IS NOT NULL AND (SELECT ledger_id FROM images WHERE id = NEW.image_id) <> NEW.ledger_id;
END;

CREATE TABLE receipt_items (
  id               INTEGER PRIMARY KEY,
  receipt_id       INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  ledger_id        INTEGER NOT NULL,             -- 非正規化（名前索引・認可用）。トリガで receipts と一致を強制
  line_no          INTEGER NOT NULL,
  line_kind        TEXT    NOT NULL DEFAULT 'item' CHECK (line_kind IN ('item','discount')),
  parent_item_id   INTEGER REFERENCES receipt_items(id) ON DELETE CASCADE,  -- 同一レシートの item 行のみ（トリガ）
  name             TEXT    NOT NULL,
  name_raw         TEXT,
  name_norm        TEXT    NOT NULL,
  name_raw_norm    TEXT,
  quantity         REAL    NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit             TEXT,
  unit_price       INTEGER,
  amount           INTEGER NOT NULL,
  amount_incl      INTEGER NOT NULL,
  tax_rate         INTEGER CHECK (tax_rate BETWEEN 0 AND 100),   -- 税率%（10 / 8 / 0）。NULL=不明
  category_id      INTEGER REFERENCES item_categories(id) ON DELETE SET NULL,
  category_source  TEXT,                          -- model / history / user（アプリ側 enum）
  bbox_x REAL, bbox_y REAL, bbox_w REAL, bbox_h REAL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (receipt_id, line_no),
  CHECK (line_kind = 'item' OR amount <= 0),
  CHECK (parent_item_id IS NULL OR line_kind = 'discount'),
  CHECK ((bbox_x IS NULL AND bbox_y IS NULL AND bbox_w IS NULL AND bbox_h IS NULL) OR
         (bbox_x BETWEEN 0 AND 1 AND bbox_y BETWEEN 0 AND 1 AND bbox_w > 0 AND bbox_h > 0
          AND bbox_x + bbox_w <= 1.0001 AND bbox_y + bbox_h <= 1.0001))
) STRICT;
CREATE INDEX receipt_items_name     ON receipt_items(ledger_id, name_norm);
CREATE INDEX receipt_items_category ON receipt_items(category_id) WHERE category_id IS NOT NULL;
CREATE INDEX receipt_items_parent   ON receipt_items(parent_item_id) WHERE parent_item_id IS NOT NULL;

CREATE TRIGGER receipt_items_guard_ins BEFORE INSERT ON receipt_items BEGIN
  SELECT RAISE(ABORT, 'item ledger mismatch')
  WHERE (SELECT ledger_id FROM receipts WHERE id = NEW.receipt_id) <> NEW.ledger_id;
  SELECT RAISE(ABORT, 'category ledger mismatch')
  WHERE NEW.category_id IS NOT NULL
    AND (SELECT ledger_id FROM item_categories WHERE id = NEW.category_id) <> NEW.ledger_id;
  SELECT RAISE(ABORT, 'discount parent must be an item line of the same receipt')
  WHERE NEW.parent_item_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM receipt_items p
                    WHERE p.id = NEW.parent_item_id AND p.receipt_id = NEW.receipt_id AND p.line_kind = 'item');
END;
CREATE TRIGGER receipt_items_guard_upd
BEFORE UPDATE OF receipt_id, ledger_id, category_id, parent_item_id, line_kind ON receipt_items BEGIN
  SELECT RAISE(ABORT, 'receipt_id/ledger_id are immutable')
  WHERE NEW.receipt_id <> OLD.receipt_id OR NEW.ledger_id <> OLD.ledger_id;
  SELECT RAISE(ABORT, 'category ledger mismatch')
  WHERE NEW.category_id IS NOT NULL
    AND (SELECT ledger_id FROM item_categories WHERE id = NEW.category_id) <> NEW.ledger_id;
  SELECT RAISE(ABORT, 'discount parent must be an item line of the same receipt')
  WHERE NEW.parent_item_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM receipt_items p
                    WHERE p.id = NEW.parent_item_id AND p.receipt_id = NEW.receipt_id AND p.line_kind = 'item');
  SELECT RAISE(ABORT, 'line with discounts must stay an item')
  WHERE NEW.line_kind <> 'item' AND EXISTS (SELECT 1 FROM receipt_items c WHERE c.parent_item_id = NEW.id);
END;
```

### 0005 drafts
```sql
CREATE TABLE drafts (
  id                       INTEGER PRIMARY KEY,
  ledger_id                INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  user_id                  INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  status                   TEXT    NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','approved','discarded','expired')),
  revision                 INTEGER NOT NULL DEFAULT 1,
  payload_json             TEXT    CHECK (payload_json IS NULL OR json_valid(payload_json)),
  source_file_id           TEXT,                 -- openai file id（重複検知用の記録。一意ではない）
  image_id                 INTEGER REFERENCES images(id) ON DELETE RESTRICT,  -- pending 中のみ保持。close 時に NULL 化
  image_status             TEXT    NOT NULL CHECK (image_status IN ('none','attached','unavailable')),
  image_unavailable_reason TEXT,                 -- fetch_interrupted / chat_upload / missing_arg / fetch_failed / too_large / decode_failed / fetch_timeout / reopened（アプリ側 enum）
  -- モデル申告メタデータの生値（出所は常に model。EXIF 等で確定した値と出所は images 側に持つ）
  reported_filename        TEXT,
  reported_taken_at        TEXT,
  approved_receipt_id      INTEGER REFERENCES receipts(id) ON DELETE SET NULL,
  approved_revision        INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  expires_at               INTEGER NOT NULL,
  closed_at                INTEGER,
  CHECK ((status = 'pending') = (closed_at IS NULL)),
  CHECK (status <> 'approved' OR approved_revision IS NOT NULL),
  CHECK (status <> 'pending' OR payload_json IS NOT NULL),
  -- 画像状態の整合（pending 中のみ。close 後は image_id を NULL にして image_status は履歴として残す）
  CHECK (status <> 'pending' OR (image_status = 'attached') = (image_id IS NOT NULL)),
  CHECK (status = 'pending' OR image_id IS NULL),
  CHECK ((image_status = 'unavailable') = (image_unavailable_reason IS NOT NULL))
) STRICT;
CREATE INDEX drafts_user_file ON drafts(user_id, source_file_id) WHERE source_file_id IS NOT NULL;   -- 重複検知（一意ではない）
CREATE INDEX drafts_user_status ON drafts(user_id, status, updated_at);
CREATE INDEX drafts_expires     ON drafts(expires_at) WHERE status = 'pending';
CREATE INDEX drafts_closed      ON drafts(closed_at)  WHERE closed_at IS NOT NULL;
CREATE INDEX drafts_image       ON drafts(image_id)   WHERE image_id IS NOT NULL;
CREATE INDEX drafts_receipt     ON drafts(approved_receipt_id) WHERE approved_receipt_id IS NOT NULL;
CREATE TRIGGER drafts_guard_ins BEFORE INSERT ON drafts WHEN NEW.image_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'image ledger mismatch')
  WHERE (SELECT ledger_id FROM images WHERE id = NEW.image_id) <> NEW.ledger_id;
END;
CREATE TRIGGER drafts_guard_upd BEFORE UPDATE OF image_id, ledger_id ON drafts BEGIN
  SELECT RAISE(ABORT, 'ledger_id is immutable') WHERE NEW.ledger_id <> OLD.ledger_id;
  SELECT RAISE(ABORT, 'image ledger mismatch')
  WHERE NEW.image_id IS NOT NULL AND (SELECT ledger_id FROM images WHERE id = NEW.image_id) <> NEW.ledger_id;
END;
```

### 0006 search / views
```sql
CREATE VIRTUAL TABLE receipt_items_fts USING fts5(
  name_norm, name_raw_norm,
  content = 'receipt_items', content_rowid = 'id',
  tokenize = 'trigram'
);
CREATE TRIGGER receipt_items_fts_ai AFTER INSERT ON receipt_items BEGIN
  INSERT INTO receipt_items_fts(rowid, name_norm, name_raw_norm) VALUES (NEW.id, NEW.name_norm, NEW.name_raw_norm);
END;
CREATE TRIGGER receipt_items_fts_ad AFTER DELETE ON receipt_items BEGIN
  INSERT INTO receipt_items_fts(receipt_items_fts, rowid, name_norm, name_raw_norm) VALUES ('delete', OLD.id, OLD.name_norm, OLD.name_raw_norm);
END;
CREATE TRIGGER receipt_items_fts_au AFTER UPDATE OF name_norm, name_raw_norm ON receipt_items BEGIN
  INSERT INTO receipt_items_fts(receipt_items_fts, rowid, name_norm, name_raw_norm) VALUES ('delete', OLD.id, OLD.name_norm, OLD.name_raw_norm);
  INSERT INTO receipt_items_fts(rowid, name_norm, name_raw_norm) VALUES (NEW.id, NEW.name_norm, NEW.name_raw_norm);
END;

CREATE VIEW v_item_facts AS
SELECT
  i.id AS item_id, i.receipt_id, r.ledger_id,
  r.purchased_on, r.purchased_month, r.payment_method,
  i.line_kind, i.name, i.quantity, i.amount, i.amount_incl, i.tax_rate,
  i.category_id,
  COALESCE(ic.parent_id, ic.id) AS category_top_id,
  r.store_id, s.name AS store_name,
  s.category_id AS store_category_id,
  COALESCE(sc.parent_id, sc.id) AS store_category_top_id
FROM receipt_items i
JOIN receipts r              ON r.id = i.receipt_id AND r.deleted_at IS NULL
LEFT JOIN item_categories ic ON ic.id = i.category_id
LEFT JOIN stores s           ON s.id = r.store_id
LEFT JOIN store_categories sc ON sc.id = s.category_id;
```

### 0007 audit
```sql
CREATE TABLE audit_events (
  id           INTEGER PRIMARY KEY,
  ledger_id    INTEGER REFERENCES ledgers(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id)   ON DELETE SET NULL,
  actor_kind   TEXT    NOT NULL,              -- web / mcp / system（アプリ側 enum）
  client_id    TEXT,
  entity_type  TEXT    NOT NULL,              -- receipt / receipt_item / draft / store / ...（アプリ側 enum）
  entity_id    INTEGER NOT NULL,
  action       TEXT    NOT NULL,              -- create / update / delete / restore / approve / discard / reopen / merge ...（アプリ側 enum）
  before_json  TEXT    CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json   TEXT    CHECK (after_json  IS NULL OR json_valid(after_json)),
  created_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX audit_events_entity ON audit_events(entity_type, entity_id, created_at);
CREATE INDEX audit_events_ledger ON audit_events(ledger_id, created_at);
```

### 0008 ledger UI
```sql
-- ledger_members.color: per-user ledger color (palette key, store::LEDGER_COLORS)
ALTER TABLE ledger_members ADD COLUMN color TEXT NOT NULL DEFAULT 'teal'
  CHECK (color IN ('teal','orange','pink','brown','slate','graphite'));

-- backfill: each user's memberships in ledger_id order get palette keys in order
UPDATE ledger_members SET color = (
  SELECT CASE (rn - 1) % 6 WHEN 0 THEN 'teal' WHEN 1 THEN 'orange' WHEN 2 THEN 'pink'
    WHEN 3 THEN 'brown' WHEN 4 THEN 'slate' ELSE 'graphite' END
  FROM (SELECT ledger_id AS lid, user_id AS uid,
          ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY ledger_id) AS rn FROM ledger_members) r
  WHERE r.lid = ledger_members.ledger_id AND r.uid = ledger_members.user_id);

-- rename auto-created personal ledgers to "default book" (store::DEFAULT_LEDGER_NAME)
UPDATE ledgers SET name = 'default book',
       updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE EXISTS (SELECT 1 FROM ledger_members m JOIN users u ON u.id = m.user_id
               WHERE m.ledger_id = ledgers.id AND m.role = 'owner'
                 AND ledgers.name = u.display_name || 'の家計簿');
```

### 0009 labels
```sql
CREATE TABLE ledger_labels (
  ledger_id   INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  color       TEXT    NOT NULL,          -- red / yellow / green / blue / purple (seeded rows only; Rust enum LabelColor)
  title       TEXT    CHECK (title IS NULL OR length(title) >= 1),  -- NULL = color only. max length is app-side (configs)
  created_at  INTEGER NOT NULL,          -- unix ms
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (ledger_id, color)
) STRICT, WITHOUT ROWID;

CREATE TABLE receipt_labels (
  receipt_id  INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  ledger_id   INTEGER NOT NULL,
  color       TEXT    NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (receipt_id, color),
  FOREIGN KEY (ledger_id, color) REFERENCES ledger_labels(ledger_id, color) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX receipt_labels_ledger_color ON receipt_labels(ledger_id, color, receipt_id);

CREATE TRIGGER receipt_labels_guard_ins BEFORE INSERT ON receipt_labels BEGIN
  SELECT RAISE(ABORT, 'receipt ledger mismatch')
  WHERE (SELECT ledger_id FROM receipts WHERE id = NEW.receipt_id) <> NEW.ledger_id;
END;
CREATE TRIGGER receipt_labels_no_update BEFORE UPDATE ON receipt_labels BEGIN
  SELECT RAISE(ABORT, 'receipt_labels rows are insert/delete only');
END;
CREATE TRIGGER ledger_labels_guard_upd BEFORE UPDATE OF ledger_id, color ON ledger_labels BEGIN
  SELECT RAISE(ABORT, 'ledger_labels key is immutable');
END;

-- seed on every ledger creation path (store::create_ledger_with_seed,
-- auth/ceremony.rs registration, test helpers). Keep the color list in sync
-- with domain::labels::LABEL_COLORS (checked by db-schema.ledger-labels-match-enum).
CREATE TRIGGER ledgers_seed_labels AFTER INSERT ON ledgers BEGIN
  INSERT INTO ledger_labels (ledger_id, color, title, created_at, updated_at)
  SELECT NEW.id, c.color, NULL, NEW.created_at, NEW.created_at
  FROM (SELECT 'red' AS color UNION ALL SELECT 'yellow' UNION ALL SELECT 'green'
        UNION ALL SELECT 'blue' UNION ALL SELECT 'purple') c;
END;

-- backfill existing ledgers
INSERT INTO ledger_labels (ledger_id, color, title, created_at, updated_at)
SELECT l.id, c.color, NULL, CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM ledgers l
CROSS JOIN (SELECT 'red' AS color UNION ALL SELECT 'yellow' UNION ALL SELECT 'green'
            UNION ALL SELECT 'blue' UNION ALL SELECT 'purple') c;
```

### 0010 drafts batch

```sql
-- NULL = single-tool creation and reopen. Used only to exclude same-batch
-- siblings from the file_id duplicate match (spec_mcp-tools.md §6).
ALTER TABLE drafts ADD COLUMN batch_id TEXT;
CREATE INDEX drafts_batch ON drafts(batch_id) WHERE batch_id IS NOT NULL;
```

### 0011 register invitations

```sql
-- TASK-32: web-issued registration-only tokens. Separate from invitations
-- (setup / invite / recovery): issuing an account joins no ledger.
CREATE TABLE register_invitations (
  token_hash   BLOB    PRIMARY KEY,
  created_by   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inviter_note TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER,
  used_by      INTEGER REFERENCES users(id) ON DELETE SET NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX register_invitations_expires ON register_invitations(expires_at);
CREATE INDEX register_invitations_issuer_open ON register_invitations(created_by) WHERE used_at IS NULL;
```

### 0012 revoke superseded refresh children

TASK-140: データ補正のみ（テーブル変更なし）。修正前の猶予内再発行で差し替えられ、失効していなかった旧の子を失効させる。直接証拠（未使用・未失効で、どの `child_hash` からも参照されず、同じ grant に参照されている未使用・未失効の先端がある）のある行だけを対象とし、rotation のない初回 token や親が削除済みの現行の子は対象外。

```sql
UPDATE oauth_refresh_tokens SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE used_at IS NULL AND revoked_at IS NULL
  AND token_hash NOT IN (SELECT child_hash FROM oauth_refresh_tokens WHERE child_hash IS NOT NULL)
  AND EXISTS (SELECT 1 FROM oauth_refresh_tokens tip
              WHERE tip.grant_id = oauth_refresh_tokens.grant_id
                AND tip.used_at IS NULL AND tip.revoked_at IS NULL
                AND tip.token_hash IN (SELECT child_hash FROM oauth_refresh_tokens WHERE child_hash IS NOT NULL));
```

### 0013 ledger share tickets

```sql
-- web-issued ledger-join tickets for already registered users. Separate
-- from invitations (setup / invite / recovery) and register_invitations
-- (identity only): accepting a ticket only adds a ledger_members row for
-- the logged-in user; it never creates a user.
CREATE TABLE ledger_share_tickets (
  token_hash   BLOB    PRIMARY KEY,               -- SHA-256(plaintext token); plaintext is never stored
  ledger_id    INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  role         TEXT    NOT NULL,                  -- editor / viewer (app-side enum; owner is never issued)
  created_by   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- issuer (ledger owner)
  inviter_note TEXT,                              -- issuer memo (optional, 200 chars max)
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  accepted_at  INTEGER,                           -- join confirmed at (never set by info / open)
  accepted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL  -- accepting user
) STRICT, WITHOUT ROWID;
CREATE INDEX ledger_share_tickets_expires ON ledger_share_tickets(expires_at);
CREATE INDEX ledger_share_tickets_issuer_open
  ON ledger_share_tickets(created_by) WHERE accepted_at IS NULL;
```
