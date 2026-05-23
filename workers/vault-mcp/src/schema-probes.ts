/**
 * Schema probes — PRAGMA-based checks for conditional migration column
 * presence. Extracted from src/index.ts for reuse by src/cron/backfill-body.ts
 * (plan-E2) alongside the original buildGraph/syncGraph call sites.
 *
 * Probes are POSITIVELY cached only: once a column exists it cannot
 * disappear, so caching `true` is safe for the isolate lifetime. A negative
 * result is NEVER cached — an isolate that probed pre-migration and stayed
 * warm across the apply would otherwise permanently poison every caller.
 * Re-probing on every negative hit is cheap (PRAGMA table_info is a fast
 * catalog read).
 *
 * (Codex P1 round-11 + P2 round-12 + round-45 findings — semantics preserved
 * exactly during the plan-E2 extraction.)
 */
import type { Env } from "./env";

let _vaultNodesSchemaPositive = false;

/**
 * Test helper — drops the positive cache so a test that needs to simulate
 * a pre-0004 database can do so even when an earlier test in the same
 * process already warmed the cache to `true`. Not intended for production
 * code (the production probe never needs to un-cache).
 */
export function resetPlan005VaultNodesCache(): void {
  _vaultNodesSchemaPositive = false;
}

export async function hasPlan005VaultNodeColumns(env: Env): Promise<boolean> {
  if (_vaultNodesSchemaPositive) return true;
  try {
    const cols = await env.DB.prepare(`PRAGMA table_info('vault_nodes')`).all<{ name: string }>();
    const names = new Set((cols.results ?? []).map((r) => r.name));
    const ok = ["body", "word_count", "content_hash", "frontmatter"].every((c) => names.has(c));
    if (ok) _vaultNodesSchemaPositive = true;
    return ok;
  } catch {
    return false;
  }
}

let _vaultEdgesIngestRunIdPositive = false;

/**
 * Drop the positive cache for vault_edges.ingest_run_id. Called by buildGraph
 * after a destructive DROP/CREATE of vault_edges on a pre-0004 database — a
 * stale cached `true` would otherwise make syncGraph select the extended
 * INSERT against a 4-column table and fail.
 */
export function resetVaultEdgesIngestRunIdCache(): void {
  _vaultEdgesIngestRunIdPositive = false;
}

export async function hasVaultEdgesIngestRunId(env: Env): Promise<boolean> {
  // Probe vault_edges.ingest_run_id independently of vault_nodes.body.
  // Migration 0004 is explicitly non-idempotent and can leave schema in a
  // partially-applied state (nodes upgraded, edges not, or vice versa) if
  // the operator re-runs a file that partially failed. Inferring one
  // column's existence from another makes syncGraph() fail with
  // `no such column: ingest_run_id`. (Codex round-45 P1 finding.)
  if (_vaultEdgesIngestRunIdPositive) return true;
  try {
    const cols = await env.DB.prepare(`PRAGMA table_info('vault_edges')`).all<{ name: string }>();
    const ok = (cols.results ?? []).some((r) => r.name === "ingest_run_id");
    if (ok) _vaultEdgesIngestRunIdPositive = true;
    return ok;
  } catch {
    return false;
  }
}

let _vaultEdgesOriginPositive = false;

/** Test helper — drop the positive cache so tests that simulate pre-PR2 DBs
 *  (no origin column) can reprobe even after a warmed isolate. */
export function resetVaultEdgesOriginCache(): void {
  _vaultEdgesOriginPositive = false;
}

/**
 * Probe for the vault_edges.origin column (PR2 non-destructive buildGraph).
 * Returns true when the column exists, meaning buildGraph must NOT drop+recreate
 * vault_edges (other origins' rows must survive the extract phase). Returns
 * false on old schema → buildGraph falls through to the DROP+CREATE migration
 * path. Positive result cached for isolate lifetime.
 */
export async function hasVaultEdgesOriginColumn(env: Env): Promise<boolean> {
  if (_vaultEdgesOriginPositive) return true;
  try {
    const cols = await env.DB.prepare(`PRAGMA table_info('vault_edges')`).all<{ name: string }>();
    const ok = (cols.results ?? []).some((r) => r.name === "origin");
    if (ok) _vaultEdgesOriginPositive = true;
    return ok;
  } catch {
    return false;
  }
}

// Tier A PR3 (post-0013): the legacy dirty-paths probe is retired. The table
// it probed is dropped by migration 0013; degrees are now recomputed via
// drainDegrees() reading vault_ops since-watermark. No probe needed.
