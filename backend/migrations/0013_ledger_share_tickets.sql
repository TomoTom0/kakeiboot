-- 0013 ledger share tickets: web-issued ledger-join tickets for already
-- registered users (share design §7-2, D-DB1). Separate from `invitations`
-- (setup / invite / recovery) and `register_invitations` (identity only):
-- accepting a ticket only adds a `ledger_members` row for the logged-in
-- user; it never creates a user. The initial scope has no `allow_signup`
-- column and no derived registration (future extension). CREATE TABLE
-- only; no existing table is touched.

CREATE TABLE ledger_share_tickets (
  token_hash   BLOB    PRIMARY KEY,               -- SHA-256(plaintext token); plaintext is never stored
  ledger_id    INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  role         TEXT    NOT NULL,                  -- editor / viewer (app-side enum; owner is never issued)
  created_by   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- issuer (ledger owner)
  inviter_note TEXT,                              -- issuer memo (optional, 200 chars max)
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  accepted_at  INTEGER,                           -- join confirmed at (never set by info / open)
  accepted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL  -- accepting user
) STRICT, WITHOUT ROWID;
CREATE INDEX ledger_share_tickets_expires ON ledger_share_tickets(expires_at);
CREATE INDEX ledger_share_tickets_issuer_open
  ON ledger_share_tickets(created_by) WHERE accepted_at IS NULL;
