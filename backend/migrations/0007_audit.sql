-- 0007 audit: before/after change log (spec_data-model.md §15 0007, section 11).

CREATE TABLE audit_events (
  id           INTEGER PRIMARY KEY,
  ledger_id    INTEGER REFERENCES ledgers(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id)   ON DELETE SET NULL,
  actor_kind   TEXT    NOT NULL,              -- web / mcp / mcp_anonymous / system (app-side enum)
  client_id    TEXT,
  entity_type  TEXT    NOT NULL,              -- receipt / receipt_item / draft / store / ... (app-side enum)
  entity_id    INTEGER NOT NULL,
  action       TEXT    NOT NULL,              -- create / update / delete / restore / approve / discard / reopen / merge (app-side enum)
  before_json  TEXT    CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json   TEXT    CHECK (after_json  IS NULL OR json_valid(after_json)),
  created_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX audit_events_entity ON audit_events(entity_type, entity_id, created_at);
CREATE INDEX audit_events_ledger ON audit_events(ledger_id, created_at);
