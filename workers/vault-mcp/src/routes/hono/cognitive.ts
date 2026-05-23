/**
 * Vault drift routes — consumed by cognitive-feedback-loop visualizer.
 *
 * IMPORTANT: these routes return VAULT state only (pagerank, cluster_id).
 * External cognitive drift endpoints are NOT served from here.
 *
 * All routes read from vault_snapshots (migration 0004). Writes happen in
 * the algorithm enrichment cron.
 *
 * Endpoints:
 *   GET /api/vault/drift?node=<id>
 *       Returns time-series of PageRank + cluster_id for one vault node.
 *
 *   GET /api/vault/propagate?node=<id>&version=<n>
 *       Returns neighbors whose PageRank changed between version n-1 and n.
 *       "version" defaults to the latest enrichment run.
 *
 * DOES NOT:
 *   - Handle rrf_logs (vault-mcp has no rrf_logs table)
 *   - Write any data (READ-ONLY)
 *
 * Ported from the power-mode cognitive.ts — adapted to vault-mcp schema:
 *   nodes.id     → vault_nodes.path
 *   edges.source_id/target_id → vault_edges.source/target
 * vault_snapshots table is identical in both schemas.
 */
import { Hono } from "hono";
import type { Env } from "../../env";
import type {
  DriftPointDto,
  VaultDriftResponse,
  PropagationChangeDto,
  VaultPropagateResponse,
} from "@vault-graph/contract";

export const cognitiveRoutes = new Hono<{ Bindings: Env }>();

