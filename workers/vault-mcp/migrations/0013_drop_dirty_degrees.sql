-- Tier A PR3: retire vault_dirty_degrees + bootstrap drainDegrees watermark.
--
-- Pre-flight: assert vault_ops exists (migration 0012 applied). If missing,
-- divide-by-zero forces the migration transaction to abort cleanly. Production
-- and staging cartographer DBs are post-0012 by the time PR3 lands.
--
-- After this migration:
--   1. vault_dirty_degrees is gone (the post-PR3 drainDegrees() reads
--      vault_ops directly via the __last_degree_drain__ since-id watermark).
--   2. The __last_degree_drain__ row is seeded to MAX(vault_ops.id) so the
--      first post-deploy drain is scoped to ops appended AFTER the deploy —
--      not the entire vault_ops history.

-- ---------------------------------------------------------------------------
-- 0. Pre-flight: assert vault_ops table exists (from migration 0012).
-- ---------------------------------------------------------------------------
SELECT 1 / (CASE
  WHEN (SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'table' AND name = 'vault_ops') = 1
  THEN 1
  ELSE 0
END) AS migration_0013_requires_migration_0012;

-- ---------------------------------------------------------------------------
-- 1. Bootstrap the drainDegrees watermark to MAX(vault_ops.id) at deploy time.
--    First drain after PR3 is then scoped to post-deploy ops only.
-- ---------------------------------------------------------------------------
INSERT OR REPLACE INTO vault_nodes
  (path, title, note_type, folder, tags, size, modified_at, indexed_at)
  VALUES ('__last_degree_drain__', 'degree_drain', null, '', '[]',
          COALESCE((SELECT MAX(id) FROM vault_ops), 0),
          '', datetime('now'));

-- ---------------------------------------------------------------------------
-- 2. Drop the legacy dirty-paths queue.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS vault_dirty_degrees;
