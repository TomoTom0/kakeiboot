-- 0005 drafts: staging rows holding the JSON payload of an in-conversation receipt
-- (spec_data-model.md §15 0005, section 7). Only pending rows carry image_id;
-- closing nulls it and keeps image_status / reason as history.

CREATE TABLE drafts (
  id                       INTEGER PRIMARY KEY,
  ledger_id                INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  user_id                  INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  status                   TEXT    NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','approved','discarded','expired')),
  revision                 INTEGER NOT NULL DEFAULT 1,
  payload_json             TEXT    CHECK (payload_json IS NULL OR json_valid(payload_json)),
  source_file_id           TEXT,                 -- openai file id (duplicate detection record; not unique)
  image_id                 INTEGER REFERENCES images(id) ON DELETE RESTRICT,  -- pending only
  image_status             TEXT    NOT NULL CHECK (image_status IN ('none','attached','unavailable')),
  image_unavailable_reason TEXT,                 -- app-side enum
  -- raw model-reported metadata (provenance is always model; confirmed values live in images)
  reported_filename        TEXT,
  reported_taken_at        TEXT,
  approved_receipt_id      INTEGER REFERENCES receipts(id) ON DELETE SET NULL,
  approved_revision        INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  expires_at               INTEGER NOT NULL,
  closed_at                INTEGER,
  CHECK ((status = 'pending') = (closed_at IS NULL)),
  CHECK (status <> 'approved' OR approved_revision IS NOT NULL),
  CHECK (status <> 'pending' OR payload_json IS NOT NULL),
  CHECK (status <> 'pending' OR (image_status = 'attached') = (image_id IS NOT NULL)),
  CHECK (status = 'pending' OR image_id IS NULL),
  CHECK ((image_status = 'unavailable') = (image_unavailable_reason IS NOT NULL))
) STRICT;
CREATE INDEX drafts_user_file ON drafts(user_id, source_file_id) WHERE source_file_id IS NOT NULL;
CREATE INDEX drafts_user_status ON drafts(user_id, status, updated_at);
CREATE INDEX drafts_expires     ON drafts(expires_at) WHERE status = 'pending';
CREATE INDEX drafts_closed      ON drafts(closed_at)  WHERE closed_at IS NOT NULL;
CREATE INDEX drafts_image       ON drafts(image_id)   WHERE image_id IS NOT NULL;
CREATE INDEX drafts_receipt     ON drafts(approved_receipt_id) WHERE approved_receipt_id IS NOT NULL;
CREATE TRIGGER drafts_guard_ins BEFORE INSERT ON drafts WHEN NEW.image_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'image ledger mismatch')
  WHERE (SELECT ledger_id FROM images WHERE id = NEW.image_id) <> NEW.ledger_id;
END;
CREATE TRIGGER drafts_guard_upd BEFORE UPDATE OF image_id, ledger_id ON drafts BEGIN
  SELECT RAISE(ABORT, 'ledger_id is immutable') WHERE NEW.ledger_id <> OLD.ledger_id;
  SELECT RAISE(ABORT, 'image ledger mismatch')
  WHERE NEW.image_id IS NOT NULL AND (SELECT ledger_id FROM images WHERE id = NEW.image_id) <> NEW.ledger_id;
END;
