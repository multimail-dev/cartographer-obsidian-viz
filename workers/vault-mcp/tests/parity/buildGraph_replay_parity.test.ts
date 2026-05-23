/**
 * PR2 Test 1/8 — buildGraph replay parity (the CI gate)
 *
 * Plan: docs/plans/2026-04-23-001-cartographer-op-log-tier-a-plan.md §Parity gate
 * Seed: docs/seeds/2026-04-24-tier-a-pr2-cutover.seed.yaml
 *
 * INVARIANT (PR2): buildGraph is non-destructive. Cross-origin edges (origin !=
 * 'extract') written before a buildGraph call MUST survive the call. The plan
 * removes the `DROP TABLE IF EXISTS vault_edges` at index.ts:1032 in PR2.
 *
 * This test MUST FAIL against current main (49737fa) because that line is still
 * present in the extract phase of buildGraph. The DROP wipes the seeded
 * ingest_triples row.
 *
 * Once PR2 lands, buildGraph's extract phase materializes via atomic applyOps
 * batches per note — no table-level DROP — and this test passes because the
 * ingest_triples row is never touched by the extract origin scope.
 */

import "../pr2-harness";
import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { setupSchema, makeEnv } from "../pr2-harness";

describe("PR2 parity: buildGraph is non-destructive", () => {
  test("ingest_triples edge survives a buildGraph extract call on empty R2", async () => {
    const { buildGraph } = await import("../../src/index");

    const db = new BunDatabase(":memory:");
    setupSchema(db);

    // Seed a marker edge from a different origin. buildGraph's extract phase
    // MUST NOT touch any origin other than 'extract' / 'finalize' /
    // 'phantom_rewrite'. ingest_triples is written by /api/ingest-triples and
    // MUST be preserved.
    db.exec(`
      INSERT INTO vault_nodes (path, title, folder, tags, modified_at)
        VALUES ('Notes/A', 'A', 'Notes', '[]', '2026-04-24T00:00:00.000Z');
      INSERT INTO vault_edges (source, target, edge_type, weight, ingest_run_id, origin)
        VALUES ('Notes/A', 'Entity/Marker', 'related', 2.5, NULL, 'ingest_triples');
    `);

    const env = makeEnv(db, []);

    // Empty R2 → extract phase has no notes to process. The only observable
    // effect on vault_edges should be: nothing (no DROP, no INSERT, no DELETE).
    await buildGraph(env, "extract");

    const edges = db
      .query("SELECT source, target, edge_type, weight, origin FROM vault_edges WHERE origin = 'ingest_triples'")
      .all() as Array<{ source: string; target: string; edge_type: string; weight: number; origin: string }>;

    expect(edges).toEqual([
      {
        source: "Notes/A",
        target: "Entity/Marker",
        edge_type: "related",
        weight: 2.5,
        origin: "ingest_triples",
      },
    ]);
  });

  test("vault_edges table itself is not recreated (AUTOINCREMENT sequence continuity)", async () => {
    const { buildGraph } = await import("../../src/index");

    const db = new BunDatabase(":memory:");
    setupSchema(db);

    // Insert, delete, re-insert — primes sqlite_sequence for vault_edges.
    db.exec(`
      INSERT INTO vault_edges (source, target, edge_type, origin)
        VALUES ('A', 'B', 'wikilink', 'extract');
      DELETE FROM vault_edges WHERE source = 'A';
    `);

    const before = db
      .query("SELECT seq FROM sqlite_sequence WHERE name = 'vault_edges'")
      .get() as { seq: number } | null;
    expect(before?.seq).toBe(1); // AUTOINCREMENT counter advanced

    const env = makeEnv(db, []);
    await buildGraph(env, "extract");

    // If buildGraph dropped+recreated vault_edges, sqlite_sequence row is gone
    // or reset to 0. If it's non-destructive, sqlite_sequence still reads 1.
    const after = db
      .query("SELECT seq FROM sqlite_sequence WHERE name = 'vault_edges'")
      .get() as { seq: number } | null;
    expect(after).not.toBeNull();
    expect(after!.seq).toBeGreaterThanOrEqual(1);
  });
});
