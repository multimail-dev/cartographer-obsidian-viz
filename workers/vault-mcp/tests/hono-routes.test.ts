/**
 * Tests for the Hono sub-app (src/routes/hono-app.ts) covering:
 *   - Auth middleware: unauthorized → 401 for no header, wrong token
 *   - Bypass-attack tests (F5, plan005 deepen-pass C1):
 *     0-byte token, 100KB token, UTF-16 multi-byte token → 401 clean (no throw)
 *   - /api/frontmatter/schema → 200
 *   - /api/vault/drift?node=... → 200 with { points: [...] } shape
 *
 * Uses bun:sqlite in-memory DB bound to c.env.DB via the same D1 adapter
 * pattern as ui-routes.test.ts.
 */

import { describe, expect, test, beforeEach, beforeAll } from "bun:test";
import { timingSafeEqual } from "node:crypto";
import { Database as BunDatabase } from "bun:sqlite";
import { honoApp, withFallthrough } from "../src/routes/hono-app";

// Polyfill crypto.subtle.timingSafeEqual for Bun's test runtime.
// CF Workers exposes this; Bun/Node does not — use Node's timingSafeEqual
// with the same semantics as a stand-in.
beforeAll(() => {
  if (!(crypto.subtle as any).timingSafeEqual) {
    (crypto.subtle as any).timingSafeEqual = (a: ArrayBufferLike, b: ArrayBufferLike) =>
      timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }
});

// ---------------------------------------------------------------------------
// Minimal D1 adapter — matches the pattern from ui-routes.test.ts
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
// Schema — base vault_nodes/vault_edges + migration 0004 additions
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE vault_nodes (
  path TEXT PRIMARY KEY,
  title TEXT,
  note_type TEXT,
  folder TEXT,
  tags TEXT,
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

CREATE TABLE vault_snapshots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id             TEXT    NOT NULL,
  enrichment_version  INTEGER NOT NULL,
  captured_at         INTEGER NOT NULL,
  pagerank            REAL,
  cluster_id          INTEGER,
  component_id        INTEGER
);

