/**
 * topic-dossier.test.ts — Tests for the topic_dossier MCP tool (plan 2026-05-19-001 U4).
 *
 * Verifies:
 *   1. Wiki page found → returns full structured bundle
 *   2. No wiki page → returns gap signal with FTS matches
 *   3. Contradiction annotations parsed from wiki body
 *   4. Freshness status classification
 *   5. include_body=false skips body read
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";

// Module mocks via pr2-harness
import { d1, setupSchema } from "./pr2-harness";

const { toolTopicDossier, parseContradictionAnnotations } = await import("../src/index");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(db: BunDatabase): any {
  return {
    DB: d1(db),
    VAULT: {
      async get(key: string) {
        // R2 stub — return null (forces D1-first path)
        return null;
      },
    },
    VAULT_FTS_RAW: undefined,
  } as any;
}

function insertNode(
  db: BunDatabase,
  path: string,
  opts?: {
    title?: string;
    frontmatter?: string;
    content_hash?: string;
    body?: string;
  },
) {
  const folder = path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
  const title = opts?.title ?? path.split("/").pop()?.replace(".md", "") ?? path;
  db.query(
    `INSERT INTO vault_nodes (path, title, folder, frontmatter, content_hash, body)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    path,
    title,
    folder,
    opts?.frontmatter ?? null,
    opts?.content_hash ?? null,
    opts?.body ?? null,
  );
}

function insertFts(db: BunDatabase, path: string, title: string, content: string, tags: string = "[]") {
  db.query(`INSERT INTO vault_fts (path, title, content, tags) VALUES (?, ?, ?, ?)`).run(path, title, content, tags);
}

function insertEdge(db: BunDatabase, source: string, target: string, edgeType: string = "wikilink") {
  db.query(
    `INSERT OR IGNORE INTO vault_edges (source, target, edge_type, weight, origin) VALUES (?, ?, ?, 1.0, 'extract')`,
  ).run(source, target, edgeType);
}

function wikiSourcesFrontmatter(sources: string[], synthesisSources?: string[], compiledAt?: string): string {
  const fm: Record<string, any> = {
    type: "wiki",
    wiki_kind: "concept",
    sources,
    compiled_at: compiledAt ?? "2026-05-01T00:00:00Z",
    source_hash: "abc123",
  };
  if (synthesisSources) fm.synthesis_sources = synthesisSources;
  return JSON.stringify(fm);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("toolTopicDossier", () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(":memory:");
    setupSchema(db);
  });

  test("topic has a wiki page → returns full bundle with synthesis, sources, freshness", async () => {
    const sources = ["People/Alice", "transcripts/ep-1"];
    const wikiBody = "# Alice\n\nAlice is a researcher. She works on AI safety.\n\n(compare: [[People/Bob]] vs [[People/Carol]])\n";
    insertNode(db, "Wiki/People/alice", {
      title: "alice",
      frontmatter: wikiSourcesFrontmatter(sources, sources, "2026-05-01T00:00:00Z"),
      body: wikiBody,
    });
    insertNode(db, "People/Alice", { content_hash: "h1" });
    insertNode(db, "transcripts/ep-1", { content_hash: "h2" });

    const env = makeEnv(db);
    const result = JSON.parse(await toolTopicDossier(env, "alice"));

    expect(result.wiki_synthesis).toBeDefined();
    expect(result.wiki_synthesis.path).toBe("Wiki/People/alice");
    expect(result.wiki_synthesis.body_excerpt).toContain("Alice is a researcher");
    expect(result.wiki_synthesis.compiled_at).toBe("2026-05-01T00:00:00Z");
    expect(result.wiki_synthesis.contradiction_annotations).toHaveLength(1);
    expect(result.wiki_synthesis.contradiction_annotations[0].sourceA).toBe("People/Bob");
    expect(result.wiki_synthesis.contradiction_annotations[0].sourceB).toBe("People/Carol");
    expect(result.coverage.wiki_gap).toBe(false);
    expect(result.coverage.synthesis_source_count).toBe(2);
  });

  test("topic has no wiki page → returns null synthesis with FTS matches and wiki_gap", async () => {
    insertNode(db, "People/Unknown", {});
    insertFts(db, "People/Unknown", "Unknown Person", "Some content about an unknown person");

    const env = makeEnv(db);
    const result = JSON.parse(await toolTopicDossier(env, "unknown"));

    expect(result.wiki_synthesis).toBeNull();
    expect(result.coverage.wiki_gap).toBe(true);
    expect(result.synthesis_sources).toEqual([]);
  });

  test("wiki body contains contradiction annotations → parsed into array", async () => {
    const body = "Some content.\n(compare: [[People/Alice]] vs [[People/Bob]])\nMore content.\n(compare: [[Concepts/X]] vs. [[Concepts/Y]])\n";
    insertNode(db, "Wiki/Concepts/topic-x", {
      title: "topic-x",
      frontmatter: wikiSourcesFrontmatter(["Concepts/Topic X"]),
      body,
    });
    insertNode(db, "Concepts/Topic X", { content_hash: "h1" });

    const env = makeEnv(db);
    const result = JSON.parse(await toolTopicDossier(env, "topic-x"));

    expect(result.wiki_synthesis.contradiction_annotations).toHaveLength(2);
  });

  test("wiki page is stale → freshness_status reflects it", async () => {
    insertNode(db, "Wiki/People/alice", {
      title: "alice",
      frontmatter: wikiSourcesFrontmatter(["People/Alice", "People/Bob"], ["People/Alice", "People/Bob"], "2026-04-01T00:00:00Z"),
      body: "# Alice",
    });
    insertNode(db, "People/Alice", { content_hash: "h1" });
    // Bob is missing → triggers stale

    const env = makeEnv(db);
    const result = JSON.parse(await toolTopicDossier(env, "alice"));

    expect(result.wiki_synthesis.freshness_status).toBe("stale");
    expect(result.coverage.freshness_status).toBe("stale");
  });

  test("wiki page has 1 synthesis source → 'thin' freshness", async () => {
    insertNode(db, "Wiki/People/alice", {
      title: "alice",
      frontmatter: wikiSourcesFrontmatter(["People/Alice"], ["People/Alice"]),
      body: "# Alice",
    });
    insertNode(db, "People/Alice", { content_hash: "h1" });

    const env = makeEnv(db);
    const result = JSON.parse(await toolTopicDossier(env, "alice"));

    expect(result.wiki_synthesis.freshness_status).toBe("thin");
  });

  test("include_body=false → skips body, no contradiction annotations", async () => {
    const body = "# Alice\n\n(compare: [[A]] vs [[B]])\n";
    insertNode(db, "Wiki/People/alice", {
      title: "alice",
      frontmatter: wikiSourcesFrontmatter(["People/Alice"]),
      body,
    });
    insertNode(db, "People/Alice", { content_hash: "h1" });

    const env = makeEnv(db);
    const result = JSON.parse(await toolTopicDossier(env, "alice", false));

    expect(result.wiki_synthesis.body_excerpt).toBeNull();
    expect(result.wiki_synthesis.contradiction_annotations).toEqual([]);
  });

  test("FTS fallback finds wiki page when slug doesn't match directly", async () => {
    insertNode(db, "Wiki/Concepts/machine-learning", {
      title: "machine-learning",
      frontmatter: wikiSourcesFrontmatter(["Concepts/Machine Learning"]),
      body: "# Machine Learning",
    });
    insertNode(db, "Concepts/Machine Learning", { content_hash: "h1" });
    // FTS index with the wiki page path
    insertFts(db, "Wiki/Concepts/machine-learning", "Machine Learning", "Machine learning is a field of AI");

    const env = makeEnv(db);
    // Search by a topic string that won't match the slug directly
    const result = JSON.parse(await toolTopicDossier(env, "Machine Learning"));

    // Should find via FTS on Wiki/ paths
    expect(result.wiki_synthesis).toBeDefined();
    expect(result.wiki_synthesis.path).toBe("Wiki/Concepts/machine-learning");
  });
});

// ---------------------------------------------------------------------------
// parseContradictionAnnotations unit tests
// ---------------------------------------------------------------------------

describe("parseContradictionAnnotations", () => {
  test("parses standard compare pattern", () => {
    const body = "some text (compare: [[People/Alice]] vs [[People/Bob]]) more text";
    const result = parseContradictionAnnotations(body);
    expect(result).toEqual([{ sourceA: "People/Alice", sourceB: "People/Bob" }]);
  });

  test("parses multiple annotations", () => {
    const body = "(compare: [[A]] vs [[B]])\n(compare: [[C]] vs [[D]])";
    const result = parseContradictionAnnotations(body);
    expect(result).toHaveLength(2);
  });

  test("handles vs. with period", () => {
    const body = "(compare: [[A]] vs. [[B]])";
    const result = parseContradictionAnnotations(body);
    expect(result).toHaveLength(1);
  });

  test("handles extra whitespace", () => {
    const body = "(compare:  [[A]]   vs   [[B]] )";
    const result = parseContradictionAnnotations(body);
    expect(result).toHaveLength(1);
    expect(result[0].sourceA).toBe("A");
    expect(result[0].sourceB).toBe("B");
  });

  test("no annotations → empty array", () => {
    const body = "some text without any compare annotations";
    const result = parseContradictionAnnotations(body);
    expect(result).toEqual([]);
  });

  test("paths with spaces", () => {
    const body = "(compare: [[People/Elon Musk]] vs [[People/Sam Altman]])";
    const result = parseContradictionAnnotations(body);
    expect(result).toEqual([{ sourceA: "People/Elon Musk", sourceB: "People/Sam Altman" }]);
  });
});
