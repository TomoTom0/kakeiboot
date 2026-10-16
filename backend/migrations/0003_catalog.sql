-- 0003 catalog: item / store categories (2-level), stores, aliases
-- (spec_data-model.md §15 0003). item_categories and store_categories are
-- same-shaped separate tables so FKs prevent mixing kinds.

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

-- depth 2 max and parent ledger match (both INSERT and UPDATE)
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

-- same shape as item_categories
CREATE TABLE store_categories (
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
  category_source TEXT,                         -- model / user (app-side enum)
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

-- name-resolution aliases (normalized)
CREATE TABLE store_aliases (
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
