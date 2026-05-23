/**
 * Shared harness for PR2 tests.
 *
 * Provides:
 *   - mock.module() for every non-D1 dependency of workers/vault-mcp/src/index.ts
 *   - d1() — bun:sqlite → D1Database shim with batch() support
 *   - setupSchema() — creates vault_nodes, vault_edges (post-PR1 shape), vault_ops,
 *     vault_dirty_degrees, vault_fts, ingest_runs, and meta
 *   - makeEnv() — populates Env with DB, SHARED_SECRET, VAULT (R2 stub),
 *     VAULT_SNAPSHOTS
 *   - withFallthrough() — injects the fetch handler for tests that need to exercise
 *     routing beyond the Hono app
 *
 * NOTE: This is a pre-write TDD harness. It imports the same mocks/shims as the
 * PR1 tests so the 8 PR2 test files can share a consistent environment.
 */

import { mock } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";

// Mock heavy worker dependencies that tests don't need to exercise.
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
  let fallthrough = async (_request: Request, _env: unknown, _ctx: unknown) =>
    new Response("missing", { status: 404 });
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

// Ensure crypto.subtle.timingSafeEqual exists under bun.
if (!(crypto.subtle as any).timingSafeEqual) {
  (crypto.subtle as any).timingSafeEqual = (a: ArrayBufferLike, b: ArrayBufferLike) =>
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function d1(db: BunDatabase): any {
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
          return {
            results: rows ?? [],
            success: true,
            meta: { changes: 0, duration: 0, last_row_id: 0, rows_read: rows.length, rows_written: 0 },
          };
        },
        async run(): Promise<any> {
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
    async batch(stmts: Array<any>) {
      const results = [];
      for (const stmt of stmts) results.push(await stmt.run());
      return results;
    },
  };
}

export function setupSchema(db: BunDatabase): void {
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
      body TEXT,
      word_count INTEGER,
      content_hash TEXT,
      frontmatter TEXT,
      ingest_run_id TEXT,
      published INTEGER,
      published_at TEXT,
      issue TEXT,
      slug TEXT,
      jot_note_id TEXT,
      author TEXT,
      out_degree INTEGER DEFAULT 0,
      in_degree INTEGER DEFAULT 0
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
    CREATE INDEX idx_vault_edges_origin_source_type ON vault_edges (origin, source, edge_type);
    CREATE INDEX idx_vault_edges_origin_target_type ON vault_edges (origin, target, edge_type);
    CREATE TABLE vault_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ulid TEXT,
      op_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      origin TEXT NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_vault_ops_ulid ON vault_ops (ulid) WHERE ulid IS NOT NULL;
    CREATE INDEX idx_vault_ops_ts ON vault_ops (ts);
    CREATE INDEX idx_vault_ops_origin_ts ON vault_ops (origin, ts);
    CREATE TABLE vault_dirty_degrees (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE vault_fts USING fts5(path UNINDEXED, title, content, tags);
    CREATE TABLE ingest_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      node_count INTEGER,
      edge_count INTEGER,
      snapshot_uri TEXT,
      error TEXT
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
  `);
}

export type R2Object = { key: string; body: string };

export function makeR2Stub(objects: R2Object[] = []): any {
  const map = new Map(objects.map((o) => [o.key, o.body]));
  return {
    async list(_opts?: unknown) {
      return {
        objects: Array.from(map.keys()).map((k) => ({
          key: k,
          size: (map.get(k) ?? "").length,
          uploaded: new Date(),
          customMetadata: {},
        })),
        truncated: false,
      };
    },
    async get(key: string) {
      const body = map.get(key);
      if (!body) return null;
      return {
        key,
        body,
        async text() { return body; },
        async arrayBuffer() { return new TextEncoder().encode(body).buffer; },
        size: body.length,
        uploaded: new Date(),
        customMetadata: {},
        httpMetadata: {},
      };
    },
    async put() {},
    async delete() {},
  };
}

export function makeEnv(db: BunDatabase, r2Objects: R2Object[] = []): any {
  return {
    DB: d1(db),
    SHARED_SECRET: "test-secret",
    VAULT: makeR2Stub(r2Objects),
    VAULT_SNAPSHOTS: { async put() {}, async get() { return null; } },
  };
}
