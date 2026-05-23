/**
 * backfill-body.test.ts — plan-E2 acceptance tests for runBodyBackfillSlice.
 *
 * Uses bun:sqlite as a D1 shim (same shape as enrich-algorithms.test.ts) and
 * an in-memory R2 shim. Covers all 18 test scenarios from the plan doc;
 * scenario 19 is the manual integration test against the live deployment.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runBodyBackfillSlice } from "../src/cron/backfill-body";
import { resetPlan005VaultNodesCache } from "../src/schema-probes";
import type { Env } from "../src/env";

// Drop the module-level positive cache before every test so scenario 12
// (pre-0004) works even after a prior test seeded the full schema.
import { beforeEach } from "bun:test";
beforeEach(() => resetPlan005VaultNodesCache());

// ---------------------------------------------------------------------------
// D1 shim
// ---------------------------------------------------------------------------

interface Stmt {
  _sql: string;
  _bound: unknown[];
  bind: (...args: unknown[]) => Stmt;
  run: () => Promise<{ meta: { changes: number }; success: boolean }>;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
}

function createD1Shim(db: Database) {
  function prepare(sql: string): Stmt {
    const stmt: Stmt = {
      _sql: sql,
      _bound: [],
      bind(...args: unknown[]) {
        const s = prepare(sql);
        s._bound = args;
        return s;
      },
      run() {
        const s = db.prepare(this._sql);
        let changes = 0;
        const info = s.run(...(this._bound as Parameters<typeof s.run>));
        changes = (info as { changes?: number }).changes ?? 0;
        return Promise.resolve({ meta: { changes }, success: true });
      },
      first<T>() {
        const s = db.prepare(this._sql);
        const row = s.get(...(this._bound as Parameters<typeof s.get>)) as T | null;
        return Promise.resolve(row ?? null);
      },
      all<T>() {
        const s = db.prepare(this._sql);
        const rows = s.all(...(this._bound as Parameters<typeof s.all>)) as T[];
        return Promise.resolve({ results: rows });
      },
    };
    return stmt;
  }

  function batch(stmts: Stmt[]) {
    return db.transaction(() => {
      const results = [];
      for (const stmt of stmts) {
        const s = db.prepare(stmt._sql);
        const info = s.run(...(stmt._bound as Parameters<typeof s.run>));
        results.push({
          meta: { changes: (info as { changes?: number }).changes ?? 0 },
          success: true,
        });
      }
      return results;
    })();
  }

  return { prepare, batch };
}

// ---------------------------------------------------------------------------
// R2 shim — minimal surface: get() returning { text, uploaded, size } or null
// ---------------------------------------------------------------------------

interface MockR2Obj { body: string; uploaded: Date; size: number }

function createR2Shim(map: Map<string, MockR2Obj>) {
  return {
    get(key: string) {
      const obj = map.get(key);
      if (!obj) return Promise.resolve(null);
      return Promise.resolve({
        text: () => Promise.resolve(obj.body),
        uploaded: obj.uploaded,
        size: obj.size,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

function bootstrapSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_nodes (
      path TEXT PRIMARY KEY,
      title TEXT,
      note_type TEXT,
      folder TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      aliases TEXT DEFAULT '[]',
      size INTEGER DEFAULT 0,
      modified_at TEXT DEFAULT '',
      indexed_at TEXT DEFAULT '',
      body TEXT,
      word_count INTEGER,
      content_hash TEXT,
      frontmatter TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS enrich_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      phase TEXT NOT NULL DEFAULT 'algorithm',
      lease_expires INTEGER NOT NULL DEFAULT 0,
      last_node_id TEXT,
      last_run_at INTEGER NOT NULL DEFAULT 0,
      nodes_processed INTEGER NOT NULL DEFAULT 0
    );

    INSERT OR IGNORE INTO enrich_cursor (id, phase) VALUES (1, 'algorithm');
  `);
}

function seedVaultNode(db: Database, path: string) {
  db.prepare(`INSERT OR REPLACE INTO vault_nodes (path, title) VALUES (?, ?)`).run(path, path);
}

function seedR2(map: Map<string, MockR2Obj>, path: string, body: string, uploadedIso = "2026-01-01T00:00:00.000Z") {
  // vault_nodes.path has no .md suffix; R2 key is path + .md
  map.set(path + ".md", { body, uploaded: new Date(uploadedIso), size: body.length });
}

function makeEnv(db: Database, r2: Map<string, MockR2Obj>): Env {
  return {
    DB: createD1Shim(db) as unknown as D1Database,
    VAULT: createR2Shim(r2) as unknown as R2Bucket,
  } as unknown as Env;
}

async function canonicalHash(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ===========================================================================
// Scenario 1 — fresh DB, full backfill in one call
// ===========================================================================

describe("runBodyBackfillSlice", () => {
  test("scenario 1: fresh DB, 30 rows processed in one completed cycle", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    const r2 = new Map<string, MockR2Obj>();
    for (let i = 0; i < 30; i++) {
      const path = `folder/note-${String(i).padStart(3, "0")}`;
      seedVaultNode(db, path);
      seedR2(r2, path, `---\ntitle: Note ${i}\n---\nBody ${i} has words`);
    }

    const env = makeEnv(db, r2);
    const result = await runBodyBackfillSlice(env, false);

    expect(result.status).toBe("completed");
    expect(result.processedThisCall).toBe(30);
    expect(result.lastNodeId).toBeNull();
    expect(result.totalProcessed).toBe(30);

    const populated = db.prepare(
      `SELECT COUNT(*) as c FROM vault_nodes WHERE body IS NOT NULL AND word_count IS NOT NULL AND content_hash IS NOT NULL`,
    ).get() as { c: number };
    expect(populated.c).toBe(30);

    const cursor = db.prepare(`SELECT phase, lease_expires, last_node_id FROM enrich_cursor WHERE id = 1`).get() as {
      phase: string; lease_expires: number; last_node_id: string | null;
    };
    expect(cursor.phase).toBe("algorithm");
    expect(cursor.lease_expires).toBe(0);
    expect(cursor.last_node_id).toBeNull();

    const cooldownRow = db.prepare(`SELECT value FROM meta WHERE key = 'last_backfill_at'`).get() as { value: string } | null;
    expect(cooldownRow).not.toBeNull();

    const summaryRow = db.prepare(`SELECT value FROM meta WHERE key = 'last_backfill_summary'`).get() as { value: string } | null;
    expect(summaryRow).not.toBeNull();
    const summary = JSON.parse(summaryRow!.value);
    expect(summary.totalProcessed).toBe(30);
  });

  // =========================================================================
  // Scenario 3 — idempotency: pre-populated content_hash skips rewrite
  // =========================================================================
  test("scenario 3: idempotency check skips already-populated rows", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    const r2 = new Map<string, MockR2Obj>();

    const staleBody = `---\ntitle: Stale\n---\nStale body`;
    const freshBody = `---\ntitle: Fresh\n---\nFresh body`;
    const staleHash = await canonicalHash(staleBody);

    // Row 1 — already at the expected hash, should be SKIPPED.
    db.prepare(
      `INSERT OR REPLACE INTO vault_nodes (path, title, content_hash, body) VALUES (?, ?, ?, ?)`,
    ).run("a/stable", "Stable", staleHash, "old body that we will NOT overwrite");
    seedR2(r2, "a/stable", staleBody);

    // Row 2 — has no content_hash, should be PROCESSED.
    seedVaultNode(db, "b/fresh");
    seedR2(r2, "b/fresh", freshBody);

    const env = makeEnv(db, r2);
    const result = await runBodyBackfillSlice(env, false);

    expect(result.status).toBe("completed");
    expect(result.processedThisCall).toBe(1);
    expect(result.skippedThisCall).toBe(1);

    const stable = db.prepare(`SELECT body FROM vault_nodes WHERE path = 'a/stable'`).get() as { body: string };
    expect(stable.body).toBe("old body that we will NOT overwrite");
  });

  // =========================================================================
  // Scenario 4 — R2 miss handling
  // =========================================================================
  test("scenario 4: R2 miss increments counter and preserves row", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    const r2 = new Map<string, MockR2Obj>();

    for (let i = 0; i < 5; i++) {
      seedVaultNode(db, `n/${i}`);
      if (i !== 2) seedR2(r2, `n/${i}`, `body ${i}`);
    }

    const env = makeEnv(db, r2);
    const result = await runBodyBackfillSlice(env, false);

    expect(result.status).toBe("completed");
    expect(result.missingFromR2ThisCall).toBe(1);
    expect(result.processedThisCall).toBe(4);

    const missingRow = db.prepare(`SELECT body FROM vault_nodes WHERE path = 'n/2'`).get() as { body: string | null };
    expect(missingRow.body).toBeNull();

    const allRows = db.prepare(`SELECT COUNT(*) as c FROM vault_nodes`).get() as { c: number };
    expect(allRows.c).toBe(5);
  });

  // =========================================================================
  // Scenario 5 — frontmatter parse failure is tolerated
  // =========================================================================
  test("scenario 5: malformed frontmatter → frontmatter=NULL, body still written", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    const r2 = new Map<string, MockR2Obj>();

    seedVaultNode(db, "bad/note");
    // Unclosed frontmatter block — parseFrontmatterExtended returns null.
    seedR2(r2, "bad/note", `---\ntitle: Never closed\nBody body`);

    const env = makeEnv(db, r2);
    const result = await runBodyBackfillSlice(env, false);

    expect(result.status).toBe("completed");
    expect(result.processedThisCall).toBe(1);

    const row = db.prepare(`SELECT body, frontmatter FROM vault_nodes WHERE path = 'bad/note'`).get() as {
      body: string; frontmatter: string | null;
    };
    expect(row.body).toContain("Body body");
    expect(row.frontmatter).toBeNull();
  });

  // =========================================================================
  // Scenario 6 — sentinel rows skipped
  // =========================================================================
  test("scenario 6: sentinel rows (path GLOB '__*') are skipped", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    const r2 = new Map<string, MockR2Obj>();

    seedVaultNode(db, "__last_sync__");
    seedVaultNode(db, "__build_run_id__");
    seedVaultNode(db, "real/note");
    seedR2(r2, "real/note", "real body");
    // Sentinels get no R2 object — if we tried to fetch them it would count
    // as a miss.

    const env = makeEnv(db, r2);
    const result = await runBodyBackfillSlice(env, false);

    expect(result.status).toBe("completed");
    expect(result.missingFromR2ThisCall).toBe(0);
    expect(result.processedThisCall).toBe(1);
  });

  // =========================================================================
  // Scenario 7 — lease_held when running_algorithms holds a fresh lease
  // =========================================================================
  test("scenario 7: lease_held when running_algorithms holds a fresh lease", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    const r2 = new Map<string, MockR2Obj>();

    db.prepare(
      `UPDATE enrich_cursor SET phase = 'running_algorithms', lease_expires = unixepoch() + 300 WHERE id = 1`,
    ).run();

    const env = makeEnv(db, r2);
    const result = await runBodyBackfillSlice(env, false);

    expect(result.status).toBe("lease_held");
    expect(result.leaseHolder?.phase).toBe("running_algorithms");
  });

  // =========================================================================
  // Scenario 8 — abandoned backfill lease is reclaimable
  // =========================================================================
  test("scenario 8: abandoned backfill lease is reclaimed, resume advances", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    const r2 = new Map<string, MockR2Obj>();

    // Seed 5 rows with paths that sort AFTER the stale cursor.
    for (let i = 0; i < 5; i++) {
      const p = `z/${i}`;
      seedVaultNode(db, p);
      seedR2(r2, p, `body ${i}`);
    }

    db.prepare(
      `UPDATE enrich_cursor SET phase = 'backfill', lease_expires = unixepoch() - 60, last_node_id = 'a/stale' WHERE id = 1`,
    ).run();

    const env = makeEnv(db, r2);
    const result = await runBodyBackfillSlice(env, false);

    expect(result.status).toBe("completed");
    expect(result.processedThisCall).toBe(5);
  });

  // =========================================================================
  // Scenario 9 — cooldown enforcement
  // =========================================================================
  test("scenario 9: cooldown skip without force after recent completion", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    const r2 = new Map<string, MockR2Obj>();

    seedVaultNode(db, "a/note");
    seedR2(r2, "a/note", "body");
    db.prepare(
      `INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('last_backfill_at', ?, unixepoch())`,
    ).run(String(Math.floor(Date.now() / 1000) - 3600));

    const env = makeEnv(db, r2);
    const result = await runBodyBackfillSlice(env, false);

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("cooldown");

    // Lease must be released.
    const cursor = db.prepare(`SELECT phase, lease_expires FROM enrich_cursor WHERE id = 1`).get() as {
      phase: string; lease_expires: number;
    };
    expect(cursor.phase).toBe("algorithm");
    expect(cursor.lease_expires).toBe(0);
  });

  // =========================================================================
  // Scenario 10 — force bypass
  // =========================================================================
  test("scenario 10: force=true bypasses cooldown and completes", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    const r2 = new Map<string, MockR2Obj>();

    seedVaultNode(db, "a/note");
    seedR2(r2, "a/note", "body");
    db.prepare(
      `INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('last_backfill_at', ?, unixepoch())`,
    ).run(String(Math.floor(Date.now() / 1000) - 3600));

    const env = makeEnv(db, r2);
    const result = await runBodyBackfillSlice(env, true);

    expect(result.status).toBe("completed");
    expect(result.processedThisCall).toBe(1);
  });

  // =========================================================================
  // Scenario 11 — force rate limit
  // =========================================================================
  test("scenario 11: force bucket exhausted returns rate_limit", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    const r2 = new Map<string, MockR2Obj>();
    seedVaultNode(db, "a/note");
    seedR2(r2, "a/note", "body");

    db.prepare(
      `INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('last_backfill_at', ?, unixepoch())`,
    ).run(String(Math.floor(Date.now() / 1000) - 3600));

    const hourBucket = Math.floor(Date.now() / 3_600_000).toString();
    db.prepare(
      `INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('backfill_force_bucket', ?, unixepoch())`,
    ).run(JSON.stringify({ bucket: hourBucket, count: 10 }));

    const env = makeEnv(db, r2);
    const result = await runBodyBackfillSlice(env, true);

    expect(result.status).toBe("rate_limit");
    const cursor = db.prepare(`SELECT phase FROM enrich_cursor WHERE id = 1`).get() as { phase: string };
    expect(cursor.phase).toBe("algorithm");
  });

  // =========================================================================
  // Scenario 12 — pre-0004 graceful
  // =========================================================================
  test("scenario 12: pre-0004 database returns not_implemented", async () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE vault_nodes (path TEXT PRIMARY KEY, title TEXT);
      CREATE TABLE enrich_cursor (id INTEGER PRIMARY KEY CHECK (id=1), phase TEXT, lease_expires INTEGER, last_node_id TEXT, nodes_processed INTEGER);
      INSERT INTO enrich_cursor (id, phase, lease_expires, nodes_processed) VALUES (1, 'algorithm', 0, 0);
    `);
    const r2 = new Map<string, MockR2Obj>();
    const env = makeEnv(db, r2);

    const result = await runBodyBackfillSlice(env, false);
    expect(result.status).toBe("not_implemented");
  });

  // =========================================================================
  // Scenario 17 — content_hash format byte-equality with buildGraph pattern
  // =========================================================================
  test("scenario 17: content_hash is lowercase hex SHA-256", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    const r2 = new Map<string, MockR2Obj>();

    const body = `---\ntitle: Canonical\n---\nCanonical body text`;
    seedVaultNode(db, "canon/note");
    seedR2(r2, "canon/note", body);

    const env = makeEnv(db, r2);
    await runBodyBackfillSlice(env, false);

    const row = db.prepare(`SELECT content_hash FROM vault_nodes WHERE path = 'canon/note'`).get() as { content_hash: string };
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.content_hash).toBe(await canonicalHash(body));
  });

  // =========================================================================
  // Scenario 18 — R2 path round-trip across path shapes
  // =========================================================================
  test("scenario 18: R2 path round-trip (root / nested / spaces / non-ASCII)", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    const r2 = new Map<string, MockR2Obj>();

    const paths = [
      "root",
      "folder/child",
      "a/b/c/deep/note",
      "with spaces/name",
      "unicode/日本語",
    ];
    for (const p of paths) {
      seedVaultNode(db, p);
      seedR2(r2, p, `body of ${p}`);
    }

    const env = makeEnv(db, r2);
    const result = await runBodyBackfillSlice(env, false);

    expect(result.status).toBe("completed");
    expect(result.processedThisCall).toBe(5);
    expect(result.missingFromR2ThisCall).toBe(0);
  });

  // =========================================================================
  // created_at uses R2 uploaded timestamp, preserved by COALESCE
  // =========================================================================
  test("created_at is set from R2 uploaded; COALESCE preserves existing", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    const r2 = new Map<string, MockR2Obj>();

    // Row A: no created_at — should get R2 uploaded timestamp.
    seedVaultNode(db, "a/new");
    seedR2(r2, "a/new", "body A", "2025-06-15T12:00:00.000Z");

    // Row B: already has created_at — should be preserved.
    db.prepare(
      `INSERT OR REPLACE INTO vault_nodes (path, title, created_at) VALUES (?, ?, ?)`,
    ).run("b/existing", "B", "2020-01-01T00:00:00.000Z");
    seedR2(r2, "b/existing", "body B", "2025-06-15T12:00:00.000Z");

    const env = makeEnv(db, r2);
    await runBodyBackfillSlice(env, false);

    const a = db.prepare(`SELECT created_at FROM vault_nodes WHERE path = 'a/new'`).get() as { created_at: string };
    expect(a.created_at).toBe("2025-06-15T12:00:00.000Z");

    const b = db.prepare(`SELECT created_at FROM vault_nodes WHERE path = 'b/existing'`).get() as { created_at: string };
    expect(b.created_at).toBe("2020-01-01T00:00:00.000Z");
  });

  // =========================================================================
  // P3 fix: cycle-level skipped/missing counters accumulate across slices
  // =========================================================================
  test("P3: mid-cycle resume carries skipped+missing counts from meta.backfill_cycle_state", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    const r2 = new Map<string, MockR2Obj>();

    // Seed 5 fresh rows that will be processed on this call.
    for (let i = 0; i < 5; i++) {
      seedVaultNode(db, `fresh/${i}`);
      seedR2(r2, `fresh/${i}`, `body ${i}`);
    }

    // Pretend a prior slice already advanced past "aaa/prior" with 100
    // skipped and 50 missing, and persisted that state.
    db.prepare(
      `UPDATE enrich_cursor
         SET phase = 'backfill',
             lease_expires = unixepoch() - 1,
             last_node_id = 'aaa/prior',
             nodes_processed = 200
       WHERE id = 1`,
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('backfill_cycle_state', ?, unixepoch())`,
    ).run(JSON.stringify({ skipped: 100, missing: 50 }));
    db.prepare(
      `INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('backfill_cycle_started_at', ?, unixepoch())`,
    ).run(String(Math.floor(Date.now() / 1000) - 60));

    const env = makeEnv(db, r2);
    const result = await runBodyBackfillSlice(env, false);

    expect(result.status).toBe("completed");
    expect(result.processedThisCall).toBe(5);
    // Cumulative values should include the prior state.
    expect(result.totalProcessed).toBe(205);
    expect(result.totalSkipped).toBe(100);
    expect(result.totalMissingFromR2).toBe(50);

    const summaryRow = db.prepare(`SELECT value FROM meta WHERE key = 'last_backfill_summary'`).get() as { value: string };
    const summary = JSON.parse(summaryRow.value);
    expect(summary.totalProcessed).toBe(205);
    expect(summary.totalSkipped).toBe(100);
    expect(summary.totalMissingFromR2).toBe(50);

    // backfill_cycle_state is cleared on completion so the next cycle starts fresh.
    const stateRow = db.prepare(`SELECT value FROM meta WHERE key = 'backfill_cycle_state'`).get();
    expect(stateRow).toBeNull();
  });

  // =========================================================================
  // Concurrent backfill: second caller receives lease_held
  // =========================================================================
  test("second concurrent caller receives lease_held", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    const r2 = new Map<string, MockR2Obj>();

    // Simulate a live backfill by pre-claiming the lease.
    db.prepare(
      `UPDATE enrich_cursor SET phase = 'backfill', lease_expires = unixepoch() + 600 WHERE id = 1`,
    ).run();

    const env = makeEnv(db, r2);
    const result = await runBodyBackfillSlice(env, false);

    expect(result.status).toBe("lease_held");
    expect(result.leaseHolder?.phase).toBe("backfill");
  });
});
