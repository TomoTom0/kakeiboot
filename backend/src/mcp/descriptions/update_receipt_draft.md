保存済みの下書き（未確定）を修正する。確定済みレシートの修正は update_receipt を使う。

- set でヘッダ（店名・日付・支払方法・合計など）を部分更新する（null で消去）。
- upsert_items は line_no をキーに明細を更新（指定した項目だけ上書き）、無い line_no は追加（追加時は name と amount が必要）。delete_line_nos で行を削除。読み直して全体を置き換えるときは replace_items（upsert_items / delete_line_nos と同時に使わない）。
- カテゴリは既存カテゴリ（get_catalog の category_paths、結果の categories_hint）から選ぶ。新しいカテゴリを勝手に作らない。
- 結果の revision が最新。承認するときはその revision を approve_receipt_draft に渡す。
