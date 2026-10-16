確定済みレシートを修正する。未確定の下書きの修正は update_receipt_draft を使う。

- revision は必須（get_receipt の値）。食い違うとエラーになり最新の内容が返るので、最新内容で直してから再度呼ぶ。
- set でヘッダを、upsert_items で明細を更新（item_id 指定で更新、item_id なしは追加）、delete_item_ids で明細を削除する。
- 結果の before に変更前の値が入る。ユーザーに「元に戻して」と言われたら before の値で update_receipt を呼ぶ。
- カテゴリは既存カテゴリ（get_catalog の category_paths）から選ぶ。
