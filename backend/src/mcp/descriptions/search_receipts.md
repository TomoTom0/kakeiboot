確定済みのレシートや明細を条件で探す。mode="receipts"（既定）はレシート単位、mode="items" は品目単位（「牛乳をいつ買ったか」等）。金額の合計・内訳を知りたいときは summarize_spending を使う。

- period（期間）、store（店名の一部）、item_query（品名の一部）、category（"大分類" か "大分類/小分類"、"未分類" 可）、payment_method、label_colors（ラベル色の配列。いずれかを持つレシートに絞る・複数色は OR）で絞り込む。
- 並びは日付の新しい順。続きは結果の next_cursor を cursor に渡す。
- receipts モードの各行には付与中のラベル（labels: 色 + 任意のタイトル）と代表品目（top_items: そのレシートの金額上位2品目。品名 + 金額。値引き行は含まず、品目のないレシートは空）が載る。ラベルの付け外しは label_receipts。
- receipts モードでは結果の文面にも各レシートの代表品目が「店名: 品名・品名」の行で付くので、行データを見なくても何を買ったか読み取れる。
- 削除済みレシートを復元したいときだけ include_deleted=true。
- 詳細は get_receipt。
