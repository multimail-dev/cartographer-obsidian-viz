/**
 * PR2 Test 2/8 — syncGraph origin-scoped reconciliation
 *
 * Plan: docs/plans/2026-04-23-001-cartographer-op-log-tier-a-plan.md §syncGraph redesign
 *
 * INVARIANT (PR2): syncGraph's DELETE is scoped to origin='extract'. Edges
 * written by /api/ingest-triples (origin='ingest_triples') or finalize phase
 * (origin='finalize') on the same path MUST survive a syncGraph run.
 *
 * Currently (main @ 49737fa), workers/vault-mcp/src/index.ts:1953 runs
 *   DELETE FROM vault_edges WHERE source = ?
 * which wipes ALL origins. This test fails against main because the seeded
 * ingest_triples edge gets deleted.
 *
 * PR2 replaces that DELETE with the origin-scoped split form specified in the
 * plan (two separate statements, each hitting its own composite index):
 *   DELETE FROM vault_edges WHERE origin = 'extract' AND source = ? AND edge_type != 'spoke_in'
 *   DELETE FROM vault_edges WHERE origin = 'extract' AND target = ? AND edge_type = 'spoke_in'
 */

import "../pr2-harness";
import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { setupSchema, makeEnv } from "../pr2-harness";

describe("PR2 parity: syncGraph is origin-scoped", () => {
  test("ingest_triples edge on synced path survives syncGraph", async () => {
    const worker = (await import("../../src/index")).default;

    const db = new BunDatabase(":memory:");
    setupSchema(db);

    // Seed vault state:
    //   - Notes/A exists
    //   - ingest_triples edge on source=Notes/A (the row under test)
    //   - a stale extract edge that syncGraph should reconcile away
    db.exec(`
      INSERT INTO vault_nodes (path, title, folder, tags, modified_at)
        VALUES ('Notes/A', 'A', 'Notes', '[]', '2026-04-24T00:00:00.000Z');
      INSERT INTO vault_edges (source, target, edge_type, weight, origin)
        VALUES ('Notes/A', 'Entity/Triple', 'related', 3.0, 'ingest_triples'),
               ('Notes/A', 'Notes/Stale', 'wikilink', 1.0, 'extract');
    `);

    const env = makeEnv(db, [
      { key: "Notes/A.md", body: "# A\n\nThis note has no outbound links.\n" },
    ]);

    const req = new Request("http://x/api/sync-graph?force=true", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" },
    });
    const res = await worker.fetch(req, env);
    // Even if routing returns a non-200 for other reasons, the DB side effects
    // (DELETE + INSERT) are what matter. Do not assert status here.

    const survivors = db
      .query(
        "SELECT source, target, edge_type, origin FROM vault_edges WHERE origin = 'ingest_triples' AND source = 'Notes/A'"
      )
      .all() as Array<{ source: string; target: string; edge_type: string; origin: string }>;

    expect(survivors).toEqual([
      {
        source: "Notes/A",
        target: "Entity/Triple",
        edge_type: "related",
        origin: "ingest_triples",
      },
    ]);

    // Guardrail: if the endpoint never reached the DELETE (e.g. 401, routing
    // miss), this test would trivially pass. Assert something observable
    // changed so a no-op endpoint is detected.
    const staleGone = db
      .query(
        "SELECT COUNT(*) AS c FROM vault_edges WHERE source = 'Notes/A' AND target = 'Notes/Stale' AND origin = 'extract'"
      )
      .get() as { c: number };
    expect(staleGone.c).toBe(0);

    // Status — keep for diagnostic only. Not part of the gate.
    void res.status;
  });
});
