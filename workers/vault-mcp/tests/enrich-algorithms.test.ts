/**
 * enrich-algorithms.test.ts
 *
 * Integration tests for the vault-mcp enrich-algorithms orchestrator.
 * Uses bun:sqlite in-memory database as a D1 shim — real algorithms,
 * no mocking.
 *
 * Covers:
 *   - Happy path: 50 nodes / 200 edges → vault_enrichment populated,
 *     meta.enrichment_version incremented.
 *   - Ingest-guard: last_ingest_run_id changes mid-run → results discarded.
 *   - Lease CAS: concurrent second invocation with phase already
 *     'running_algorithms' → skipped, no double-write.
 *   - Snapshot pruning: 60 seed versions → rows older than
 *     (current_version - 52) deleted.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runAlgorithmEnrichment } from "../src/cron/enrich-algorithms";
import type { EnrichmentResult } from "../src/cron/enrich-algorithms";

// ---------------------------------------------------------------------------
// D1 shim — wraps bun:sqlite to match the Cloudflare D1Database interface
// ---------------------------------------------------------------------------

function createD1Shim(db: Database) {
  function prepare(sql: string) {
    return {
      _sql: sql,
      _bound: [] as unknown[],

      bind(...args: unknown[]) {
        const stmt = prepare(sql);
        stmt._bound = args;
        return stmt;
      },

      run() {
        const s = db.prepare(this._sql);
        let changes = 0;
        try {
          const info = s.run(...(this._bound as Parameters<typeof s.run>));
          changes = (info as { changes?: number }).changes ?? 0;
        } catch (e) {
          throw e;
        }
        return Promise.resolve({ meta: { changes } });
      },

      first<T>(): Promise<T | null> {
        const s = db.prepare(this._sql);
        const row = s.get(...(this._bound as Parameters<typeof s.get>)) as T | null;
        return Promise.resolve(row ?? null);
      },

      all<T>(): Promise<{ results: T[] }> {
        const s = db.prepare(this._sql);
        const rows = s.all(...(this._bound as Parameters<typeof s.all>)) as T[];
        return Promise.resolve({ results: rows });
      },
    };
  }

  function batch(stmts: ReturnType<typeof prepare>[]) {
    return db.transaction(() => {
      const results = [];
      for (const stmt of stmts) {
        const s = db.prepare(stmt._sql);
        try {
          const info = s.run(...(stmt._bound as Parameters<typeof s.run>));
          results.push({ meta: { changes: (info as { changes?: number }).changes ?? 0 } });
        } catch (e) {
          throw e;
        }
      }
      return results;
    })();
  }

  return { prepare, batch };
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
      size INTEGER DEFAULT 0,
      modified_at TEXT DEFAULT '',
      indexed_at TEXT DEFAULT '',
      body TEXT,
      word_count INTEGER,
      content_hash TEXT,
      frontmatter TEXT,
      created_at TEXT,
      ingest_run_id TEXT,
      out_degree INTEGER DEFAULT 0,
      in_degree INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS vault_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      edge_type TEXT DEFAULT 'related',
      weight REAL DEFAULT 1.0,
      ingest_run_id TEXT
    );

    CREATE TABLE IF NOT EXISTS vault_enrichment (
      path TEXT PRIMARY KEY,
      pagerank REAL DEFAULT 0.0,
      prev_pagerank REAL DEFAULT 0.0,
      computed_at INTEGER DEFAULT 0,
      cluster_id INTEGER,
      component_id INTEGER,
      clustering_coeff REAL
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
      lease_owner TEXT,
      last_node_id TEXT,
      last_run_at INTEGER NOT NULL DEFAULT 0,
      nodes_processed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS vault_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT NOT NULL,
      enrichment_version INTEGER NOT NULL,
      captured_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      pagerank REAL,
      cluster_id INTEGER,
      component_id INTEGER
    );

    INSERT OR IGNORE INTO enrich_cursor (id, phase) VALUES (1, 'algorithm');
    INSERT OR IGNORE INTO meta (key, value, updated_at) VALUES ('last_ingest_run_id', '"run-A"', unixepoch());
  `);
}

// ---------------------------------------------------------------------------
// Fixture generator (deterministic LCG — no external deps)
// ---------------------------------------------------------------------------

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function seedGraph(db: Database, nodeCount = 50, edgeCount = 200, ingestRunId = "run-A") {
  const rng = lcg(42);

  // Insert nodes with ingest_run_id so per-row race guard can match
  for (let i = 0; i < nodeCount; i++) {
    db.prepare(
      `INSERT OR REPLACE INTO vault_nodes (path, title, ingest_run_id) VALUES (?, ?, ?)`,
    ).run(`node/${i}.md`, `Node ${i}`, ingestRunId);
  }

  // Chain for connectivity
  for (let i = 0; i < nodeCount - 1; i++) {
    db.prepare(
      `INSERT INTO vault_edges (source, target, weight, ingest_run_id) VALUES (?, ?, 1.0, ?)`,
    ).run(`node/${i}.md`, `node/${i + 1}.md`, ingestRunId);
  }

  // Random additional edges
  const edgeSet = new Set<string>();
  for (let i = 0; i < nodeCount - 1; i++) edgeSet.add(`${i}:${i + 1}`);
  let attempts = 0;
  let inserted = nodeCount - 1;
  while (inserted < edgeCount && attempts < edgeCount * 20) {
    attempts++;
    const s = Math.floor(rng() * nodeCount);
    const t = Math.floor(rng() * nodeCount);
    if (s === t) continue;
    const key = s < t ? `${s}:${t}` : `${t}:${s}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);
    db.prepare(
      `INSERT INTO vault_edges (source, target, weight, ingest_run_id) VALUES (?, ?, 1.0, ?)`,
    ).run(`node/${s}.md`, `node/${t}.md`, ingestRunId);
    inserted++;
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("runAlgorithmEnrichment", () => {
  // Happy path ---------------------------------------------------------------

  test("happy path: populates vault_enrichment and increments enrichment_version", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    seedGraph(db, 50, 200);

    const d1 = createD1Shim(db);
    const env = { DB: d1 } as unknown as Parameters<typeof runAlgorithmEnrichment>[0];

    const result: EnrichmentResult = await runAlgorithmEnrichment(env);

    expect(result.status).toBe("done");
    expect(result.nodeCount).toBe(50);
    expect(result.communityCount).toBeGreaterThan(0);
    expect(result.componentCount).toBeGreaterThan(0);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

    // vault_enrichment rows should be populated
    const enriched = db.prepare(
      `SELECT COUNT(*) as count FROM vault_enrichment WHERE pagerank IS NOT NULL AND cluster_id IS NOT NULL`,
    ).get() as { count: number };
    expect(enriched.count).toBeGreaterThan(0);

    // enrichment_version should be 1
    const version = db.prepare(
      `SELECT value FROM meta WHERE key = 'enrichment_version'`,
    ).get() as { value: string } | null;
    expect(version?.value).toBe("1");

    // Phase should be reset to 'embedding'
    const cursor = db.prepare(`SELECT phase FROM enrich_cursor WHERE id = 1`).get() as { phase: string };
    // After round-2 codex fix: phase resets to 'algorithm' (not 'embedding')
    // because vault-mcp has no embedding phase to transition back from.
    expect(cursor.phase).toBe("algorithm");
  });

  test("happy path: vault_snapshots rows are inserted", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    seedGraph(db, 50, 200);

    const d1 = createD1Shim(db);
    const env = { DB: d1 } as unknown as Parameters<typeof runAlgorithmEnrichment>[0];

    await runAlgorithmEnrichment(env);

    const snaps = db.prepare(
      `SELECT COUNT(*) as count FROM vault_snapshots WHERE enrichment_version = 1`,
    ).get() as { count: number };
    expect(snaps.count).toBe(50);
  });

  // Ingest-guard -------------------------------------------------------------

  test("ingest-guard: discards results when last_ingest_run_id changes mid-run", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    seedGraph(db, 50, 200, "run-A");

    // Patch last_ingest_run_id to match nodes
    db.prepare(`UPDATE meta SET value = '"run-A"' WHERE key = 'last_ingest_run_id'`).run();

    // Intercept D1 prepare to inject a mutation after the first SELECT of
    // last_ingest_run_id (which happens before algorithm run) but before
    // the second SELECT (the post-algo guard check). We achieve this by
    // patching the vault_enrichment INSERT to also mutate the run id —
    // but that's too coupled. Instead we directly change the meta row
    // right before the test and use a thin wrapper that mutates on the
    // second read.
    const baseD1 = createD1Shim(db);

    let ingestCheckCount = 0;
    const wrappedPrepare = (sql: string) => {
      const stmt = baseD1.prepare(sql);
      if (sql.trim().startsWith("SELECT value FROM meta WHERE key = 'last_ingest_run_id'")) {
        const originalFirst = stmt.first.bind(stmt);
        stmt.first = <T>() => {
          ingestCheckCount++;
          if (ingestCheckCount >= 2) {
            // Simulate a new ingest arriving: flip the run id
            db.prepare(`UPDATE meta SET value = '"run-B"' WHERE key = 'last_ingest_run_id'`).run();
          }
          return originalFirst<T>();
        };
      }
      return stmt;
    };

    const env = { DB: { prepare: wrappedPrepare, batch: baseD1.batch } } as unknown as Parameters<typeof runAlgorithmEnrichment>[0];

    const result = await runAlgorithmEnrichment(env);

    expect(result.status).toBe("ingest_conflict");

    // vault_enrichment must be empty — results were discarded
    const enriched = db.prepare(
      `SELECT COUNT(*) as count FROM vault_enrichment WHERE pagerank > 0`,
    ).get() as { count: number };
    expect(enriched.count).toBe(0);
  });

  // Lease CAS ----------------------------------------------------------------

  test("lease CAS: concurrent invocation with phase already running_algorithms is skipped", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    seedGraph(db, 50, 200);

    // Force phase to 'running_algorithms' to simulate a concurrent isolate
    db.prepare(`UPDATE enrich_cursor SET phase = 'running_algorithms' WHERE id = 1`).run();

    const d1 = createD1Shim(db);
    const env = { DB: d1 } as unknown as Parameters<typeof runAlgorithmEnrichment>[0];

    const result = await runAlgorithmEnrichment(env);

    expect(result.status).toBe("skipped");

    // vault_enrichment must still be empty
    const enriched = db.prepare(
      `SELECT COUNT(*) as count FROM vault_enrichment`,
    ).get() as { count: number };
    expect(enriched.count).toBe(0);
  });

  test("lease CAS: abandoned running_algorithms claim with expired lease is reclaimed", async () => {
    // Round-41 P1 regression: a crashed cron isolate left phase =
    // 'running_algorithms' with a lease that has since expired. The next
    // invocation must reclaim it instead of wedging forever.
    const db = new Database(":memory:");
    bootstrapSchema(db);
    seedGraph(db, 50, 200);

    db.prepare(
      `UPDATE enrich_cursor SET phase = 'running_algorithms', lease_expires = unixepoch() - 60 WHERE id = 1`,
    ).run();

    const d1 = createD1Shim(db);
    const env = { DB: d1 } as unknown as Parameters<typeof runAlgorithmEnrichment>[0];

    const result = await runAlgorithmEnrichment(env);
    expect(result.status).toBe("done");
  });

  test("lease CAS: abandoned backfill claim with expired lease is reclaimed", async () => {
    // Plan-E2 blocking mirror gate (adversary WARNING #5). An operator-
    // driven backfill crashed mid-cycle and left phase='backfill' with an
    // expired lease. The weekly enrichment cron must reclaim it —
    // otherwise an abandoned backfill wedges enrichment forever.
    const db = new Database(":memory:");
    bootstrapSchema(db);
    seedGraph(db, 50, 200);

    db.prepare(
      `UPDATE enrich_cursor SET phase = 'backfill', lease_expires = unixepoch() - 60, last_node_id = 'node/5.md' WHERE id = 1`,
    ).run();

    const d1 = createD1Shim(db);
    const env = { DB: d1 } as unknown as Parameters<typeof runAlgorithmEnrichment>[0];

    const result = await runAlgorithmEnrichment(env);
    expect(result.status).toBe("done");

    // After completion, phase resets to 'algorithm' and the lease is cleared.
    const cursor = db.prepare(`SELECT phase, lease_expires FROM enrich_cursor WHERE id = 1`).get() as { phase: string; lease_expires: number };
    expect(cursor.phase).toBe("algorithm");
    expect(cursor.lease_expires).toBe(0);
  });

  test("lease CAS: backfill with future lease blocks enrichment reclaim", async () => {
    // Symmetric to the running_algorithms future-lease test: an in-flight
    // backfill (fresh lease) must NOT be reclaimed by enrichment.
    const db = new Database(":memory:");
    bootstrapSchema(db);
    seedGraph(db, 50, 200);

    db.prepare(
      `UPDATE enrich_cursor SET phase = 'backfill', lease_expires = unixepoch() + 600 WHERE id = 1`,
    ).run();

    const d1 = createD1Shim(db);
    const env = { DB: d1 } as unknown as Parameters<typeof runAlgorithmEnrichment>[0];

    const result = await runAlgorithmEnrichment(env);
    expect(result.status).toBe("skipped");
  });

  test("lease CAS: running_algorithms with future lease blocks reclaim", async () => {
    // Round-41 P1: a legit in-flight run has a future lease. A concurrent
    // cron invocation must see 'skipped', not reclaim.
    const db = new Database(":memory:");
    bootstrapSchema(db);
    seedGraph(db, 50, 200);

    db.prepare(
      `UPDATE enrich_cursor SET phase = 'running_algorithms', lease_expires = unixepoch() + 600 WHERE id = 1`,
    ).run();

    const d1 = createD1Shim(db);
    const env = { DB: d1 } as unknown as Parameters<typeof runAlgorithmEnrichment>[0];

    const result = await runAlgorithmEnrichment(env);
    expect(result.status).toBe("skipped");
  });

  // Snapshot pruning ---------------------------------------------------------

  test("snapshot pruning: deletes rows with version < (current_version - 52)", async () => {
    const db = new Database(":memory:");
    bootstrapSchema(db);
    seedGraph(db, 50, 200);

    // Seed 60 historical snapshot versions (node 'node/0.md' only, to keep it fast)
    for (let v = 1; v <= 60; v++) {
      db.prepare(
        `INSERT INTO vault_snapshots (node_id, enrichment_version, pagerank, cluster_id, component_id)
         VALUES ('node/0.md', ?, 0.01, 0, 0)`,
      ).run(v);
    }
    // Pre-set enrichment_version to 60 so the next run produces version 61
    db.prepare(
      `INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('enrichment_version', '60', unixepoch())`,
    ).run();

    const d1 = createD1Shim(db);
    const env = { DB: d1 } as unknown as Parameters<typeof runAlgorithmEnrichment>[0];

    const result = await runAlgorithmEnrichment(env);
    expect(result.status).toBe("done");

    // After run: enrichment_version = 61.
    // pruneBelow = 61 - 52 = 9.
    // Rows with enrichment_version < 9 should be deleted → versions 1–8 gone (8 rows).
    const remaining = db.prepare(
      `SELECT MIN(enrichment_version) as min_v, MAX(enrichment_version) as max_v, COUNT(*) as count
       FROM vault_snapshots WHERE node_id = 'node/0.md'`,
    ).get() as { min_v: number; max_v: number; count: number };

    // Minimum surviving version must be >= 9
    expect(remaining.min_v).toBeGreaterThanOrEqual(9);
    // Should have deleted versions 1-8 (8 rows from seed) — the new run adds 50 rows for v=61
    const seededSurvivors = db.prepare(
      `SELECT COUNT(*) as count FROM vault_snapshots WHERE node_id = 'node/0.md' AND enrichment_version < 9`,
    ).get() as { count: number };
    expect(seededSurvivors.count).toBe(0);
  });

  // P2 regression — prev_pagerank carry-forward -------------------------------

  test("REGRESSION P2: prev_pagerank is carried forward on re-run", async () => {
    // Codex found that the original UPDATE statement only wrote pagerank, never
    // SET prev_pagerank = pagerank. detectCentralityShifts() filters on
    // prev_pagerank > 0, so delta tracking always returned empty after the
    // first enrichment. This test pins the carry-forward behaviour.
    const db = new Database(":memory:");
    bootstrapSchema(db);
    seedGraph(db, 50, 200);

    const d1 = createD1Shim(db);
    const env = { DB: d1 } as unknown as Parameters<typeof runAlgorithmEnrichment>[0];

    // First enrichment run — writes pagerank, prev_pagerank starts at 0.
    await runAlgorithmEnrichment(env);

    // Capture pagerank values after first run.
    const afterFirst = db.prepare(
      `SELECT path, pagerank, prev_pagerank FROM vault_enrichment WHERE pagerank > 0 LIMIT 5`,
    ).all() as Array<{ path: string; pagerank: number; prev_pagerank: number }>;
    expect(afterFirst.length).toBeGreaterThan(0);

    // Reset phase + lease so the orchestrator can run again.
    db.prepare(`UPDATE enrich_cursor SET phase = 'algorithm', lease_expires = 0 WHERE id = 1`).run();

    // Second run — should carry the previous pagerank into prev_pagerank.
    await runAlgorithmEnrichment(env);

    const afterSecond = db.prepare(
      `SELECT path, pagerank, prev_pagerank FROM vault_enrichment WHERE path IN (${afterFirst.map(() => '?').join(',')})`,
    ).all(...afterFirst.map((r) => r.path)) as Array<{ path: string; pagerank: number; prev_pagerank: number }>;

    // For at least one row, prev_pagerank after second run must equal pagerank from first run.
    let carryForwardConfirmed = 0;
    for (const row of afterSecond) {
      const first = afterFirst.find((r) => r.path === row.path);
      if (first && Math.abs(row.prev_pagerank - first.pagerank) < 1e-9) {
        carryForwardConfirmed++;
      }
    }
    expect(carryForwardConfirmed).toBeGreaterThan(0);
    // And NONE of the prev_pagerank values should still be 0 for nodes that had non-zero pagerank.
    const stillZero = afterSecond.filter((r) => r.prev_pagerank === 0 && r.pagerank > 0).length;
    expect(stillZero).toBe(0);
  });
});
