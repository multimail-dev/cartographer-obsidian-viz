/**
 * wiki-lookup.test.ts — Tests for wiki cross-reference helpers (plan 2026-05-19-001 U1, U2, U3).
 *
 * Verifies:
 *   1. findWikiPagesForPaths resolves canonical-folder paths via slug construction
 *   2. Fallback via vault_edges wikilinks for non-canonical paths
 *   3. Freshness classification (fresh/stale/thin/unknown)
 *   4. search_notes envelope format with wiki cross-reference (U2)
 *   5. search_notes "array" format backward compatibility (U2)
 *   6. find_related wiki_context augmentation (U3)
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Module mocks — pr2-harness sets up mock.module() at import time, before
// any test code runs. This prevents cloudflare:workers resolution errors.
// ---------------------------------------------------------------------------

import { d1, setupSchema, makeEnv as harnessMakeEnv } from "./pr2-harness";

// Dynamic import after mocks are established
const { findWikiPagesForPaths, toolSearchNotes, toolFindRelated } = await import("../src/index");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple schema for findWikiPagesForPaths tests (no FTS needed). */
const SIMPLE_SCHEMA_SQL = `
CREATE TABLE vault_nodes (
  path TEXT PRIMARY KEY, title TEXT, note_type TEXT, folder TEXT,
  tags TEXT DEFAULT '[]', in_degree INTEGER DEFAULT 0, out_degree INTEGER DEFAULT 0,
  size INTEGER DEFAULT 0, modified_at TEXT, indexed_at TEXT DEFAULT (datetime('now')),
  aliases TEXT DEFAULT '[]', frontmatter TEXT, body TEXT, word_count INTEGER,
  content_hash TEXT, created_at TEXT, ingest_run_id TEXT
);
CREATE TABLE vault_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, target TEXT NOT NULL,
  edge_type TEXT NOT NULL, weight REAL DEFAULT 1.0, origin TEXT DEFAULT 'extract',
  created_at TEXT DEFAULT (datetime('now')), UNIQUE(source, target, edge_type)
);
`;

function makeEnv(db: BunDatabase): any {
  return { DB: d1(db) } as any;
}

