-- 0006 search: FTS5 trigram index over receipt item names and the fact view
-- (spec_data-model.md §15 0006, section 13). external content keeps the index
-- rebuildable via triggers.

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