CREATE TABLE snapshot_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  node_count  INTEGER NOT NULL,
  edge_count  INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK(status IN ('pending','persisted','failed'))
);
`;

// ---------------------------------------------------------------------------
// Fixture seed
// ---------------------------------------------------------------------------

function seed(db: BunDatabase) {
  db.run(SCHEMA_SQL);

  // Real nodes with frontmatter
  db.query(
    `INSERT INTO vault_nodes (path, title, note_type, folder, tags, modified_at, frontmatter)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "Concepts/ExampleProject",
    "Example Project",
    "note",
    "Concepts",
    '["concept"]',
    "2026-04-12T00:00:00.000Z",
    JSON.stringify({ status: "active", project: "example-project" }),
  );

  db.query(
    `INSERT INTO vault_nodes (path, title, note_type, folder, tags, modified_at, frontmatter)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "Projects/Phase3",
    "Phase 3",
    "note",
    "Projects",
    '["project"]',
    "2026-04-12T00:00:00.000Z",
    JSON.stringify({ status: "complete" }),
  );

  // Node with no frontmatter — should not appear in schema results
  db.query(
    `INSERT INTO vault_nodes (path, title, note_type, folder, tags, modified_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("People/Alice", "Alice", "note", "People", '["person"]', "2026-04-12T00:00:00.000Z");

  // Sentinel rows — must be excluded
  db.query(
    `INSERT INTO vault_nodes (path, title, note_type, folder, tags, modified_at, frontmatter)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("__last_sync__", "sync", null, "", "[]", "2026-04-12T00:00:00.000Z", '{"sentinel":true}');

  // Edge between real nodes
  db.query(
    `INSERT INTO vault_edges (source, target, edge_type) VALUES (?, ?, ?)`,
  ).run("Concepts/ExampleProject", "Projects/Phase3", "wikilink");

  // Drift snapshots for Concepts/ExampleProject
  db.query(
    `INSERT INTO vault_snapshots (node_id, enrichment_version, captured_at, pagerank, cluster_id, component_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("Concepts/ExampleProject", 1, Date.now() - 10000, 0.25, 1, 0);
  db.query(
    `INSERT INTO vault_snapshots (node_id, enrichment_version, captured_at, pagerank, cluster_id, component_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("Concepts/ExampleProject", 2, Date.now(), 0.42, 1, 0);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SECRET = "test-secret-value";

function makeEnv(db: BunDatabase): any {
  return {
    DB: d1(db),
    SHARED_SECRET: SECRET,
    // Minimal R2 stub — not needed for these routes but Hono may require Env shape
    VAULT_SNAPSHOTS: {
      async put() {},
      async get() { return null; },
    },
  };
}

function authHeader(token: string): string {
  return `Bearer ${token}`;
}

async function req(
  path: string,
  env: any,
  headers: Record<string, string> = {},
): Promise<Response> {
  const request = new Request(`http://localhost${path}`, { headers });
  return honoApp.fetch(request, env);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Hono sub-app auth middleware", () => {
  let db: BunDatabase;
  let env: any;

  beforeEach(() => {
    db = new BunDatabase(":memory:");
    seed(db);
    env = makeEnv(db);
  });

  test("no Authorization header → 401", async () => {
    const res = await req("/api/frontmatter/schema", env);
    expect(res.status).toBe(401);
  });

  test("wrong token → 401", async () => {
    const res = await req("/api/frontmatter/schema", env, {
      Authorization: authHeader("wrong-token"),
    });
    expect(res.status).toBe(401);
  });

  test("bypass-attack: 0-byte token → 401 clean (no throw)", async () => {
    // Empty bearer value — timingSafeEqual would throw on raw comparison
    // (empty digest ≠ 32 bytes). SHA-256 normalization prevents the throw.
    const res = await req("/api/frontmatter/schema", env, {
      Authorization: "Bearer ",
    });
    expect(res.status).toBe(401);
  });

  test("bypass-attack: 100KB token → 401 clean (no throw)", async () => {
    const bigToken = "x".repeat(100 * 1024);
    const res = await req("/api/frontmatter/schema", env, {
      Authorization: authHeader(bigToken),
    });
    expect(res.status).toBe(401);
  });

  test("bypass-attack: UTF-16 multi-byte token → 401 clean (no throw)", async () => {
    // 'é' is 2 bytes in UTF-8; TextEncoder encodes it correctly. The point is
    // that variable byte-length multi-byte strings don't trigger a timingSafeEqual
    // length-mismatch throw because we SHA-256 first.
    const multiByteToken = "\u00e9".repeat(20); // 'é' × 20
    const res = await req("/api/frontmatter/schema", env, {
      Authorization: authHeader(multiByteToken),
    });
    expect(res.status).toBe(401);
  });

  test("valid token → passes auth (200 from downstream handler)", async () => {
    const res = await req("/api/frontmatter/schema", env, {
      Authorization: authHeader(SECRET),
    });
    expect(res.status).toBe(200);
  });
});

describe("GET /api/frontmatter/schema", () => {
  let db: BunDatabase;
  let env: any;

  beforeEach(() => {
    db = new BunDatabase(":memory:");
    seed(db);
    env = makeEnv(db);
  });

  test("returns 200 with fields array", async () => {
    const res = await req("/api/frontmatter/schema", env, {
      Authorization: authHeader(SECRET),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.fields)).toBe(true);
  });

  test("sentinel rows are excluded — their frontmatter does not appear in schema", async () => {
    const res = await req("/api/frontmatter/schema", env, {
      Authorization: authHeader(SECRET),
    });
    const body = (await res.json()) as any;
    // Sentinel has { sentinel: true } — 'sentinel' field must not appear
    const sentinelField = body.fields.find((f: any) => f.field === "sentinel");
    expect(sentinelField).toBeUndefined();
  });

  test("real node frontmatter fields appear in schema", async () => {
    const res = await req("/api/frontmatter/schema", env, {
      Authorization: authHeader(SECRET),
    });
    const body = (await res.json()) as any;
    const statusField = body.fields.find((f: any) => f.field === "status");
    expect(statusField).toBeDefined();
    expect(statusField.total).toBe(2); // two nodes have status
  });
});

describe("GET /api/vault/drift", () => {
  let db: BunDatabase;
  let env: any;

  beforeEach(() => {
    db = new BunDatabase(":memory:");
    seed(db);
    env = makeEnv(db);
  });

  test("missing node param → 400", async () => {
    const res = await req("/api/vault/drift", env, {
      Authorization: authHeader(SECRET),
    });
    expect(res.status).toBe(400);
  });

  test("existing node → 200 with points array", async () => {
    const res = await req("/api/vault/drift?node=Concepts%2FExampleProject", env, {
      Authorization: authHeader(SECRET),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // DTO is camelCase per shared contract (round-3 codex fix).
    expect(body.nodeId).toBe("Concepts/ExampleProject");
    expect(body.title).toBe("Example Project");
    expect(Array.isArray(body.points)).toBe(true);
    expect(body.points).toHaveLength(2);
    expect(body.points[0].enrichmentVersion).toBe(1);
    expect(body.points[1].enrichmentVersion).toBe(2);
    expect(typeof body.points[0].capturedAt).toBe("number");
  });

  test("unknown node → 200 with empty points (not 404)", async () => {
    const res = await req("/api/vault/drift?node=Does%2FNotExist", env, {
      Authorization: authHeader(SECRET),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.points).toHaveLength(0);
  });
});

describe("GET /api/vault/propagate", () => {
  let db: BunDatabase;
  let env: any;

  beforeEach(() => {
    db = new BunDatabase(":memory:");
    seed(db);
    env = makeEnv(db);
  });

  test("missing node param → 400", async () => {
    const res = await req("/api/vault/propagate", env, {
      Authorization: authHeader(SECRET),
    });
    expect(res.status).toBe(400);
  });

  test("node with no snapshot data → 200 with empty changed", async () => {
    const res = await req("/api/vault/propagate?node=People%2FAlice", env, {
      Authorization: authHeader(SECRET),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.changed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F3 integration — Hono→fallthrough→stub handler via /api/enrich/status
//
// We cannot import index.ts in Bun tests (cloudflare:workers package is
// unavailable outside the CF runtime). Instead we wire the fallthrough
// via withFallthrough() with a stub that mirrors the production
// legacyDispatch behaviour for /api/enrich/status only. This exercises
// the full Hono auth-middleware → route-miss → catch-all → fallthrough
// dispatch path.
// ---------------------------------------------------------------------------

// Minimal stub that handles /api/enrich/status the same way legacyDispatch does.
// Called once at module load — withFallthrough wires it into honoApp permanently.
withFallthrough(async (request, env: any) => {
  const url = new URL(request.url);

  // Centralized auth check (mirrors legacyDispatch)
  if (url.pathname.startsWith("/api/")) {
    const { verifyBearer: vb } = await import("../src/auth/bearer");
    if (!(await vb(request, env.SHARED_SECRET))) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (request.method === "GET" && url.pathname === "/api/enrich/status") {
    const cursor = await env.DB.prepare(
      "SELECT phase, lease_expires FROM enrich_cursor WHERE id = 1"
    ).first<{ phase: string; lease_expires: number | null }>();
    const [lastRunAt, enrichVersion, communityCount] = await Promise.all([
      env.DB.prepare("SELECT value FROM meta WHERE key = 'last_enrichment_at'").first<{ value: string }>(),
      env.DB.prepare("SELECT value FROM meta WHERE key = 'enrichment_version'").first<{ value: string }>(),
      env.DB.prepare("SELECT value FROM meta WHERE key = 'enrichment_community_count'").first<{ value: string }>(),
    ]);
    return new Response(JSON.stringify({
      phase: cursor?.phase ?? null,
      leaseExpires: cursor?.lease_expires ?? null,
      lastRunAt: lastRunAt?.value ?? null,
      enrichmentVersion: enrichVersion?.value ?? null,
      communityCount: communityCount?.value ?? null,
    }), { headers: { "Content-Type": "application/json" } });
  }

  return new Response("not found", { status: 404 });
});

describe("F3: Hono fallthrough → GET /api/enrich/status", () => {
  let db: BunDatabase;
  let env: any;

  beforeEach(() => {
    db = new BunDatabase(":memory:");
    seed(db);
    // Add enrich_cursor and meta tables required by /api/enrich/status
    db.run(`
      CREATE TABLE IF NOT EXISTS enrich_cursor (
        id INTEGER PRIMARY KEY,
        phase TEXT NOT NULL DEFAULT 'embedding',
        lease_expires INTEGER
      );
      INSERT OR IGNORE INTO enrich_cursor (id, phase) VALUES (1, 'embedding');
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER
      );
      INSERT OR IGNORE INTO meta (key, value) VALUES ('last_enrichment_at', '2026-04-13T07:00:00.000Z');
      INSERT OR IGNORE INTO meta (key, value) VALUES ('enrichment_version', '5');
      INSERT OR IGNORE INTO meta (key, value) VALUES ('enrichment_community_count', '12');
    `);
    env = makeEnv(db);
  });

  test("no auth → 401 (legacy dispatcher enforces bearer on /api/*)", async () => {
    // After the P0 fix, the Hono auth middleware is scoped to
    // /api/frontmatter/*, /api/vault/* — NOT all /api/*.
    // /api/enrich/status falls through to the legacy dispatcher stub, which
    // does its own bearer check and 401s.
    const res = await req("/api/enrich/status", env);
    expect(res.status).toBe(401);
  });

  test("REGRESSION P0: non-Hono UNAUTH UI path reaches fallthrough (not 401 from Hono middleware)", async () => {
    // Regression test for codex P0 finding: honoApp.use('*') used to gate
    // every request behind bearer, including UI and OAuth paths. After the
    // fix, unscoped paths must reach withFallthrough unauthenticated.
    // The legacy stub returns 404 for unknown paths without a /api/ prefix,
    // proving Hono auth did NOT fire.
    const res = await fetch("http://x/some-ui-path", { method: "GET" }).catch(() => null);
    // fetch to "http://x" returns null under bun, so use honoApp.fetch directly:
    const res2 = await honoApp.fetch(
      new Request("http://x/some-ui-path"),
      env,
    );
    expect(res2.status).toBe(404); // reached fallthrough stub, returned its 404
    const body = await res2.text();
    expect(body).toBe("not found");
  });

  test("REGRESSION P0: non-Hono UNAUTH root path reaches fallthrough", async () => {
    const res = await honoApp.fetch(new Request("http://x/"), env);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  test("valid token → 200 with expected status shape", async () => {
    const res = await req("/api/enrich/status", env, {
      Authorization: authHeader(SECRET),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty("phase");
    expect(body).toHaveProperty("leaseExpires");
    expect(body).toHaveProperty("lastRunAt");
    expect(body).toHaveProperty("enrichmentVersion");
    expect(body).toHaveProperty("communityCount");
    expect(body.phase).toBe("embedding");
    expect(body.enrichmentVersion).toBe("5");
    expect(body.communityCount).toBe("12");
    // REGRESSION P2: confirm we are reading last_enrichment_at (written key),
    // not last_enrich_at (previously read, never written).
    expect(body.lastRunAt).toBe("2026-04-13T07:00:00.000Z");
  });

  test("response is JSON with correct Content-Type", async () => {
    const res = await req("/api/enrich/status", env, {
      Authorization: authHeader(SECRET),
    });
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
