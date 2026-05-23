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

describe("backfillTierAOps", () => {
  test("is idempotent across repeated resets", async () => {
    const { backfillTierAOps } = await import("../../src/index");
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
        indexed_at TEXT DEFAULT (datetime('now')),
        content_hash TEXT
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

      INSERT INTO vault_nodes (path, title, note_type, folder, tags, aliases, size, modified_at, content_hash) VALUES
        ('Notes/A', 'A', 'note', 'Notes', '[]', '[]', 1, '2026-04-23T00:00:00.000Z', 'hash-a'),
        ('__maintenance_mode__', 'maintenance', null, '', '[]', '[]', 0, '', 'meta');
      INSERT INTO vault_edges (source, target, edge_type, weight, ingest_run_id, origin) VALUES
        ('Notes/A', 'Notes/B', 'wikilink', 1, 'sync-1', 'extract'),
        ('Notes/A', 'Entity/C', 'related', 1.5, NULL, 'extract'),
        ('Notes/A', 'Notes/D', 'folder', 0.5, NULL, 'extract');
    `);

    const env = { DB: d1(db) };
    await backfillTierAOps(env as any);
    const first = db.query(
      "SELECT op_type, origin, payload_json FROM vault_ops ORDER BY op_type, origin, payload_json",
    ).all();

    await backfillTierAOps(env as any);
    const second = db.query(
      "SELECT op_type, origin, payload_json FROM vault_ops ORDER BY op_type, origin, payload_json",
    ).all();

    expect(second).toEqual(first);
  });
});
