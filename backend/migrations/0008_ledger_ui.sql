-- 0008 ledger UI (TASK-16, spec_data-model.md section 15)

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
