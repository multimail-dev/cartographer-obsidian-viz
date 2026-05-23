/**
 * classify-drift.ts
 *
 * L2 PR1.5 — pure helper for two-phase verifier confirmation.
 *
 * Plan: docs/plans/2026-04-26-003-fix-l2-verifier-snapshot-reads-eliminate-race-plan.md (r9) §Phase 1.
 *
 * Partitions two `verifyCacheCoherence` responses (A from first call, B from second call)
 * into:
 *   - confirmed_drift = A ∩ B  — rows present in BOTH responses → real drift, escalates as 409
 *   - transient_drift = A △ B  — symmetric difference → race noise, does NOT escalate
 *
 * Set membership uses CANONICAL STRING KEYS (per codex r3 BLOCKER #1):
 *   edge_key = `${bucket}|${origin}|${source}|${target}|${edge_type}`
 *   node_key = `${bucket}|${path}`
 *
 * Without canonical keys, `Set<object>` would compare by identity and report all
 * drift as transient (always-false-negative). Bucket prefix keeps the four edge/node
 * buckets in separate set spaces (a row that's `missing_in_cache` in A and
 * `extra_in_cache` in B is genuinely different drift, not the same row).
 *
 * Output deterministically sorted by canonical key — repeated calls with identical
 * inputs produce byte-identical output.
 */

export type DriftEdge = { source: string; target: string; edge_type: string; origin: string };

export type DriftBuckets = {
  missing_in_cache: DriftEdge[];
  extra_in_cache: DriftEdge[];
  missing_nodes: Array<{ path: string }>;
  extra_nodes: Array<{ path: string }>;
};

export type DriftReport =
  | { ok: true; window: { since_id: number; max_id: number }; checked_edges: number; checked_nodes: number }
  | { ok: false; window: { since_id: number; max_id: number }; drift: DriftBuckets };

export type ClassifyResult = {
  confirmed_drift: DriftBuckets;
  transient_drift: DriftBuckets;
  transient_race_detected: boolean;
};

function emptyBuckets(): DriftBuckets {
  return { missing_in_cache: [], extra_in_cache: [], missing_nodes: [], extra_nodes: [] };
}

function bucketsOf(report: DriftReport): DriftBuckets {
  return report.ok ? emptyBuckets() : report.drift;
}

function edgeKey(bucket: string, e: DriftEdge): string {
  return `${bucket}|${e.origin}|${e.source}|${e.target}|${e.edge_type}`;
}

function nodeKey(bucket: string, n: { path: string }): string {
  return `${bucket}|${n.path}`;
}

function partitionEdges(
  bucket: "missing_in_cache" | "extra_in_cache",
  a: DriftEdge[],
  b: DriftEdge[],
): { confirmed: DriftEdge[]; transient: DriftEdge[] } {
  const aMap = new Map(a.map((e) => [edgeKey(bucket, e), e]));
  const bMap = new Map(b.map((e) => [edgeKey(bucket, e), e]));
  const confirmed: DriftEdge[] = [];
  const transient: DriftEdge[] = [];
  // A ∩ B → confirmed; A \ B → transient
  for (const [key, edge] of aMap) {
    if (bMap.has(key)) confirmed.push(edge);
    else transient.push(edge);
  }
  // B \ A → transient
  for (const [key, edge] of bMap) {
    if (!aMap.has(key)) transient.push(edge);
  }
  // Deterministic sort by canonical key
  confirmed.sort((x, y) => edgeKey(bucket, x).localeCompare(edgeKey(bucket, y)));
  transient.sort((x, y) => edgeKey(bucket, x).localeCompare(edgeKey(bucket, y)));
  return { confirmed, transient };
}

function partitionNodes(
  bucket: "missing_nodes" | "extra_nodes",
  a: Array<{ path: string }>,
  b: Array<{ path: string }>,
): { confirmed: Array<{ path: string }>; transient: Array<{ path: string }> } {
  const aMap = new Map(a.map((n) => [nodeKey(bucket, n), n]));
  const bMap = new Map(b.map((n) => [nodeKey(bucket, n), n]));
  const confirmed: Array<{ path: string }> = [];
  const transient: Array<{ path: string }> = [];
  for (const [key, node] of aMap) {
    if (bMap.has(key)) confirmed.push(node);
    else transient.push(node);
  }
  for (const [key, node] of bMap) {
    if (!aMap.has(key)) transient.push(node);
  }
  confirmed.sort((x, y) => x.path.localeCompare(y.path));
  transient.sort((x, y) => x.path.localeCompare(y.path));
  return { confirmed, transient };
}

function bucketsNonEmpty(b: DriftBuckets): boolean {
  return (
    b.missing_in_cache.length > 0 ||
    b.extra_in_cache.length > 0 ||
    b.missing_nodes.length > 0 ||
    b.extra_nodes.length > 0
  );
}

export function classifyDrift(reportA: DriftReport, reportB: DriftReport): ClassifyResult {
  const a = bucketsOf(reportA);
  const b = bucketsOf(reportB);

  const missingEdges = partitionEdges("missing_in_cache", a.missing_in_cache, b.missing_in_cache);
  const extraEdges = partitionEdges("extra_in_cache", a.extra_in_cache, b.extra_in_cache);
  const missingNodes = partitionNodes("missing_nodes", a.missing_nodes, b.missing_nodes);
  const extraNodes = partitionNodes("extra_nodes", a.extra_nodes, b.extra_nodes);

  const confirmed_drift: DriftBuckets = {
    missing_in_cache: missingEdges.confirmed,
    extra_in_cache: extraEdges.confirmed,
    missing_nodes: missingNodes.confirmed,
    extra_nodes: extraNodes.confirmed,
  };
  const transient_drift: DriftBuckets = {
    missing_in_cache: missingEdges.transient,
    extra_in_cache: extraEdges.transient,
    missing_nodes: missingNodes.transient,
    extra_nodes: extraNodes.transient,
  };

  return {
    confirmed_drift,
    transient_drift,
    transient_race_detected: bucketsNonEmpty(transient_drift),
  };
}
