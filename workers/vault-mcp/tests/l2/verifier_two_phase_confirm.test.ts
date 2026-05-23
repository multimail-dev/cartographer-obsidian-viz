/**
 * verifier_two_phase_confirm.test.ts
 *
 * L2 PR1.5 — orchestration tests for two-phase verifier confirmation.
 *
 * Plan: docs/plans/2026-04-26-003-fix-l2-verifier-snapshot-reads-eliminate-race-plan.md (r9) §Phase 1.
 *
 * Tests `runVerifierTwoPhase(verifyFn)` — the pure orchestration function that the
 * route handler delegates to. Dependency injection keeps the test independent of
 * D1 + HTTP plumbing.
 *
 * Behaviors under test:
 *   - First call ok=true → second call NOT made (call count = 1), returns ok response
 *   - First call drift, second call ok=true → 200 status, empty confirmed_drift, populated transient_drift
 *   - First and second call same drift → 409 status, confirmed_drift = drift, transient empty
 *   - First and second call partial overlap → 409 status, intersection in confirmed, sym-diff in transient
 *   - First call drift, second call THROWS → 200 status, empty confirmed_drift, second_call_error diagnostic
 *   - First call THROWS → 500 status (second call NOT attempted; "both throw" not reachable)
 *
 * Pre-write per supervisor TDD-strict discipline.
 */

import { describe, expect, test } from "bun:test";

const { runVerifierTwoPhase } = await import("../../src/l2/two-phase-verifier");

type DriftEdge = { source: string; target: string; edge_type: string; origin: string };
type DriftBuckets = {
  missing_in_cache: DriftEdge[];
  extra_in_cache: DriftEdge[];
  missing_nodes: Array<{ path: string }>;
  extra_nodes: Array<{ path: string }>;
};

function emptyBuckets(): DriftBuckets {
  return { missing_in_cache: [], extra_in_cache: [], missing_nodes: [], extra_nodes: [] };
}

function okReport(maxId = 5) {
  return {
    ok: true as const,
    window: { since_id: 0, max_id: maxId },
    checked_edges: 0,
    checked_nodes: 0,
  };
}

function driftReport(buckets: Partial<DriftBuckets>, maxId = 5) {
  return {
    ok: false as const,
    window: { since_id: 0, max_id: maxId },
    drift: { ...emptyBuckets(), ...buckets },
  };
}

function edge(source: string, target: string): DriftEdge {
  return { source, target, edge_type: "wikilink", origin: "extract" };
}

function makeMockVerifier(responses: Array<any | (() => Promise<any>)>) {
  let i = 0;
  const calls: number[] = [];
  const fn = async (_db: any) => {
    calls.push(i);
    const r = responses[i++];
    if (typeof r === "function") return r();
    return r;
  };
  return { fn, calls };
}

describe("L2 PR1.5 — runVerifierTwoPhase: happy path", () => {
  test("first call ok=true → only ONE verifier call, status 200", async () => {
    const { fn, calls } = makeMockVerifier([okReport()]);
    const result = await runVerifierTwoPhase({} as any, fn);
    expect(result.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(result.body.ok).toBe(true);
  });
});

describe("L2 PR1.5 — runVerifierTwoPhase: confirmation cases", () => {
  test("first drift + second ok=true → 200, empty confirmed_drift, populated transient_drift", async () => {
    const { fn, calls } = makeMockVerifier([
      driftReport({ extra_in_cache: [edge("x", "y")] }),
      okReport(),
    ]);
    const result = await runVerifierTwoPhase({} as any, fn);
    expect(calls.length).toBe(2);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(false);
    expect(result.body.confirmed_drift.extra_in_cache).toEqual([]);
    expect(result.body.transient_drift.extra_in_cache.length).toBe(1);
    expect(result.body.transient_race_detected).toBe(true);
  });

  test("identical drift on both → 409 with confirmed populated, transient empty", async () => {
    const drift = driftReport({ extra_in_cache: [edge("x", "y")] });
    const { fn, calls } = makeMockVerifier([drift, drift]);
    const result = await runVerifierTwoPhase({} as any, fn);
    expect(calls.length).toBe(2);
    expect(result.status).toBe(409);
    expect(result.body.confirmed_drift.extra_in_cache.length).toBe(1);
    expect(result.body.transient_drift.extra_in_cache).toEqual([]);
    expect(result.body.transient_race_detected).toBe(false);
  });

  test("partial overlap → 409 with intersection in confirmed, sym-diff in transient", async () => {
    const { fn } = makeMockVerifier([
      driftReport({ extra_in_cache: [edge("a", "b"), edge("c", "d")] }),
      driftReport({ extra_in_cache: [edge("c", "d"), edge("e", "f")] }),
    ]);
    const result = await runVerifierTwoPhase({} as any, fn);
    expect(result.status).toBe(409);
    expect(result.body.confirmed_drift.extra_in_cache.length).toBe(1);
    expect(result.body.confirmed_drift.extra_in_cache[0]).toEqual(
      expect.objectContaining({ source: "c", target: "d" }),
    );
    expect(result.body.transient_drift.extra_in_cache.length).toBe(2);
    expect(result.body.transient_race_detected).toBe(true);
  });
});

describe("L2 PR1.5 — runVerifierTwoPhase: failure cases", () => {
  test("first call THROWS → status 500, second call NOT attempted", async () => {
    const { fn, calls } = makeMockVerifier([
      () => Promise.reject(new Error("D1 catastrophic")),
    ]);
    const result = await runVerifierTwoPhase({} as any, fn);
    expect(calls.length).toBe(1);
    expect(result.status).toBe(500);
    expect(result.body.error).toContain("D1 catastrophic");
  });

  test("first drift + second THROWS → 200 with empty confirmed_drift + second_call_error", async () => {
    const { fn, calls } = makeMockVerifier([
      driftReport({ extra_in_cache: [edge("x", "y")] }),
      () => Promise.reject(new Error("D1 timeout under load")),
    ]);
    const result = await runVerifierTwoPhase({} as any, fn);
    expect(calls.length).toBe(2);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(false);
    expect(result.body.confirmed_drift.extra_in_cache).toEqual([]);
    expect(result.body.second_call_error).toContain("D1 timeout");
  });
});

describe("L2 PR1.5 — runVerifierTwoPhase: response shape contract", () => {
  test("ok response has window/checked_edges/checked_nodes; no drift fields", async () => {
    const { fn } = makeMockVerifier([okReport(42)]);
    const result = await runVerifierTwoPhase({} as any, fn);
    expect(result.body.ok).toBe(true);
    expect(result.body.window.max_id).toBe(42);
    expect(result.body).not.toHaveProperty("confirmed_drift");
    expect(result.body).not.toHaveProperty("transient_drift");
  });

  test("drift response always has both confirmed_drift and transient_drift buckets", async () => {
    const { fn } = makeMockVerifier([
      driftReport({ extra_in_cache: [edge("x", "y")] }),
      driftReport({ extra_in_cache: [edge("x", "y")] }),
    ]);
    const result = await runVerifierTwoPhase({} as any, fn);
    expect(result.body).toHaveProperty("confirmed_drift");
    expect(result.body).toHaveProperty("transient_drift");
    expect(result.body.confirmed_drift).toHaveProperty("missing_in_cache");
    expect(result.body.confirmed_drift).toHaveProperty("extra_in_cache");
    expect(result.body.confirmed_drift).toHaveProperty("missing_nodes");
    expect(result.body.confirmed_drift).toHaveProperty("extra_nodes");
  });
});
