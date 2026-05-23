/**
 * cache_coherence_clean.test.ts
 *
 * L2 PR1 — verifier returns ok=true when vault_edges is consistent with vault_ops.
 *
 * Plan: docs/plans/2026-04-26-002-cartographer-crdt-l2-audit-log-stability-plan.md (r1) §PR1.
 * Seed evaluation_principles: replay_equivalence (0.25), additive_safety (0.20).
 *
 * Pre-write per supervisor TDD-strict discipline.
 */

import "../pr2-harness";
import { describe, expect, test, beforeEach } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { d1, setupSchema } from "../pr2-harness";
const { verifyCacheCoherence } = await import("../../src/index");

describe("L2 PR1 — verifyCacheCoherence happy path", () => {
  let db: BunDatabase;
  let env: { DB: any };

  beforeEach(() => {
    db = new BunDatabase(":memory:");
    setupSchema(db);
    env = { DB: d1(db) };
  });

  test("zero ops, zero edges → ok=true with empty window", async () => {
    const report = await verifyCacheCoherence(env.DB);
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("unexpected drift");
    expect(report.checked_edges).toBe(0);
    expect(report.checked_nodes).toBe(0);
  });

  test("ops + correctly materialized cache → ok=true", async () => {
    // Production reality: every vault_nodes row is preceded by an upsert_node
    // op (applyOps writes both). Mirror that here.
    db.run(`INSERT INTO vault_ops (op_type, payload_json, origin) VALUES
      ('upsert_node', '{"path":"a.md","title":"A"}', 'extract'),
      ('upsert_node', '{"path":"b.md","title":"B"}', 'extract'),
      ('upsert_node', '{"path":"c.md","title":"C"}', 'extract'),
      ('add_edge', '{"source":"a.md","target":"b.md","edge_type":"wikilink","origin":"extract"}', 'extract'),
      ('add_edge', '{"source":"b.md","target":"c.md","edge_type":"wikilink","origin":"extract"}', 'extract')
    `);
    db.run(`INSERT INTO vault_nodes (path, title, tags) VALUES
      ('a.md','A','[]'),
      ('b.md','B','[]'),
      ('c.md','C','[]')
    `);
    db.run(`INSERT INTO vault_edges (source, target, edge_type, origin) VALUES
      ('a.md','b.md','wikilink','extract'),
      ('b.md','c.md','wikilink','extract')
    `);

    const report = await verifyCacheCoherence(env.DB);
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("unexpected drift");
    expect(report.checked_edges).toBe(2);
    expect(report.checked_nodes).toBe(3);
    expect(report.window.max_id).toBe(5);
  });

  test("upsert/remove pair leaves zero net state, no drift", async () => {
    db.run(`INSERT INTO vault_ops (op_type, payload_json, origin) VALUES
      ('upsert_node', '{"path":"x.md","title":"X"}', 'extract'),
      ('delete_node', '{"path":"x.md"}', 'extract')
    `);
    // vault_nodes correctly has nothing for x.md.
    const report = await verifyCacheCoherence(env.DB);
    expect(report.ok).toBe(true);
  });
});
