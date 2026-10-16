-- 0010 drafts batch: the sibling-group id of one create_receipt_drafts call
-- (TASK-18, spec_data-model.md §7-1, §15 0010). NULL = single-tool creation
-- and reopen. Used only to exclude same-batch siblings from the file_id
-- duplicate match (one photo shared by several receipts of one call).

ALTER TABLE drafts ADD COLUMN batch_id TEXT;
CREATE INDEX drafts_batch ON drafts(batch_id) WHERE batch_id IS NOT NULL;
