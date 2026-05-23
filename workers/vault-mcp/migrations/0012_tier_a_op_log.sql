-- Tier A op-log bootstrap:
--   0. Assert migration 0004+ has been applied (vault_edges.ingest_run_id exists)
--   1. Create vault_ops
--   2. Rebuild vault_edges with origin as part of the uniqueness key
--   3. Backfill origin on current edges
--   4. Seed vault_ops from current vault_edges + vault_nodes
--
-- This migration follows the repo's real migration chain, where 0004 has
-- already added vault_edges.ingest_run_id. SQLite/D1 migrations do not offer
-- procedural IF/ELSE for a single file, so we rebuild against the live schema
-- shape produced by 0004+.
--
-- Codex PR review round 1 finding: the plan (r8) specified "two variants"
-- gated by a hasVaultEdgesIngestRunId probe for pre-0004 DBs. That model does
-- not fit SQLite's single-file migration contract, so instead this migration
-- asserts 0004+ via a pre-flight divide-by-zero guard. Pre-0004 DBs hit the
-- guard and the migration transaction aborts cleanly — no silent data loss.
-- Production and staging cartographer DBs are definitely post-0004.

-- ---------------------------------------------------------------------------
-- 0. Pre-flight: assert vault_edges.ingest_run_id column exists (from 0004).
--    If missing, force a clean abort via division by zero. The migration
--    transaction rolls back; no destructive changes apply.
-- ---------------------------------------------------------------------------
SELECT 1 / (CASE
  WHEN (SELECT COUNT(*) FROM pragma_table_info('vault_edges')
        WHERE name = 'ingest_run_id') = 1
  THEN 1
  ELSE 0
END) AS migration_0012_requires_migration_0004;

CREATE TABLE IF NOT EXISTS vault_ops (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  op_type      TEXT NOT NULL CHECK (op_type IN ('add_edge', 'remove_edge', 'upsert_node', 'delete_node')),
  payload_json TEXT NOT NULL,
  origin       TEXT NOT NULL CHECK (origin IN ('extract', 'ingest_triples', 'finalize', 'phantom_rewrite', 'migration')),
  ts           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vault_ops_ts
  ON vault_ops (ts);

CREATE INDEX IF NOT EXISTS idx_vault_ops_origin_ts
  ON vault_ops (origin, ts);

CREATE TABLE vault_edges_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  target        TEXT NOT NULL,
  edge_type     TEXT NOT NULL CHECK (edge_type IN (
    'wikilink', 'tag', 'related', 'folder', 'temporal', 'tag_cooccurrence',
    'spoke_in', 'discusses', 'predicts', 'claims', 'part_of', 'has_part',
    'references', 'derived_from', 'version_of', 'replaces', 'replaced_by',
    'requires', 'required_by', 'instance_of', 'broader', 'narrower',
    'supports', 'contradicts', 'evolved_into', 'inspired_by', 'depends_on',
    'overrides', 'learned_from', 'scoped_by', 'rejected', 'belongs_to'
  )),
  weight        REAL DEFAULT 1.0,
  created_at    TEXT DEFAULT (datetime('now')),
  ingest_run_id TEXT,
  origin        TEXT NOT NULL DEFAULT 'extract'
                  CHECK (origin IN ('extract', 'ingest_triples', 'finalize', 'phantom_rewrite', 'migration')),
  UNIQUE(origin, source, target, edge_type)
);

INSERT INTO vault_edges_new
  (id, source, target, edge_type, weight, created_at, ingest_run_id, origin)
SELECT
  id,
  source,
  target,
  edge_type,
  weight,
  created_at,
  ingest_run_id,
  'extract'
FROM vault_edges;

DROP TABLE vault_edges;
ALTER TABLE vault_edges_new RENAME TO vault_edges;

CREATE INDEX IF NOT EXISTS idx_vault_edges_origin_source_type
  ON vault_edges (origin, source, edge_type);

CREATE INDEX IF NOT EXISTS idx_vault_edges_origin_target_type
  ON vault_edges (origin, target, edge_type);

CREATE INDEX IF NOT EXISTS idx_edges_source
  ON vault_edges(source);

CREATE INDEX IF NOT EXISTS idx_edges_target
  ON vault_edges(target);

CREATE INDEX IF NOT EXISTS idx_edges_type
  ON vault_edges(edge_type);

UPDATE vault_edges
SET origin = 'finalize'
WHERE edge_type IN ('folder', 'temporal', 'tag_cooccurrence');

UPDATE vault_edges
SET origin = 'ingest_triples'
WHERE edge_type NOT IN ('folder', 'temporal', 'tag_cooccurrence')
  AND ingest_run_id IS NULL;

INSERT INTO vault_ops (op_type, payload_json, origin, ts)
SELECT
  'add_edge',
  json_object(
    'source', source,
    'target', target,
    'edge_type', edge_type,
    'weight', weight,
    'ingest_run_id', ingest_run_id
  ),
  origin,
  datetime('now')
FROM vault_edges;

INSERT INTO vault_ops (op_type, payload_json, origin, ts)
SELECT
  'upsert_node',
  json_object(
    'path', path,
    'title', title,
    'note_type', note_type,
    'folder', folder,
    'tags', tags,
    'aliases', aliases,
    'size', size,
    'modified_at', modified_at,
    'content_hash', content_hash
  ),
  'migration',
  datetime('now')
FROM vault_nodes
WHERE path NOT GLOB '__*';
