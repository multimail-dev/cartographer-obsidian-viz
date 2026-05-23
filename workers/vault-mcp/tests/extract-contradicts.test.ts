/**
 * extract-contradicts.test.ts — Tests for contradiction edge extraction from
 * wiki pages (plan 2026-05-19-001 U5).
 *
 * Verifies:
 *   1. Wiki pages with (compare: [[A]] vs [[B]]) emit contradicts edges
 *   2. source = wiki page path (NOT referenced note) — critical for reconcileExtract safety
 *   3. Two edges per contradiction (wiki→A, wiki→B)
 *   4. Non-wiki notes don't trigger compare scanning
 *   5. Malformed annotations are skipped
 *   6. Lifecycle: edges survive extraction of referenced notes
 */

import { describe, expect, test } from "bun:test";
import { extractEdgesFromNote } from "../src/extract";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wikiContent(body: string): string {
  return `---
type: wiki
wiki_kind: concept
sources: [People/Alice, People/Bob]
compiled_at: "2026-05-01T00:00:00Z"
source_hash: abc123
---
${body}`;
}

function noteContent(body: string): string {
  return `---
type: transcript
---
${body}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractEdgesFromNote — contradicts edges from wiki pages", () => {
  test("wiki page with (compare: [[A]] vs [[B]]) → emits TWO contradicts edges: wiki→A, wiki→B", () => {
    const content = wikiContent(
      "# Topic\n\nSome synthesis.\n\n(compare: [[People/Alice]] vs [[People/Bob]])\n"
    );
    const result = extractEdgesFromNote("Wiki/Concepts/topic.md", content, "2026-05-01", 500);

    const contradicts = result.edges.filter(e => e.edge_type === "contradicts");
    expect(contradicts).toHaveLength(2);

    // Both edges have source = wiki page path
    expect(contradicts[0].source).toBe("Wiki/Concepts/topic");
    expect(contradicts[1].source).toBe("Wiki/Concepts/topic");

    // Targets are the referenced notes
    const targets = new Set(contradicts.map(e => e.target));
    expect(targets.has("People/Alice")).toBe(true);
    expect(targets.has("People/Bob")).toBe(true);
  });

  test("multiple compare annotations → emits two edges per annotation", () => {
    const content = wikiContent(
      "# Topic\n\n(compare: [[A]] vs [[B]])\n\nMore text.\n\n(compare: [[C]] vs [[D]])\n"
    );
    const result = extractEdgesFromNote("Wiki/People/alice.md", content, "2026-05-01", 500);

    const contradicts = result.edges.filter(e => e.edge_type === "contradicts");
    expect(contradicts).toHaveLength(4);

    // All edges sourced from the wiki page
    for (const edge of contradicts) {
      expect(edge.source).toBe("Wiki/People/alice");
    }
  });

  test("no compare annotations → no contradicts edges emitted", () => {
    const content = wikiContent(
      "# Topic\n\nA synthesis without any contradictions.\n\n[[People/Alice]] is mentioned.\n"
    );
    const result = extractEdgesFromNote("Wiki/Concepts/topic.md", content, "2026-05-01", 500);

    const contradicts = result.edges.filter(e => e.edge_type === "contradicts");
    expect(contradicts).toHaveLength(0);

    // Normal wikilink extraction still works
    const wikilinks = result.edges.filter(e => e.edge_type === "wikilink");
    expect(wikilinks.length).toBeGreaterThan(0);
  });

  test("non-wiki note → no compare scanning", () => {
    const content = noteContent(
      "# Transcript\n\n(compare: [[People/Alice]] vs [[People/Bob]])\n"
    );
    const result = extractEdgesFromNote("transcripts/ep-1.md", content, "2026-05-01", 500);

    const contradicts = result.edges.filter(e => e.edge_type === "contradicts");
    expect(contradicts).toHaveLength(0);
  });

  test("malformed annotation (compare: [[A]] vs ) → skipped, no edge emitted", () => {
    const content = wikiContent(
      "# Topic\n\n(compare: [[A]] vs )\n\n(compare: [[B]] vs [[C]])\n"
    );
    const result = extractEdgesFromNote("Wiki/Concepts/topic.md", content, "2026-05-01", 500);

    const contradicts = result.edges.filter(e => e.edge_type === "contradicts");
    // Only the valid annotation produces edges
    expect(contradicts).toHaveLength(2);
    const targets = new Set(contradicts.map(e => e.target));
    expect(targets.has("B")).toBe(true);
    expect(targets.has("C")).toBe(true);
  });

  test("paths with spaces: (compare: [[People/Elon Musk]] vs [[People/Sam Altman]]) → correctly extracted", () => {
    const content = wikiContent(
      "# Topic\n\n(compare: [[People/Elon Musk]] vs [[People/Sam Altman]])\n"
    );
    const result = extractEdgesFromNote("Wiki/People/elon-musk.md", content, "2026-05-01", 500);

    const contradicts = result.edges.filter(e => e.edge_type === "contradicts");
    expect(contradicts).toHaveLength(2);
    expect(contradicts[0].target).toBe("People/Elon Musk");
    expect(contradicts[1].target).toBe("People/Sam Altman");
  });

  test("vs. with period → correctly parsed", () => {
    const content = wikiContent(
      "# Topic\n\n(compare: [[A]] vs. [[B]])\n"
    );
    const result = extractEdgesFromNote("Wiki/Concepts/topic.md", content, "2026-05-01", 500);

    const contradicts = result.edges.filter(e => e.edge_type === "contradicts");
    expect(contradicts).toHaveLength(2);
  });

  test("case insensitive: (Compare: [[A]] vs [[B]]) → matches", () => {
    const content = wikiContent(
      "# Topic\n\n(Compare: [[A]] vs [[B]])\n"
    );
    const result = extractEdgesFromNote("Wiki/Concepts/topic.md", content, "2026-05-01", 500);

    const contradicts = result.edges.filter(e => e.edge_type === "contradicts");
    expect(contradicts).toHaveLength(2);
  });

  test("contradicts edges have weight 1.0", () => {
    const content = wikiContent(
      "# Topic\n\n(compare: [[A]] vs [[B]])\n"
    );
    const result = extractEdgesFromNote("Wiki/Concepts/topic.md", content, "2026-05-01", 500);

    const contradicts = result.edges.filter(e => e.edge_type === "contradicts");
    for (const edge of contradicts) {
      expect(edge.weight).toBe(1.0);
    }
  });

  test("wikilinks from wiki pages still extracted alongside contradicts", () => {
    const content = wikiContent(
      "# Topic\n\n[[People/Alice]] is mentioned.\n\n(compare: [[People/Bob]] vs [[People/Carol]])\n"
    );
    const result = extractEdgesFromNote("Wiki/Concepts/topic.md", content, "2026-05-01", 500);

    const wikilinks = result.edges.filter(e => e.edge_type === "wikilink");
    const contradicts = result.edges.filter(e => e.edge_type === "contradicts");

    // Wikilinks include Alice (and possibly Bob/Carol too from body scanning)
    expect(wikilinks.some(e => e.target === "People/Alice")).toBe(true);
    // Contradicts edges for Bob and Carol
    expect(contradicts.some(e => e.target === "People/Bob")).toBe(true);
    expect(contradicts.some(e => e.target === "People/Carol")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle tests — simulates reconcileExtract behavior
// ---------------------------------------------------------------------------

describe("contradicts edge lifecycle (reconcileExtract simulation)", () => {
  test("wiki page extraction → contradicts edges have source=wiki path, not target path", () => {
    const content = wikiContent("(compare: [[People/Alice]] vs [[People/Bob]])");
    const result = extractEdgesFromNote("Wiki/Concepts/topic.md", content, "2026-05-01", 500);

    const contradicts = result.edges.filter(e => e.edge_type === "contradicts");

    // reconcileExtract runs: DELETE WHERE origin='extract' AND source=?1
    // If source were "People/Alice", extracting People/Alice would destroy these edges.
    // With source = "Wiki/Concepts/topic", only re-extracting the wiki page touches them.
    for (const edge of contradicts) {
      expect(edge.source).toBe("Wiki/Concepts/topic");
      expect(edge.source).not.toBe("People/Alice");
      expect(edge.source).not.toBe("People/Bob");
    }
  });

  test("extracting a non-wiki note produces NO contradicts edges — cannot interfere with wiki contradicts", () => {
    // Simulate: note A mentions a comparison in its content
    const content = noteContent("I disagree with [[People/Bob]]. (compare: [[People/Alice]] vs [[People/Bob]])");
    const result = extractEdgesFromNote("People/Alice.md", content, "2026-05-01", 500);

    const contradicts = result.edges.filter(e => e.edge_type === "contradicts");
    // Non-wiki notes don't produce contradicts edges
    expect(contradicts).toHaveLength(0);

    // reconcileExtract for People/Alice would run:
    // DELETE WHERE origin='extract' AND source='People/Alice'
    // This can never touch contradicts edges where source='Wiki/...'
  });

  test("re-extraction of wiki page with different contradictions → old edges removed, new present", () => {
    // First extraction: A vs B
    const content1 = wikiContent("(compare: [[People/Alice]] vs [[People/Bob]])");
    const result1 = extractEdgesFromNote("Wiki/Concepts/topic.md", content1, "2026-05-01", 500);
    const c1 = result1.edges.filter(e => e.edge_type === "contradicts");
    expect(c1).toHaveLength(2);

    // Second extraction: C vs D (different contradictions)
    const content2 = wikiContent("(compare: [[People/Carol]] vs [[People/Dave]])");
    const result2 = extractEdgesFromNote("Wiki/Concepts/topic.md", content2, "2026-05-02", 500);
    const c2 = result2.edges.filter(e => e.edge_type === "contradicts");
    expect(c2).toHaveLength(2);

    // New extraction only contains Carol/Dave — reconcileExtract would delete old Alice/Bob edges
    // (because they share source='Wiki/Concepts/topic' and origin='extract')
    const targets2 = new Set(c2.map(e => e.target));
    expect(targets2.has("People/Carol")).toBe(true);
    expect(targets2.has("People/Dave")).toBe(true);
    expect(targets2.has("People/Alice")).toBe(false);
    expect(targets2.has("People/Bob")).toBe(false);
  });
});
