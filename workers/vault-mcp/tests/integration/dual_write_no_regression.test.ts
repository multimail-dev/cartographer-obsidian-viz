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

describe("dual-write ingest endpoint", () => {
  test("keeps legacy edge materialization and appends vault_ops", async () => {
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
        content_hash TEXT,
        out_degree INTEGER DEFAULT 0,
        in_degree INTEGER DEFAULT 0
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
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
    `);

    const env = makeEnv(db);
    const req = new Request("http://x/api/ingest-triples", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        triples: [{ subject: "Notes/A", relation: "related", object: "Entity/B", weight: 1.25 }],
      }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ingested).toBe(1);
    expect(body.skipped).toBe(0);

    const edge = db.query(
      "SELECT source, target, edge_type, weight, origin FROM vault_edges",
    ).get() as { source: string; target: string; edge_type: string; weight: number; origin: string };
    expect(edge).toEqual({
      source: "Notes/A",
      target: "Entity/B",
      edge_type: "related",
      weight: 1.25,
      origin: "ingest_triples",
    });

    const op = db.query(
      "SELECT op_type, origin FROM vault_ops",
    ).get() as { op_type: string; origin: string };
    expect(op).toEqual({ op_type: "add_edge", origin: "ingest_triples" });

    // PR3: /api/replay-graph-dry-run was retired with the rest of the PR2
    // verification surface. The per-write parity assertions above cover the
    // shadow-write invariant on their own (vault_edges row + matching
    // vault_ops row, same origin).
  });
});
