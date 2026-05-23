/**
 * cache_coherence_synthetic_marker_excluded.test.ts
 *
 * L2 PR1 — verifier excludes synthetic marker rows from drift report.
 *
 * Synthetic markers (__last_degree_drain__, __last_sync__) live in vault_nodes
 * for cursor/state purposes — they have no corresponding vault_ops entry, but
 * that is by design and must NOT be reported as drift.
 *
 * Plan: docs/plans/2026-04-26-002-cartographer-crdt-l2-audit-log-stability-plan.md (r1) §PR1.
 *
 * Pre-write per supervisor TDD-strict discipline.
 */

import "../pr2-harness";
import { describe, expect, test, beforeEach } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { d1, setupSchema } from "../pr2-harness";
const { verifyCacheCoherence } = await import("../../src/index");

describe("L2 PR1 — verifyCacheCoherence synthetic marker exclusion", () => {
  let db: BunDatabase;
  let env: { DB: any };

  beforeEach(() => {
    db = new BunDatabase(":memory:");
    setupSchema(db);
    env = { DB: d1(db) };
  });

  test("synthetic marker rows are excluded from extra_nodes", async () => {
    db.run(`INSERT INTO vault_nodes (path, title, tags) VALUES
      ('__last_degree_drain__','degree_drain','[]'),
      ('__last_sync__','sync_marker','[]')
    `);
    // No vault_ops at all. Without exclusion, the markers would be reported as extra_nodes.
    const report = await verifyCacheCoherence(env.DB);
    expect(report.ok).toBe(true);
  });

  test("real node + marker → only real node behavior matters", async () => {
    db.run(`INSERT INTO vault_ops (op_type, payload_json, origin) VALUES
      ('upsert_node', '{"path":"a.md","title":"A"}', 'extract')
    `);
    db.run(`INSERT INTO vault_nodes (path, title, tags) VALUES
      ('a.md','A','[]'),
      ('__last_degree_drain__','degree_drain','[]')
    `);
    const report = await verifyCacheCoherence(env.DB);
    expect(report.ok).toBe(true);
  });

  // Regression: PR #64 first-smoke caught __last_build_completed__ as
  // false-positive drift because the original VERIFIER_SYNTHETIC_PATHS
  // hard-coded only __last_degree_drain__ and __last_sync__. Switching to
  // the ^__.*__$ regex covers all current AND future synthetic markers
  // following the project convention.
  test("regression: __last_build_completed__ excluded (PR #64 first-smoke false-positive)", async () => {
    db.run(`INSERT INTO vault_nodes (path, title, tags) VALUES
      ('__last_build_completed__','build_graph','[]')
    `);
    const report = await verifyCacheCoherence(env.DB);
    expect(report.ok).toBe(true);
  });

  test("all known transient build markers excluded under ^__.*__$ pattern", async () => {
    db.run(`INSERT INTO vault_nodes (path, title, tags) VALUES
      ('__last_build_completed__','build_graph','[]'),
      ('__build_progress__','progress','[]'),
      ('__build_cursor__','cursor','[]'),
      ('__build_run_id__','run_id','[]'),
      ('__last_degree_drain__','degree_drain','[]'),
      ('__last_sync__','sync','[]')
    `);
    const report = await verifyCacheCoherence(env.DB);
    expect(report.ok).toBe(true);
  });

  test("real notes that just happen to contain underscores are NOT excluded", async () => {
    // Defensive: ensure the regex isn't overly broad. A note like
    // "my__weird__note.md" has only one set of double-underscores and a
    // file extension — the regex requires the path to BE wholly between
    // ^__ and __$, so this should be reported as drift since no upsert_node
    // op exists for it.
    db.run(`INSERT INTO vault_nodes (path, title, tags) VALUES
      ('my__weird__note.md','My Weird Note','[]')
    `);
    const report = await verifyCacheCoherence(env.DB);
    expect(report.ok).toBe(false);
    if (report.ok) throw new Error("expected drift — real notes must not be silently excluded");
    expect(report.drift.extra_nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "my__weird__note.md" })]),
    );
  });
});