// Pre-0004 guard: vault_snapshots is created by migration 0004. During the
// dual-path rollout window the code is live before the migration runs. Probe
// once per request; if the table is missing, return an empty response rather
// than 500ing. (Codex round-39 P1 finding.)
async function hasVaultSnapshots(env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='vault_snapshots' LIMIT 1`
    ).first<{ name: string }>();
    return !!row;
  } catch {
    return false;
  }
}

// Raw D1 row shape uses SQL snake_case column names; we project into the
// shared camelCase DTO before serializing. (Codex P2 round-3 finding: the
// handlers were returning snake_case keys that typed consumers could not read.)
interface DriftRow {
  captured_at: number;
  enrichment_version: number;
  pagerank: number;
  cluster_id: number | null;
  component_id: number | null;
}

cognitiveRoutes.get("/api/vault/drift", async (c) => {
  const nodeId = c.req.query("node");
  if (!nodeId) return c.json({ error: "Missing node param" }, 400);

  if (!(await hasVaultSnapshots(c.env))) {
    const empty: VaultDriftResponse = { nodeId, title: nodeId, points: [] };
    return c.json(empty);
  }

  const rows = await c.env.DB.prepare(
    `SELECT captured_at, enrichment_version, pagerank, cluster_id, component_id
     FROM vault_snapshots
     WHERE node_id = ?
     ORDER BY enrichment_version ASC
     LIMIT 500`,
  ).bind(nodeId).all<DriftRow>();

  const titleRow = await c.env.DB.prepare(
    `SELECT title FROM vault_nodes WHERE path = ? LIMIT 1`,
  ).bind(nodeId).first<{ title: string }>();

  const points: DriftPointDto[] = (rows.results ?? []).map((r) => ({
    capturedAt: r.captured_at,
    enrichmentVersion: r.enrichment_version,
    pagerank: r.pagerank,
    clusterId: r.cluster_id,
    componentId: r.component_id,
  }));

  const response: VaultDriftResponse = {
    nodeId,
    title: titleRow?.title ?? nodeId,
    points,
  };
  return c.json(response);
});

cognitiveRoutes.get("/api/vault/propagate", async (c) => {
  const seedNode = c.req.query("node");
  const versionParam = c.req.query("version");
  if (!seedNode) return c.json({ error: "Missing node param" }, 400);

  if (!(await hasVaultSnapshots(c.env))) {
    const empty: VaultPropagateResponse = {
      seed: seedNode,
      enrichmentVersion: 0,
      changed: [],
      historicalAccuracy: "exact",
    };
    return c.json(empty);
  }

  let version = versionParam ? parseInt(versionParam, 10) : NaN;
  if (isNaN(version)) {
    const latest = await c.env.DB.prepare(
      `SELECT MAX(enrichment_version) AS v FROM vault_snapshots`,
    ).first<{ v: number | null }>();
    if (!latest?.v) {
      const empty: VaultPropagateResponse = { seed: seedNode, enrichmentVersion: 0, changed: [], historicalAccuracy: "exact" };
      return c.json(empty);
    }
    version = latest.v;
  }

  // Resolve neighbors from vault_snapshots at the REQUESTED version, not
  // live vault_edges, so historical propagation queries are consistent
  // with the snapshot node set. We approximate neighborhood via live edges
  // AND restrict to nodes that actually had a snapshot row at that version.
  // TRUE accuracy against historical edge topology requires snapshotting
  // edges too (not currently persisted). Report the accuracy class in the
  // response so consumers know whether to trust the set.
  // (Codex P2 round-19 partial fix + self-review round-20 accuracy flag.)
  const latestVersionRow = await c.env.DB.prepare(
    `SELECT MAX(enrichment_version) AS v FROM vault_snapshots`,
  ).first<{ v: number | null }>();
  const isLatest = (latestVersionRow?.v ?? 0) === version;
  const historicalAccuracy: "exact" | "approximate" = isLatest ? "exact" : "approximate";

  const neighborRows = await c.env.DB.prepare(
    `SELECT DISTINCT neighbor FROM (
       SELECT CASE WHEN source = ? THEN target ELSE source END AS neighbor
       FROM vault_edges
       WHERE source = ? OR target = ?
     )
     WHERE neighbor IN (
       SELECT DISTINCT node_id FROM vault_snapshots WHERE enrichment_version = ?
     )`,
  ).bind(seedNode, seedNode, seedNode, version).all<{ neighbor: string }>();

  const neighbors = (neighborRows.results ?? []).map((r) => r.neighbor);
  if (neighbors.length === 0) {
    const empty: VaultPropagateResponse = { seed: seedNode, enrichmentVersion: version, changed: [], historicalAccuracy };
    return c.json(empty);
  }

  const changed: PropagationChangeDto[] = [];

  for (const nId of neighbors) {
    const current = await c.env.DB.prepare(
      `SELECT pagerank, cluster_id FROM vault_snapshots
       WHERE node_id = ? AND enrichment_version = ? LIMIT 1`,
    ).bind(nId, version).first<{ pagerank: number; cluster_id: number | null }>();
    if (!current) continue;

    const prev = await c.env.DB.prepare(
      `SELECT pagerank, cluster_id FROM vault_snapshots
       WHERE node_id = ? AND enrichment_version < ?
       ORDER BY enrichment_version DESC LIMIT 1`,
    ).bind(nId, version).first<{ pagerank: number; cluster_id: number | null }>();

    const prBefore = prev?.pagerank ?? current.pagerank;
    const delta = current.pagerank - prBefore;
    const clusterChanged = (prev?.cluster_id ?? null) !== (current.cluster_id ?? null);

    if (Math.abs(delta) > 1e-6 || clusterChanged) {
      const titleRow = await c.env.DB.prepare(
        `SELECT title FROM vault_nodes WHERE path = ? LIMIT 1`,
      ).bind(nId).first<{ title: string }>();

      changed.push({
        nodeId: nId,
        title: titleRow?.title ?? nId,
        pagerankBefore: prBefore,
        pagerankAfter: current.pagerank,
        pagerankDelta: delta,
        clusterBefore: prev?.cluster_id ?? null,
        clusterAfter: current.cluster_id,
      });
    }
  }

  changed.sort((a, b) => Math.abs(b.pagerankDelta) - Math.abs(a.pagerankDelta));

  const response: VaultPropagateResponse = {
    seed: seedNode,
    enrichmentVersion: version,
    changed,
    historicalAccuracy,
  };
  return c.json(response);
});
