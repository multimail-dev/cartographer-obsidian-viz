-- Phase Z of wiki v2 (docs/plans/2026-04-15-002-feat-wiki-v2-vault-native-plan.md)
--
-- Supersedes: migrations/0006_wiki_layer.sql
--
-- Preconditions (must be true BEFORE applying this migration):
--   1. Wiki v2 (feat/wiki-v2-vault-native) is merged to main.
--   2. Wiki pages have been compiled and are live in the R2 bucket.
--   3. /api/build-graph has run so vault_nodes + vault_edges contain the new
--      wiki notes and their edge_type='wikilink' rows.
--   4. The worker code removing /api/wiki/* routes + 4 MCP tools + WIKI binding
--      has been deployed. (Code-side deletions land in the same PR as this
--      migration, but the SQL is applied by hand via `wrangler d1 execute` —
--      this file is the executable record, not an auto-applied migration.)
--
-- Rationale: v1 stood up four parallel tables (wiki_pages, wiki_links, wiki_fts,
-- wiki_log) that duplicated what vault_nodes + vault_edges + vault_fts already
-- provide once wiki markdown files are indexed by extractEdgesFromNote. Wiki v2
-- writes those markdown files directly to the obsidian-vault R2 bucket under a
-- Wiki/ prefix, so the parallel surface is dead weight. See the plan document
-- §"What v1 got wrong" for the full post-mortem.
--
-- Rollback: see rollback/0007_drop_wiki_layer.sql (recreates the tables but NOT
-- their data — this drop is one-way in practice).

DROP TABLE IF EXISTS wiki_fts;
DROP TABLE IF EXISTS wiki_log;
DROP TABLE IF EXISTS wiki_links;
DROP TABLE IF EXISTS wiki_pages;

DELETE FROM meta WHERE key IN (
  'wiki_schema_version',
  'wiki_prompt_version',
  'last_wiki_compile_at',
  'last_wiki_compile_summary'
);
