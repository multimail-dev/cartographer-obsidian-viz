#!/usr/bin/env bun
/**
 * Phase 3: Local SQLite sync client.
 *
 * Does: pulls vault_ops from D1 via /api/sync-ops, exports vault_nodes +
 *       vault_edges via /api/export, materializes ops into local state.
 * Does NOT: write ops back to D1 (Phase C1 is read-only).
 * Use instead of: manual D1 HTTP queries or wrangler d1 execute.
 *
 * Usage:
 *   bun scripts/sync-local.ts                    # incremental sync
 *   bun scripts/sync-local.ts --initial          # full initial export + ops sync
 *   bun scripts/sync-local.ts --ops-only         # sync vault_ops only (skip export)
 *
 * Env:
 *   VAULT_API_URL     — base URL (default: https://your-vault-domain.com)
 *   VAULT_BEARER      — Bearer token (reads from .dev.vars if not set)
 *   LOCAL_DB_PATH     — SQLite path (default: ~/.cartographer/local-graph.sqlite)
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_API_URL, DEFAULT_DB_PATH, SCHEMA_PATH, loadBearer } from "./lib/config";

const API_URL = process.env.VAULT_API_URL ?? DEFAULT_API_URL;
const BEARER = loadBearer();
const DB_PATH = process.env.LOCAL_DB_PATH ?? DEFAULT_DB_PATH;

const isInitial = process.argv.includes("--initial");
const opsOnly = process.argv.includes("--ops-only");

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${BEARER}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${BEARER}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function initDb(): Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schema);
  return db;
}

// ---------------------------------------------------------------------------
// Export: bulk pull vault_nodes + vault_edges from /api/export
// ---------------------------------------------------------------------------

async function exportTable(db: Database, table: "vault_nodes" | "vault_edges"): Promise<number> {
  let offset = 0;
  const limit = 2000;
  let total = 0;

  // Use INSERT OR REPLACE for idempotent re-import without a full wipe.
  // On initial sync the table is empty anyway; on re-export, changed rows
  // are updated and unchanged rows are overwritten with the same values.

  while (true) {
    const data = await apiGet<{
      rows: Record<string, unknown>[];
      has_more: boolean;
      total: number;
    }>(`/api/export?table=${table}&offset=${offset}&limit=${limit}`);

    if (!data.rows?.length) break;

    const tx = db.transaction(() => {
      for (const row of data.rows) {
        if (table === "vault_nodes") {
          db.run(
            `INSERT OR REPLACE INTO vault_nodes
             (path, title, note_type, folder, tags, aliases, size, modified_at,
              indexed_at, body, word_count, content_hash, frontmatter,
              ingest_run_id, in_degree, out_degree, published, published_at,
              issue, slug, jot_note_id, author)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              row.path, row.title, row.note_type, row.folder,
              row.tags, row.aliases, row.size, row.modified_at,
              row.indexed_at, row.body, row.word_count, row.content_hash,
              row.frontmatter, row.ingest_run_id, row.in_degree, row.out_degree,
              row.published, row.published_at, row.issue, row.slug,
              row.jot_note_id, row.author,
            ],
          );
        } else {
          db.run(
            `INSERT OR REPLACE INTO vault_edges
             (source, target, edge_type, weight, ingest_run_id, origin)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [row.source, row.target, row.edge_type, row.weight, row.ingest_run_id, row.origin],
          );
        }
      }
    });
    tx();

    total += data.rows.length;
    offset += limit;
    process.stdout.write(`\r  ${table}: ${total} / ${data.total} rows`);

    if (!data.has_more) break;
  }

  console.log(`\r  ${table}: ${total} rows exported`);

  // Update sync_state
  db.run(
    "UPDATE sync_state SET value = ? WHERE key = ?",
    [String(total), table === "vault_nodes" ? "nodes_exported" : "edges_exported"],
  );

  return total;
}

// ---------------------------------------------------------------------------
// Sync: incremental vault_ops pull via /api/sync-ops
// ---------------------------------------------------------------------------

async function syncOps(db: Database): Promise<{ synced: number; backfilled: number }> {
  const watermarkRow = db.query<{ value: string }, []>(
    "SELECT value FROM sync_state WHERE key = 'remote_watermark'"
  ).get();
  let watermark: string | null = watermarkRow?.value || null;
  let totalSynced = 0;
  let totalBackfilled = 0;
  let knownTotalOps: number | null = null;

  while (true) {
    const data = await apiPost<{
      ops: Array<{
        ulid: string;
        op_type: string;
        payload: Record<string, unknown>;
        origin: string;
        ts: string;
      }>;
      watermark: string | null;
      has_more: boolean;
      stats: { returned: number; backfilled: number; total_ops: number };
    }>("/api/sync-ops", {
      ops: [], // C1: read-only, no outbound ops
      watermark,
      limit: 1000,
    });

    totalBackfilled += data.stats.backfilled;
    if (data.stats.total_ops != null) knownTotalOps = data.stats.total_ops;

    if (!data.ops.length) break;

    // Insert ops into local vault_ops table
    const tx = db.transaction(() => {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO vault_ops (ulid, op_type, payload_json, origin, ts, peer)
         VALUES (?, ?, ?, ?, ?, 'remote')`
      );
      for (const op of data.ops) {
        stmt.run(op.ulid, op.op_type, JSON.stringify(op.payload), op.origin, op.ts);
      }

      // Materialize ops into vault_nodes + vault_edges
      for (const op of data.ops) {
        materializeOp(db, op);
      }
    });
    tx();

    totalSynced += data.ops.length;
    watermark = data.watermark;

    const progressTotal = knownTotalOps ?? "?";
    process.stdout.write(
      `\r  vault_ops: ${totalSynced} / ${progressTotal} synced`
    );

    if (!data.has_more) break;
  }

  // Persist watermark
  if (watermark) {
    db.run(
      "UPDATE sync_state SET value = ? WHERE key = 'remote_watermark'",
      [watermark],
    );
  }
  db.run(
    "UPDATE sync_state SET value = ? WHERE key = 'last_sync_ts'",
    [new Date().toISOString()],
  );

  if (totalSynced > 0) {
    console.log(`\r  vault_ops: ${totalSynced} ops synced`);
  } else {
    console.log("  vault_ops: up to date");
  }

  return { synced: totalSynced, backfilled: totalBackfilled };
}

/**
 * Apply a single vault_ops entry to the materialized vault_nodes/vault_edges tables.
 * This is a simplified version of the CF Worker's applyOps() — sufficient for
 * C1 read-only replica where the local side never produces conflicting writes.
 */
