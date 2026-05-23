-- ─── wiki_pages ──────────────────────────────────────────────────────────
CREATE TABLE wiki_pages (
  path              TEXT PRIMARY KEY,                  -- canonical wiki path, e.g. 'Entities/Example' or 'Clusters/601186267'
  kind              TEXT NOT NULL CHECK (kind IN ('entity', 'concept', 'cluster', 'index', 'log')),
  title             TEXT NOT NULL,
  r2_key            TEXT NOT NULL,                     -- key in wiki R2 bucket, e.g. 'entities/example.md'
  source_paths      TEXT NOT NULL,                     -- JSON array of vault_nodes.path values this page summarizes
  cluster_id        INTEGER,                           -- nullable FK-like link to vault_enrichment.cluster_id
  pagerank          REAL,                              -- max pagerank among source_paths (for sort ordering)
  word_count        INTEGER,                           -- compiled page word count
  wiki_version      INTEGER NOT NULL DEFAULT 1,        -- incremented on every recompile
  compiled_at       INTEGER NOT NULL,                  -- unixepoch SECONDS (matches plan-005 round-20 convention)
  compiled_by       TEXT NOT NULL,                     -- 'claude-sonnet-4-6' | 'claude-opus-4-6' | '@cf/meta/llama-...'
  prompt_hash       TEXT NOT NULL,                     -- SHA-256 hex of the prompt template that produced this page
  source_hash       TEXT NOT NULL                      -- SHA-256 hex of concat(source_paths' content_hash in sorted path order)
);
CREATE INDEX idx_wiki_pages_kind     ON wiki_pages(kind);
CREATE INDEX idx_wiki_pages_cluster  ON wiki_pages(cluster_id);
CREATE INDEX idx_wiki_pages_compiled ON wiki_pages(compiled_at DESC);

-- ─── wiki_links ──────────────────────────────────────────────────────────
CREATE TABLE wiki_links (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path    TEXT NOT NULL,                        -- wiki_pages.path (always wiki-side)
  target_path    TEXT NOT NULL,                        -- wiki_pages.path OR vault_nodes.path
  target_kind    TEXT NOT NULL CHECK (target_kind IN ('wiki', 'vault')),
  anchor_text    TEXT,                                 -- visible link text in the body
  UNIQUE(source_path, target_path, target_kind)
);
CREATE INDEX idx_wiki_links_source ON wiki_links(source_path);
CREATE INDEX idx_wiki_links_target ON wiki_links(target_path);

-- ─── wiki_log ────────────────────────────────────────────────────────────
CREATE TABLE wiki_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  happened_at     INTEGER NOT NULL,                    -- unixepoch seconds
  kind            TEXT NOT NULL,                       -- 'compile' | 'recompile' | 'skip' | 'error' | 'query'
  source          TEXT,                                -- wiki_pages.path (nullable)
  detail          TEXT                                 -- JSON blob
);
CREATE INDEX idx_wiki_log_happened ON wiki_log(happened_at DESC);
CREATE INDEX idx_wiki_log_kind     ON wiki_log(kind);

-- ─── wiki_fts ────────────────────────────────────────────────────────────
CREATE VIRTUAL TABLE wiki_fts USING fts5(
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
