-- 0009 labels: per-ledger fixed color labels and receipt assignments
-- (spec_data-model.md 6-4, 15).

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
