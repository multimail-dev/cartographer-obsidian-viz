import { describe, expect, mock, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";

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
mock.module("../../src/ui-handler", () => ({ handleUiAssetRequest() { return null; } }));
mock.module("../../src/ui-routes", () => ({ handleUiRequest: async () => null }));
mock.module("../../src/access-handler", () => ({ handleAccessRequest: async () => new Response("ok") }));
mock.module("../../src/snapshots", () => ({ writeVaultSnapshot: async () => {} }));
mock.module("../../src/cron/enrich-algorithms", () => ({ runAlgorithmEnrichment: async () => ({ ok: true }) }));
mock.module("../../src/cron/backfill-body", () => ({ runBodyBackfillSlice: async () => ({ status: "completed" }) }));
mock.module("../../src/routes/hono-app", () => {
  let fallthrough = async (request: Request, env: unknown, ctx: unknown) => new Response("missing", { status: 404 });
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
          return (db.query(sql).get(...boundArgs) as T) ?? null;
        },
        async all<T>(): Promise<any> {
          const rows = db.query(sql).all(...boundArgs) as T[];
          return { results: rows ?? [], success: true, meta: { changes: 0, duration: 0, last_row_id: 0, rows_read: rows.length, rows_written: 0 } };
        },
        async run(): Promise<any> {
          const result = db.query(sql).run(...boundArgs);
          return { success: true, results: [], meta: { changes: result.changes ?? 0, duration: 0, last_row_id: Number(result.lastInsertRowid ?? 0), rows_read: 0, rows_written: result.changes ?? 0 } };
        },
      };
      return stmt;
    },
    async batch(stmts: Array<any>) {
      const results = [];
      for (const stmt of stmts) results.push(await stmt.run());
      return results;
    },
  };
}

function setupEnv(): { db: BunDatabase; env: any } {
  const db = new BunDatabase(":memory:");
  db.exec(`
    CREATE TABLE vault_nodes (
      path TEXT PRIMARY KEY,
      title TEXT,
      note_type TEXT,
      folder TEXT,
      tags TEXT,
      aliases TEXT DEFAULT '[]',
      size INTEGER DEFAULT 0,
      modified_at TEXT,
      indexed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE vault_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      created_at TEXT DEFAULT (datetime('now')),
      ingest_run_id TEXT,
      origin TEXT NOT NULL DEFAULT 'extract',
      UNIQUE(origin, source, target, edge_type)
    );
    CREATE TABLE vault_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ulid TEXT,
      op_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      origin TEXT NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_vault_ops_ulid ON vault_ops (ulid) WHERE ulid IS NOT NULL;
    CREATE TABLE vault_dirty_degrees (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL
    );

    INSERT INTO vault_nodes (path, title, folder, tags, modified_at) VALUES ('Notes/A', 'A', 'Notes', '[]', '2026-04-23T00:00:00.000Z');
    INSERT INTO vault_edges (source, target, edge_type, weight, ingest_run_id, origin) VALUES
      ('Notes/A', 'Notes/Old', 'wikilink', 1.0, 'sync-old', 'extract'),
      ('People/Old', 'Notes/A', 'spoke_in', 1.0, 'sync-old', 'extract'),
      ('Notes/A', 'Entity/Keep', 'related', 1.5, NULL, 'ingest_triples');
  `);
  return { db, env: { DB: d1(db) } };
}

describe("applyOps reconcile_extract", () => {
  test("reconciles extract-owned edges without touching other origins", async () => {
    const { applyOps } = await import("../../src/index");
    const { db, env } = setupEnv();

    const ops = [
      {
        op_type: "upsert_node",
        origin: "extract",
        payload: { path: "Notes/A", title: "A", note_type: "note", folder: "Notes", tags: "[]", aliases: [], size: 1, modified_at: "2026-04-23T00:00:00.000Z" },
      },
      {
        op_type: "remove_edge",
        origin: "extract",
        payload: { source: "Notes/A", target: "Notes/Old", edge_type: "wikilink" },
      },
      {
        op_type: "remove_edge",
        origin: "extract",
        payload: { source: "People/Old", target: "Notes/A", edge_type: "spoke_in" },
      },
      {
        op_type: "add_edge",
        origin: "extract",
        payload: { source: "Notes/A", target: "Notes/New", edge_type: "wikilink", weight: 1, ingest_run_id: "sync-new" },
      },
      {
        op_type: "add_edge",
        origin: "extract",
        payload: { source: "People/New", target: "Notes/A", edge_type: "spoke_in", weight: 1, ingest_run_id: "sync-new" },
      },
    ];

    const nodeStmt = env.DB.prepare(`
      INSERT INTO vault_nodes (path, title, note_type, folder, tags, aliases, size, modified_at, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(path) DO UPDATE SET title = excluded.title
    `).bind("Notes/A", "A", "note", "Notes", "[]", "[]", 1, "2026-04-23T00:00:00.000Z");

    const result = await applyOps(env, ops, {
      reconcileExtract: {
        path: "Notes/A",
        desiredEdges: [
          { source: "Notes/A", target: "Notes/New", edge_type: "wikilink", weight: 1, ingest_run_id: "sync-new", origin: "extract" },
          { source: "People/New", target: "Notes/A", edge_type: "spoke_in", weight: 1, ingest_run_id: "sync-new", origin: "extract" },
        ] as any,
        nodeStmt,
      },
    });

    expect(result.insertedOps).toBe(5);

    const edges = db.query(
      "SELECT source, target, edge_type, origin FROM vault_edges ORDER BY origin, source, target, edge_type",
    ).all() as Array<{ source: string; target: string; edge_type: string; origin: string }>;
    expect(edges).toEqual([
      { source: "Notes/A", target: "Notes/New", edge_type: "wikilink", origin: "extract" },
      { source: "People/New", target: "Notes/A", edge_type: "spoke_in", origin: "extract" },
      { source: "Notes/A", target: "Entity/Keep", edge_type: "related", origin: "ingest_triples" },
    ]);

    // PR3: vault_dirty_degrees retired — drainDegrees() now derives dirty
    // paths from vault_ops directly. Reconcile-extract semantics above are
    // unchanged; the dirty-row count assertion is no longer applicable.
  });

  test("enforces the exact 800-edge cap message", async () => {
    const { applyOps } = await import("../../src/index");
    const { env } = setupEnv();
    const nodeStmt = env.DB.prepare(`
      INSERT INTO vault_nodes (path, title, folder, tags, aliases, size, modified_at, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind("Notes/A", "A", "Notes", "[]", "[]", 1, "2026-04-23T00:00:00.000Z");

    const desiredEdges = Array.from({ length: 801 }, (_, i) => ({
      source: "Notes/A",
      target: `Notes/${i}`,
      edge_type: "wikilink",
      weight: 1,
      ingest_run_id: "sync-overflow",
      origin: "extract" as const,
    }));

    await expect(applyOps(env, [], {
      reconcileExtract: { path: "Notes/A", desiredEdges, nodeStmt },
    })).rejects.toThrow(
      "extractEdgesFromNote produced 801 edges for Notes/A; exceeds per-note cap of 800 (D1 100-stmt batch budget). Operator: investigate note for runaway link expansion.",
    );
  });
});
