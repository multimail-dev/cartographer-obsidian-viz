-- Migration 0004: Enrichment extensions (additive, ONE-SHOT — NOT idempotent)
-- Adds columns, tables, and indexes required for the algorithm enrichment pipeline.
--
-- IDEMPOTENCY: only CREATE TABLE / CREATE INDEX statements are idempotent
-- (IF NOT EXISTS). The `ALTER TABLE ... ADD COLUMN` statements are NOT —
-- SQLite has no `ADD COLUMN IF NOT EXISTS`, and re-applying this file on a
-- partially-migrated database will abort with a duplicate-column error.
-- The plan 005 B10 deploy playbook handles this by probing column presence
-- via `pragma_table_info('vault_nodes')` before running the migration and
-- skipping if already applied. Do not rely on blind re-runs being safe.
-- DO NOT apply this migration until vault-mcp is on a code version that tolerates
-- both vault_centrality and vault_enrichment table names (Phase B9 dual-path code).
-- (Codex round-41 P2 finding — comment now matches actual behavior.)

-- B1: Add nullable body/content columns to vault_nodes
ALTER TABLE vault_nodes ADD COLUMN body TEXT;
ALTER TABLE vault_nodes ADD COLUMN word_count INTEGER;
ALTER TABLE vault_nodes ADD COLUMN content_hash TEXT;
ALTER TABLE vault_nodes ADD COLUMN frontmatter TEXT;
ALTER TABLE vault_nodes ADD COLUMN created_at TEXT;
ALTER TABLE vault_nodes ADD COLUMN ingest_run_id TEXT;

-- B2: Add ingest_run_id to vault_edges
ALTER TABLE vault_edges ADD COLUMN ingest_run_id TEXT;

-- B3 (additive): Add enrichment columns + indexes to vault_centrality
-- The rename (vault_centrality → vault_enrichment) is in migration 0005.
ALTER TABLE vault_centrality ADD COLUMN cluster_id INTEGER;
ALTER TABLE vault_centrality ADD COLUMN component_id INTEGER;
ALTER TABLE vault_centrality ADD COLUMN clustering_coeff REAL;
CREATE INDEX IF NOT EXISTS idx_vault_centrality_cluster    ON vault_centrality(cluster_id);
CREATE INDEX IF NOT EXISTS idx_vault_centrality_component  ON vault_centrality(component_id);
CREATE INDEX IF NOT EXISTS idx_vault_centrality_pagerank   ON vault_centrality(pagerank DESC);

-- B4: Create meta key-value store + seed last_ingest_run_id
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Seed so the orchestrator's ingest-race guard has a non-NULL starting point
-- before the sync-graph writer (B6b) deploys. Without this, the guard is a
-- silent no-op on the first enrichment run.
INSERT OR IGNORE INTO meta (key, value, updated_at) VALUES ('last_ingest_run_id', 'bootstrap', unixepoch());

-- B5: Create enrich_cursor with lease semantics
CREATE TABLE IF NOT EXISTS enrich_cursor (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  phase           TEXT    NOT NULL DEFAULT 'algorithm',  -- 'embedding' | 'algorithm' | 'running_algorithms' | 'backfill'
  lease_expires   INTEGER NOT NULL DEFAULT 0,
  lease_owner     TEXT,
  last_node_id    TEXT,
  last_run_at     INTEGER NOT NULL DEFAULT 0,
  nodes_processed INTEGER NOT NULL DEFAULT 0
);
-- Default phase is 'algorithm': Vectorize/embedding phase is deferred.
-- The next cron run enters algorithm phase directly.
INSERT OR IGNORE INTO enrich_cursor (id, phase) VALUES (1, 'algorithm');

-- B6: Create ingest_runs
CREATE TABLE IF NOT EXISTS ingest_runs (
  id           TEXT    PRIMARY KEY,
  snapshot_uri TEXT,
  started_at   INTEGER NOT NULL,
  completed_at INTEGER,
  node_count   INTEGER,
  edge_count   INTEGER,
  status       TEXT    NOT NULL DEFAULT 'running',
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_started ON ingest_runs(started_at DESC);

-- B6a: Create vault_snapshots for per-node per-enrichment-run drift history
-- Consumed by the cognitive-feedback-loop visualizer.
CREATE TABLE IF NOT EXISTS vault_snapshots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id             TEXT    NOT NULL,              -- path in vault-graph schema
  enrichment_version  INTEGER NOT NULL,
  captured_at         INTEGER NOT NULL,              -- epoch millis
  pagerank            REAL,
  cluster_id          INTEGER,
  component_id        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_vault_snapshots_node    ON vault_snapshots(node_id, enrichment_version DESC);
CREATE INDEX IF NOT EXISTS idx_vault_snapshots_version ON vault_snapshots(enrichment_version);
