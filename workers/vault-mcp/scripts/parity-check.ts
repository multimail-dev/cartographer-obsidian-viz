#!/usr/bin/env bun
/**
 * Phase 3: Parity check — compares local SQLite replica against remote D1.
 *
 * Does: counts vault_ops, vault_nodes, vault_edges on both sides, reports delta.
 * Does NOT: compare row-level content (that's a deeper audit).
 * Use instead of: manual wrangler d1 queries.
 *
 * Exit code 0: delta ≤ 1 sync window (acceptance criterion met).
 * Exit code 1: delta exceeds 1 sync window or error.
 *
 * Usage:
 *   bun scripts/parity-check.ts
 *
 * Env: same as sync-local.ts (VAULT_API_URL, VAULT_BEARER, LOCAL_DB_PATH)
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { DEFAULT_API_URL, DEFAULT_DB_PATH, loadBearer } from "./lib/config";

const API_URL = process.env.VAULT_API_URL ?? DEFAULT_API_URL;
const BEARER = loadBearer();
const DB_PATH = process.env.LOCAL_DB_PATH ?? DEFAULT_DB_PATH;

// Max acceptable ops delta (1 sync window = 5min cadence ≈ few hundred ops max)
const MAX_OPS_DELTA = 500;

async function getRemoteCounts(): Promise<{
  ops: number;
  nodes: number;
  edges: number;
}> {
  // Use /api/sync-ops to get total ops count. Send null watermark so the
  // server includes total_ops in the stats; limit=1 minimizes data transfer.
  const syncRes = await fetch(`${API_URL}/api/sync-ops`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${BEARER}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ops: [], watermark: null, limit: 1 }),
  });
  if (!syncRes.ok) throw new Error(`/api/sync-ops ${syncRes.status}`);
  const syncData = await syncRes.json() as { stats: { total_ops: number } };

  // Get node count via /api/export
  const nodesRes = await fetch(`${API_URL}/api/export?table=vault_nodes&limit=1`, {
    headers: { "Authorization": `Bearer ${BEARER}` },
  });
  if (!nodesRes.ok) throw new Error(`/api/export vault_nodes ${nodesRes.status}`);
  const nodesData = await nodesRes.json() as { total: number };

  // Get edge count via /api/export
  const edgesRes = await fetch(`${API_URL}/api/export?table=vault_edges&limit=1`, {
    headers: { "Authorization": `Bearer ${BEARER}` },
  });
  if (!edgesRes.ok) throw new Error(`/api/export vault_edges ${edgesRes.status}`);
  const edgesData = await edgesRes.json() as { total: number };

  return {
    ops: syncData.stats.total_ops,
    nodes: nodesData.total,
    edges: edgesData.total,
  };
}

function getLocalCounts(db: Database): { ops: number; nodes: number; edges: number } {
  return {
    ops: db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM vault_ops").get()?.c ?? 0,
    nodes: db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM vault_nodes").get()?.c ?? 0,
    edges: db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM vault_edges").get()?.c ?? 0,
  };
}

async function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`Local database not found at ${DB_PATH}`);
    console.error("Run: bun scripts/sync-local.ts --initial");
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });

  try {
    console.log("Fetching remote counts...");
    const remote = await getRemoteCounts();

    console.log("Reading local counts...");
    const local = getLocalCounts(db);

    const watermark = db.query<{ value: string }, []>(
      "SELECT value FROM sync_state WHERE key = 'remote_watermark'"
    ).get()?.value ?? "(none)";

    const lastSync = db.query<{ value: string }, []>(
      "SELECT value FROM sync_state WHERE key = 'last_sync_ts'"
    ).get()?.value ?? "(never)";

    // Calculate deltas
    const opsDelta = remote.ops - local.ops;
    const nodesDelta = remote.nodes - local.nodes;
    const edgesDelta = remote.edges - local.edges;

    console.log("\nParity Report");
    console.log("─".repeat(55));
    console.log(`${"Table".padEnd(15)} ${"Remote".padStart(10)} ${"Local".padStart(10)} ${"Delta".padStart(10)}`);
    console.log("─".repeat(55));
    console.log(`${"vault_ops".padEnd(15)} ${String(remote.ops).padStart(10)} ${String(local.ops).padStart(10)} ${formatDelta(opsDelta)}`);
    console.log(`${"vault_nodes".padEnd(15)} ${String(remote.nodes).padStart(10)} ${String(local.nodes).padStart(10)} ${formatDelta(nodesDelta)}`);
    console.log(`${"vault_edges".padEnd(15)} ${String(remote.edges).padStart(10)} ${String(local.edges).padStart(10)} ${formatDelta(edgesDelta)}`);
    console.log("─".repeat(55));
    console.log(`Watermark:  ${watermark}`);
    console.log(`Last sync:  ${lastSync}`);

    // Verdict
    const opsOk = Math.abs(opsDelta) <= MAX_OPS_DELTA;
    // Nodes and edges can differ more due to materialization timing
    const verdict = opsOk ? "PASS" : "FAIL";
    console.log(`\nVerdict: ${verdict} (ops delta ${opsDelta}, threshold ±${MAX_OPS_DELTA})`);

    if (!opsOk) {
      console.error("Parity check FAILED — ops delta exceeds 1 sync window");
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

function formatDelta(d: number): string {
  const s = d > 0 ? `+${d}` : String(d);
  return s.padStart(10);
}

main().catch((err) => {
  console.error("parity-check failed:", err);
  process.exit(1);
});
