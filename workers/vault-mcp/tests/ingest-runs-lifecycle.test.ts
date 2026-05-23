/**
 * ingest-runs-lifecycle.test.ts — plan 2026-04-27-001 lifecycle fix tests.
 *
 * Verifies that syncGraphInner and buildGraph properly close ingest_runs rows
 * via try/finally (syncGraph) or try/catch (buildGraph extract) so no orphan
 * "running" rows accumulate. Uses the pr2-harness D1 shim + R2 stub.
 *
 * Tests:
 *   1. syncGraphInner finally fires on thrown exception (orphan row prevention)
 *   2. syncGraphInner finally records noop status on empty diff
 *   3. syncGraphInner fails fast when ingest_runs INSERT throws
 *   4. buildGraph catch fires on thrown exception in extract phase
 *   5. buildGraph finalize handles missing __build_run_id__ sentinel
 */

import "./pr2-harness";
import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { setupSchema, makeEnv, makeR2Stub, d1 } from "./pr2-harness";

describe("ingest_runs lifecycle (plan 2026-04-27-001)", () => {
  // -----------------------------------------------------------------------
  // Test 1: syncGraphInner finally fires on thrown exception
  // -----------------------------------------------------------------------
  test("syncGraphInner finally marks row error on thrown exception", async () => {
    const worker = (await import("../src/index")).default;

    const db = new BunDatabase(":memory:");
    setupSchema(db);

    // Seed a single note in R2 so sync will try to process it.
    // The note has a valid wikilink to trigger edge extraction.
    const env = makeEnv(db, [
      { key: "Notes/Test.md", body: "# Test\n\n[[Nonexistent]]\n" },
    ]);

    // Sabotage: after the ingest_runs INSERT succeeds, make the next
    // vault_nodes SELECT throw. We do this by dropping vault_nodes after
    // the INSERT fires, so the SELECT at the diff-detection phase throws.
    const originalPrepare = env.DB.prepare.bind(env.DB);
    let insertDone = false;
    env.DB.prepare = function (sql: string) {
      const stmt = originalPrepare(sql);
      if (sql.includes("INSERT INTO ingest_runs")) {
        const origRun = stmt.run.bind(stmt);
        stmt.run = function () {
          const result = origRun();
          insertDone = true;
          return result;
        };
      }
      // After the INSERT is done, make the vault_nodes SELECT for diff-detection throw
      if (insertDone && sql.includes("SELECT path, indexed_at FROM vault_nodes")) {
        const origAll = stmt.all.bind(stmt);
        stmt.all = function () {
          throw new Error("simulated D1 failure for lifecycle test");
        };
      }
      return stmt;
    };

    const req = new Request("http://x/api/sync-graph?force=true", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" },
    });
    const res = await worker.fetch(req, env);

    // The fetch handler catches the throw and returns 500
    expect(res.status).toBe(500);

    // The finally block should have written a terminal status
    const row = db
      .query(
        "SELECT status, completed_at, error FROM ingest_runs WHERE id LIKE 'sync-%' ORDER BY rowid DESC LIMIT 1"
      )
      .get() as { status: string; completed_at: number | null; error: string | null } | null;

    expect(row).not.toBeNull();
    expect(row!.status).toBe("error");
    expect(row!.completed_at).not.toBeNull();
    expect(row!.error).toContain("simulated D1 failure");
  });

  // -----------------------------------------------------------------------
  // Test 2: syncGraphInner finally records noop status on empty diff
  // -----------------------------------------------------------------------
  test("syncGraphInner finally records noop status on empty diff", async () => {
    const worker = (await import("../src/index")).default;

    const db = new BunDatabase(":memory:");
    setupSchema(db);

    // Empty R2 — no notes to sync. syncGraph should noop.
    const env = makeEnv(db, []);

    const req = new Request("http://x/api/sync-graph?force=true", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" },
    });
    const res = await worker.fetch(req, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.synced).toBe(0);
    expect(body.done).toBe(true);

    // The finally block should have written noop status
    const row = db
      .query(
        "SELECT status, completed_at, node_count, error FROM ingest_runs WHERE id LIKE 'sync-%' ORDER BY rowid DESC LIMIT 1"
      )
      .get() as { status: string; completed_at: number | null; node_count: number | null; error: string | null } | null;

    expect(row).not.toBeNull();
    expect(row!.status).toBe("noop");
    expect(row!.completed_at).not.toBeNull();
    expect(row!.node_count).toBe(0);
    expect(row!.error).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Test 3: syncGraphInner fails fast when ingest_runs INSERT throws
  // -----------------------------------------------------------------------
  test("syncGraphInner fails fast when ingest_runs INSERT throws", async () => {
    const worker = (await import("../src/index")).default;

    const db = new BunDatabase(":memory:");
    setupSchema(db);

    // Drop the ingest_runs table so the INSERT will throw
    db.exec("DROP TABLE ingest_runs");
    db.exec("CREATE TABLE ingest_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'running', started_at INTEGER NOT NULL, completed_at INTEGER, node_count INTEGER, error TEXT)");

    const env = makeEnv(db, [
      { key: "Notes/Test.md", body: "# Test\n" },
    ]);

    // Sabotage: make the INSERT throw by providing an invalid column
    const originalPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = function (sql: string) {
      if (sql.includes("INSERT INTO ingest_runs") && sql.includes("'running'")) {
        return {
          bind() {
            return {
              async run() {
                throw new Error("simulated INSERT failure");
              },
            };
          },
        };
      }
      return originalPrepare(sql);
    };

    const req = new Request("http://x/api/sync-graph?force=true", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" },
    });
    const res = await worker.fetch(req, env);

    // The throw should propagate — fetch handler catches and returns 500
    expect(res.status).toBe(500);

    // No audit row should exist — the INSERT itself failed
    const count = db
      .query("SELECT COUNT(*) as c FROM ingest_runs")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 4: buildGraph catch fires on thrown exception in extract phase
  // -----------------------------------------------------------------------
  test("buildGraph catch marks row error on thrown exception in extract", async () => {
    const { buildGraph } = await import("../src/index");

    const db = new BunDatabase(":memory:");
    setupSchema(db);

    // Create an env with a rigged R2 stub that throws mid-list
    const r2Stub = {
      async list() {
        throw new Error("simulated R2 list failure in extract");
      },
      async get() { return null; },
      async put() {},
      async delete() {},
    };
    const env = {
      DB: d1(db),
      SHARED_SECRET: "test-secret",
      VAULT: r2Stub,
      VAULT_SNAPSHOTS: { async put() {}, async get() { return null; } },
    };

    // buildGraph extract — should throw from R2.list()
    let threw = false;
    try {
      await buildGraph(env, "extract", true);
    } catch (e: any) {
      threw = true;
      expect(e.message).toContain("simulated R2 list failure");
    }
    expect(threw).toBe(true);

    // The catch block should have marked the ingest_runs row as error
    const row = db
      .query(
        "SELECT status, completed_at, error FROM ingest_runs WHERE id LIKE 'build-%' ORDER BY rowid DESC LIMIT 1"
      )
      .get() as { status: string; completed_at: number | null; error: string | null } | null;

    expect(row).not.toBeNull();
    expect(row!.status).toBe("error");
    expect(row!.completed_at).not.toBeNull();
    expect(row!.error).toContain("simulated R2 list failure");
  });

  // -----------------------------------------------------------------------
  // Test 5: buildGraph finalize handles missing __build_run_id__ sentinel
  // -----------------------------------------------------------------------
  test("buildGraph finalize recovers when __build_run_id__ sentinel is missing", async () => {
    const { buildGraph } = await import("../src/index");

    const db = new BunDatabase(":memory:");
    setupSchema(db);

    // Simulate a state where extract completed but the sentinel was deleted
    // before finalize: insert a running build row but don't write the sentinel.
    const buildRunId = `build-${Date.now()}`;
    db.exec(`
      INSERT INTO ingest_runs (id, started_at, status)
        VALUES ('${buildRunId}', ${Math.floor(Date.now() / 1000)}, 'running');
    `);

    // No __build_run_id__ sentinel — finalize should detect this and recover
    const env = makeEnv(db, []);

    // buildGraph finalize — the sentinel is missing
    const result = await buildGraph(env, "finalize");
    const parsed = JSON.parse(result);
    expect(parsed.phase).toBe("finalize");
    expect(parsed.done).toBe(true);

    // The orphan recovery should have marked the running build row as error
    const row = db
      .prepare(
        "SELECT status, completed_at, error FROM ingest_runs WHERE id = ?"
      )
      .get(buildRunId) as { status: string; completed_at: number | null; error: string | null } | null;

    expect(row).not.toBeNull();
    expect(row!.status).toBe("error");
    expect(row!.completed_at).not.toBeNull();
    expect(row!.error).toContain("sentinel __build_run_id__ missing");
  });
});
