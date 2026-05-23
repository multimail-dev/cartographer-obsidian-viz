#!/usr/bin/env bun
/**
 * Phase C2: Push local vault_ops to D1 via /api/sync-ops.
 *
 * Does: reads local vault_ops (peer='local', ulid > push_watermark), sends them
 *       to the CF Worker's /api/sync-ops endpoint in 2000-op batches, advances
 *       the local push_watermark. Creates an atomic SQLite backup before pushing.
 * Does NOT: pull ops from D1 (use sync-local.ts for that). Does NOT modify
 *           local vault_nodes/vault_edges — this script only reads local ops
 *           and pushes them upstream.
 * Use instead of: /api/build-graph (which re-derives from R2 — expensive).
 *
 * Usage:
 *   bun scripts/push-to-d1.ts              # push new local ops to D1
 *   bun scripts/push-to-d1.ts --dry-run    # show what would be pushed, no HTTP calls
 *
 * Env:
 *   VAULT_API_URL     — base URL (default: https://your-vault-domain.com)
 *   VAULT_BEARER      — Bearer token (reads from .dev.vars if not set)
 *   LOCAL_DB_PATH     — SQLite path (default: ~/.cartographer/local-graph.sqlite)
 *   SKIP_BACKUP       — set to "1" to skip pre-push backup (for testing)
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_API_URL, DEFAULT_DB_PATH, SCHEMA_PATH, loadBearer } from "./lib/config";
import { backupLocalDb } from "./lib/backup";

const API_URL = process.env.VAULT_API_URL ?? DEFAULT_API_URL;
const BEARER = loadBearer();
const DB_PATH = process.env.LOCAL_DB_PATH ?? DEFAULT_DB_PATH;

const isDryRun = process.argv.includes("--dry-run");
const skipBackup = process.env.SKIP_BACKUP === "1";

const BATCH_SIZE = 2000; // matches /api/sync-ops cap
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // exponential backoff ms
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

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
    const err = new Error(`${path} ${res.status}: ${text}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

async function apiPostWithRetry<T>(path: string, body: unknown): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await apiPost<T>(path, body);
    } catch (err: any) {
      const isRetryable = RETRYABLE_STATUSES.has(err.status);
      const isLastAttempt = attempt === MAX_RETRIES;

      if (!isRetryable || isLastAttempt) throw err;

      const delay = RETRY_DELAYS[attempt] ?? 4000;
      console.warn(`  retry ${attempt + 1}/${MAX_RETRIES} after ${err.status} (${delay}ms)`);
      await Bun.sleep(delay);
    }
  }
  throw new Error("unreachable");
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
// Push logic
// ---------------------------------------------------------------------------

interface LocalOp {
  ulid: string;
  op_type: string;
  payload_json: string;
  origin: string;
  ts: string;
}

async function pushOps(db: Database): Promise<{ totalPushed: number; batches: number }> {
  const watermarkRow = db.query<{ value: string }, []>(
    "SELECT value FROM sync_state WHERE key = 'push_watermark'",
  ).get();
  let watermark: string = watermarkRow?.value || "";

  let totalPushed = 0;
  let batches = 0;

  // Count total pending ops for progress reporting
  const pendingCount = db.query<{ c: number }, [string]>(
    "SELECT COUNT(*) AS c FROM vault_ops WHERE peer = 'local' AND ulid > ?",
  ).get(watermark)?.c ?? 0;

  if (pendingCount === 0) {
    console.log("  up to date — no new local ops to push");
    return { totalPushed: 0, batches: 0 };
  }

  console.log(`  ${pendingCount} local ops to push`);

  const selectStmt = db.query<LocalOp, [string]>(
    `SELECT ulid, op_type, payload_json, origin, ts
     FROM vault_ops
     WHERE peer = 'local' AND ulid > ?
     ORDER BY ulid ASC
     LIMIT ${BATCH_SIZE}`,
  );

  while (true) {
    const ops = selectStmt.all(watermark);
    if (ops.length === 0) break;

    if (isDryRun) {
      console.log(`  [dry-run] would push batch ${batches + 1}: ${ops.length} ops (${ops[0].ulid} → ${ops[ops.length - 1].ulid})`);
      watermark = ops[ops.length - 1].ulid;
      totalPushed += ops.length;
      batches++;
      continue;
    }

    // Transform to /api/sync-ops payload format
    const payload = ops.map((op) => ({
      op_type: op.op_type,
      payload: JSON.parse(op.payload_json),
      origin: op.origin,
      ulid: op.ulid,
    }));

    const response = await apiPostWithRetry<{
      ops: unknown[];
      watermark: string | null;
      has_more: boolean;
      stats: { returned: number; applied: number; backfilled: number; total_ops: number };
    }>("/api/sync-ops", {
      ops: payload,
      watermark: null, // we don't want return ops
      limit: 1,        // minimum — server clamps Math.max(limit, 1)
    });

    watermark = ops[ops.length - 1].ulid;
    totalPushed += ops.length;
    batches++;

    // Advance watermark after each successful batch
    db.run(
      "UPDATE sync_state SET value = ? WHERE key = 'push_watermark'",
      [watermark],
    );

    process.stdout.write(
      `\r  pushed: ${totalPushed} / ${pendingCount} ops (batch ${batches}, applied=${response.stats.applied})`,
    );
  }

  if (totalPushed > 0 && !isDryRun) console.log(); // newline after \r progress
  return { totalPushed, batches };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`push-to-d1: ${DB_PATH} → ${API_URL}/api/sync-ops`);
  if (isDryRun) console.log("  [dry-run mode — no HTTP calls]");

  const db = initDb();

  try {
    // Pre-push backup (skip in dry-run or when SKIP_BACKUP=1)
    if (!isDryRun && !skipBackup) {
      console.log("Creating pre-push backup...");
      await backupLocalDb(DB_PATH);
    }

    console.log(isDryRun ? "Scanning local ops..." : "Pushing local ops to D1...");
    const start = Date.now();
    const { totalPushed, batches } = await pushOps(db);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    // Summary
    const watermark = db.query<{ value: string }, []>(
      "SELECT value FROM sync_state WHERE key = 'push_watermark'",
    ).get()?.value ?? "(none)";

    console.log(`\nSummary:`);
    console.log(`  ops pushed:     ${totalPushed}`);
    console.log(`  batches:        ${batches}`);
    console.log(`  elapsed:        ${elapsed}s`);
    console.log(`  push_watermark: ${watermark}`);
    console.log("done.");
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("push-to-d1 failed:", err);
  process.exit(1);
});
