/**
 * cache_coherence_drift.test.ts
 *
 * L2 PR1 — cache-coherence verifier detects drift between vault_ops (truth)
 * and vault_edges (materialized cache).
 *
 * Plan: docs/plans/2026-04-26-002-cartographer-crdt-l2-audit-log-stability-plan.md (r1) §PR1.
 * Seed AC#3, AC#4 (additive: doctored vault_edges, expected drift report).
 *
 * Pre-write per supervisor TDD-strict discipline (seed evaluation_principles
 * tdd_discipline weight 0.10). The implementing agent makes this pass without
 * modifying this file.
 *
 * Verifier contract (locked in plan §PR1 "Verifier contract"):
 *   verifyCacheCoherence(db: D1Database): Promise<DriftReport>
 *   DriftReport = { ok: true, window, checked_edges, checked_nodes }
 *              | { ok: false, window, drift: { missing_in_cache, extra_in_cache, missing_nodes, extra_nodes } }
 */

import "../pr2-harness";
import { describe, expect, test, beforeEach } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { d1, setupSchema } from "../pr2-harness";

// Dynamic import after harness mocks are in place. RED until L2-5 lands the
// implementation. The implementation MUST export `verifyCacheCoherence` from
// src/index.ts (or from a new src/l2/verifier.ts re-exported via index.ts).
const { verifyCacheCoherence } = await import("../../src/index");

type DriftEdge = { source: string; target: string; edge_type: string; origin: string };
type DriftReport =
  | { ok: true; window: { since_id: number; max_id: number }; checked_edges: number; checked_nodes: number }
  | {
      ok: false;
      window: { since_id: number; max_id: number };
      drift: {
        missing_in_cache: DriftEdge[];
        extra_in_cache: DriftEdge[];
        missing_nodes: Array<{ path: string }>;
        extra_nodes: Array<{ path: string }>;
      };
    };

function seedThreeOps(db: BunDatabase): void {
  // Three ops at ids 1, 2, 3:
  //   1: add_edge A→B
  //   2: add_edge B→C
  //   3: remove_edge A→B
  // Net materialized: only B→C should be in vault_edges.
  db.run(`INSERT INTO vault_ops (op_type, payload_json, origin) VALUES
    ('add_edge',    '{"source":"a.md","target":"b.md","edge_type":"wikilink","origin":"extract"}', 'extract'),
    ('add_edge',    '{"source":"b.md","target":"c.md","edge_type":"wikilink","origin":"extract"}', 'extract'),
    ('remove_edge', '{"source":"a.md","target":"b.md","edge_type":"wikilink","origin":"extract"}', 'extract')
  `);
  db.run(`INSERT INTO vault_nodes (path, title, tags) VALUES
    ('a.md','A','[]'),
    ('b.md','B','[]'),
    ('c.md','C','[]')
  `);
}

describe("L2 PR1 — verifyCacheCoherence detects drift", () => {
  let db: BunDatabase;
  let env: { DB: any };

  beforeEach(() => {
    db = new BunDatabase(":memory:");
    setupSchema(db);
    env = { DB: d1(db) };
  });

  test("doctored extra_in_cache row is reported", async () => {
    seedThreeOps(db);
    // Materialize correctly per ops (only B→C survives the remove_edge)…
    db.run(`INSERT INTO vault_edges (source, target, edge_type, origin) VALUES
      ('b.md','c.md','wikilink','extract')`);
    // …then doctor a phantom row that no op ever created.
    db.run(`INSERT INTO vault_edges (source, target, edge_type, origin) VALUES
      ('x.md','y.md','wikilink','extract')`);

    const report = (await verifyCacheCoherence(env.DB)) as DriftReport;
    expect(report.ok).toBe(false);
    if (report.ok) throw new Error("expected drift");
    expect(report.window.max_id).toBe(3);
    expect(report.drift.extra_in_cache).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "x.md", target: "y.md", edge_type: "wikilink", origin: "extract" }),
      ]),
    );
    expect(report.drift.missing_in_cache).toEqual([]);
  });

  test("missing_in_cache: ops say B→C exists but cache lacks it", async () => {
    seedThreeOps(db);
    // Skip materializing B→C — drift in the other direction.
    const report = (await verifyCacheCoherence(env.DB)) as DriftReport;
    expect(report.ok).toBe(false);
    if (report.ok) throw new Error("expected drift");
    expect(report.drift.missing_in_cache).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "b.md", target: "c.md", edge_type: "wikilink", origin: "extract" }),
      ]),
    );
  });

  test("missing_nodes: ops upserted a node but vault_nodes lacks it", async () => {
    db.run(`INSERT INTO vault_ops (op_type, payload_json, origin) VALUES
      ('upsert_node', '{"path":"orphan.md","title":"Orphan"}', 'extract')`);
    // Don't insert into vault_nodes.

    const report = (await verifyCacheCoherence(env.DB)) as DriftReport;
    expect(report.ok).toBe(false);
    if (report.ok) throw new Error("expected drift");
    expect(report.drift.missing_nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "orphan.md" })]),
    );
  });

  test("delete_node op makes a present node count as extra_nodes", async () => {
    db.run(`INSERT INTO vault_nodes (path, title, tags) VALUES ('zombie.md', 'Z', '[]')`);
    db.run(`INSERT INTO vault_ops (op_type, payload_json, origin) VALUES
      ('upsert_node', '{"path":"zombie.md","title":"Z"}', 'extract'),
      ('delete_node', '{"path":"zombie.md"}', 'extract')`);

    const report = (await verifyCacheCoherence(env.DB)) as DriftReport;
    expect(report.ok).toBe(false);
    if (report.ok) throw new Error("expected drift");
    expect(report.drift.extra_nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "zombie.md" })]),
    );
  });
});
