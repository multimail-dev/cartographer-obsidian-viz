/**
 * sweeper-cron.test.ts — issue #78
 *
 * Verifies the hourly orphan sweep in the scheduled handler correctly marks
 * stale ingest_runs rows (>1h, status='running'/'pending', completed_at IS NULL)
 * as error while leaving healthy running rows and already-completed rows untouched.
 *
 * Uses pr2-harness D1 shim (bun:sqlite in-memory).
 */

import "./pr2-harness";
import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { setupSchema, d1 } from "./pr2-harness";

describe("sweeper-cron: ingest_runs orphan sweep (#78)", () => {
  /** Helper: create env + seed rows, run the scheduled handler, return db. */
  async function runSweep(seedRows: Array<{
    id: string;
    status: string;
    started_at: number;
    completed_at: number | null;
    error: string | null;
  }>) {
    const db = new BunDatabase(":memory:");
    setupSchema(db);

    for (const row of seedRows) {
      db.exec(
        `INSERT INTO ingest_runs (id, status, started_at, completed_at, error)
         VALUES ('${row.id}', '${row.status}', ${row.started_at}, ${row.completed_at === null ? "NULL" : row.completed_at}, ${row.error === null ? "NULL" : `'${row.error}'`})`
      );
    }

    const env = {
      DB: d1(db),
      SHARED_SECRET: "test-secret",
      VAULT: { async list() { return { objects: [], truncated: false }; }, async get() { return null; }, async put() {}, async delete() {} },
      VAULT_SNAPSHOTS: { async put() {}, async get() { return null; } },
    };

    // Import the worker and invoke scheduled handler with the hourly cron
    const worker = (await import("../src/index")).default;

    // Capture the waitUntil promise so we can await it
    let waitUntilPromise: Promise<unknown> = Promise.resolve();
    const ctx = {
      waitUntil(p: Promise<unknown>) { waitUntilPromise = p; },
    };
    const event = { cron: "0 * * * *", scheduledTime: Date.now() };

    await worker.scheduled(event as any, env as any, ctx as any);
    await waitUntilPromise;

    return db;
  }

  const NOW = Math.floor(Date.now() / 1000);
  const TWO_HOURS_AGO = NOW - 2 * 3600;
  const FIVE_MINUTES_AGO = NOW - 5 * 60;

  test("marks stale running orphan as error", async () => {
    const db = await runSweep([
      { id: "sync-orphan-1", status: "running", started_at: TWO_HOURS_AGO, completed_at: null, error: null },
    ]);

    const row = db.query("SELECT status, completed_at, error FROM ingest_runs WHERE id = 'sync-orphan-1'").get() as any;
    expect(row.status).toBe("error");
    expect(row.completed_at).not.toBeNull();
    expect(row.error).toContain("orphan sweep");
  });

  test("does NOT touch healthy running row (started <1h ago)", async () => {
    const db = await runSweep([
      { id: "sync-healthy-1", status: "running", started_at: FIVE_MINUTES_AGO, completed_at: null, error: null },
    ]);

    const row = db.query("SELECT status, completed_at, error FROM ingest_runs WHERE id = 'sync-healthy-1'").get() as any;
    expect(row.status).toBe("running");
    expect(row.completed_at).toBeNull();
    expect(row.error).toBeNull();
  });

  test("does NOT touch already-completed row", async () => {
    const db = await runSweep([
      { id: "sync-done-1", status: "completed", started_at: TWO_HOURS_AGO, completed_at: TWO_HOURS_AGO + 300, error: null },
    ]);

    const row = db.query("SELECT status, completed_at, error FROM ingest_runs WHERE id = 'sync-done-1'").get() as any;
    expect(row.status).toBe("completed");
    expect(row.completed_at).toBe(TWO_HOURS_AGO + 300);
    expect(row.error).toBeNull();
  });

  test("marks stale pending orphan as error", async () => {
    const db = await runSweep([
      { id: "build-pending-1", status: "pending", started_at: TWO_HOURS_AGO, completed_at: null, error: null },
    ]);

    const row = db.query("SELECT status, completed_at, error FROM ingest_runs WHERE id = 'build-pending-1'").get() as any;
    expect(row.status).toBe("error");
    expect(row.completed_at).not.toBeNull();
    expect(row.error).toContain("orphan sweep");
  });

  test("combined scenario: sweeps only the orphan", async () => {
    const db = await runSweep([
      { id: "orphan", status: "running", started_at: TWO_HOURS_AGO, completed_at: null, error: null },
      { id: "healthy", status: "running", started_at: FIVE_MINUTES_AGO, completed_at: null, error: null },
      { id: "done", status: "completed", started_at: TWO_HOURS_AGO, completed_at: TWO_HOURS_AGO + 60, error: null },
    ]);

    const orphan = db.query("SELECT status, completed_at, error FROM ingest_runs WHERE id = 'orphan'").get() as any;
    expect(orphan.status).toBe("error");
    expect(orphan.completed_at).not.toBeNull();
    expect(orphan.error).toContain("orphan sweep");

    const healthy = db.query("SELECT status, completed_at, error FROM ingest_runs WHERE id = 'healthy'").get() as any;
    expect(healthy.status).toBe("running");
    expect(healthy.completed_at).toBeNull();

    const done = db.query("SELECT status, completed_at, error FROM ingest_runs WHERE id = 'done'").get() as any;
    expect(done.status).toBe("completed");
    expect(done.completed_at).toBe(TWO_HOURS_AGO + 60);
  });
});
