/**
 * Phase 3 tests: /api/sync-ops endpoint + ULID backfill + vault_ops ULID writes.
 *
 * Uses pr2-harness for D1 shim + mock setup (mock.module required).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { d1, setupSchema, makeEnv } from "./pr2-harness";

let db: ReturnType<typeof Database.prototype.constructor>;
let env: any;
let worker: any;

beforeEach(async () => {
  db = new Database(":memory:");
  setupSchema(db);
  env = makeEnv(db);
  worker = await import("../src/index");
});

function authHeaders() {
  return {
    "Authorization": `Bearer ${env.SHARED_SECRET}`,
    "Content-Type": "application/json",
  };
}

describe("/api/sync-ops", () => {
  it("returns empty ops when vault_ops is empty", async () => {
    const res = await worker.default.fetch(
      new Request("http://x/api/sync-ops", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ ops: [], watermark: null }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ops).toEqual([]);
    expect(data.has_more).toBe(false);
    expect(data.stats.total_ops).toBe(0);
  });

  it("returns ops with ULIDs after applyOps writes", async () => {
    // Write some ops via applyOps
    const { applyOps } = await import("../src/index");
    await applyOps(env, [
      { op_type: "add_edge", origin: "extract", payload: { source: "a.md", target: "b.md", edge_type: "wikilink", weight: 1 } },
      { op_type: "upsert_node", origin: "extract", payload: { path: "a.md", title: "A" } },
    ]);

    // Verify ops have ULIDs
    const rows = db.query("SELECT ulid FROM vault_ops WHERE ulid IS NOT NULL").all() as { ulid: string }[];
    expect(rows.length).toBe(2);
    expect(rows[0].ulid).toHaveLength(26);

    // Fetch via /api/sync-ops
    const res = await worker.default.fetch(
      new Request("http://x/api/sync-ops", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ ops: [], watermark: null }),
      }),
      env,
    );
    const data = await res.json();
    expect(data.ops).toHaveLength(2);
    expect(data.ops[0].ulid).toHaveLength(26);
    expect(data.stats.total_ops).toBe(2);
  });

  it("respects watermark — returns only newer ops", async () => {
    // Insert ops with explicit ULIDs for deterministic sort order.
    // ULIDs sort lexicographically; "01A..." < "01B..." is guaranteed.
    db.run(
      "INSERT INTO vault_ops (ulid, op_type, payload_json, origin, ts) VALUES (?, ?, ?, ?, datetime('now'))",
      ["01A00000000000000000000000", "add_edge", '{"source":"a.md","target":"b.md","edge_type":"wikilink","weight":1}', "extract"],
    );

    // Get watermark from first sync
    const res1 = await worker.default.fetch(
      new Request("http://x/api/sync-ops", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ ops: [], watermark: null }),
      }),
      env,
    );
    const data1 = await res1.json();
    const watermark = data1.watermark;
    expect(data1.ops).toHaveLength(1);
    expect(watermark).toBe("01A00000000000000000000000");

    // Insert a second op with a later ULID
    db.run(
      "INSERT INTO vault_ops (ulid, op_type, payload_json, origin, ts) VALUES (?, ?, ?, ?, datetime('now'))",
      ["01B00000000000000000000000", "add_edge", '{"source":"c.md","target":"d.md","edge_type":"wikilink","weight":1}', "extract"],
    );

    // Second sync with watermark — should only return the new op
    const res2 = await worker.default.fetch(
      new Request("http://x/api/sync-ops", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ ops: [], watermark }),
      }),
      env,
    );
    const data2 = await res2.json();
    expect(data2.ops).toHaveLength(1);
    expect(data2.ops[0].payload.source).toBe("c.md");
    // total_ops is always present (even with non-null watermark)
    expect(data2.stats.total_ops).toBe(2);
  });

  it("paginates with limit and has_more", async () => {
    const { applyOps } = await import("../src/index");
    // Write 5 ops
    const ops = Array.from({ length: 5 }, (_, i) => ({
      op_type: "add_edge" as const,
      origin: "extract" as const,
      payload: { source: `${i}.md`, target: "z.md", edge_type: "wikilink", weight: 1 },
    }));
    await applyOps(env, ops);

    // Request with limit=2
    const res = await worker.default.fetch(
      new Request("http://x/api/sync-ops", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ ops: [], watermark: null, limit: 2 }),
      }),
      env,
    );
    const data = await res.json();
    expect(data.ops).toHaveLength(2);
    expect(data.has_more).toBe(true);

    // Follow-up with watermark from first page
    const res2 = await worker.default.fetch(
      new Request("http://x/api/sync-ops", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ ops: [], watermark: data.watermark, limit: 10 }),
      }),
      env,
    );
    const data2 = await res2.json();
    expect(data2.ops).toHaveLength(3);
    expect(data2.has_more).toBe(false);
  });

  it("requires auth", async () => {
    const res = await worker.default.fetch(
      new Request("http://x/api/sync-ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops: [], watermark: null }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe("ULID backfill", () => {
  it("backfills pre-Phase-3 rows that lack ULIDs", async () => {
    // Insert rows WITHOUT ulid (simulating pre-migration data)
    db.run(
      "INSERT INTO vault_ops (op_type, payload_json, origin, ts) VALUES (?, ?, ?, datetime('now'))",
      ["add_edge", '{"source":"a","target":"b","edge_type":"wikilink","weight":1}', "extract"],
    );
    db.run(
      "INSERT INTO vault_ops (op_type, payload_json, origin, ts) VALUES (?, ?, ?, datetime('now'))",
      ["upsert_node", '{"path":"a.md","title":"A"}', "extract"],
    );

    // Verify no ULIDs yet
    const before = db.query("SELECT COUNT(*) AS c FROM vault_ops WHERE ulid IS NOT NULL").get() as { c: number };
    expect(before.c).toBe(0);

    // Trigger backfill via /api/sync-ops
    const res = await worker.default.fetch(
      new Request("http://x/api/sync-ops", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ ops: [], watermark: null }),
      }),
      env,
    );
    const data = await res.json();
    expect(data.stats.backfilled).toBe(2);

    // Verify ULIDs are populated
    const after = db.query("SELECT COUNT(*) AS c FROM vault_ops WHERE ulid IS NOT NULL").get() as { c: number };
    expect(after.c).toBe(2);

    // And ops are returned in the response
    expect(data.ops).toHaveLength(2);
  });

  it("is idempotent — second call backfills 0", async () => {
    db.run(
      "INSERT INTO vault_ops (op_type, payload_json, origin, ts) VALUES (?, ?, ?, datetime('now'))",
      ["add_edge", '{"source":"a","target":"b","edge_type":"wikilink","weight":1}', "extract"],
    );

    // First call
    const { backfillVaultOpsUlids } = await import("../src/index");
    const r1 = await backfillVaultOpsUlids(env);
    expect(r1.backfilled).toBe(1);

    // Second call
    const r2 = await backfillVaultOpsUlids(env);
    expect(r2.backfilled).toBe(0);
  });
});

describe("/api/export", () => {
  it("returns vault_nodes excluding sentinels", async () => {
    db.run("INSERT INTO vault_nodes (path, title) VALUES ('note.md', 'A Note')");
    db.run("INSERT INTO vault_nodes (path, title) VALUES ('__last_sync__', 'sentinel')");

    const res = await worker.default.fetch(
      new Request("http://x/api/export?table=vault_nodes&limit=100"),
      { ...env },
    );
    // Auth check — should require bearer
    expect(res.status).toBe(401);

    // With auth
    const res2 = await worker.default.fetch(
      new Request("http://x/api/export?table=vault_nodes&limit=100", {
        headers: { "Authorization": `Bearer ${env.SHARED_SECRET}` },
      }),
      env,
    );
    expect(res2.status).toBe(200);
    const data = await res2.json();
    expect(data.total).toBe(1); // sentinel excluded
    expect(data.rows[0].path).toBe("note.md");
  });

  it("returns vault_edges", async () => {
    db.run(
      "INSERT INTO vault_edges (source, target, edge_type, weight, origin) VALUES ('a.md', 'b.md', 'wikilink', 1, 'extract')"
    );

    const res = await worker.default.fetch(
      new Request("http://x/api/export?table=vault_edges&limit=100", {
        headers: { "Authorization": `Bearer ${env.SHARED_SECRET}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(1);
    expect(data.rows[0].source).toBe("a.md");
  });

  it("rejects invalid table parameter", async () => {
    const res = await worker.default.fetch(
      new Request("http://x/api/export?table=users", {
        headers: { "Authorization": `Bearer ${env.SHARED_SECRET}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("paginates correctly", async () => {
    for (let i = 0; i < 5; i++) {
      db.run(`INSERT INTO vault_nodes (path, title) VALUES ('note${i}.md', 'Note ${i}')`);
    }

    const res = await worker.default.fetch(
      new Request("http://x/api/export?table=vault_nodes&limit=2&offset=0", {
        headers: { "Authorization": `Bearer ${env.SHARED_SECRET}` },
      }),
      env,
    );
    const data = await res.json();
    expect(data.rows).toHaveLength(2);
    expect(data.has_more).toBe(true);
    expect(data.total).toBe(5);
  });
});

describe("ingestRunId uses ULID", () => {
  it("syncGraph produces ULID-based ingestRunId", async () => {
    // Seed R2 with a note so syncGraph has something to process
    const r2 = env.VAULT;
    await r2.put("test.md", "# Test\n\nHello [[world]]");

    const { default: workerModule } = await import("../src/index");

    const res = await workerModule.fetch(
      new Request("http://x/api/sync-graph?force=true", {
        headers: { "Authorization": `Bearer ${env.SHARED_SECRET}` },
      }),
      env,
    );

    // Check ingest_runs table for ULID-based ID
    const runs = db.query("SELECT id FROM ingest_runs").all() as { id: string }[];
    if (runs.length > 0) {
      // Should start with "sync-" followed by a 26-char ULID
      expect(runs[0].id).toMatch(/^sync-[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });
});
