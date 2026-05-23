/**
 * classify_drift.test.ts
 *
 * L2 PR1.5 — pure-helper unit tests for classifyDrift(reportA, reportB).
 *
 * Plan: docs/plans/2026-04-26-003-fix-l2-verifier-snapshot-reads-eliminate-race-plan.md (r9) §Phase 1.
 * Acceptance contract:
 *   - confirmed_drift = A ∩ B (rows present in BOTH responses) — escalates as 409
 *   - transient_drift = A △ B (rows present in only ONE response) — does NOT escalate
 *   - Set membership uses CANONICAL STRING KEYS, not object identity
 *   - Output deterministically sorted by canonical key
 *
 * Pre-write per supervisor TDD-strict discipline.
 */

import { describe, expect, test } from "bun:test";

// Dynamic import per harness pattern. RED until L2-PR1.5 ships src/l2/classify-drift.ts.
const { classifyDrift } = await import("../../src/l2/classify-drift");

type DriftEdge = { source: string; target: string; edge_type: string; origin: string };
type DriftBuckets = {
  missing_in_cache: DriftEdge[];
  extra_in_cache: DriftEdge[];
  missing_nodes: Array<{ path: string }>;
  extra_nodes: Array<{ path: string }>;
};

type DriftReport =
  | { ok: true; window: { since_id: number; max_id: number }; checked_edges: number; checked_nodes: number }
  | { ok: false; window: { since_id: number; max_id: number }; drift: DriftBuckets };

// Test helpers
function emptyBuckets(): DriftBuckets {
  return { missing_in_cache: [], extra_in_cache: [], missing_nodes: [], extra_nodes: [] };
}

function okReport(maxId = 10): DriftReport {
  return { ok: true, window: { since_id: 0, max_id: maxId }, checked_edges: 0, checked_nodes: 0 };
}

function driftReport(bucketsOverride: Partial<DriftBuckets>, maxId = 10): DriftReport {
  return {
    ok: false,
    window: { since_id: 0, max_id: maxId },
    drift: { ...emptyBuckets(), ...bucketsOverride },
  };
}

function edge(source: string, target: string, edge_type = "wikilink", origin = "extract"): DriftEdge {
  return { source, target, edge_type, origin };
}

describe("L2 PR1.5 — classifyDrift partitioning (basic)", () => {
  test("(empty, empty) → both buckets empty, transient_race_detected false", () => {
    const result = classifyDrift(okReport(), okReport());
    expect(result.confirmed_drift).toEqual(emptyBuckets());
    expect(result.transient_drift).toEqual(emptyBuckets());
    expect(result.transient_race_detected).toBe(false);
  });

  test("(ok=true, ok=true) → no drift either way", () => {
    const result = classifyDrift(okReport(), okReport());
    expect(result.confirmed_drift).toEqual(emptyBuckets());
    expect(result.transient_drift).toEqual(emptyBuckets());
  });

  test("identical drift in both → all in confirmed_drift", () => {
    const r = driftReport({ extra_in_cache: [edge("a.md", "b.md")] });
    const result = classifyDrift(r, r);
    expect(result.confirmed_drift.extra_in_cache).toEqual([
      expect.objectContaining({ source: "a.md", target: "b.md" }),
    ]);
    expect(result.transient_drift.extra_in_cache).toEqual([]);
  });

  test("disjoint drift sets → all in transient_drift", () => {
    const a = driftReport({ extra_in_cache: [edge("x.md", "y.md")] });
    const b = driftReport({ extra_in_cache: [edge("p.md", "q.md")] });
    const result = classifyDrift(a, b);
    expect(result.confirmed_drift.extra_in_cache).toEqual([]);
    expect(result.transient_drift.extra_in_cache.length).toBe(2);
    expect(result.transient_race_detected).toBe(true);
  });

  test("partial overlap → intersection in confirmed, symmetric diff in transient", () => {
    const a = driftReport({ extra_in_cache: [edge("a", "b"), edge("c", "d")] });
    const b = driftReport({ extra_in_cache: [edge("c", "d"), edge("e", "f")] });
    const result = classifyDrift(a, b);
    expect(result.confirmed_drift.extra_in_cache).toEqual([
      expect.objectContaining({ source: "c", target: "d" }),
    ]);
    // Symmetric diff: a's {a,b} (missing in B) + b's {e,f} (missing in A)
    const transientPairs = result.transient_drift.extra_in_cache.map((e) => `${e.source}|${e.target}`);
    expect(transientPairs.sort()).toEqual(["a|b", "e|f"]);
  });

  test("(ok=false, ok=true) → all of A's drift goes to transient (B saw nothing)", () => {
    const a = driftReport({ extra_in_cache: [edge("x", "y")], missing_nodes: [{ path: "z.md" }] });
    const result = classifyDrift(a, okReport());
    expect(result.confirmed_drift).toEqual(emptyBuckets());
    expect(result.transient_drift.extra_in_cache.length).toBe(1);
    expect(result.transient_drift.missing_nodes).toEqual([{ path: "z.md" }]);
    expect(result.transient_race_detected).toBe(true);
  });

  test("asymmetric: A has missing_in_cache, B has extra_in_cache → all transient (different buckets)", () => {
    const a = driftReport({ missing_in_cache: [edge("a", "b")] });
    const b = driftReport({ extra_in_cache: [edge("a", "b")] });
    const result = classifyDrift(a, b);
    // Same logical edge, different bucket → DIFFERENT canonical keys (bucket prefix) → transient
    expect(result.confirmed_drift.missing_in_cache).toEqual([]);
    expect(result.confirmed_drift.extra_in_cache).toEqual([]);
    expect(result.transient_drift.missing_in_cache.length).toBe(1);
    expect(result.transient_drift.extra_in_cache.length).toBe(1);
  });
});

