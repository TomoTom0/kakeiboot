確定済みレシートを削除（論理削除。90日以内なら復元できる）または復元する。未確定の下書きの取り消しは discard_receipt_draft を使う。

- 削除は2段階: まず confirm なしで呼ぶと対象の要約（preview）と revision が返る。ユーザーに対象を示し、明示の同意を得てから confirm:true と revision を付けて再度呼ぶ。
- 復元は restore:true（確認不要）。