function materializeOp(
  db: Database,
  op: { op_type: string; payload: Record<string, unknown>; origin: string },
): void {
  switch (op.op_type) {
    case "add_edge":
      db.run(
        `INSERT OR IGNORE INTO vault_edges (source, target, edge_type, weight, ingest_run_id, origin)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          op.payload.source as string,
          op.payload.target as string,
          op.payload.edge_type as string,
          (op.payload.weight as number) ?? 1.0,
          (op.payload.ingest_run_id as string) ?? null,
          op.origin,
        ],
      );
      break;

    case "remove_edge":
      db.run(
        `DELETE FROM vault_edges
         WHERE origin = ? AND source = ? AND target = ? AND edge_type = ?`,
        [
          op.origin,
          op.payload.source as string,
          op.payload.target as string,
          op.payload.edge_type as string,
        ],
      );
      break;

    case "upsert_node":
      db.run(
        `INSERT INTO vault_nodes (path, title, note_type, folder, tags, aliases, size, modified_at, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(path) DO UPDATE SET
           title = excluded.title,
           note_type = excluded.note_type,
           folder = excluded.folder,
           tags = excluded.tags,
           aliases = excluded.aliases,
           size = excluded.size,
           modified_at = excluded.modified_at,
           indexed_at = excluded.indexed_at`,
        [
          op.payload.path as string,
          (op.payload.title as string) ?? null,
          (op.payload.note_type as string) ?? null,
          (op.payload.folder as string) ?? null,
          (op.payload.tags as string) ?? "[]",
          JSON.stringify((op.payload.aliases as string[]) ?? []),
          (op.payload.size as number) ?? 0,
          (op.payload.modified_at as string) ?? "",
        ],
      );
      break;

    case "delete_node":
      db.run("DELETE FROM vault_nodes WHERE path = ?", [op.payload.path as string]);
      break;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`sync-local: ${API_URL} → ${DB_PATH}`);
  const db = initDb();

  try {
    if (isInitial && !opsOnly) {
      console.log("Phase 1: Exporting materialized state...");
      await exportTable(db, "vault_nodes");
      await exportTable(db, "vault_edges");
    }

    console.log(isInitial ? "Phase 2: Syncing vault_ops..." : "Syncing vault_ops...");
    const { synced, backfilled } = await syncOps(db);

    // Report final state
    const nodeCount = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM vault_nodes").get()?.c ?? 0;
    const edgeCount = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM vault_edges").get()?.c ?? 0;
    const opsCount = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM vault_ops").get()?.c ?? 0;
    const watermark = db.query<{ value: string }, []>(
      "SELECT value FROM sync_state WHERE key = 'remote_watermark'"
    ).get()?.value ?? "(none)";

    console.log("\nLocal state:");
    console.log(`  vault_nodes: ${nodeCount}`);
    console.log(`  vault_edges: ${edgeCount}`);
    console.log(`  vault_ops:   ${opsCount}`);
    console.log(`  watermark:   ${watermark}`);
    if (backfilled > 0) console.log(`  (remote backfilled ${backfilled} ULIDs)`);
    console.log("done.");
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("sync-local failed:", err);
  process.exit(1);
});