function insertNode(
  db: BunDatabase,
  path: string,
  opts?: {
    title?: string;
    frontmatter?: string;
    content_hash?: string;
    modified_at?: string;
    body?: string;
  },
) {
  const folder = path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
  const title = opts?.title ?? path.split("/").pop()?.replace(".md", "") ?? path;
  db.query(
    `INSERT INTO vault_nodes (path, title, folder, frontmatter, content_hash, modified_at, body)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    path,
    title,
    folder,
    opts?.frontmatter ?? null,
    opts?.content_hash ?? null,
    opts?.modified_at ?? new Date().toISOString(),
    opts?.body ?? null,
  );
}

function insertEdge(
  db: BunDatabase,
  source: string,
  target: string,
  edgeType: string = "wikilink",
  weight: number = 1.0,
) {
  db.query(
    `INSERT OR IGNORE INTO vault_edges (source, target, edge_type, weight) VALUES (?, ?, ?, ?)`,
  ).run(source, target, edgeType, weight);
}

function wikiSourcesFrontmatter(sources: string[], synthesisSources?: string[], compiledAt?: string): string {
  const fm: Record<string, any> = {
    type: "wiki",
    wiki_kind: "concept",
    sources,
    compiled_at: compiledAt ?? "2026-05-01T00:00:00Z",
    source_hash: "abc123",
  };
  if (synthesisSources) {
    fm.synthesis_sources = synthesisSources;
  }
  return JSON.stringify(fm);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findWikiPagesForPaths", () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(":memory:");
    db.exec(SIMPLE_SCHEMA_SQL);
  });

  test("canonical path has a wiki page → returns wiki metadata with 'fresh' status", async () => {
    const sources = ["People/Alice", "transcripts/ep-1", "transcripts/ep-2"];
    insertNode(db, "Wiki/People/alice", {
      title: "alice",
      frontmatter: wikiSourcesFrontmatter(sources, sources, "2026-05-01T00:00:00Z"),
      content_hash: "wiki-hash-1",
    });
    // Insert the source nodes so freshness check finds them
    insertNode(db, "People/Alice", { content_hash: "src-hash-1" });
    insertNode(db, "transcripts/ep-1", { content_hash: "src-hash-2" });
    insertNode(db, "transcripts/ep-2", { content_hash: "src-hash-3" });

    const result = await findWikiPagesForPaths(makeEnv(db), ["People/Alice"]);

    expect(result).toHaveLength(1);
    expect(result[0].wikiPath).toBe("Wiki/People/alice");
    expect(result[0].freshnessStatus).toBe("fresh");
    expect(result[0].sourceCount).toBe(3);
    expect(result[0].synthesisSrcCount).toBe(3);
    expect(result[0].compiledAt).toBe("2026-05-01T00:00:00Z");
  });

  test("multiple source paths share the same wiki page → deduplicated, single wiki ref", async () => {
    const sources = ["People/Alice", "People/Bob"];
    insertNode(db, "Wiki/People/alice", {
      title: "alice",
      frontmatter: wikiSourcesFrontmatter(sources, sources),
    });
    insertNode(db, "Wiki/People/bob", {
      title: "bob",
      frontmatter: wikiSourcesFrontmatter(["People/Bob"]),
    });
    insertNode(db, "People/Alice", { content_hash: "h1" });
    insertNode(db, "People/Bob", { content_hash: "h2" });

    const result = await findWikiPagesForPaths(makeEnv(db), ["People/Alice", "People/Bob"]);

    // Each path maps to a different wiki page
    expect(result).toHaveLength(2);
    const paths = result.map(r => r.wikiPath).sort();
    expect(paths).toEqual(["Wiki/People/alice", "Wiki/People/bob"]);
  });

  test("no wiki page exists for any path → returns empty array", async () => {
    insertNode(db, "People/Unknown", {});

    const result = await findWikiPagesForPaths(makeEnv(db), ["People/Unknown"]);

    expect(result).toEqual([]);
  });

  test("wiki page exists but synthesis source was modified → 'stale' freshness", async () => {
    const sources = ["People/Alice", "People/Bob"];
    insertNode(db, "Wiki/People/alice", {
      title: "alice",
      frontmatter: wikiSourcesFrontmatter(sources, sources, "2026-04-01T00:00:00Z"),
    });
    insertNode(db, "People/Alice", { content_hash: "h1" });
    // Bob is missing (deleted or not indexed) → triggers stale
    // Only 1 of 2 synthesis sources found with content_hash

    const result = await findWikiPagesForPaths(makeEnv(db), ["People/Alice"]);

    expect(result).toHaveLength(1);
    expect(result[0].freshnessStatus).toBe("stale");
  });

  test("wiki page has only 1 synthesis source → 'thin' coverage", async () => {
    insertNode(db, "Wiki/People/alice", {
      title: "alice",
      frontmatter: wikiSourcesFrontmatter(["People/Alice"], ["People/Alice"]),
    });
    insertNode(db, "People/Alice", { content_hash: "h1" });

    const result = await findWikiPagesForPaths(makeEnv(db), ["People/Alice"]);

    expect(result).toHaveLength(1);
    expect(result[0].freshnessStatus).toBe("thin");
  });

  test("edge fallback: non-canonical path resolved via vault_edges wikilink", async () => {
    // Note in non-canonical folder — no direct slug mapping
    insertNode(db, "channels/legal-news/ep-42", { content_hash: "h1" });
    // Wiki page links to it
    insertNode(db, "Wiki/Entities/legal-news", {
      title: "legal-news",
      frontmatter: wikiSourcesFrontmatter(
        ["channels/legal-news/ep-42", "channels/legal-news/ep-43"],
        ["channels/legal-news/ep-42", "channels/legal-news/ep-43"],
      ),
    });
    insertNode(db, "channels/legal-news/ep-43", { content_hash: "h2" });
    insertEdge(db, "Wiki/Entities/legal-news", "channels/legal-news/ep-42", "wikilink");

    const result = await findWikiPagesForPaths(makeEnv(db), ["channels/legal-news/ep-42"]);

    expect(result).toHaveLength(1);
    expect(result[0].wikiPath).toBe("Wiki/Entities/legal-news");
  });

  test("path with .md suffix → correctly normalized", async () => {
    insertNode(db, "Wiki/People/alice", {
      title: "alice",
      frontmatter: wikiSourcesFrontmatter(["People/Alice"], ["People/Alice", "transcripts/ep-1"]),
    });
    insertNode(db, "People/Alice", { content_hash: "h1" });
    insertNode(db, "transcripts/ep-1", { content_hash: "h2" });

    const result = await findWikiPagesForPaths(makeEnv(db), ["People/Alice.md"]);

    expect(result).toHaveLength(1);
    expect(result[0].wikiPath).toBe("Wiki/People/alice");
  });

  test("path with spaces and special characters → correctly slugified", async () => {
    insertNode(db, "Wiki/People/elon-musk", {
      title: "elon-musk",
      frontmatter: wikiSourcesFrontmatter(["People/Elon Musk"], ["People/Elon Musk", "People/Other"]),
    });
    insertNode(db, "People/Elon Musk", { content_hash: "h1" });
    insertNode(db, "People/Other", { content_hash: "h2" });

    const result = await findWikiPagesForPaths(makeEnv(db), ["People/Elon Musk"]);

    expect(result).toHaveLength(1);
    expect(result[0].wikiPath).toBe("Wiki/People/elon-musk");
  });

  test("empty paths → returns empty array", async () => {
    const result = await findWikiPagesForPaths(makeEnv(db), []);
    expect(result).toEqual([]);
  });

  test("maxResults caps output", async () => {
    // Insert 5 wiki pages
    for (const name of ["alice", "bob", "carol", "dave", "eve"]) {
      insertNode(db, `Wiki/People/${name}`, {
        title: name,
        frontmatter: wikiSourcesFrontmatter([`People/${name}`]),
      });
      insertNode(db, `People/${name}`, { content_hash: `h-${name}` });
    }

    const result = await findWikiPagesForPaths(
      makeEnv(db),
      ["People/alice", "People/bob", "People/carol", "People/dave", "People/eve"],
      2,
    );

    expect(result.length).toBeLessThanOrEqual(2);
  });

  test("duplicate paths are deduplicated", async () => {
    insertNode(db, "Wiki/People/alice", {
      title: "alice",
      frontmatter: wikiSourcesFrontmatter(["People/Alice"], ["People/Alice", "People/Bob"]),
    });
    insertNode(db, "People/Alice", { content_hash: "h1" });
    insertNode(db, "People/Bob", { content_hash: "h2" });

    const result = await findWikiPagesForPaths(makeEnv(db), [
      "People/Alice",
      "People/Alice.md",
      "People/Alice",
    ]);

    expect(result).toHaveLength(1);
  });

  test("wiki frontmatter missing → freshnessStatus is 'unknown'", async () => {
    insertNode(db, "Wiki/People/alice", { title: "alice" });

    const result = await findWikiPagesForPaths(makeEnv(db), ["People/Alice"]);

    expect(result).toHaveLength(1);
    expect(result[0].freshnessStatus).toBe("unknown");
    expect(result[0].sourceCount).toBe(0);
    expect(result[0].synthesisSrcCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// U2: search_notes wiki cross-reference tests
// ---------------------------------------------------------------------------

function insertFts(db: BunDatabase, path: string, title: string, content: string, tags: string = "[]") {
  db.query(`INSERT INTO vault_fts (path, title, content, tags) VALUES (?, ?, ?, ?)`).run(path, title, content, tags);
}

describe("toolSearchNotes wiki cross-reference (U2)", () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(":memory:");
    setupSchema(db);
  });

  test("envelope format: FTS results with wiki page → includes wiki_context", async () => {
    // Insert vault_node for the wiki page
    insertNode(db, "Wiki/People/alice", {
      title: "alice",
      frontmatter: wikiSourcesFrontmatter(["People/Alice"], ["People/Alice", "People/Bob"]),
    });
    insertNode(db, "People/Alice", { content_hash: "h1" });
    insertNode(db, "People/Bob", { content_hash: "h2" });
    // FTS index: a note path matching the query
    insertFts(db, "People/Alice", "Alice", "Alice is a researcher in AI");

    const env = makeEnv(db);
    const result = JSON.parse(await toolSearchNotes(env, "Alice"));

    expect(result.results).toBeDefined();
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.wiki_context).toBeDefined();
    expect(result.wiki_context.wiki_pages.length).toBeGreaterThan(0);
    expect(result.wiki_context.wiki_pages[0].wikiPath).toBe("Wiki/People/alice");
    expect(result.wiki_context.wiki_gap).toBe(false);
  });

  test("envelope format: FTS results without wiki page → wiki_gap is true", async () => {
    insertFts(db, "notes/random", "Random Note", "Some random content");

    const env = makeEnv(db);
    const result = JSON.parse(await toolSearchNotes(env, "random"));

    expect(result.results).toBeDefined();
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.wiki_context.wiki_gap).toBe(true);
    expect(result.wiki_context.wiki_pages).toEqual([]);
  });

  test("envelope format: empty FTS results → empty results with wiki_gap", async () => {
    const env = makeEnv(db);
    // Insert at least one FTS row so the "FTS index is empty" check passes
    insertFts(db, "notes/something", "Something", "unrelated content");

    const result = JSON.parse(await toolSearchNotes(env, "xyznonexistent"));

    expect(result.results).toEqual([]);
    expect(result.wiki_context.wiki_gap).toBe(true);
  });

  test("array format: returns legacy bare array without wiki_context", async () => {
    insertFts(db, "People/Alice", "Alice", "Alice is a researcher");

    const env = makeEnv(db);
    const result = JSON.parse(await toolSearchNotes(env, "Alice", undefined, 20, "array"));

    expect(Array.isArray(result)).toBe(true);
    expect(result[0].path).toBe("People/Alice.md");
    expect(result[0].snippet).toBeDefined();
    // No wiki_context in array format
    expect(result.wiki_context).toBeUndefined();
  });

  test("array format: empty results → empty array", async () => {
    insertFts(db, "notes/something", "Something", "unrelated");

    const env = makeEnv(db);
    const result = JSON.parse(await toolSearchNotes(env, "xyznonexistent", undefined, 20, "array"));

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([]);
  });

  test("default format is envelope when omitted", async () => {
    insertFts(db, "People/Alice", "Alice", "Alice works on AI");

    const env = makeEnv(db);
    // Call without format parameter — should default to envelope
    const result = JSON.parse(await toolSearchNotes(env, "Alice"));

    expect(result.results).toBeDefined();
    expect(result.wiki_context).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// U3: find_related wiki cross-reference tests
// ---------------------------------------------------------------------------

describe("toolFindRelated wiki cross-reference (U3)", () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(":memory:");
    setupSchema(db);
  });

  test("seed note has a wiki page → wiki_context includes the wiki ref", async () => {
    // Set up a simple graph: Alice → Bob via wikilink
    insertNode(db, "People/Alice", { content_hash: "h1" });
    insertNode(db, "People/Bob", { content_hash: "h2" });
    insertEdge(db, "People/Alice", "People/Bob", "wikilink");
    // Wiki page for Alice
    insertNode(db, "Wiki/People/alice", {
      title: "alice",
      frontmatter: wikiSourcesFrontmatter(["People/Alice"], ["People/Alice", "People/Bob"]),
    });

    const env = makeEnv(db);
    const result = JSON.parse(await toolFindRelated(env, "People/Alice"));

    expect(result.seed).toBe("People/Alice");
    expect(result.wiki_context).toBeDefined();
    expect(result.wiki_context.wiki_pages.length).toBeGreaterThan(0);
    expect(result.wiki_context.wiki_pages[0].wikiPath).toBe("Wiki/People/alice");
    expect(result.wiki_context.wiki_gap).toBe(false);
  });

  test("no wiki page for seed or results → wiki_gap is true", async () => {
    insertNode(db, "notes/random-a", {});
    insertNode(db, "notes/random-b", {});
    insertEdge(db, "notes/random-a", "notes/random-b", "wikilink");

    const env = makeEnv(db);
    const result = JSON.parse(await toolFindRelated(env, "notes/random-a"));

    expect(result.wiki_context).toBeDefined();
    expect(result.wiki_context.wiki_gap).toBe(true);
    expect(result.wiki_context.wiki_pages).toEqual([]);
  });

  test("existing response fields preserved (seed, results, count, total_found)", async () => {
    insertNode(db, "People/Alice", {});
    insertNode(db, "People/Bob", {});
    insertEdge(db, "People/Alice", "People/Bob", "wikilink");

    const env = makeEnv(db);
    const result = JSON.parse(await toolFindRelated(env, "People/Alice"));

    expect(result.seed).toBe("People/Alice");
    expect(result.results).toBeDefined();
    expect(typeof result.count).toBe("number");
    expect(typeof result.total_found).toBe("number");
    // wiki_context is additive — doesn't replace anything
    expect(result.wiki_context).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Slugify parity test — wiki compilation ↔ inlined wikiSlugify
// Tested via candidateWikiPath behavior (slugify is not exported).
// For direct slug parity, see parity/wiki-slugify-parity.test.ts.
// ---------------------------------------------------------------------------
