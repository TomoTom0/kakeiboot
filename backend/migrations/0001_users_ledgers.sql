-- 0001 users / ledgers / ledger_members (spec_data-model.md §15 0001).
-- users includes the columns used for operator-side account identification.
-- default_ledger_id is nullable at the DDL level: user creation inserts with NULL
-- and updates it after the personal ledger is created (application flow).

CREATE TABLE users (
  id                    INTEGER PRIMARY KEY,
  webauthn_user_handle  BLOB    NOT NULL UNIQUE CHECK (length(webauthn_user_handle) = 16),  -- UUID v4 (webauthn-rs user unique id)
  account_number        TEXT    NOT NULL UNIQUE
                        CHECK (account_number GLOB 'BB-[0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z]-[0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z]'),  -- Crockford base32
  display_name          TEXT    NOT NULL,
  default_ledger_id     INTEGER REFERENCES ledgers(id),   -- web target ledger. NULL at insert, set after ledger creation
  admin_note            TEXT,                             -- operator memo. never shown on web / MCP
  invite_note           TEXT,                             -- inviter memo. operator CLI only
  invited_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  invited_via_kind      TEXT,                             -- setup / invite (app-side enum)
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  disabled_at           INTEGER                           -- non-NULL: reject all auth paths
) STRICT;
CREATE INDEX users_invited_by ON users(invited_by) WHERE invited_by IS NOT NULL;

CREATE TABLE ledgers (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE ledger_members (
  ledger_id   INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  role        TEXT    NOT NULL,                 -- owner / editor / viewer (app-side enum)
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (ledger_id, user_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX ledger_members_user ON ledger_members(user_id);
