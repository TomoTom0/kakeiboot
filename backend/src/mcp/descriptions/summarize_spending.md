支出を集計する（金額の合計・内訳・推移）。個々のレシートを探すときは search_receipts を使う。

report:
- monthly_overview: 当月の合計・前月比・カテゴリ内訳・上位店・直近6か月の推移
- by_category: 品目カテゴリ別（filters.category でその小分類別）
- by_store: 店別
- monthly_trend: 月別推移（filters 併用でカテゴリ・店の推移）
- by_payment_method: 支払方法別
- item_price_history: 品目の単価の推移（filters.item_query 必須）

- period を省略すると report ごとの既定期間（多くは今月、推移系は直近12か月）。
- filters.store_category で「コンビニでいくら」等を表す。
- filters.label_colors（ラベル色の配列）で特定のラベルを持つレシートに絞る（複数色は OR）。ユーザーがラベルのタイトル（例: 旅行）で言った場合は get_catalog の labels で色に解決して渡す。適用中の絞り込みは結果の filters に返る。
- 金額は税込換算。
