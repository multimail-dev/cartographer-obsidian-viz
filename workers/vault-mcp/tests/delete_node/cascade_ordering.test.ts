/**
 * PR2 Test 6/8 — delete_node cascade ordering
 *
 * Plan: docs/plans/2026-04-23-001-cartographer-op-log-tier-a-plan.md §delete_node cascade
 *
 * INVARIANT (PR2): when a node is deleted, the emission order within the
 * batch is:
 *   1. Cascaded `remove_edge` ops for every edge with source=path OR target=path
 *   2. Then the `delete_node` op
 *
 * Replay must process ops in vault_ops.id order. The test asserts that every
 * remove_edge cascade op has a STRICTLY LOWER id than the delete_node op in
 * the same emitting batch.
 *
 * Current main: applyOps (added in PR1) supports delete_node at
 * workers/vault-mcp/src/index.ts:483 with a single DELETE FROM vault_edges
 * WHERE source=? OR target=? — but it does NOT emit cascaded remove_edge ops
 * before the delete_node op. The test fails because no remove_edge ops are
 * found preceding the delete_node op in vault_ops.
 */

import "../pr2-harness";
import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { setupSchema, makeEnv } from "../pr2-harness";

describe("PR2 delete_node: cascade ordering", () => {
  test("remove_edge ops emitted before delete_node op in vault_ops.id order", async () => {
    const { applyOps } = await import("../../src/index");

    const db = new BunDatabase(":memory:");
    setupSchema(db);
    db.exec(`
      INSERT INTO vault_nodes (path, title, folder, tags, modified_at) VALUES
        ('Notes/A', 'A', 'Notes', '[]', '2026-04-24T00:00:00.000Z'),
        ('Notes/B', 'B', 'Notes', '[]', '2026-04-24T00:00:00.000Z'),
        ('Notes/X', 'X', 'Notes', '[]', '2026-04-24T00:00:00.000Z');
      INSERT INTO vault_edges (source, target, edge_type, origin) VALUES
        ('Notes/A', 'Notes/X', 'wikilink', 'extract'),
        ('Notes/X', 'Notes/B', 'wikilink', 'extract'),
        ('People/P', 'Notes/X', 'spoke_in', 'extract');
    `);

    const env = makeEnv(db);

    // A single delete_node op — PR2 must expand it into cascaded remove_edge
    // ops FOLLOWED BY the delete_node op, all within one applyOps call.
    await applyOps(
      env,
      [
        {
          op_type: "delete_node",
          origin: "extract",
          payload: { path: "Notes/X" },
        },
      ] as any,
      {}
    );

    const ops = db
      .query(
        "SELECT id, op_type, payload_json FROM vault_ops ORDER BY id"
      )
      .all() as Array<{ id: number; op_type: string; payload_json: string }>;

    const removeOps = ops.filter((o) => o.op_type === "remove_edge");
    const deleteOps = ops.filter((o) => o.op_type === "delete_node");

    expect(deleteOps.length).toBe(1);
    expect(removeOps.length).toBeGreaterThanOrEqual(3); // 3 edges touching X

    const deleteId = deleteOps[0].id;
    for (const r of removeOps) {
      expect(r.id).toBeLessThan(deleteId);
    }

    // All three edges appear in the cascaded remove_edge set
    const removedKeys = removeOps.map((r) => {
      const p = JSON.parse(r.payload_json);
      return `${p.source}|${p.target}|${p.edge_type}`;
    });
    expect(removedKeys).toContain("Notes/A|Notes/X|wikilink");
    expect(removedKeys).toContain("Notes/X|Notes/B|wikilink");
    expect(removedKeys).toContain("People/P|Notes/X|spoke_in");
  });
});
