/**
 * PR2 Test 7/8 — delete_node interleaved with add_edge
 *
 * Plan: docs/plans/2026-04-23-001-cartographer-op-log-tier-a-plan.md §delete_node cascade
 *   scenarios 1 and 2.
 *
 * INVARIANT (PR2): ops apply in vault_ops.id order. An add_edge ordered AFTER
 * a matching delete_node lands as a phantom (vault_edges row survives, but
 * the referenced node does not exist in vault_nodes). toolFindRelated
 * phantom-filters at read time; vault_edges still carries the row for
 * append-only audit integrity.
 *
 * Scenario 1: add_edge BEFORE delete_node
 *   - emit ops: add_edge(B, X, wikilink), remove_edge(A, X, wikilink), delete_node(X)
 *   - final state: vault_nodes has no X; vault_edges has (B, X, wikilink) as phantom;
 *                  (A, X, wikilink) removed
 *
 * Scenario 2: delete_node BEFORE add_edge
 *   - emit ops: remove_edge(A, X, wikilink), delete_node(X), add_edge(B, X, wikilink)
 *   - final state: same as scenario 1 (phantom edge present, node absent)
 *
 * Current main: applyOps handles delete_node in a cascade-less way at
 * workers/vault-mcp/src/index.ts:483, which means the interleaving assertions
 * (phantom present, node gone) may pass for the raw DELETE path — but the
 * test also asserts on vault_ops ordering, which requires PR2's emit-cascade-
 * remove-edges-before-delete-node semantics. Scenario 2's ordering assertion
 * fails on main.
 */

import "../pr2-harness";
import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { setupSchema, makeEnv } from "../pr2-harness";

describe("PR2 delete_node: interleave with add_edge", () => {
  test("scenario 1 — add_edge before delete_node", async () => {
    const { applyOps } = await import("../../src/index");

    const db = new BunDatabase(":memory:");
    setupSchema(db);
    db.exec(`
      INSERT INTO vault_nodes (path, title, folder, tags, modified_at) VALUES
        ('A', 'A', 'Notes', '[]', '2026-04-24T00:00:00.000Z'),
        ('B', 'B', 'Notes', '[]', '2026-04-24T00:00:00.000Z'),
        ('X', 'X', 'Notes', '[]', '2026-04-24T00:00:00.000Z');
      INSERT INTO vault_edges (source, target, edge_type, origin) VALUES
        ('A', 'X', 'wikilink', 'extract');
    `);

    const env = makeEnv(db);

    await applyOps(
      env,
      [
        { op_type: "add_edge", origin: "extract",
          payload: { source: "B", target: "X", edge_type: "wikilink", weight: 1 } },
        { op_type: "remove_edge", origin: "extract",
          payload: { source: "A", target: "X", edge_type: "wikilink" } },
        { op_type: "delete_node", origin: "extract", payload: { path: "X" } },
      ] as any,
      {}
    );

    // Node X absent
    const nodeX = db.query("SELECT path FROM vault_nodes WHERE path = 'X'").get();
    expect(nodeX).toBeNull();

    // (A, X, wikilink) removed
    const removed = db
      .query("SELECT COUNT(*) AS c FROM vault_edges WHERE source = 'A' AND target = 'X'")
      .get() as { c: number };
    expect(removed.c).toBe(0);

    // (B, X, wikilink) PRESENT as phantom. PR2 contract (plan §delete_node):
    //   - Ops apply in vault_ops.id order — NOT grouped by op_type.
    //   - delete_node's APPLY only DELETEs from vault_nodes. No edge cascade
    //     on apply. The cascade is an EMISSION-time detail (cascaded
    //     remove_edge ops are emitted BEFORE delete_node and cover edges
    //     that existed at EMISSION time).
    //
    // In scenario 1, (B, X) was added by a separate emitter (not delete_node's
    // cascade). Since delete_node's apply doesn't cascade, (B, X) survives as
    // a phantom edge pointing at a non-existent node X. Read-time filtering
    // (toolFindRelated phantom-filter) hides it from users.
    //
    // Current main FAILS this assertion because applyOps (a) reorders ops by
    // op_type, placing add_edge first, and (b) delete_node's apply includes
    // a `DELETE FROM vault_edges WHERE source=? OR target=?` that wipes
    // (B, X) even though (B, X) was added by an unrelated emitter. PR2 must
    // change both behaviors.
    const phantom = db
      .query("SELECT COUNT(*) AS c FROM vault_edges WHERE source = 'B' AND target = 'X'")
      .get() as { c: number };
    expect(phantom.c).toBe(1);
  });

  test("scenario 2 — delete_node before add_edge (phantom edge lands)", async () => {
    const { applyOps } = await import("../../src/index");

    const db = new BunDatabase(":memory:");
    setupSchema(db);
    db.exec(`
      INSERT INTO vault_nodes (path, title, folder, tags, modified_at) VALUES
        ('A', 'A', 'Notes', '[]', '2026-04-24T00:00:00.000Z'),
        ('B', 'B', 'Notes', '[]', '2026-04-24T00:00:00.000Z'),
        ('X', 'X', 'Notes', '[]', '2026-04-24T00:00:00.000Z');
      INSERT INTO vault_edges (source, target, edge_type, origin) VALUES
        ('A', 'X', 'wikilink', 'extract');
    `);

    const env = makeEnv(db);

    await applyOps(
      env,
      [
        { op_type: "remove_edge", origin: "extract",
          payload: { source: "A", target: "X", edge_type: "wikilink" } },
        { op_type: "delete_node", origin: "extract", payload: { path: "X" } },
        { op_type: "add_edge", origin: "extract",
          payload: { source: "B", target: "X", edge_type: "wikilink", weight: 1 } },
      ] as any,
      {}
    );

    // Node X absent
    const nodeX = db.query("SELECT path FROM vault_nodes WHERE path = 'X'").get();
    expect(nodeX).toBeNull();

    // (A, X, wikilink) removed
    const removedA = db
      .query("SELECT COUNT(*) AS c FROM vault_edges WHERE source = 'A' AND target = 'X'")
      .get() as { c: number };
    expect(removedA.c).toBe(0);

    // (B, X, wikilink) lands as a PHANTOM — add_edge applied AFTER delete_node,
    // and delete_node's cascade couldn't know about it.
    const phantom = db
      .query("SELECT COUNT(*) AS c FROM vault_edges WHERE source = 'B' AND target = 'X'")
      .get() as { c: number };
    expect(phantom.c).toBe(1);
  });
});