describe("L2 PR1.5 — classifyDrift canonical-key derivation (codex r3 BLOCKER #1)", () => {
  test("same set, different row order → all confirmed (set-based, not order-based)", () => {
    const a = driftReport({ extra_in_cache: [edge("a", "b"), edge("c", "d")] });
    const b = driftReport({ extra_in_cache: [edge("c", "d"), edge("a", "b")] });
    const result = classifyDrift(a, b);
    expect(result.confirmed_drift.extra_in_cache.length).toBe(2);
    expect(result.transient_drift.extra_in_cache.length).toBe(0);
  });

  test("same values, fresh object instances → confirmed (key-based, not identity-based)", () => {
    // Without canonical-key derivation, naive Set<object> would treat these as 4 distinct
    // members and report all 4 as transient. Canonical keys make them 2 unique entries.
    const a = driftReport({
      extra_in_cache: [{ source: "a.md", target: "b.md", edge_type: "wikilink", origin: "extract" }],
    });
    const b = driftReport({
      extra_in_cache: [{ source: "a.md", target: "b.md", edge_type: "wikilink", origin: "extract" }],
    });
    const result = classifyDrift(a, b);
    expect(result.confirmed_drift.extra_in_cache.length).toBe(1);
    expect(result.transient_drift.extra_in_cache.length).toBe(0);
  });

  test("output deterministically ordered by canonical key", () => {
    const a = driftReport({
      extra_in_cache: [edge("z", "y"), edge("a", "b"), edge("m", "n")],
    });
    const result1 = classifyDrift(a, a);
    const result2 = classifyDrift(a, a);
    // Two calls with same input → byte-identical output (sorted)
    expect(JSON.stringify(result1)).toEqual(JSON.stringify(result2));
    // And the order is stable — first edge by canonical key is "extract|a|b|wikilink"
    expect(result1.confirmed_drift.extra_in_cache[0]).toEqual(
      expect.objectContaining({ source: "a", target: "b" }),
    );
  });

  test("nodes use canonical key on path", () => {
    const a = driftReport({ missing_nodes: [{ path: "x.md" }, { path: "a.md" }] });
    const b = driftReport({ missing_nodes: [{ path: "a.md" }, { path: "x.md" }] });
    const result = classifyDrift(a, b);
    expect(result.confirmed_drift.missing_nodes.length).toBe(2);
    expect(result.transient_drift.missing_nodes.length).toBe(0);
    // Sorted output
    expect(result.confirmed_drift.missing_nodes[0].path).toBe("a.md");
    expect(result.confirmed_drift.missing_nodes[1].path).toBe("x.md");
  });
});

describe("L2 PR1.5 — classifyDrift response-shape contract", () => {
  test("returns structure with both buckets always present", () => {
    const result = classifyDrift(okReport(), okReport());
    expect(result).toHaveProperty("confirmed_drift");
    expect(result).toHaveProperty("transient_drift");
    expect(result.confirmed_drift).toHaveProperty("missing_in_cache");
    expect(result.confirmed_drift).toHaveProperty("extra_in_cache");
    expect(result.confirmed_drift).toHaveProperty("missing_nodes");
    expect(result.confirmed_drift).toHaveProperty("extra_nodes");
  });

  test("transient_race_detected is true iff transient_drift is non-empty", () => {
    const empty = classifyDrift(okReport(), okReport());
    expect(empty.transient_race_detected).toBe(false);

    const withTransient = classifyDrift(
      driftReport({ extra_in_cache: [edge("x", "y")] }),
      okReport(),
    );
    expect(withTransient.transient_race_detected).toBe(true);

    const allConfirmed = classifyDrift(
      driftReport({ extra_in_cache: [edge("x", "y")] }),
      driftReport({ extra_in_cache: [edge("x", "y")] }),
    );
    expect(allConfirmed.transient_race_detected).toBe(false);
  });
});
