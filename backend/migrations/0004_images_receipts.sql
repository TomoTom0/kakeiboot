-- 0004 confirmed data: images, image access tokens, receipts, receipt items
-- (spec_data-model.md §15 0004).

CREATE TABLE images (
  id                        INTEGER PRIMARY KEY,
  ledger_id                 INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  uploaded_by               INTEGER NOT NULL REFERENCES users(id),
  file_key                  TEXT    NOT NULL UNIQUE,   -- ULID
  storage_path              TEXT    NOT NULL UNIQUE,
  mime_type                 TEXT    NOT NULL DEFAULT 'image/webp',
  width                     INTEGER NOT NULL CHECK (width > 0),
  height                    INTEGER NOT NULL CHECK (height > 0),
  byte_size                 INTEGER NOT NULL CHECK (byte_size > 0),
  sha256                    BLOB    NOT NULL,          -- hash of fetched bytes (pre-conversion)
  source_file_id            TEXT,
  source_host               TEXT,
  -- confirmed values (with provenance). raw model-reported values live in drafts.reported_*
  original_filename         TEXT,
  original_filename_source  TEXT,                      -- model / download
  taken_at_local            TEXT,                      -- 'YYYY-MM-DDTHH:MM:SS'
  taken_at_offset           TEXT,
  taken_at_source           TEXT,                      -- exif / model
  exif_json                 TEXT CHECK (exif_json IS NULL OR json_valid(exif_json)),
  created_at                INTEGER NOT NULL,
  CHECK ((original_filename IS NULL) = (original_filename_source IS NULL)),
  CHECK ((taken_at_local IS NULL) = (taken_at_source IS NULL))
) STRICT;
CREATE INDEX images_sha ON images(ledger_id, sha256);
CREATE INDEX images_source_file ON images(ledger_id, source_file_id) WHERE source_file_id IS NOT NULL;
CREATE INDEX images_created ON images(created_at);

-- short-lived widget access tokens (/media/img/<token>)
CREATE TABLE image_access_tokens (
  token_hash  BLOB    PRIMARY KEY,            -- SHA-256 of a 256-bit random value
  image_id    INTEGER NOT NULL REFERENCES images(id)  ON DELETE CASCADE,
  ledger_id   INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
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
  purchased_on          TEXT    NOT NULL CHECK (purchased_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  purchased_time        TEXT    CHECK (purchased_time IS NULL OR purchased_time GLOB '[0-2][0-9]:[0-5][0-9]*'),
  purchased_month       TEXT    GENERATED ALWAYS AS (substr(purchased_on, 1, 7)) VIRTUAL,
  tax_mode              TEXT    CHECK (tax_mode IN ('inclusive','exclusive')),   -- NULL = unknown
  total_amount          INTEGER,
  tax_amount            INTEGER,
  payment_method        TEXT,                    -- app-side enum
  note                  TEXT,
  revision              INTEGER NOT NULL DEFAULT 1,
  created_at            INTEGER NOT NULL,        -- = input time
  updated_at            INTEGER NOT NULL,
  deleted_at            INTEGER
) STRICT;
CREATE INDEX receipts_ledger_date  ON receipts(ledger_id, purchased_on) WHERE deleted_at IS NULL;
CREATE INDEX receipts_ledger_store ON receipts(ledger_id, store_id, purchased_on) WHERE deleted_at IS NULL;
CREATE INDEX receipts_store        ON receipts(store_id) WHERE store_id IS NOT NULL;
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
  ledger_id        INTEGER NOT NULL,             -- denormalized; kept equal to receipts by trigger
  line_no          INTEGER NOT NULL,
  line_kind        TEXT    NOT NULL DEFAULT 'item' CHECK (line_kind IN ('item','discount')),
  parent_item_id   INTEGER REFERENCES receipt_items(id) ON DELETE CASCADE,
  name             TEXT    NOT NULL,
  name_raw         TEXT,
  name_norm        TEXT    NOT NULL,
  name_raw_norm    TEXT,
  quantity         REAL    NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit             TEXT,
  unit_price       INTEGER,
  amount           INTEGER NOT NULL,
  amount_incl      INTEGER NOT NULL,
  tax_rate         INTEGER CHECK (tax_rate BETWEEN 0 AND 100),
  category_id      INTEGER REFERENCES item_categories(id) ON DELETE SET NULL,
  category_source  TEXT,                          -- model / history / user (app-side enum)
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
