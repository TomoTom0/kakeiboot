-- 0011 register invitations: web-issued registration-only tokens
-- (TASK-32, spec_auth.md 2-1, spec_data-model.md §14, §15 0011). Separate
-- from `invitations` (setup / invite / recovery): issuing an account does
-- not join any ledger. CREATE TABLE only; no existing table is touched.

CREATE TABLE register_invitations (
  token_hash   BLOB    PRIMARY KEY,
  created_by   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inviter_note TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER,
  used_by      INTEGER REFERENCES users(id) ON DELETE SET NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX register_invitations_expires ON register_invitations(expires_at);
CREATE INDEX register_invitations_issuer_open ON register_invitations(created_by) WHERE used_at IS NULL;
