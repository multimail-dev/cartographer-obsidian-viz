-- Migration 0005: Rename vault_centrality → vault_enrichment
-- NOT idempotent — run exactly once, AFTER:
--   1. Migration 0004 is applied and green.
--   2. Dual-path code (Phase B9) is deployed and serving traffic for ≥60s.
--      The dual-path probe tolerates both table names during the transition window.
-- After this migration runs, deploy the cleanup commit that removes the dual-path
-- probe and uses vault_enrichment exclusively.

ALTER TABLE vault_centrality RENAME TO vault_enrichment;

-- SQLite carries indexes across RENAME but names drift — drop and recreate
-- under the new prefix for clarity. Table is ≤10k rows, so this is cheap.
DROP INDEX IF EXISTS idx_vault_centrality_cluster;
DROP INDEX IF EXISTS idx_vault_centrality_component;
DROP INDEX IF EXISTS idx_vault_centrality_pagerank;
CREATE INDEX idx_vault_enrichment_cluster   ON vault_enrichment(cluster_id);
CREATE INDEX idx_vault_enrichment_component ON vault_enrichment(component_id);
CREATE INDEX idx_vault_enrichment_pagerank  ON vault_enrichment(pagerank DESC);
