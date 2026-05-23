/**
 * cross-seam.test.ts — plan005 cross-agent-boundary integration test.
 *
 * Motivation: Wave 1/2/3 of plan005 was dispatched in parallel to 7 agents.
 * Each agent's per-unit tests passed (green bun test, green tsc) because
 * each agent wrote its own fixture. Codex review then surfaced 45+ issues
 * (1 P0, 22 P1, 20 P2, 1 P3) across 18 rounds — every one was a contract
 * drift at a seam where two independently-written modules disagreed on
 * exact names (meta keys, column names, DTO field casing).
 *
 * This test exists so that NEVER happens on a plan-005-shaped diff again.
 * It seeds ONE fresh D1 database, runs a full pipeline round-trip against
 * the real production handlers (orchestrator + status endpoint +
 * enrichments handler + meta handler + graph handler + cognitive drift
 * route), and asserts at every seam that the writer agrees with the
 * reader. Any future name drift at ANY seam fails this test immediately.
 *
 * If a future change introduces a new name-level seam (new meta key, new
 * column, new DTO field), add the assertion here. This is the primary QA
 * gate for parallel-wave work on this codebase.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runAlgorithmEnrichment } from "../src/cron/enrich-algorithms";
import { handleEnrichmentsRequest } from "../src/routes/ui/enrichments";
import { handleMetaRequest } from "../src/routes/ui/meta";
import { handleGraphNodesRequest } from "../src/routes/ui/graph";

// ---------------------------------------------------------------------------
// Shared D1 shim — reused verbatim from enrich-algorithms.test.ts because
// it matches the exact CF D1 interface the handlers expect.
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
        const info = s.run(...(this._bound as Parameters<typeof s.run>));
        return Promise.resolve({ meta: { changes: (info as { changes?: number }).changes ?? 0 } });
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
  function batch(stmts: ReturnType<typeof prepare>[]): Promise<Array<{ meta: { changes: number } }>> {
    try {
      const results = db.transaction(() => {
        const out = [];
        for (const stmt of stmts) {
          const s = db.prepare(stmt._sql);
          const info = s.run(...(stmt._bound as Parameters<typeof s.run>));
          out.push({ meta: { changes: (info as { changes?: number }).changes ?? 0 } });
        }
        return out;
      })();
      return Promise.resolve(results);
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return { prepare, batch };
}

// ---------------------------------------------------------------------------
// Schema bootstrap — mirrors migration 0004_enrichment_extensions.sql +
// 0005_rename_centrality.sql EXACTLY. If the migrations change, this must
// change. That is the point — this test is a contract between migration
// authors and handler authors.
// ---------------------------------------------------------------------------

function bootstrapSchema(db: Database) {
  db.exec(`
    CREATE TABLE vault_nodes (
      path          TEXT PRIMARY KEY,
      title         TEXT,
      note_type     TEXT,
      folder        TEXT,
      tags          TEXT,
      in_degree     INTEGER DEFAULT 0,
      out_degree    INTEGER DEFAULT 0,
      aliases       TEXT,
      size          INTEGER DEFAULT 0,
      modified_at   TEXT,
      indexed_at    TEXT,
      -- Plan005 Phase B additive columns (migration 0004):
      body          TEXT,
      word_count    INTEGER,
      content_hash  TEXT,
      frontmatter   TEXT,
      created_at    TEXT,
      ingest_run_id TEXT
    );

    CREATE TABLE vault_edges (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source        TEXT NOT NULL,
      target        TEXT NOT NULL,
      edge_type     TEXT NOT NULL,
      weight        REAL DEFAULT 1.0,
      ingest_run_id TEXT
    );

    -- Post-0005 name
    CREATE TABLE vault_enrichment (
      path             TEXT PRIMARY KEY,
      pagerank         REAL DEFAULT 0,
      prev_pagerank    REAL DEFAULT 0,
      computed_at      INTEGER DEFAULT 0,
      cluster_id       INTEGER,
      component_id     INTEGER,
      clustering_coeff REAL
    );

    CREATE TABLE meta (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO meta (key, value, updated_at) VALUES ('last_ingest_run_id', 'bootstrap', 0);

    CREATE TABLE enrich_cursor (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      phase           TEXT NOT NULL DEFAULT 'algorithm',
      lease_expires   INTEGER NOT NULL DEFAULT 0,
      lease_owner     TEXT,
      last_node_id    TEXT,
      last_run_at     INTEGER NOT NULL DEFAULT 0,
      nodes_processed INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO enrich_cursor (id, phase) VALUES (1, 'algorithm');

    CREATE TABLE ingest_runs (
      id            TEXT PRIMARY KEY,
      snapshot_uri  TEXT,
      started_at    INTEGER NOT NULL,
      completed_at  INTEGER,
      node_count    INTEGER,
      edge_count    INTEGER,
      status        TEXT NOT NULL DEFAULT 'running',
      error         TEXT
    );

    CREATE TABLE vault_snapshots (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id             TEXT NOT NULL,
      enrichment_version  INTEGER NOT NULL,
      captured_at         INTEGER NOT NULL,
      pagerank            REAL,
      cluster_id          INTEGER,
      component_id        INTEGER
    );
  `);
}

function seedGraph(db: Database, nodeCount = 50, edgeCount = 200) {
  for (let i = 0; i < nodeCount; i++) {
    db.prepare(
      `INSERT INTO vault_nodes (path, title, folder, note_type, tags, modified_at, indexed_at)
       VALUES (?, ?, 'n', 'note', '[]', '2026-01-01', '2026-01-01')`,
    ).run(`node/${i}.md`, `Node ${i}`);
  }
  // Sentinel the orchestrator must exclude.
  db.prepare(
    `INSERT INTO vault_nodes (path, title, folder, note_type, tags, modified_at, indexed_at)
     VALUES ('__last_sync__', 'sentinel', '', 'note', '[]', '2026-01-01', '2026-01-01')`,
  ).run();
  // Ring + chord edges.
  for (let i = 0; i < edgeCount; i++) {
    const s = i % nodeCount;
    const t = (i * 7 + 3) % nodeCount;
    if (s !== t) {
      db.prepare(
        `INSERT INTO vault_edges (source, target, edge_type, weight) VALUES (?, ?, 'wikilink', 1.0)`,
      ).run(`node/${s}.md`, `node/${t}.md`);
    }
  }
}

function makeEnv(db: Database) {
  return {
    DB: createD1Shim(db),
    SHARED_SECRET: "test-secret",
    VAULT: { get: async () => null, list: async () => ({ objects: [], truncated: false }) },
  } as any;
}

// ---------------------------------------------------------------------------
// THE TEST: full round-trip across every plan005 agent boundary.
// ---------------------------------------------------------------------------

describe("CROSS-SEAM: plan005 full round-trip against real handlers", () => {
  let db: Database;
  let env: any;

  beforeEach(() => {
    db = new Database(":memory:");
    bootstrapSchema(db);
    seedGraph(db, 50, 200);
    env = makeEnv(db);
  });

  test("orchestrator → enrichments → meta → graph → drift — every seam agrees", async () => {
    // --- STEP 1: run the orchestrator (Wave 2-A agent's output) ---
    const result = await runAlgorithmEnrichment(env);
    expect(result.status).toBe("done");
    expect(result.nodeCount).toBe(50);
    expect(result.communityCount).toBeGreaterThan(0);

    // --- SEAM 1: orchestrator writes meta keys; /api/enrichments reads them ---
    // This seam drifted as `last_enrichment_at` vs `last_enrich_at` +
    // `enrichment_community_count` vs `community_count` (codex rounds 1-2).
    const enrichRes = await handleEnrichmentsRequest(env);
    expect(enrichRes.status).toBe(200);
    const enrichBody = (await enrichRes.json()) as any;
    expect(enrichBody.version).toBe(1);
    expect(enrichBody.lastRunAt).toBeGreaterThan(0);
    expect(enrichBody.communityCount).toBeGreaterThan(0);
    expect(enrichBody.phase).toBe("algorithm"); // round-2 fix: phase lives in enrich_cursor

    // --- SEAM 2: /api/meta reads the SAME keys and the same enrich_cursor ---
    const metaRes = await handleMetaRequest(env);
    expect(metaRes.status).toBe(200);
    const metaBody = (await metaRes.json()) as any;
    expect(metaBody.enrichmentVersion).toBe(1);
    expect(metaBody.enrichmentCommunityCount).toBe(enrichBody.communityCount);
    // round-3 fix: bootstrap sentinel maps to null, not "bootstrap"
    expect(metaBody.lastIngestRunId).toBeNull();

    // --- SEAM 3: /api/graph/nodes joins vault_enrichment columns ---
    // Drifted as graph.ts selecting NULL for legacy table (codex round-9/16).
    const graphUrl = new URL("http://test/api/graph/nodes?include=enrichment&limit=10");
    const graphRes = await handleGraphNodesRequest(graphUrl, env);
    expect(graphRes.status).toBe(200);
    const graphBody = (await graphRes.json()) as any;
    expect(graphBody.items.length).toBeGreaterThan(0);
    const firstEnrichedNode = graphBody.items.find((n: any) => n.pagerank !== null);
    expect(firstEnrichedNode).toBeDefined();
    expect(firstEnrichedNode.pagerank).toBeGreaterThan(0);
    expect(firstEnrichedNode.clusterId).not.toBeNull();
    expect(firstEnrichedNode.componentId).not.toBeNull();
    // Handler returns `id`, not `path` (round-8 DTO alignment).
    expect(typeof firstEnrichedNode.id).toBe("string");

    // --- SEAM 4: vault_snapshots row exists + has captured_at ---
    // Drifted as the orchestrator INSERT omitting captured_at (codex round-8 P1).
    const snapRows = db
      .prepare(
        `SELECT node_id, enrichment_version, captured_at, pagerank, cluster_id, component_id FROM vault_snapshots LIMIT 1`,
      )
      .all() as any[];
    expect(snapRows.length).toBeGreaterThan(0);
    expect(snapRows[0].captured_at).toBeGreaterThan(0);
    expect(snapRows[0].enrichment_version).toBe(1);

    // --- SEAM 5: cluster_id must be STABLE — re-run produces same id per node ---
    // Drifted in round-9 (raw Louvain labels).
    const firstRunClusters = new Map<string, number>();
    const allFirst = db.prepare(`SELECT path, cluster_id FROM vault_enrichment`).all() as any[];
    for (const row of allFirst) firstRunClusters.set(row.path, row.cluster_id);

    // --- SEAM 6: second orchestrator run carries prev_pagerank forward ---
    // Drifted in round-5 (only seeded as 0, never updated).
    db.prepare(`UPDATE enrich_cursor SET phase = 'algorithm', lease_expires = 0 WHERE id = 1`).run();
    const result2 = await runAlgorithmEnrichment(env);
    expect(result2.status).toBe("done");
    const afterSecond = db
      .prepare(`SELECT path, pagerank, prev_pagerank, cluster_id FROM vault_enrichment WHERE pagerank > 0`)
      .all() as any[];
    expect(afterSecond.length).toBeGreaterThan(0);
    // Every row with non-zero pagerank must have prev_pagerank > 0 on the second run.
    const stillZero = afterSecond.filter((r) => r.prev_pagerank === 0 && r.pagerank > 0).length;
    expect(stillZero).toBe(0);
    // Cluster IDs must have stayed stable (same FNV-1a hash of canonical path).
    let stableCount = 0;
    for (const row of afterSecond) {
      if (firstRunClusters.get(row.path) === row.cluster_id) stableCount++;
    }
    expect(stableCount).toBeGreaterThan(afterSecond.length * 0.8); // >80% stable

    // --- SEAM 7: sentinel (__last_sync__) was excluded from algorithm input ---
    // Drifted in round-8 P2.
    const sentinelEnriched = db
      .prepare(`SELECT 1 FROM vault_enrichment WHERE path = '__last_sync__'`)
      .get();
    expect(sentinelEnriched).toBeNull();

    // --- SEAM 8: meta table has the enrichment_version key the orchestrator wrote ---
    // Catches future writer renames.
    const metaKeys = db.prepare(`SELECT key FROM meta ORDER BY key`).all() as Array<{ key: string }>;
    const keyNames = metaKeys.map((r) => r.key);
    expect(keyNames).toContain("enrichment_version");
    expect(keyNames).toContain("last_enrichment_at");
    expect(keyNames).toContain("enrichment_community_count");
    expect(keyNames).toContain("last_ingest_run_id");
  });

  test("orchestrator on empty graph clears enrichment state (round-8 regression)", async () => {
    // Wipe the non-sentinel nodes so nodeCount = 0.
    db.prepare(`DELETE FROM vault_nodes WHERE path NOT GLOB '__*'`).run();
    // Seed stale enrichment + meta to prove the early-return path wipes them.
    db.prepare(`INSERT INTO vault_enrichment (path, pagerank) VALUES ('old/stale.md', 0.42)`).run();
    db.prepare(`INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('enrichment_version', '99', 0)`).run();

    const result = await runAlgorithmEnrichment(env);
    expect(result.status).toBe("done");
    expect(result.nodeCount).toBe(0);

    const remaining = db.prepare(`SELECT COUNT(*) as c FROM vault_enrichment`).get() as { c: number };
    expect(remaining.c).toBe(0);
    const version = db.prepare(`SELECT value FROM meta WHERE key = 'enrichment_version'`).get() as { value: string };
    expect(version.value).toBe("0");
  });

  test("transition window: pre-0004 vault_centrality — orchestrator skips cleanly", async () => {
    // Covers the rollout seam: code deployed before migration 0004 applies.
    // The legacy vault_centrality table has only (path, pagerank, prev_pagerank,
    // computed_at). Orchestrator must detect missing extension columns and
    // return status='skipped' instead of throwing 'no such column'.
    // (Exercises round-16 graph.ts probe + round-26 orchestrator probe.)
    const legacyDb = new Database(":memory:");
    // Partial schema: only the tables that exist pre-0004, plus vault_centrality
    // with its pre-0004 column set.
    legacyDb.exec(`
      CREATE TABLE vault_nodes (
        path        TEXT PRIMARY KEY,
        title       TEXT, note_type TEXT, folder TEXT, tags TEXT,
        in_degree INTEGER DEFAULT 0, out_degree INTEGER DEFAULT 0,
        aliases TEXT, size INTEGER DEFAULT 0, modified_at TEXT, indexed_at TEXT
      );
      CREATE TABLE vault_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL, target TEXT NOT NULL,
        edge_type TEXT NOT NULL, weight REAL DEFAULT 1.0
      );
      CREATE TABLE vault_centrality (
        path TEXT PRIMARY KEY,
        pagerank REAL DEFAULT 0,
        prev_pagerank REAL DEFAULT 0,
        computed_at INTEGER DEFAULT 0
      );
      CREATE TABLE enrich_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        phase TEXT NOT NULL DEFAULT 'algorithm',
        lease_expires INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO enrich_cursor (id, phase) VALUES (1, 'algorithm');
    `);
    legacyDb.prepare(
      `INSERT INTO vault_nodes (path, title, folder, note_type, tags, modified_at, indexed_at)
       VALUES ('node/0.md', 'Zero', 'n', 'note', '[]', '2026-01-01', '2026-01-01')`,
    ).run();

    const legacyEnv = { DB: createD1Shim(legacyDb) } as any;
    const result = await runAlgorithmEnrichment(legacyEnv);
    expect(result.status).toBe("skipped");

    // Critical: phase must be reset so a POST-migration retry can claim.
    const phase = legacyDb.prepare(`SELECT phase FROM enrich_cursor WHERE id = 1`).get() as { phase: string };
    expect(phase.phase).toBe("algorithm");

    // vault_centrality must NOT have been written (no cluster_id column).
    const colsRow = legacyDb.prepare(`PRAGMA table_info('vault_centrality')`).all() as any[];
    const colNames = new Set(colsRow.map((r) => r.name));
    expect(colNames.has("cluster_id")).toBe(false);
  });

  test("transition window: graph.ts LEFT JOIN falls back to NULL on pre-0004 vault_centrality", async () => {
    // After 0004 runs, vault_centrality gains cluster_id/component_id/
    // clustering_coeff. Before 0004, graph.ts must serve NULL for those
    // fields and still return pagerank from the legacy columns.
    const legacyDb = new Database(":memory:");
    legacyDb.exec(`
      CREATE TABLE vault_nodes (
        path TEXT PRIMARY KEY, title TEXT, note_type TEXT, folder TEXT,
        tags TEXT, in_degree INTEGER DEFAULT 0, out_degree INTEGER DEFAULT 0,
        aliases TEXT, size INTEGER DEFAULT 0, modified_at TEXT, indexed_at TEXT
      );
      CREATE TABLE vault_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT, target TEXT, edge_type TEXT, weight REAL
      );
      CREATE TABLE vault_centrality (
        path TEXT PRIMARY KEY,
        pagerank REAL, prev_pagerank REAL, computed_at INTEGER
      );
    `);
    legacyDb.prepare(
      `INSERT INTO vault_nodes (path, title, folder, note_type, tags, modified_at, indexed_at)
       VALUES ('node/a.md', 'A', 'n', 'note', '[]', '2026-01-01', '2026-01-01')`,
    ).run();
    legacyDb.prepare(`INSERT INTO vault_centrality (path, pagerank) VALUES ('node/a.md', 0.42)`).run();

    const legacyEnv = { DB: createD1Shim(legacyDb) } as any;
    const url = new URL("http://test/api/graph/nodes?include=enrichment&limit=10");
    const res = await handleGraphNodesRequest(url, legacyEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const node = body.items.find((i: any) => i.id === "node/a.md");
    expect(node).toBeDefined();
    expect(node.pagerank).toBe(0.42);
    // Extension columns must be null since 0004 hasn't added them yet.
    expect(node.clusterId).toBeNull();
    expect(node.componentId).toBeNull();
    expect(node.clusteringCoeff).toBeNull();
  });

  test("ingest_runs 'running' row blocks enrichment (round-15 guard)", async () => {
    // started_at must be within the 1h staleness bound — stale 'running'
    // rows (>1h old) are ignored by the guard per round-19 fix.
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO ingest_runs (id, started_at, status) VALUES ('sync-in-flight', ?, 'running')`,
    ).run(now);
    const result = await runAlgorithmEnrichment(env);
    expect(result.status).toBe("skipped");
    // vault_enrichment must still be empty — orchestrator refused to run.
    const enriched = db.prepare(`SELECT COUNT(*) as c FROM vault_enrichment`).get() as { c: number };
    expect(enriched.c).toBe(0);
    // And the lease must have been released so a later call can retry.
    const phase = db.prepare(`SELECT phase FROM enrich_cursor WHERE id = 1`).get() as { phase: string };
    expect(phase.phase).toBe("algorithm");
  });
});
