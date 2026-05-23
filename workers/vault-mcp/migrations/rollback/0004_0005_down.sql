-- Down-migration: Reversal of 0004 + 0005
-- Run in this order to undo migrations 0005 then 0004.
-- Requires SQLite ≥3.35 (D1 supports DROP COLUMN).

-- Reversal of migration 0005:
-- Drop the indexes created by 0005 BEFORE renaming (they reference vault_enrichment columns).
DROP INDEX IF EXISTS idx_vault_enrichment_cluster;
DROP INDEX IF EXISTS idx_vault_enrichment_component;
DROP INDEX IF EXISTS idx_vault_enrichment_pagerank;
ALTER TABLE vault_enrichment RENAME TO vault_centrality;

-- Reversal of migration 0004 (tables first, then columns in reverse creation order):
DROP TABLE IF EXISTS vault_snapshots;
DROP TABLE IF EXISTS ingest_runs;
DROP TABLE IF EXISTS enrich_cursor;
DROP TABLE IF EXISTS meta;
-- Drop indexes added by 0004 that reference columns we are about to drop.
DROP INDEX IF EXISTS idx_vault_centrality_cluster;
DROP INDEX IF EXISTS idx_vault_centrality_component;
DROP INDEX IF EXISTS idx_vault_centrality_pagerank;
ALTER TABLE vault_centrality DROP COLUMN clustering_coeff;
ALTER TABLE vault_centrality DROP COLUMN component_id;
ALTER TABLE vault_centrality DROP COLUMN cluster_id;
ALTER TABLE vault_edges DROP COLUMN ingest_run_id;
ALTER TABLE vault_nodes DROP COLUMN ingest_run_id;
ALTER TABLE vault_nodes DROP COLUMN created_at;
ALTER TABLE vault_nodes DROP COLUMN frontmatter;
ALTER TABLE vault_nodes DROP COLUMN content_hash;
ALTER TABLE vault_nodes DROP COLUMN word_count;
ALTER TABLE vault_nodes DROP COLUMN body;
