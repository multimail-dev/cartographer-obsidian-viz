-- Rollback stub for 0007_drop_wiki_layer.sql.
--
-- WARNING: this rollback recreates the SCHEMA of the v1 wiki layer but NOT
-- its data. The demo entity row and its R2 object in the
-- wiki R2 bucket are also removed as part of Phase Z, so a
-- rollback yields an empty parallel surface — not the state prior to
-- Phase Z. Phase Z is effectively one-way.
--
-- This file exists so there is a paired rollback artifact in the
-- migrations/rollback/ convention, not because Phase Z is reversible in
-- a meaningful sense. If you need to actually bring wiki v1 back, also
-- restore:
--   - workers/vault-mcp/src/wiki/{fts,links,mcp-tools,r2-wiki}.ts
--   - workers/vault-mcp/src/routes/hono/wiki.ts
--   - the 4 registerTool calls in src/index.ts
--   - the WIKI R2 binding in wrangler.toml + env.ts
--   - the 6 wiki-*.test.ts files (except wiki-prompts.test.ts which survives)
-- from git history before this PR.

CREATE TABLE IF NOT EXISTS wiki_pages (
  path              TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('entity', 'concept', 'cluster', 'index', 'log')),
  title             TEXT NOT NULL,
  r2_key            TEXT NOT NULL,
  source_paths      TEXT NOT NULL,
  cluster_id        INTEGER,
  pagerank          REAL,
  word_count        INTEGER,
  wiki_version      INTEGER NOT NULL DEFAULT 1,
  compiled_at       INTEGER NOT NULL,
  compiled_by       TEXT NOT NULL,
  prompt_hash       TEXT NOT NULL,
  source_hash       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_kind     ON wiki_pages(kind);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_cluster  ON wiki_pages(cluster_id);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_compiled ON wiki_pages(compiled_at DESC);

CREATE TABLE IF NOT EXISTS wiki_links (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path    TEXT NOT NULL,
  target_path    TEXT NOT NULL,
  target_kind    TEXT NOT NULL CHECK (target_kind IN ('wiki', 'vault')),
  anchor_text    TEXT,
  UNIQUE(source_path, target_path, target_kind)
);
CREATE INDEX IF NOT EXISTS idx_wiki_links_source ON wiki_links(source_path);
CREATE INDEX IF NOT EXISTS idx_wiki_links_target ON wiki_links(target_path);

CREATE TABLE IF NOT EXISTS wiki_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  happened_at     INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  source          TEXT,
  detail          TEXT
);
CREATE INDEX IF NOT EXISTS idx_wiki_log_happened ON wiki_log(happened_at DESC);
CREATE INDEX IF NOT EXISTS idx_wiki_log_kind     ON wiki_log(kind);

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
  path,
  title,
  body,
  kind,
  tokenize='unicode61 remove_diacritics 2'
);

INSERT OR REPLACE INTO meta (key, value, updated_at)
  VALUES ('wiki_schema_version', '1', unixepoch());
INSERT OR REPLACE INTO meta (key, value, updated_at)
  VALUES ('wiki_prompt_version', '1', unixepoch());
