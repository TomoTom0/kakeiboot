-- 0012 revoke superseded refresh children (TASK-140, spec_auth.md 4-9 step 3,
-- spec_data-model.md §14, §15 0012). Data-only: no table is created or
-- altered.
--
-- Before TASK-140 a grace-window reissue (refresh step 3) replaced the
-- parent's child_hash but left the old child's refresh row unused and
-- unrevoked, so it could still rotate as a fresh token. Step 3 now revokes
-- it, and presenting a revoked child revokes the family. This revokes the
-- orphans left by the old code, using direct evidence only: the row is
-- unused, unrevoked, referenced by no child_hash, and its grant has a live
-- tip (an unused, unrevoked row that some child_hash references). Initial
-- tokens of never-rotated grants and current children whose parent was
-- already deleted have no such tip and stay untouched.

UPDATE oauth_refresh_tokens SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE used_at IS NULL AND revoked_at IS NULL
  AND token_hash NOT IN (SELECT child_hash FROM oauth_refresh_tokens WHERE child_hash IS NOT NULL)
  AND EXISTS (SELECT 1 FROM oauth_refresh_tokens tip
              WHERE tip.grant_id = oauth_refresh_tokens.grant_id
                AND tip.used_at IS NULL AND tip.revoked_at IS NULL
                AND tip.token_hash IN (SELECT child_hash FROM oauth_refresh_tokens WHERE child_hash IS NOT NULL));
