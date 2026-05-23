/**
 * two-phase-verifier.ts
 *
 * L2 PR1.5 — orchestrator for two-phase verifier confirmation.
 *
 * Plan: docs/plans/2026-04-26-003-fix-l2-verifier-snapshot-reads-eliminate-race-plan.md (r9) §Phase 1.
 *
 * Calls the verifier; if it reports drift, immediately re-calls and partitions the
 * results via classifyDrift to separate real drift from transient race noise.
 *
 * Status semantics:
 *   - First call ok=true              → 200 (single call; second not attempted)
 *   - First call drift, second ok=true → 200 with empty confirmed_drift + populated transient_drift
 *   - Both calls drift, intersection empty → 200 (transient — no overlap)
 *   - Both calls drift, intersection non-empty → 409 with confirmed_drift = intersection
 *   - First call THROWS               → 500 (second call NOT attempted; "both throw" not reachable)
 *   - First drift, second THROWS       → 200 with empty confirmed_drift + second_call_error diagnostic
 */

import { classifyDrift, type DriftReport, type DriftBuckets } from "./classify-drift";

export type VerifyFn = (db: any) => Promise<DriftReport>;

export type VerifierResponseBody =
  | {
      ok: true;
      window: { since_id: number; max_id: number };
      checked_edges: number;
      checked_nodes: number;
    }
  | {
      ok: false;
      window: { since_id: number; max_id: number };
      confirmed_drift: DriftBuckets;
      transient_drift: DriftBuckets;
      transient_race_detected: boolean;
      second_call_error?: string;
    }
  | { error: string };

export type VerifierResponse = {
  status: 200 | 409 | 500;
  body: VerifierResponseBody;
};

function bucketsNonEmpty(b: DriftBuckets): boolean {
  return (
    b.missing_in_cache.length > 0 ||
    b.extra_in_cache.length > 0 ||
    b.missing_nodes.length > 0 ||
    b.extra_nodes.length > 0
  );
}

export async function runVerifierTwoPhase(
  env: { DB: any },
  verifyFn: VerifyFn,
): Promise<VerifierResponse> {
  // First call. If this throws, return 500 immediately — the second call is NEVER
  // attempted, so "both throw" is not a reachable runtime state (per codex r8 fix).
  let first: DriftReport;
  try {
    first = await verifyFn(env.DB);
  } catch (err) {
    return {
      status: 500,
      body: { error: String((err as Error)?.message ?? err) },
    };
  }

  // Happy path: first call clean. Skip second call.
  if (first.ok) {
    return {
      status: 200,
      body: {
        ok: true,
        window: first.window,
        checked_edges: first.checked_edges,
        checked_nodes: first.checked_nodes,
      },
    };
  }

  // First call reported drift. Second call confirms or refutes.
  let second: DriftReport;
  let secondCallError: string | undefined;
  try {
    second = await verifyFn(env.DB);
  } catch (err) {
    // Second-call exception → treat the first-call drift as transient (cannot confirm).
    secondCallError = String((err as Error)?.message ?? err);
    return {
      status: 200,
      body: {
        ok: false,
        window: first.window,
        confirmed_drift: {
          missing_in_cache: [],
          extra_in_cache: [],
          missing_nodes: [],
          extra_nodes: [],
        },
        transient_drift: first.drift, // first call's drift, unverified
        transient_race_detected: bucketsNonEmpty(first.drift),
        second_call_error: secondCallError,
      },
    };
  }

  // Both calls succeeded. Partition.
  const classified = classifyDrift(first, second);

  const status: 200 | 409 = bucketsNonEmpty(classified.confirmed_drift) ? 409 : 200;

  return {
    status,
    body: {
      ok: false,
      window: first.window,
      confirmed_drift: classified.confirmed_drift,
      transient_drift: classified.transient_drift,
      transient_race_detected: classified.transient_race_detected,
    },
  };
}
