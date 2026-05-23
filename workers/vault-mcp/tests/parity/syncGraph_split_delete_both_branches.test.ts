/**
 * PR2 Test 3/8 — syncGraph split-DELETE executes both branches
 *
 * Plan: docs/plans/2026-04-23-001-cartographer-op-log-tier-a-plan.md §syncGraph redesign
 *   (r6 round-5 non-blocking #D: split DELETE into two statements so SQLite's
 *    planner picks one index per query; OR on two different columns degenerates
 *    to a scan.)
 *
 * INVARIANT (PR2): syncGraph emits TWO DELETE statements per synced path —
 *   branch 1: DELETE WHERE origin='extract' AND source=?1 AND edge_type != 'spoke_in'
 *   branch 2: DELETE WHERE origin='extract' AND target=?1 AND edge_type  = 'spoke_in'
 *
 * Both branches must execute on every sync. This test seeds vault_edges with
 * both an extract source-side edge AND an extract target-side spoke_in edge
 * and asserts both are removed after syncGraph runs.
 *
 * Currently (main @ 49737fa), workers/vault-mcp/src/index.ts:1953 runs a
 * single `DELETE FROM vault_edges WHERE source = ?`. That deletes the source-
 * side edge but LEAVES the target-side spoke_in edge intact (because its
 * source is a different path). This test fails against main on the spoke_in
 * assertion.
 */

import "../pr2-harness";
import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { setupSchema, makeEnv } from "../pr2-harness";

describe("PR2 parity: syncGraph split-DELETE", () => {
  test("both source-branch and target-branch spoke_in DELETEs fire", async () => {
    const worker = (await import("../../src/index")).default;

    const db = new BunDatabase(":memory:");
    setupSchema(db);

    // Seed:
    //   (A, B, wikilink, extract)  ← source-side extract, non-spoke_in → branch 1 removes
    //   (C, A, spoke_in, extract)  ← target-side extract, spoke_in      → branch 2 removes
    //   (A, D, related, ingest_triples) ← different origin → survives
    db.exec(`
      INSERT INTO vault_nodes (path, title, folder, tags, modified_at)
        VALUES ('Notes/A', 'A', 'Notes', '[]', '2026-04-24T00:00:00.000Z');
      INSERT INTO vault_edges (source, target, edge_type, weight, origin) VALUES
        ('Notes/A', 'Notes/B', 'wikilink', 1.0, 'extract'),
        ('People/C', 'Notes/A', 'spoke_in', 1.0, 'extract'),
        ('Notes/A', 'Entity/D', 'related', 1.0, 'ingest_triples');
    `);

    const env = makeEnv(db, [
      { key: "Notes/A.md", body: "# A\n\nNo outbound links.\n" },
    ]);

    const req = new Request("http://x/api/sync-graph?force=true", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" },
    });
    await worker.fetch(req, env);

    // Branch 1 assertion: source-side extract non-spoke_in edge removed
    const branch1Remaining = db
      .query(
        "SELECT COUNT(*) AS c FROM vault_edges WHERE origin = 'extract' AND source = 'Notes/A' AND target = 'Notes/B' AND edge_type = 'wikilink'"
      )
      .get() as { c: number };
    expect(branch1Remaining.c).toBe(0);

    // Branch 2 assertion: target-side extract spoke_in edge removed
    const branch2Remaining = db
      .query(
        "SELECT COUNT(*) AS c FROM vault_edges WHERE origin = 'extract' AND source = 'People/C' AND target = 'Notes/A' AND edge_type = 'spoke_in'"
      )
      .get() as { c: number };
    expect(branch2Remaining.c).toBe(0);

    // Different-origin edge survives
    const differentOrigin = db
      .query(
        "SELECT COUNT(*) AS c FROM vault_edges WHERE origin = 'ingest_triples' AND source = 'Notes/A' AND target = 'Entity/D'"
      )
      .get() as { c: number };
    expect(differentOrigin.c).toBe(1);

    // Provenance: both remove_edge ops present in vault_ops under origin=extract
    const removeOps = db
      .query(
        "SELECT payload_json FROM vault_ops WHERE op_type = 'remove_edge' AND origin = 'extract' ORDER BY id"
      )
      .all() as Array<{ payload_json: string }>;
    const removedKeys = removeOps.map((r) => {
      const p = JSON.parse(r.payload_json);
      return `${p.source}|${p.target}|${p.edge_type}`;
    });
    expect(removedKeys).toContain("Notes/A|Notes/B|wikilink");
    expect(removedKeys).toContain("People/C|Notes/A|spoke_in");
  });
});
