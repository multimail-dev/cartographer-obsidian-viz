/**
 * cluster-diversity.test.ts — Tests for Phase 1 of the hierarchical community
 * retrieval plan (2026-05-06-001).
 *
 * Verifies:
 *   1. toolFindRelated uses cluster_id from vault_enrichment for diversity
 *   2. detectBridges produces graduated bridge strength (cross-cluster > same-cluster)
 *   3. Graceful fallback to folder-prefix diversity when vault_enrichment is missing
 */

import { describe, expect, test, beforeEach, mock } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Module mocks — required before importing from src/index.ts because the
// module-level OAuthProvider / McpAgent / VaultMcpDO.serve() calls execute
// at import time and reference CF-specific globals.
// ---------------------------------------------------------------------------

mock.module("cloudflare:workers", () => ({
  WorkerEntrypoint: class WorkerEntrypoint {},
  DurableObject: class DurableObject {},
}));
mock.module("@cloudflare/workers-oauth-provider", () => ({
  default: class OAuthProvider {
    constructor(_: unknown) {}
  },
}));
mock.module("agents/mcp", () => ({
  McpAgent: class McpAgent {
    env: any;
    static serve() {
      return { fetch() { return new Response("mock"); } };
    }
    constructor(_: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
mock.module("../src/ui-handler", () => ({ handleUiAssetRequest() { return null; } }));
mock.module("../src/ui-routes", () => ({ handleUiRequest: async () => null }));
mock.module("../src/access-handler", () => ({ handleAccessRequest: async () => new Response("ok") }));
mock.module("../src/snapshots", () => ({ writeVaultSnapshot: async () => {} }));
mock.module("../src/cron/enrich-algorithms", () => ({ runAlgorithmEnrichment: async () => ({ ok: true }) }));
mock.module("../src/cron/backfill-body", () => ({ runBodyBackfillSlice: async () => ({ status: "completed" }) }));
mock.module("../src/routes/hono-app", () => {
  let fallthrough = async (_r: Request, _e: unknown, _c: unknown) => new Response("missing", { status: 404 });
  return {
    honoApp: {
      fetch(request: Request, env: unknown, ctx: unknown) {
        return fallthrough(request, env, ctx);
      },
    },
    withFallthrough(fn: typeof fallthrough) {
      fallthrough = fn;
    },
  };
});
mock.module("../src/auth/cf-access-jwt", () => ({
  verifyCfAccessJwt: async () => ({ common_name: "test" }),
  CfAccessError: class CfAccessError extends Error { kind = "test"; },
}));

import { toolFindRelated, detectBridges } from "../src/index";
import type { FastLoopCandidate } from "../src/index";

// ---------------------------------------------------------------------------
// Minimal D1 adapter — matches the pattern from hono-routes.test.ts
// ---------------------------------------------------------------------------

function d1(db: BunDatabase): any {
  return {
    prepare(sql: string) {
      let boundArgs: any[] = [];
      const stmt = {
        bind(...args: any[]) {
          boundArgs = args;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          const row = db.query(sql).get(...boundArgs);
          return (row as T) ?? null;
        },
        async all<T>(): Promise<{
          results: T[];
          success: boolean;
          meta: { changes: number; duration: number; last_row_id: number; rows_read: number; rows_written: number };
        }> {
          const rows = db.query(sql).all(...boundArgs) as T[];
          return {
            results: rows ?? [],
            success: true,
            meta: { changes: 0, duration: 0, last_row_id: 0, rows_read: rows?.length ?? 0, rows_written: 0 },
          };
        },
        async run(): Promise<{
          success: boolean;
          results: never[];
          meta: { changes: number; duration: number; last_row_id: number; rows_read: number; rows_written: number };
        }> {
          const result = db.query(sql).run(...boundArgs);
          return {
            success: true,
            results: [],
            meta: {
              changes: result.changes ?? 0,
              duration: 0,
              last_row_id: Number(result.lastInsertRowid ?? 0),
              rows_read: 0,
              rows_written: result.changes ?? 0,
            },
          };
        },
      };
      return stmt;
    },
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE vault_nodes (
  path TEXT PRIMARY KEY,
  title TEXT,
  note_type TEXT,
  folder TEXT,
  tags TEXT DEFAULT '[]',
  in_degree INTEGER DEFAULT 0,
  out_degree INTEGER DEFAULT 0,
  size INTEGER DEFAULT 0,
  modified_at TEXT,
  indexed_at TEXT DEFAULT (datetime('now')),
  aliases TEXT DEFAULT '[]',
  frontmatter TEXT,
  body TEXT,
  word_count INTEGER,
  content_hash TEXT,
  created_at TEXT,
  ingest_run_id TEXT
);

CREATE TABLE vault_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source, target, edge_type)
);

CREATE TABLE vault_enrichment (
  path TEXT PRIMARY KEY,
  pagerank REAL DEFAULT 0.0,
  cluster_id INTEGER,
  component_id INTEGER,
  clustering_coeff REAL
);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(db: BunDatabase): any {
  return { DB: d1(db) } as any;
}

function insertNode(db: BunDatabase, path: string, opts?: { in_degree?: number; out_degree?: number; size?: number; indexed_at?: string }) {
  const folder = path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
  const title = path.split("/").pop()?.replace(".md", "") ?? path;
  db.query(
    `INSERT INTO vault_nodes (path, title, folder, in_degree, out_degree, size, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    path,
    title,
    folder,
    opts?.in_degree ?? 0,
    opts?.out_degree ?? 0,
    opts?.size ?? 500,
    opts?.indexed_at ?? new Date().toISOString()
  );
}

function insertEdge(db: BunDatabase, source: string, target: string, edge_type: string = "wikilink", weight: number = 1.0) {
  db.query(
    `INSERT OR IGNORE INTO vault_edges (source, target, edge_type, weight) VALUES (?, ?, ?, ?)`
  ).run(source, target, edge_type, weight);
}

function insertEnrichment(db: BunDatabase, path: string, cluster_id: number) {
  db.query(
    `INSERT OR REPLACE INTO vault_enrichment (path, cluster_id) VALUES (?, ?)`
  ).run(path, cluster_id);
}

// ---------------------------------------------------------------------------
// toolFindRelated — cluster_id diversity
// ---------------------------------------------------------------------------

describe("toolFindRelated: cluster_id diversity", () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(":memory:");
    db.exec(SCHEMA_SQL);
  });

  test("returns results from ≥3 distinct cluster_ids when seed has degree ≥5", async () => {
    // Seed note with high degree connecting to notes in 5 different clusters
    const seed = "Topics/seed-note.md";
    insertNode(db, seed, { in_degree: 5, out_degree: 5 });

    // Create 5 clusters of 3 notes each, all linked from seed
    for (let cluster = 0; cluster < 5; cluster++) {
      for (let i = 0; i < 3; i++) {
        const path = `Cluster${cluster}/note-${i}.md`;
        insertNode(db, path);
        insertEdge(db, seed, path, "wikilink");
        insertEnrichment(db, path, cluster);

        // Add some intra-cluster edges for BFS discovery
        if (i > 0) {
          const prevPath = `Cluster${cluster}/note-${i - 1}.md`;
          insertEdge(db, path, prevPath, "related");
        }
      }
    }

    const env = makeEnv(db);
    const raw = await toolFindRelated(env, seed, 2);
    const result = JSON.parse(raw);

    // Extract cluster_ids from returned paths via the enrichment table
    const returnedPaths = result.results.map((r: any) => r.path);
    const clusterIds = new Set<number>();
    for (const p of returnedPaths) {
      const row = db.query("SELECT cluster_id FROM vault_enrichment WHERE path = ?").get(p) as any;
      if (row?.cluster_id !== null && row?.cluster_id !== undefined) {
        clusterIds.add(row.cluster_id);
      }
    }

    expect(clusterIds.size).toBeGreaterThanOrEqual(3);
    expect(result.results.length).toBeGreaterThan(0);
  });

  test("diversity fill selects notes from unseen clusters over same-cluster notes", async () => {
    const seed = "Topics/seed.md";
    insertNode(db, seed, { out_degree: 20 });

    // Cluster 0: 10 notes with high edge weights (will dominate top 15)
    for (let i = 0; i < 10; i++) {
      const path = `Popular/note-${i}.md`;
      insertNode(db, path);
      insertEdge(db, seed, path, "wikilink", 2.0);
      insertEnrichment(db, path, 0);
    }

    // Cluster 1-5: 1 note each with low edge weights (should be pulled in by diversity)
    for (let c = 1; c <= 5; c++) {
      const path = `Niche${c}/note-0.md`;
      insertNode(db, path);
      insertEdge(db, seed, path, "wikilink", 0.5);
      insertEnrichment(db, path, c);
    }

    const env = makeEnv(db);
    const raw = await toolFindRelated(env, seed, 1);
    const result = JSON.parse(raw);

    // The diversity fill should pull in notes beyond the top-15 cluster-0 block
    const returnedPaths = result.results.map((r: any) => r.path);
    const clusterIds = new Set<number>();
    for (const p of returnedPaths) {
      const row = db.query("SELECT cluster_id FROM vault_enrichment WHERE path = ?").get(p) as any;
      if (row?.cluster_id !== null && row?.cluster_id !== undefined) {
        clusterIds.add(row.cluster_id);
      }
    }

    // Should have cluster 0 (dominant) plus several others from diversity fill
    expect(clusterIds.has(0)).toBe(true);
    expect(clusterIds.size).toBeGreaterThanOrEqual(3);
  });

  test("falls back to folder-prefix diversity when vault_enrichment is empty", async () => {
    const seed = "Topics/seed.md";
    insertNode(db, seed, { out_degree: 10 });

    // Notes in different folders but NO vault_enrichment rows
    const folders = ["FolderA/Sub1", "FolderB/Sub2", "FolderC/Sub3", "FolderD/Sub4"];
    for (const folder of folders) {
      for (let i = 0; i < 4; i++) {
        const path = `${folder}/note-${i}.md`;
        insertNode(db, path);
        insertEdge(db, seed, path, "wikilink");
      }
    }

    const env = makeEnv(db);
    const raw = await toolFindRelated(env, seed, 1);
    const result = JSON.parse(raw);

    // Should still produce results using folder-prefix fallback
    expect(result.results.length).toBeGreaterThan(0);

    // Diversity fill should produce results from multiple folder prefixes
    const folderPrefixes = new Set(
      result.results.map((r: any) => {
        const s = r.path.split("/");
        return s.length >= 2 ? `${s[0]}/${s[1]}` : s[0];
      })
    );
    expect(folderPrefixes.size).toBeGreaterThanOrEqual(3);
  });

  test("falls back to folder-prefix when vault_enrichment table does not exist", async () => {
    // Create a DB WITHOUT the vault_enrichment table
    const noEnrichDb = new BunDatabase(":memory:");
    noEnrichDb.exec(`
      CREATE TABLE vault_nodes (
        path TEXT PRIMARY KEY, title TEXT, note_type TEXT, folder TEXT,
        tags TEXT DEFAULT '[]', in_degree INTEGER DEFAULT 0, out_degree INTEGER DEFAULT 0,
        size INTEGER DEFAULT 0, modified_at TEXT,
        indexed_at TEXT DEFAULT (datetime('now')),
        aliases TEXT DEFAULT '[]', frontmatter TEXT, body TEXT, word_count INTEGER,
        content_hash TEXT, created_at TEXT, ingest_run_id TEXT
      );
      CREATE TABLE vault_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL, target TEXT NOT NULL, edge_type TEXT NOT NULL,
        weight REAL DEFAULT 1.0, created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(source, target, edge_type)
      );
    `);

    const seed = "Topics/seed.md";
    insertNode(noEnrichDb, seed, { out_degree: 5 });
    for (let i = 0; i < 5; i++) {
      const path = `Area${i}/Sub/note.md`;
      insertNode(noEnrichDb, path);
      insertEdge(noEnrichDb, seed, path, "wikilink");
    }

    const env = makeEnv(noEnrichDb);
    // Should NOT throw — graceful fallback
    const raw = await toolFindRelated(env, seed, 1);
    const result = JSON.parse(raw);
    expect(result.results.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// detectBridges — graduated bridge strength
// ---------------------------------------------------------------------------

describe("detectBridges: graduated bridge strength", () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(":memory:");
    db.exec(SCHEMA_SQL);
  });

  test("cross-cluster bridges get strength 1.0", async () => {
    // Note that bridges two targets in different clusters
    const bridge = "Notes/bridge-note.md";
    const targetA = "ClusterA/target-a.md";
    const targetB = "ClusterB/target-b.md";

    // indexed_at must be within 15 minutes of "now" for detectBridges to pick it up
    const recentTime = new Date().toISOString();

    insertNode(db, bridge, { size: 500, indexed_at: recentTime });
    insertNode(db, targetA);
    insertNode(db, targetB);

    insertEdge(db, bridge, targetA, "wikilink");
    insertEdge(db, bridge, targetB, "wikilink");
    // No direct or 1-hop connection between A and B

    insertEnrichment(db, targetA, 10);
    insertEnrichment(db, targetB, 20);

    const env = makeEnv(db);
    const candidates = await detectBridges(env);

    const bridgeCandidates = candidates.filter((c) => c.type === "bridge");
    expect(bridgeCandidates.length).toBeGreaterThanOrEqual(1);
    expect(bridgeCandidates[0].strength).toBe(1.0);
  });

  test("same-cluster bridges get strength 0.7", async () => {
    const bridge = "Notes/bridge-note.md";
    const targetA = "SameCluster/target-a.md";
    const targetB = "SameCluster/target-b.md";

    const recentTime = new Date().toISOString();

    insertNode(db, bridge, { size: 500, indexed_at: recentTime });
    insertNode(db, targetA);
    insertNode(db, targetB);

    insertEdge(db, bridge, targetA, "wikilink");
    insertEdge(db, bridge, targetB, "wikilink");

    // Both targets in the same cluster
    insertEnrichment(db, targetA, 42);
    insertEnrichment(db, targetB, 42);

    const env = makeEnv(db);
    const candidates = await detectBridges(env);

    const bridgeCandidates = candidates.filter((c) => c.type === "bridge");
    expect(bridgeCandidates.length).toBeGreaterThanOrEqual(1);
    expect(bridgeCandidates[0].strength).toBe(0.7);
  });

  test("missing enrichment data falls back to strength 0.9", async () => {
    const bridge = "Notes/bridge-note.md";
    const targetA = "AreaA/target-a.md";
    const targetB = "AreaB/target-b.md";

    const recentTime = new Date().toISOString();

    insertNode(db, bridge, { size: 500, indexed_at: recentTime });
    insertNode(db, targetA);
    insertNode(db, targetB);

    insertEdge(db, bridge, targetA, "wikilink");
    insertEdge(db, bridge, targetB, "wikilink");

    // NO enrichment data at all — should fall back to 0.9
    const env = makeEnv(db);
    const candidates = await detectBridges(env);

    const bridgeCandidates = candidates.filter((c) => c.type === "bridge");
    expect(bridgeCandidates.length).toBeGreaterThanOrEqual(1);
    expect(bridgeCandidates[0].strength).toBe(0.9);
  });

  test("partial enrichment (one target missing) falls back to strength 0.9", async () => {
    const bridge = "Notes/bridge-note.md";
    const targetA = "AreaA/target-a.md";
    const targetB = "AreaB/target-b.md";

    const recentTime = new Date().toISOString();

    insertNode(db, bridge, { size: 500, indexed_at: recentTime });
    insertNode(db, targetA);
    insertNode(db, targetB);

    insertEdge(db, bridge, targetA, "wikilink");
    insertEdge(db, bridge, targetB, "wikilink");

    // Only one target has enrichment data
    insertEnrichment(db, targetA, 10);
    // targetB has no enrichment row

    const env = makeEnv(db);
    const candidates = await detectBridges(env);

    const bridgeCandidates = candidates.filter((c) => c.type === "bridge");
    expect(bridgeCandidates.length).toBeGreaterThanOrEqual(1);
    // One undefined → falls back to 0.9
    expect(bridgeCandidates[0].strength).toBe(0.9);
  });

  test("1-hop via non-wikilink/related edge type does NOT exclude bridge candidate", async () => {
    // The 1-hop check uses a narrower edge type filter (wikilink, related only)
    // than the direct check (wikilink, related, discusses, references, spoke_in).
    // A 1-hop path via 'discusses' should NOT suppress the bridge candidate.
    const bridge = "Notes/bridge-note.md";
    const targetA = "AreaA/target-a.md";
    const targetB = "AreaB/target-b.md";
    const intermediary = "Middle/intermediary.md";

    const recentTime = new Date().toISOString();

    insertNode(db, bridge, { size: 500, indexed_at: recentTime });
    insertNode(db, targetA);
    insertNode(db, targetB);
    insertNode(db, intermediary);

    // Bridge note links to both targets
    insertEdge(db, bridge, targetA, "wikilink");
    insertEdge(db, bridge, targetB, "wikilink");

    // A 1-hop path exists via 'discusses' — should NOT suppress the bridge
    // because the 1-hop check only considers wikilink/related edges
    insertEdge(db, targetA, intermediary, "discusses");
    insertEdge(db, intermediary, targetB, "discusses");

    insertEnrichment(db, targetA, 10);
    insertEnrichment(db, targetB, 20);

    const env = makeEnv(db);
    const candidates = await detectBridges(env);

    // Bridge candidate should still be produced because the 1-hop path
    // uses 'discusses' edges which are outside the 1-hop filter
    const bridgeCandidates = candidates.filter((c) => c.type === "bridge");
    expect(bridgeCandidates.length).toBeGreaterThanOrEqual(1);
    expect(bridgeCandidates[0].strength).toBe(1.0); // cross-cluster (10 != 20)
  });

  test("1-hop via wikilink/related DOES exclude bridge candidate", async () => {
    // Contrast with the above test — a 1-hop path via wikilink/related
    // SHOULD suppress the bridge candidate.
    const bridge = "Notes/bridge-note.md";
    const targetA = "AreaA/target-a.md";
    const targetB = "AreaB/target-b.md";
    const intermediary = "Middle/intermediary.md";

    const recentTime = new Date().toISOString();

    insertNode(db, bridge, { size: 500, indexed_at: recentTime });
    insertNode(db, targetA);
    insertNode(db, targetB);
    insertNode(db, intermediary);

    // Bridge note links to both targets
    insertEdge(db, bridge, targetA, "wikilink");
    insertEdge(db, bridge, targetB, "wikilink");

    // A 1-hop path exists via 'wikilink' — SHOULD suppress the bridge
    insertEdge(db, targetA, intermediary, "wikilink");
    insertEdge(db, intermediary, targetB, "wikilink");

    const env = makeEnv(db);
    const candidates = await detectBridges(env);

    // No bridge candidate — targets are already connected at 1-hop
    const bridgeCandidates = candidates.filter((c) => c.type === "bridge");
    expect(bridgeCandidates.length).toBe(0);
  });

  test("bridge strength preserved when vault_enrichment table does not exist", async () => {
    const noEnrichDb = new BunDatabase(":memory:");
    noEnrichDb.exec(`
      CREATE TABLE vault_nodes (
        path TEXT PRIMARY KEY, title TEXT, note_type TEXT, folder TEXT,
        tags TEXT DEFAULT '[]', in_degree INTEGER DEFAULT 0, out_degree INTEGER DEFAULT 0,
        size INTEGER DEFAULT 0, modified_at TEXT,
        indexed_at TEXT DEFAULT (datetime('now')),
        aliases TEXT DEFAULT '[]', frontmatter TEXT, body TEXT, word_count INTEGER,
        content_hash TEXT, created_at TEXT, ingest_run_id TEXT
      );
      CREATE TABLE vault_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL, target TEXT NOT NULL, edge_type TEXT NOT NULL,
        weight REAL DEFAULT 1.0, created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(source, target, edge_type)
      );
    `);

    const bridge = "Notes/bridge-note.md";
    const targetA = "AreaA/target-a.md";
    const targetB = "AreaB/target-b.md";

    const recentTime = new Date().toISOString();

    insertNode(noEnrichDb, bridge, { size: 500, indexed_at: recentTime });
    insertNode(noEnrichDb, targetA);
    insertNode(noEnrichDb, targetB);

    insertEdge(noEnrichDb, bridge, targetA, "wikilink");
    insertEdge(noEnrichDb, bridge, targetB, "wikilink");

    const env = makeEnv(noEnrichDb);
    // Should NOT throw — graceful fallback to 0.9
    const candidates = await detectBridges(env);
    const bridgeCandidates = candidates.filter((c) => c.type === "bridge");
    expect(bridgeCandidates.length).toBeGreaterThanOrEqual(1);
    expect(bridgeCandidates[0].strength).toBe(0.9);
  });
});
