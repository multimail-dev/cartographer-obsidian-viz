/**
 * PR2 Test 4/8 — syncGraph vs /api/ingest-triples race
 *
 * Plan: docs/plans/2026-04-23-001-cartographer-op-log-tier-a-plan.md §Concurrency analysis
 *
 * INVARIANT (PR2): origin-scoping IS the fencing mechanism — sync_writer_lease
 * is retired. A syncGraph call and a /api/ingest-triples call operating on the
 * same source path converge to a state containing BOTH writers' edges:
 *   - extract edges from syncGraph under origin='extract'
 *   - ingest_triples edges under origin='ingest_triples'
 * Neither writer's DELETE touches the other's rows.
 *
 * Currently (main @ 49737fa), the lease serializes these two callers AND
 * syncGraph's DELETE at index.ts:1953 is origin-blind, so even under
 * serialization the ingest_triples edge can be clobbered if syncGraph runs
 * second on the same path. This test fails against main.
 */

import "../pr2-harness";
import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { setupSchema, makeEnv } from "../pr2-harness";

describe("PR2 race: syncGraph vs ingest_triples", () => {
  test("both origins coexist after concurrent writes on same path", async () => {
    const worker = (await import("../../src/index")).default;

    const db = new BunDatabase(":memory:");
    setupSchema(db);
    db.exec(`
      INSERT INTO vault_nodes (path, title, folder, tags, modified_at)
        VALUES ('Notes/A', 'A', 'Notes', '[]', '2026-04-24T00:00:00.000Z'),
               ('Notes/B', 'B', 'Notes', '[]', '2026-04-24T00:00:00.000Z');
    `);

    const env = makeEnv(db, [
      { key: "Notes/A.md", body: "# A\n\n[[B]]\n" },
      { key: "Notes/B.md", body: "# B\n\n" },
    ]);

    const ingestReq = new Request("http://x/api/ingest-triples", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        triples: [{ subject: "Notes/A", relation: "claim", object: "Entity/Triple", weight: 1.25 }],
      }),
    });
    const syncReq = new Request("http://x/api/sync-graph?force=true", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" },
    });

    // Concurrent dispatch — under the bun:sqlite D1 shim, batches serialize in
    // the order awaited, but both callers must emit independent DELETE/INSERT
    // origin-scoped plans.
    const [ingestRes, syncRes] = await Promise.all([
      worker.fetch(ingestReq, env),
      worker.fetch(syncReq, env),
    ]);
    void ingestRes.status;
    void syncRes.status;

    // Ingest_triples edge still there
    const triple = db
      .query(
        "SELECT source, target, edge_type, weight, origin FROM vault_edges WHERE origin = 'ingest_triples' AND source = 'Notes/A'"
      )
      .get() as { source: string; target: string; edge_type: string; weight: number; origin: string } | null;
    expect(triple).not.toBeNull();
    expect(triple!.target).toBe("Entity/Triple");
    expect(triple!.origin).toBe("ingest_triples");

    // Extract wikilink edge from syncGraph also materialized (origin='extract')
    const extractEdge = db
      .query(
        "SELECT source, target, edge_type, origin FROM vault_edges WHERE origin = 'extract' AND source = 'Notes/A' AND target = 'Notes/B' AND edge_type = 'wikilink'"
      )
      .get() as { source: string; target: string; origin: string } | null;
    expect(extractEdge).not.toBeNull();
    expect(extractEdge!.origin).toBe("extract");
  });
});
