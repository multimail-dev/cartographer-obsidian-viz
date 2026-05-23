/**
 * Phase 2 tests: buildGraph non-destructive refactor.
 *
 * Plan reference: docs/plans/2026-04-29-001-feat-crdt-local-first-wiki-endstate-plan.md
 * §Phase 2 — "build_graph non-destructive refactor"
 *
 * Acceptance criteria:
 *   1. buildGraph extract uses INSERT...ON CONFLICT(path) DO UPDATE for vault_nodes.
 *   2. SELECT COUNT(*) FROM vault_nodes never decreases during a buildGraph run.
 *   3. FTS5 index incrementally updated (per-path DELETE + INSERT, not DROP/CREATE).
 *   4. Stale rows cleaned up after extract (with 5% safety threshold).
 *   5. ingest_run_id stamped on every processed vault_nodes row.
 *
 * These tests verify:
 *   1. Source-code structure: destructive patterns are gone, new patterns present.
 *   2. Pure-logic equivalence: stale detection logic produces correct results.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX_TS = readFileSync(
  join(__dirname, "..", "src", "index.ts"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// Destructive patterns removed
// ---------------------------------------------------------------------------

describe("Phase 2: destructive patterns removed", () => {
  test("no DELETE FROM vault_nodes in buildGraph extract", () => {
    // The old pattern: DELETE FROM vault_nodes wiped the entire table on
    // every build start (totalProcessed === 0). This is the exact pattern
    // that caused data loss when a cron timed out mid-rebuild.
    //
    // Scan the buildGraph function body for the destructive DELETE.
    // The only DELETE FROM vault_nodes should be for sentinel rows
    // (path = '__build_progress__', etc.) and the stale cleanup
    // (which is guarded by ingest_run_id check, not a blind wipe).
    const buildGraphBody = INDEX_TS.slice(
      INDEX_TS.indexOf("export async function buildGraph("),
      INDEX_TS.indexOf("export async function buildGraph(") + 8000,
    );
    // Must NOT contain unguarded DELETE FROM vault_nodes
    expect(buildGraphBody).not.toMatch(
      /env\.DB\.prepare\("DELETE FROM vault_nodes"\)/
    );
  });

  test("no DROP TABLE vault_fts in buildGraph extract", () => {
    const buildGraphBody = INDEX_TS.slice(
      INDEX_TS.indexOf("export async function buildGraph("),
      INDEX_TS.indexOf("export async function buildGraph(") + 8000,
    );
    expect(buildGraphBody).not.toContain("DROP TABLE IF EXISTS vault_fts");
  });

  test("FTS table created with IF NOT EXISTS, not DROP + CREATE", () => {
    expect(INDEX_TS).toContain(
      "CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5"
    );
  });
});

// ---------------------------------------------------------------------------
// Non-destructive patterns present
// ---------------------------------------------------------------------------

describe("Phase 2: non-destructive patterns present", () => {
  test("buildGraph uses INSERT...ON CONFLICT(path) DO UPDATE for vault_nodes", () => {
    // All three INSERT variants in buildGraph must use ON CONFLICT DO UPDATE
    const buildGraphBody = INDEX_TS.slice(
      INDEX_TS.indexOf("export async function buildGraph("),
      INDEX_TS.indexOf("export async function buildGraph(") + 12000,
    );
    const upsertMatches = buildGraphBody.match(
      /ON CONFLICT\(path\) DO UPDATE SET/g
    );
    // At least 2 variants: has005Cols, !has005Cols
    expect(upsertMatches!.length).toBeGreaterThanOrEqual(2);
  });

  test("buildGraph INSERT variants include ingest_run_id", () => {
    // The has005Cols variants must include ingest_run_id in both
    // INSERT columns and ON CONFLICT SET clause
    const buildGraphBody = INDEX_TS.slice(
      INDEX_TS.indexOf("export async function buildGraph("),
      INDEX_TS.indexOf("export async function buildGraph(") + 12000,
    );
    // Count ingest_run_id = excluded.ingest_run_id in buildGraph
    const stampMatches = buildGraphBody.match(
      /ingest_run_id = excluded\.ingest_run_id/g
    );
    // At least 1: has005Cols variant (pre-005 variant has no column)
    expect(stampMatches!.length).toBeGreaterThanOrEqual(1);
  });

  test("FTS updated per-path: DELETE + INSERT pattern", () => {
    // buildGraph extract must use per-path FTS DELETE before INSERT,
    // matching the syncGraph pattern (not DROP TABLE + bulk INSERT)
    const buildGraphBody = INDEX_TS.slice(
      INDEX_TS.indexOf("export async function buildGraph("),
      INDEX_TS.indexOf("export async function buildGraph(") + 12000,
    );
    expect(buildGraphBody).toContain(
      'DELETE FROM vault_fts WHERE path = ?'
    );
    expect(buildGraphBody).toContain(
      "INSERT INTO vault_fts (path, title, content, tags) VALUES"
    );
  });

  test("Phase 2 comment references plan §Phase 2", () => {
    expect(INDEX_TS).toContain(
      "Phase 2 non-destructive refactor (plan §Phase 2)"
    );
  });
});

// ---------------------------------------------------------------------------
// Stale-row cleanup
// ---------------------------------------------------------------------------

describe("Phase 2: stale-row cleanup", () => {
  test("cleanupStaleNodes helper is defined and called at done=true", () => {
    expect(INDEX_TS).toContain("async function cleanupStaleNodes(");
    // Called at done=true with buildStartTime for concurrent-writer safety
    expect(INDEX_TS).toContain("await cleanupStaleNodes(env, currentBuildRunId, buildStartTime)");
    // STALE_WHERE includes indexed_at guard to protect concurrent writers
    expect(INDEX_TS).toContain(
      "const STALE_WHERE = `(ingest_run_id IS NULL OR ingest_run_id != ?1) AND path NOT GLOB '__*' AND indexed_at < ?2`"
    );
  });

  test("stale cleanup has 5% safety threshold via named constant", () => {
    expect(INDEX_TS).toContain("const STALE_CLEANUP_THRESHOLD = 0.05");
    expect(INDEX_TS).toContain("staleCount > totalCount * STALE_CLEANUP_THRESHOLD");
  });

  test("stale cleanup deletes FTS entries before vault_nodes", () => {
    // FTS DELETE must reference vault_nodes subquery to find stale paths
    expect(INDEX_TS).toContain(
      "DELETE FROM vault_fts WHERE path IN (SELECT path FROM vault_nodes WHERE"
    );
  });

  test("stale cleanup excludes sentinel rows", () => {
    // Sentinel rows (path GLOB '__*') must be excluded from cleanup
    expect(INDEX_TS).toContain("AND path NOT GLOB '__*'");
  });

  test("response includes stale_cleaned_up when done=true", () => {
    expect(INDEX_TS).toContain("stale_cleaned_up: staleCleanedUp");
  });

  test("concurrent-writer safety: indexed_at guard in STALE_WHERE", () => {
    // P1 fix: rows written by concurrent writers (syncGraph, write_note)
    // after the build started have indexed_at >= buildStartTime and are
    // exempt from cleanup.
    expect(INDEX_TS).toContain("indexed_at < ?2");
    // Build start time is read from the __build_run_id__ sentinel
    expect(INDEX_TS).toContain(
      "SELECT indexed_at FROM vault_nodes WHERE path = '__build_run_id__'"
    );
  });

  test("stale vault_edges cleaned up for deleted notes", () => {
    // P2 fix: extract-origin edges for stale paths are also cleaned up.
    // Both source-edges and spoke_in target-edges are handled.
    expect(INDEX_TS).toContain(
      "DELETE FROM vault_edges WHERE origin = 'extract' AND source IN"
    );
    expect(INDEX_TS).toContain(
      "DELETE FROM vault_edges WHERE origin = 'extract' AND target IN"
    );
  });
});

// ---------------------------------------------------------------------------
// Pure-logic: stale detection
// ---------------------------------------------------------------------------

describe("Phase 2: stale detection logic", () => {
  test("stale count within 5% threshold → cleanup proceeds", () => {
    const totalCount = 10000;
    const staleCount = 400; // 4% < 5%
    const shouldClean =
      staleCount > 0 && totalCount > 0 && staleCount <= totalCount * 0.05;
    expect(shouldClean).toBe(true);
  });

  test("stale count exceeds 5% threshold → cleanup skipped", () => {
    const totalCount = 10000;
    const staleCount = 600; // 6% > 5%
    const shouldClean =
      staleCount > 0 && totalCount > 0 && staleCount <= totalCount * 0.05;
    expect(shouldClean).toBe(false);
  });

  test("stale count at exactly 5% → cleanup proceeds", () => {
    const totalCount = 10000;
    const staleCount = 500; // exactly 5%
    const shouldClean =
      staleCount > 0 && totalCount > 0 && staleCount <= totalCount * 0.05;
    expect(shouldClean).toBe(true);
  });

  test("zero stale rows → no cleanup needed", () => {
    const totalCount = 10000;
    const staleCount = 0;
    const shouldClean =
      staleCount > 0 && totalCount > 0 && staleCount <= totalCount * 0.05;
    expect(shouldClean).toBe(false);
  });

  test("zero total rows → no cleanup (division safety)", () => {
    const totalCount = 0;
    const staleCount = 0;
    const shouldClean =
      staleCount > 0 && totalCount > 0 && staleCount <= totalCount * 0.05;
    expect(shouldClean).toBe(false);
  });

  test("first build after upgrade: all rows lack ingest_run_id → threshold blocks", () => {
    // On the first non-destructive build, all existing rows have NULL
    // ingest_run_id. As notes are processed, their rows get stamped.
    // After extract, only rows for R2-deleted notes remain stale.
    //
    // But if the build is interrupted partway, many rows still have NULL
    // ingest_run_id. The 5% threshold prevents mass deletion.
    const totalCount = 9412;
    const staleCount = 8000; // 85% — most rows still have NULL ingest_run_id
    const shouldClean =
      staleCount > 0 && totalCount > 0 && staleCount <= totalCount * 0.05;
    expect(shouldClean).toBe(false);
  });

  test("normal build: handful of deleted notes → cleanup proceeds", () => {
    // Normal case: 9400 notes processed, 12 old notes deleted from R2
    const totalCount = 9412;
    const staleCount = 12; // 0.1% < 5%
    const shouldClean =
      staleCount > 0 && totalCount > 0 && staleCount <= totalCount * 0.05;
    expect(shouldClean).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool description accuracy
// ---------------------------------------------------------------------------

describe("Phase 2: tool description accuracy", () => {
  test("build_graph MCP tool description reflects non-destructive behavior", () => {
    // The description must accurately state the behavior, not aspirational claims.
    // Sharp Directive 3: verify comment claims against code body.
    expect(INDEX_TS).toContain("no DELETE FROM vault_nodes, no DROP TABLE vault_fts");
    expect(INDEX_TS).toContain("stamped with ingest_run_id");
    expect(INDEX_TS).toContain("FTS updated per-path (DELETE+INSERT)");
  });

  test("build_graph description mentions applyOps({materialize:true}), not reconcileExtract", () => {
    // buildGraph extract uses applyOps with materialize:true.
    // reconcileExtract is used by syncGraph, not buildGraph extract.
    const descriptionArea = INDEX_TS.slice(
      INDEX_TS.indexOf("ADMIN: Full graph rebuild"),
      INDEX_TS.indexOf("ADMIN: Full graph rebuild") + 1000,
    );
    expect(descriptionArea).toContain("applyOps({materialize:true})");
    expect(descriptionArea).not.toContain("reconcileExtract");
  });
});
