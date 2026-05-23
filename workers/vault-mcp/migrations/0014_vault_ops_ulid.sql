-- Phase 3: Add ULID column to vault_ops for cross-peer identity.
--
-- The existing autoincrement `id` stays as the intra-peer sequence number
-- (used by drainDegrees watermark, local pagination). The new `ulid` column
-- is the cross-peer identity: sync exchanges ops by ULID, not by autoincrement.
--
-- Nullable initially — the worker backfills existing rows on first
-- /api/sync-ops call or /api/build-graph run. After backfill, all new INSERTs
-- include a ULID. The partial unique index enforces uniqueness only on
-- non-NULL rows so the migration doesn't break pre-backfill state.

ALTER TABLE vault_ops ADD COLUMN ulid TEXT;

-- Partial unique index: only enforced where ulid IS NOT NULL.
-- After backfill completes, every row has a ulid and the index covers all rows.
-- This single B-tree index serves both uniqueness enforcement AND sort-order
-- queries (WHERE ulid > ? ORDER BY ulid) — no separate sort index needed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_ops_ulid
  ON vault_ops(ulid) WHERE ulid IS NOT NULL;
