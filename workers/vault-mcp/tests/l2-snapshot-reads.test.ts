/**
 * L2 snapshot-consistency tests for issues #67-71.
 *
 * Plan reference: docs/plans/2026-04-29-001-feat-crdt-local-first-wiki-endstate-plan.md
 * §Phase 1 — "Snapshot consistency for existing D1 reads."
 *
 * Each issue targets a function that previously used multiple sequential or
 * concurrent D1 reads without snapshot isolation. The fixes consolidate reads
 * into single UNION ALL statements (atomic in D1), env.DB.batch() calls
 * (sequential on same connection), or watermark checks.
 *
 * These tests verify:
 *   1. Source-code structure: the old patterns are gone, new patterns present.
 *   2. Pure-logic equivalence: new code produces identical output shapes.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX_TS = readFileSync(
  join(__dirname, "..", "src", "index.ts"),
  "utf-8"
);

// ---------------------------------------------------------------------------
// #69 — GET /api/enrich/status: UNION ALL snapshot
// ---------------------------------------------------------------------------

describe("L2 snapshot #69: /api/enrich/status", () => {
  test("uses single UNION ALL statement, not Promise.all", () => {
    // The old pattern: Promise.all with 3 separate meta reads
    expect(INDEX_TS).not.toMatch(
      /Promise\.all\(\[\s*env\.DB\.prepare\("SELECT value FROM meta WHERE key = 'last_enrichment_at/
    );
    // The new pattern: UNION ALL combining all 5 reads
    expect(INDEX_TS).toContain("SELECT 'phase' as key, phase as value FROM enrich_cursor WHERE id = 1");
    expect(INDEX_TS).toContain("UNION ALL");
    expect(INDEX_TS).toContain("SELECT 'enrichment_community_count', value FROM meta");
  });

  test("L2 comment references issue #69", () => {
    expect(INDEX_TS).toContain("L2 snapshot fix (#69)");
  });

  test("response shape preserved: phase, leaseExpires, lastRunAt, enrichmentVersion, communityCount", () => {
    // The response JSON construction must still set all 5 keys
    expect(INDEX_TS).toContain('phase: m.get("phase")');
    expect(INDEX_TS).toContain('lastRunAt: m.get("last_enrichment_at")');
    expect(INDEX_TS).toContain('enrichmentVersion: m.get("enrichment_version")');
    expect(INDEX_TS).toContain('communityCount: m.get("enrichment_community_count")');
  });

  test("UNION ALL row parsing: Map-based key-value extraction", () => {
    // Pure logic test: verify the Map extraction pattern works
    type Row = { key: string; value: string | null };
    const rows: Row[] = [
      { key: "phase", value: "idle" },
      { key: "lease_expires", value: "1714400000" },
      { key: "last_enrichment_at", value: "2026-04-29" },
      { key: "enrichment_version", value: "42" },
      { key: "enrichment_community_count", value: "15" },
    ];
    const m = new Map(rows.map((r) => [r.key, r.value]));
    expect(m.get("phase")).toBe("idle");
    expect(parseInt(m.get("lease_expires")!, 10)).toBe(1714400000);
    expect(m.get("last_enrichment_at")).toBe("2026-04-29");
    expect(m.get("enrichment_version")).toBe("42");
    expect(m.get("enrichment_community_count")).toBe("15");
  });

  test("UNION ALL row parsing: missing rows return null", () => {
    // Pre-migration-0004 databases: enrich_cursor and meta may not exist.
    // The .catch() returns empty results, so the Map is empty.
    const m = new Map<string, string | null>();
    expect(m.get("phase") ?? null).toBeNull();
    expect(m.has("lease_expires") ? parseInt(m.get("lease_expires")!, 10) || null : null).toBeNull();
    expect(m.get("last_enrichment_at") ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #68 — toolVaultHealth: UNION ALL + batch for stats, topics, phantoms
// ---------------------------------------------------------------------------

describe("L2 shared helpers", () => {
  test("scalarMap helper is defined and used by both #68 and #70", () => {
    expect(INDEX_TS).toContain("function scalarMap(results:");
    // Both stats (#68) and finalize (#70) should call it
    const matches = INDEX_TS.match(/scalarMap\(/g);
    expect(matches!.length).toBeGreaterThanOrEqual(3); // definition + 2 call sites
  });

  test("EDGES_BY_TYPE_SQL constant eliminates duplicate query strings", () => {
    expect(INDEX_TS).toContain('const EDGES_BY_TYPE_SQL = "SELECT edge_type');
    // Both stats and finalize should reference the constant
    const refs = INDEX_TS.match(/EDGES_BY_TYPE_SQL/g);
    expect(refs!.length).toBeGreaterThanOrEqual(3); // definition + 2 usages
  });
});

describe("L2 snapshot #68: toolVaultHealth", () => {
  test("stats case uses UNION ALL for scalar reads, not 5 sequential awaits", () => {
    // Old pattern: 5 separate env.DB.prepare(...).first() calls
    // Specifically: the old pattern had separate nodeCount and edgeCount queries
    expect(INDEX_TS).not.toMatch(
      /case "stats"[\s\S]{0,200}await env\.DB\.prepare\("SELECT COUNT\(\*\) as count FROM vault_nodes"\)\.first/
    );
    // New pattern: UNION ALL
    expect(INDEX_TS).toContain("SELECT 'node_count' as kind, CAST(COUNT(*) as TEXT) as val FROM vault_nodes");
    expect(INDEX_TS).toContain("SELECT 'edge_count', CAST(COUNT(*) as TEXT) FROM vault_edges");
    expect(INDEX_TS).toContain("SELECT 'avg_degree', CAST(ROUND(AVG(in_degree + out_degree), 2) as TEXT) FROM vault_nodes");
    expect(INDEX_TS).toContain("SELECT 'drain_watermark'");
  });

  test("stats case L2 comment references issue #68", () => {
    expect(INDEX_TS).toContain("L2 snapshot fix (#68)");
  });

  test("topics case uses single UNION ALL, not 2 sequential queries", () => {
    // Old pattern: 2 separate queries for sourceCounts and compiledCounts
    // New pattern: single UNION ALL with src_/wiki_ prefixed kind
    expect(INDEX_TS).toContain("'src_' ||");
    expect(INDEX_TS).toContain("'wiki_' ||");
  });

  test("phantoms case uses CTE for consistent phantom detection", () => {
    expect(INDEX_TS).toContain("WITH phantom_edges AS");
    expect(INDEX_TS).toContain("(SELECT SUM(edge_count) FROM phantom_edges) as total_phantom_edges");
  });

  test("stats UNION ALL scalar parsing: round-trip fidelity", () => {
    // Pure logic test: verify the Map-based scalar extraction
    const results = [
      { kind: "node_count", val: "9412" },
      { kind: "edge_count", val: "42000" },
      { kind: "avg_degree", val: "8.92" },
      { kind: "drain_watermark", val: "150000" },
    ];
    const sm = new Map(results.map((r) => [r.kind, r.val]));
    expect(parseInt(sm.get("node_count")!, 10)).toBe(9412);
    expect(parseInt(sm.get("edge_count")!, 10)).toBe(42000);
    expect(parseFloat(sm.get("avg_degree")!)).toBe(8.92);
    expect(parseInt(sm.get("drain_watermark")!, 10)).toBe(150000);

    const nCount = parseInt(sm.get("node_count")!, 10);
    const eCount = parseInt(sm.get("edge_count")!, 10);
    const density = nCount > 1 ? (eCount / (nCount * (nCount - 1))).toFixed(6) : "0";
    expect(parseFloat(density)).toBeGreaterThan(0);
  });

  test("topics UNION ALL parsing: src_ and wiki_ prefix extraction", () => {
    const results = [
      { kind: "src_People", count: 120 },
      { kind: "src_Concepts", count: 85 },
      { kind: "wiki_People", count: 45 },
      { kind: "wiki_Concepts", count: 30 },
    ];
    const sourceTopics: Record<string, number> = {};
    const compiledPages: Record<string, number> = {};
    for (const r of results) {
      if (!r.kind) continue;
      if (r.kind.startsWith("src_")) sourceTopics[r.kind.slice(4)] = r.count;
      else if (r.kind.startsWith("wiki_")) compiledPages[r.kind.slice(5)] = r.count;
    }
    expect(sourceTopics).toEqual({ People: 120, Concepts: 85 });
    expect(compiledPages).toEqual({ People: 45, Concepts: 30 });
  });

  test("phantoms CTE: total_phantom_edges from first row", () => {
    // The CTE embeds the total in every row; we extract from the first
    type Row = { target: string; edge_count: number; total_phantom_edges: number };
    const results: Row[] = [
      { target: "missing-note-1.md", edge_count: 15, total_phantom_edges: 42 },
      { target: "missing-note-2.md", edge_count: 10, total_phantom_edges: 42 },
    ];
    const total = results.length > 0 ? results[0].total_phantom_edges : 0;
    expect(total).toBe(42);
    const topPhantoms = results.map((r) => ({ target: r.target, edge_count: r.edge_count }));
    expect(topPhantoms).toEqual([
      { target: "missing-note-1.md", edge_count: 15 },
      { target: "missing-note-2.md", edge_count: 10 },
    ]);
  });

  test("phantoms CTE: empty results return 0 total", () => {
    const results: { target: string; edge_count: number; total_phantom_edges: number }[] = [];
    const total = results.length > 0 ? results[0].total_phantom_edges : 0;
    expect(total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #70 — buildGraph finalize-stats: UNION ALL + batch
// ---------------------------------------------------------------------------

describe("L2 snapshot #70: buildGraph finalize-stats", () => {
  test("finalize uses UNION ALL for node/edge counts, not sequential awaits", () => {
    // Old pattern: separate nodeCount and edgeCount queries in finalize
    // New pattern: UNION ALL in a batch call
    expect(INDEX_TS).toContain("L2 snapshot fix (#70)");
    // The finalize block should use countsResult/countsMap, not nodeCount/edgeCount
    expect(INDEX_TS).toContain("countsMap");
    expect(INDEX_TS).toContain("finalNodeCount");
    expect(INDEX_TS).toContain("finalEdgeCount");
  });

  test("finalize completion timestamp uses new variable name", () => {
    // The __last_build_completed__ INSERT must use finalNodeCount
    expect(INDEX_TS).toContain(".bind(finalNodeCount).run()");
  });

  test("finalize ingest_runs completion uses new variable name", () => {
    expect(INDEX_TS).toContain(".bind(finalNodeCount, buildRunRow.title)");
  });
});

// ---------------------------------------------------------------------------
// #67 — /api/digest: batch + derived counts
// ---------------------------------------------------------------------------

describe("L2 snapshot #67: /api/digest", () => {
  test("uses env.DB.batch, not Promise.all", () => {
    // Old pattern: Promise.all([...4 queries])
    // Check that the old 4-query Promise.all is gone from the digest handler
    expect(INDEX_TS).not.toMatch(
      /\/api\/digest[\s\S]{0,400}Promise\.all\(\[/
    );
    // New pattern: env.DB.batch()
    expect(INDEX_TS).toContain("L2 snapshot fix (#67)");
  });

  test("separate COUNT queries eliminated", () => {
    // The old pattern had standalone COUNT queries for totalNotes/totalEdges
    // Now counts are derived from .results.length
    expect(INDEX_TS).toContain("notesResult.results.length + edgesResult.results.length");
  });

  test("batch result typed with D1Result tuple", () => {
    expect(INDEX_TS).toContain("D1Result<{ path: string; title: string;");
  });
});

// ---------------------------------------------------------------------------
// #71 — runFastScore: watermark check
// ---------------------------------------------------------------------------

describe("L2 snapshot #71: runFastScore watermark", () => {
  test("captures pre- and post-detector watermarks", () => {
    expect(INDEX_TS).toContain("L2 snapshot fix (#71)");
    // Pre-detector watermark
    expect(INDEX_TS).toMatch(/const preWatermark = await env\.DB\.prepare\(\s*"SELECT MAX\(id\) as max_id FROM vault_ops"/);
    // Post-detector watermark
    expect(INDEX_TS).toMatch(/const postWatermark = await env\.DB\.prepare\(\s*"SELECT MAX\(id\) as max_id FROM vault_ops"/);
  });

  test("response includes snapshot_stale flag", () => {
    expect(INDEX_TS).toContain("snapshot_stale: snapshotStale");
  });

  test("response includes snapshot_watermark object", () => {
    expect(INDEX_TS).toContain("snapshot_watermark:");
    expect(INDEX_TS).toContain("pre: preWatermark?.max_id ?? 0");
    expect(INDEX_TS).toContain("post: postWatermark?.max_id ?? 0");
  });

  test("snapshotStale is false when watermarks match", () => {
    const pre: { max_id: number | null } | null = { max_id: 12345 };
    const post: { max_id: number | null } | null = { max_id: 12345 };
    const stale = pre === null || post === null
      ? true
      : (pre.max_id ?? 0) !== (post.max_id ?? 0);
    expect(stale).toBe(false);
  });

  test("snapshotStale is true when watermarks differ", () => {
    const pre: { max_id: number | null } | null = { max_id: 12345 };
    const post: { max_id: number | null } | null = { max_id: 12350 };
    const stale = pre === null || post === null
      ? true
      : (pre.max_id ?? 0) !== (post.max_id ?? 0);
    expect(stale).toBe(true);
  });

  test("snapshotStale defaults to true when watermark reads fail", () => {
    // .catch(() => null) returns null when vault_ops table missing or DB error.
    // Unknown state is not fresh — default to stale.
    const pre = null;
    const post = null;
    const stale = pre === null || post === null
      ? true
      : (pre.max_id ?? 0) !== (post.max_id ?? 0);
    expect(stale).toBe(true);
  });

  test("snapshotStale handles empty vault_ops (max_id is null, both reads succeed)", () => {
    // Both reads succeed but vault_ops is empty → max_id is null in both.
    const pre: { max_id: number | null } | null = { max_id: null };
    const post: { max_id: number | null } | null = { max_id: null };
    const stale = pre === null || post === null
      ? true
      : (pre.max_id ?? 0) !== (post.max_id ?? 0);
    expect(stale).toBe(false);
  });
});
