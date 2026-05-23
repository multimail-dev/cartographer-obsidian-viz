-- Phase 3: Local SQLite schema for CRDT read-only replica.
--
-- Mirrors D1 tables that the local sync client populates.
-- Sentinel rows (__last_sync__, __last_degree_drain__, etc.) are NOT synced —
-- they are intra-peer bookkeeping. The local peer has its own sentinel:
-- __sync_watermark__ tracks the last ULID received from remote.
--
-- Usage: sqlite3 ~/.cartographer/local-graph.sqlite < local-schema.sql

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- vault_ops: append-only op-log (the CRDT sync primitive)
CREATE TABLE IF NOT EXISTS vault_ops (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ulid         TEXT UNIQUE NOT NULL,
  op_type      TEXT NOT NULL CHECK (op_type IN ('add_edge', 'remove_edge', 'upsert_node', 'delete_node')),
  payload_json TEXT NOT NULL,
  origin       TEXT NOT NULL CHECK (origin IN ('extract', 'ingest_triples', 'finalize', 'phantom_rewrite', 'migration')),
  ts           TEXT NOT NULL,
  peer         TEXT NOT NULL DEFAULT 'remote'
);
CREATE INDEX IF NOT EXISTS idx_vault_ops_ulid ON vault_ops(ulid);
CREATE INDEX IF NOT EXISTS idx_vault_ops_ts ON vault_ops(ts);
CREATE INDEX IF NOT EXISTS idx_vault_ops_origin_ts ON vault_ops(origin, ts);

-- vault_nodes: materialized node state (populated from /api/export, kept fresh via ops replay)
CREATE TABLE IF NOT EXISTS vault_nodes (
  path          TEXT PRIMARY KEY,
  title         TEXT,
  note_type     TEXT,
  folder        TEXT,
  tags          TEXT DEFAULT '[]',
  aliases       TEXT DEFAULT '[]',
  size          INTEGER DEFAULT 0,
  modified_at   TEXT DEFAULT '',
  indexed_at    TEXT DEFAULT '',
  body          TEXT,
  word_count    INTEGER DEFAULT 0,
  content_hash  TEXT,
  frontmatter   TEXT,
  ingest_run_id TEXT,
  in_degree     INTEGER DEFAULT 0,
  out_degree    INTEGER DEFAULT 0,
  published     INTEGER DEFAULT 0,
  published_at  TEXT,
  issue         INTEGER,
  slug          TEXT,
  jot_note_id   TEXT,
  author        TEXT
);

-- vault_edges: materialized edge state (populated from /api/export, kept fresh via ops replay)
CREATE TABLE IF NOT EXISTS vault_edges (
  source        TEXT NOT NULL,
  target        TEXT NOT NULL,
  edge_type     TEXT NOT NULL,
  weight        REAL DEFAULT 1.0,
  ingest_run_id TEXT,
  origin        TEXT NOT NULL DEFAULT 'extract',
  UNIQUE(source, target, edge_type, origin)
);
CREATE INDEX IF NOT EXISTS idx_vault_edges_source ON vault_edges(source);
CREATE INDEX IF NOT EXISTS idx_vault_edges_target ON vault_edges(target);
CREATE INDEX IF NOT EXISTS idx_vault_edges_origin ON vault_edges(origin);

-- ---------------------------------------------------------------------------
-- Local buildGraph support tables
-- These tables are required by the local buildGraph/syncGraph pipeline.
-- They mirror the D1 schema (migrations 0004+) but are local-only —
-- NOT synced from remote via /api/sync-ops.
-- ---------------------------------------------------------------------------

-- ingest_runs: tracks buildGraph/syncGraph run lifecycle
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

-- meta: key-value store for coordination (ingest run ids, enrichment state, etc.)
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- vault_fts: full-text search on note content (FTS5 virtual table)
CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(path, title, content, tags, tokenize='unicode61 remove_diacritics 2');

-- vault_centrality: PageRank centrality scores (populated by future centrality
-- computation step; NOT written by build-graph-local.ts finalize phase)
CREATE TABLE IF NOT EXISTS vault_centrality (
  path        TEXT PRIMARY KEY,
  score       REAL NOT NULL DEFAULT 0,
  computed_at TEXT
);

-- Sync metadata
CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Watermark: last ULID received from remote peer
-- INSERT OR IGNORE so schema re-runs are idempotent
INSERT OR IGNORE INTO sync_state (key, value) VALUES ('remote_watermark', '');
INSERT OR IGNORE INTO sync_state (key, value) VALUES ('last_sync_ts', '');
INSERT OR IGNORE INTO sync_state (key, value) VALUES ('nodes_exported', '0');
INSERT OR IGNORE INTO sync_state (key, value) VALUES ('edges_exported', '0');
-- Push watermark: last local vault_ops ULID pushed to D1 (empty = cold start)
INSERT OR IGNORE INTO sync_state (key, value) VALUES ('push_watermark', '');
