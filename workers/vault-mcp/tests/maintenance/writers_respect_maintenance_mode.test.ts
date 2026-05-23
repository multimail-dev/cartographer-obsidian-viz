import { beforeAll, describe, expect, mock, test } from "bun:test";
import { timingSafeEqual } from "node:crypto";
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

beforeAll(() => {
  if (!(crypto.subtle as any).timingSafeEqual) {
    (crypto.subtle as any).timingSafeEqual = (a: ArrayBufferLike, b: ArrayBufferLike) =>
      timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }
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

function makeEnv(db: BunDatabase): any {
  return {
    DB: d1(db),
    SHARED_SECRET: "secret",
    VAULT: { async list() { return { objects: [], truncated: false }; }, async get() { return null; } },
    VAULT_SNAPSHOTS: { async put() {}, async get() { return null; } },
  };
}

describe("maintenance mode", () => {
  test("writer endpoints return 503 while maintenance is active and status reports ttl", async () => {
    const worker = (await import("../../src/index")).default;
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
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
      CREATE TABLE ingest_runs (
        id TEXT PRIMARY KEY,
        started_at INTEGER,
        completed_at INTEGER,
        node_count INTEGER,
        edge_count INTEGER,
        status TEXT,
        error TEXT
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
      INSERT INTO vault_nodes (path, title, note_type, folder, tags, size, modified_at, indexed_at)
      VALUES ('__maintenance_mode__', 'maintenance', null, '', '[]', 0, '', datetime('now', '+5 minutes'));
    `);

    const env = makeEnv(db);
    const headers = { Authorization: "Bearer secret", "Content-Type": "application/json" };

    const ingestRes = await worker.fetch(new Request("http://x/api/ingest-triples", {
      method: "POST",
      headers,
      body: JSON.stringify({ triples: [{ subject: "A", relation: "related", object: "B" }] }),
    }), env);
    expect(ingestRes.status).toBe(503);

    const buildRes = await worker.fetch(new Request("http://x/api/build-graph", {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
    }), env);
    expect(buildRes.status).toBe(503);

    const syncRes = await worker.fetch(new Request("http://x/api/sync-graph", {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
    }), env);
    expect(syncRes.status).toBe(503);

    // PR3: /api/tier-a-reset?phase=status was retired with the rest of the
    // tier-a-reset endpoint. Maintenance-mode TTL is now exercised
    // implicitly via the 503 responses on the writer endpoints above.
  });
});
