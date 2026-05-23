-- Persistent dirty-path tracking enables scoped degree recompute in syncGraph
-- (replacing two full-table UPDATEs over ~10k vault_nodes per call). The
-- AUTOINCREMENT rowid enables snapshot-based drain
-- (UPDATE/DELETE WHERE rowid <= snapshot_max), so concurrent writers' rows
-- survive a sync's drain and get processed by the next call. Path is not
-- unique; duplicates collapse via SELECT DISTINCT during drain.

CREATE TABLE IF NOT EXISTS vault_dirty_degrees (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL
);
