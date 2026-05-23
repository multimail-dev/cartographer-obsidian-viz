/**
 * Wave 0 regression test for the Wiki/ digest exemption.
 *
 * R2 object modified_at stamps ~3,800 files with the same
 * minute during bulk wiki compilation, which would normally be filtered
 * as a sync artifact. The fix is a per-note exemption in the digest
 * handler: notes with path.startsWith("Wiki/") bypass the bulk-minute
 * filter unconditionally, while non-Wiki bulk noise still gets filtered.
 *
 * This test verifies two things:
 *   1. The handler source contains the binding conditional
 *      `bulkMinutes.has(min) && !n.path.startsWith("Wiki/")`.
 *   2. A pure reimplementation of the filter logic correctly handles a
 *      mixed-minute fixture (Wiki pages survive, non-Wiki bulk is filtered).
 *
 * The full /api/digest handler lives inline in src/index.ts and pulls in
 * the entire Cloudflare Worker OAuth graph, which is expensive to boot for
 * a test. The grep + pure-logic combination exercises the contract without
 * the harness cost.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX_TS_PATH = join(__dirname, "..", "src", "index.ts");

describe("digest handler Wiki/ exemption — source binding", () => {
  test("index.ts contains the per-note Wiki/ exemption conditional", () => {
    const source = readFileSync(INDEX_TS_PATH, "utf-8");
    expect(source).toContain('bulkMinutes.has(min) && !n.path.startsWith("Wiki/")');
  });

  test("index.ts does NOT contain the pre-v2 filter without the Wiki/ guard", () => {
    const source = readFileSync(INDEX_TS_PATH, "utf-8");
    // Old filter: `if (bulkMinutes.has(min)) continue;` — forbidden.
    // The v2 filter must always include the negated Wiki/ prefix check.
    const lines = source.split("\n");
    for (const line of lines) {
      if (/bulkMinutes\.has\(min\)/.test(line) && /continue;/.test(line)) {
        expect(line).toContain('!n.path.startsWith("Wiki/")');
      }
    }
  });
});

describe("digest handler Wiki/ exemption — pure logic", () => {
  /** Replica of the binding filter used inside the live handler. */
  function shouldSkipBulkArtifact(bulkMinutes: Set<string>, path: string, minute: string): boolean {
    return bulkMinutes.has(minute) && !path.startsWith("Wiki/");
  }

  test("mixed minute: Wiki/ notes survive, non-Wiki bulk gets filtered", () => {
    const bulkMinutes = new Set(["2026-04-15T12:34"]);
    // 25 notes in the bulk minute: 20 under Wiki/Orphans, 5 under Notes
    const fixture = [
      ...Array.from({ length: 20 }, (_, i) => ({
        path: `Wiki/Orphans/orphan-${i}`,
        minute: "2026-04-15T12:34",
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        path: `Notes/random-${i}`,
        minute: "2026-04-15T12:34",
      })),
    ];
    const surviving = fixture.filter((n) => !shouldSkipBulkArtifact(bulkMinutes, n.path, n.minute));
    expect(surviving).toHaveLength(20);
    expect(surviving.every((n) => n.path.startsWith("Wiki/Orphans/"))).toBe(true);
  });

  test("non-bulk minute: everything survives regardless of prefix", () => {
    const bulkMinutes = new Set<string>(); // empty
    const fixture = [
      { path: "Wiki/Entities/alice", minute: "2026-04-15T09:00" },
      { path: "Notes/bob", minute: "2026-04-15T09:00" },
      { path: "Wiki/Orphans/carol", minute: "2026-04-15T09:00" },
    ];
    const surviving = fixture.filter((n) => !shouldSkipBulkArtifact(bulkMinutes, n.path, n.minute));
    expect(surviving).toHaveLength(3);
  });

  test("bulk minute with zero Wiki/ notes: all non-Wiki notes filtered", () => {
    const bulkMinutes = new Set(["2026-04-15T12:34"]);
    const fixture = [
      { path: "Notes/one", minute: "2026-04-15T12:34" },
      { path: "Notes/two", minute: "2026-04-15T12:34" },
      { path: "Notes/three", minute: "2026-04-15T12:34" },
    ];
    const surviving = fixture.filter((n) => !shouldSkipBulkArtifact(bulkMinutes, n.path, n.minute));
    expect(surviving).toHaveLength(0);
  });

  test("case-sensitive: lowercase 'wiki/' does NOT get exempted", () => {
    const bulkMinutes = new Set(["2026-04-15T12:34"]);
    const fixture = [
      { path: "wiki/Entities/alice", minute: "2026-04-15T12:34" }, // lowercase, not real
      { path: "Wiki/Entities/alice", minute: "2026-04-15T12:34" }, // correct case
    ];
    const surviving = fixture.filter((n) => !shouldSkipBulkArtifact(bulkMinutes, n.path, n.minute));
    expect(surviving).toEqual([{ path: "Wiki/Entities/alice", minute: "2026-04-15T12:34" }]);
  });
});
