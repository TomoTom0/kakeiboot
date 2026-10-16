-- 0002 auth: WebAuthn, web sessions, invitations, OAuth 2.1, account identification
-- (spec_data-model.md §15 0002). webauthn_ceremonies.authz_request_hash references
-- oauth_authorization_requests defined later in this file; SQLite checks FKs at DML
-- time so the definition order is unconstrained.

CREATE TABLE webauthn_credentials (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  BLOB    NOT NULL UNIQUE,
  passkey_json   TEXT    NOT NULL CHECK (json_valid(passkey_json)),  -- webauthn_rs::prelude::Passkey
  label          TEXT,
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER,
  updated_at     INTEGER NOT NULL
) STRICT;
CREATE INDEX webauthn_credentials_user ON webauthn_credentials(user_id);

CREATE TABLE webauthn_ceremonies (
  id_hash     BLOB    PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK (kind IN ('register','authenticate')),
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,   -- NULL for discoverable auth
  state_json  TEXT    NOT NULL CHECK (json_valid(state_json)),
  authz_request_hash  BLOB REFERENCES oauth_authorization_requests(id_hash) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX webauthn_ceremonies_expires ON webauthn_ceremonies(expires_at);
CREATE INDEX webauthn_ceremonies_authz ON webauthn_ceremonies(authz_request_hash) WHERE authz_request_hash IS NOT NULL;

CREATE TABLE web_sessions (
  id_hash             BLOB    PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at          INTEGER NOT NULL,
  auth_at             INTEGER NOT NULL,             -- last passkey auth time
  last_seen_at        INTEGER NOT NULL,
  idle_expires_at     INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at          INTEGER,
  user_agent          TEXT
) STRICT, WITHOUT ROWID;
CREATE INDEX web_sessions_user ON web_sessions(user_id);
CREATE INDEX web_sessions_expires ON web_sessions(absolute_expires_at);

-- setup / invite / recovery one-time tokens (hash stored)
CREATE TABLE invitations (
  token_hash      BLOB    PRIMARY KEY,
  kind            TEXT    NOT NULL CHECK (kind IN ('setup','invite','recovery')),
  created_by      INTEGER REFERENCES users(id) ON DELETE CASCADE,    -- invite only
  target_user_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,    -- recovery only
  ledger_id       INTEGER REFERENCES ledgers(id) ON DELETE CASCADE,  -- invite only
  role            TEXT,                                              -- invite only (editor / viewer)
  operator_note   TEXT,                                              -- setup: required, recovery: optional
  inviter_note    TEXT,                                              -- invite only, optional
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER,
  used_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((kind = 'recovery') = (target_user_id IS NOT NULL)),
  CHECK ((kind = 'invite') = (ledger_id IS NOT NULL AND role IS NOT NULL)),
  CHECK ((kind = 'invite') = (created_by IS NOT NULL)),
  CHECK (kind <> 'setup' OR operator_note IS NOT NULL),
  CHECK (kind = 'invite' OR inviter_note IS NULL),
  CHECK (kind <> 'invite' OR operator_note IS NULL)
) STRICT, WITHOUT ROWID;
CREATE INDEX invitations_expires ON invitations(expires_at);
-- one unused recovery token per user; revocation is row deletion
CREATE UNIQUE INDEX invitations_recovery_open ON invitations(target_user_id) WHERE kind = 'recovery' AND used_at IS NULL;

-- CIMD document cache
CREATE TABLE oauth_clients (
  client_id                   TEXT    PRIMARY KEY,
  metadata_json               TEXT    NOT NULL CHECK (json_valid(metadata_json)),
  client_name                 TEXT,
  redirect_uris_json          TEXT    NOT NULL CHECK (json_valid(redirect_uris_json)),
  token_endpoint_auth_method  TEXT    NOT NULL,      -- none / private_key_jwt (app-side enum)
  jwks_uri                    TEXT,
  etag                        TEXT,
  fetched_at                  INTEGER NOT NULL,
  expires_at                  INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE oauth_jwks_cache (
  jwks_uri     TEXT    PRIMARY KEY,
  jwks_json    TEXT    NOT NULL CHECK (json_valid(jwks_json)),
  etag         TEXT,
  fetched_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- verified authorize parameters (login round trip and consent POST binding)
CREATE TABLE oauth_authorization_requests (
  id_hash         BLOB    PRIMARY KEY,
  client_id       TEXT    NOT NULL REFERENCES oauth_clients(client_id),
  redirect_uri    TEXT    NOT NULL,
  state           TEXT,
  code_challenge  TEXT    NOT NULL,
  scope           TEXT    NOT NULL,
  resource        TEXT    NOT NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL                                  -- 10 min
) STRICT, WITHOUT ROWID;
CREATE INDEX oauth_authz_requests_expires ON oauth_authorization_requests(expires_at);

-- consent + refresh token family (created on auth code exchange)
CREATE TABLE oauth_grants (
  id                   INTEGER PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id            TEXT    NOT NULL REFERENCES oauth_clients(client_id),
  scope                TEXT    NOT NULL,
  resource             TEXT    NOT NULL,
  active_ledger_id     INTEGER REFERENCES ledgers(id) ON DELETE SET NULL,
  created_at           INTEGER NOT NULL,
  absolute_expires_at  INTEGER NOT NULL,
  last_used_at         INTEGER,
  revoked_at           INTEGER,
  revoked_reason       TEXT                     -- user / refresh_reuse / code_reuse / superseded / admin (app-side enum)
) STRICT;
CREATE INDEX oauth_grants_user ON oauth_grants(user_id);
CREATE INDEX oauth_grants_user_client ON oauth_grants(user_id, client_id, resource) WHERE revoked_at IS NULL;
CREATE INDEX oauth_grants_active_ledger ON oauth_grants(active_ledger_id) WHERE active_ledger_id IS NOT NULL;

-- scope guard: only a ledger the grant user belongs to can be selected
CREATE TRIGGER oauth_grants_active_ledger_ins BEFORE INSERT ON oauth_grants
WHEN NEW.active_ledger_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM ledger_members m WHERE m.ledger_id = NEW.active_ledger_id AND m.user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'active_ledger_id: not a member'); END;
CREATE TRIGGER oauth_grants_active_ledger_upd BEFORE UPDATE OF active_ledger_id, user_id ON oauth_grants
WHEN NEW.active_ledger_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM ledger_members m WHERE m.ledger_id = NEW.active_ledger_id AND m.user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'active_ledger_id: not a member'); END;

-- forbid PK-column updates (membership changes are DELETE + INSERT)
CREATE TRIGGER ledger_members_no_pk_update BEFORE UPDATE OF ledger_id, user_id ON ledger_members
BEGIN SELECT RAISE(ABORT, 'ledger_members: ledger_id/user_id are immutable'); END;

-- leaving a membership clears the user's grant selection (no fallback to default)
CREATE TRIGGER ledger_members_del_clear_active AFTER DELETE ON ledger_members
BEGIN
  UPDATE oauth_grants SET active_ledger_id = NULL
  WHERE user_id = OLD.user_id AND active_ledger_id = OLD.ledger_id;
END;

CREATE TABLE oauth_auth_codes (
  code_hash       BLOB    PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id       TEXT    NOT NULL REFERENCES oauth_clients(client_id),
  redirect_uri    TEXT    NOT NULL,
  code_challenge  TEXT    NOT NULL,
  scope           TEXT    NOT NULL,
  resource        TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER,
  grant_id        INTEGER REFERENCES oauth_grants(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX oauth_auth_codes_expires ON oauth_auth_codes(expires_at);

CREATE TABLE oauth_access_tokens (
  token_hash   BLOB    PRIMARY KEY,
  grant_id     INTEGER NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  refresh_hash BLOB,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER
) STRICT, WITHOUT ROWID;
CREATE INDEX oauth_access_tokens_grant ON oauth_access_tokens(grant_id);
CREATE INDEX oauth_access_tokens_refresh ON oauth_access_tokens(refresh_hash) WHERE refresh_hash IS NOT NULL;
CREATE INDEX oauth_access_tokens_expires ON oauth_access_tokens(expires_at);

CREATE TABLE oauth_refresh_tokens (
  token_hash   BLOB    PRIMARY KEY,
  grant_id     INTEGER NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  parent_hash  BLOB,
  child_hash   BLOB,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,                -- min(issued + 30d, grant.absolute_expires_at)
  used_at      INTEGER,                         -- first rotation use (grace start; not updated on re-issue)
  revoked_at   INTEGER,
  CHECK ((used_at IS NULL) = (child_hash IS NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX oauth_refresh_tokens_grant ON oauth_refresh_tokens(grant_id);
CREATE INDEX oauth_refresh_tokens_expires ON oauth_refresh_tokens(expires_at);

CREATE TABLE oauth_client_assertion_jtis (
  client_id   TEXT    NOT NULL,
  jti         TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  PRIMARY KEY (client_id, jti)
) STRICT, WITHOUT ROWID;
CREATE INDEX oauth_jtis_expires ON oauth_client_assertion_jtis(expires_at);

-- account identification and recovery requests
CREATE TABLE user_subject_hashes (
  subject_hash   BLOB    NOT NULL,          -- v1 = SHA-256("budget-book/openai-subject/v1:" + subject)
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer         TEXT    NOT NULL,          -- 'openai' (app-side enum)
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (subject_hash, user_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX user_subject_hashes_user ON user_subject_hashes(user_id);
CREATE INDEX user_subject_hashes_last_seen ON user_subject_hashes(last_seen_at);

CREATE TABLE recovery_requests (
  id               INTEGER PRIMARY KEY,
  request_number   TEXT    NOT NULL UNIQUE,                 -- 'R-XXXX'
  status           TEXT    NOT NULL CHECK (status IN ('open','resolved','rejected')),
  subject_hash     BLOB,
  ip_hash          BLOB,                                     -- nulled 24h after creation
  note             TEXT    CHECK (note IS NULL OR length(note) <= 1000),
  append_count     INTEGER NOT NULL DEFAULT 0 CHECK (append_count >= 0),
  created_at       INTEGER NOT NULL,
  closed_at        INTEGER,
  close_note       TEXT,
  CHECK ((status = 'open') = (closed_at IS NULL))
) STRICT;
CREATE INDEX recovery_requests_subject ON recovery_requests(subject_hash, created_at) WHERE subject_hash IS NOT NULL;
CREATE INDEX recovery_requests_ip ON recovery_requests(ip_hash, created_at) WHERE ip_hash IS NOT NULL;
CREATE INDEX recovery_requests_created ON recovery_requests(created_at);
CREATE UNIQUE INDEX recovery_requests_open_subject ON recovery_requests(subject_hash) WHERE status = 'open' AND subject_hash IS NOT NULL;

CREATE TABLE recovery_request_candidates (
  request_id  INTEGER NOT NULL REFERENCES recovery_requests(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      TEXT    NOT NULL,          -- subject / bearer (app-side enum)
  PRIMARY KEY (request_id, user_id, source)
) STRICT, WITHOUT ROWID;
CREATE INDEX recovery_request_candidates_user ON recovery_request_candidates(user_id);

CREATE TABLE recovery_overflow_daily (       -- count of requests rejected by the global cap
  day    TEXT    PRIMARY KEY,                 -- JST date 'YYYY-MM-DD'
  count  INTEGER NOT NULL CHECK (count >= 0)
) STRICT, WITHOUT ROWID;
