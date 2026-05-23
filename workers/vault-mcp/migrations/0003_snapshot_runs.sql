CREATE TABLE IF NOT EXISTS snapshot_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  node_count  INTEGER NOT NULL,
  edge_count  INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK(status IN ('pending','persisted','failed'))
);

CREATE INDEX IF NOT EXISTS idx_snapshot_runs_created_at
  ON snapshot_runs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_snapshot_runs_status_created_at
  ON snapshot_runs(status, created_at DESC);
