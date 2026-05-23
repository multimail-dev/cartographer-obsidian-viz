/**
 * Unit tests for src/power/adapter.ts.
 *
 * Run with: bun test tests/power-adapter.test.ts
 *
 * Uses bun's built-in test runner + a mocked fetch. Verifies that the
 * adapter constructs the right URLs, handles pagination correctly, and
 * attaches Bearer auth when configured.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { createPowerSource, fetchBridges } from "../src/power/adapter.ts";

let originalFetch: typeof fetch;
let fetchCalls: Array<{ url: string; init?: RequestInit }>;

function mockFetch(responder: (url: string) => Response | Promise<Response>) {
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, init });
    return responder(url);
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("load() paginates /api/graph/nodes and /api/graph/edges until nextCursor is null", async () => {
  mockFetch((url) => {
    if (url.includes("/api/graph/nodes")) {
      const parsed = new URL(url);
      const cursor = parsed.searchParams.get("cursor") ?? "";
      if (cursor === "") {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "a",
                title: "A",
                folder: "",
                nodeType: "idea",
                frontmatter: {},
                tags: [],
                wordCount: 10,
                created: 1,
                modified: 2,
                contentHash: "h1",
                embeddingVersion: 1,
                ingestRunId: "r1",
                x: null,
                y: null,
              },
            ],
            nextCursor: "a",
            total: 2,
          }),
          { status: 200 },
        );
      }
      if (cursor === "a") {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "b",
                title: "B",
                folder: "",
                nodeType: "note",
                frontmatter: {},
                tags: [],
                wordCount: 20,
                created: 3,
                modified: 4,
                contentHash: "h2",
                embeddingVersion: 0,
                ingestRunId: "r1",
                x: null,
                y: null,
              },
            ],
            nextCursor: null,
            total: 2,
          }),
          { status: 200 },
        );
      }
    }
    if (url.includes("/api/graph/edges")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "a|b|wikilink",
              sourceId: "a",
              targetId: "b",
              edgeType: "wikilink",
              weight: 1,
              ingestRunId: "r1",
            },
          ],
          nextCursor: null,
          total: 1,
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  });

  const source = createPowerSource({ baseUrl: "https://example.test" });
  const graph = await source.load();

  expect(graph.nodes.length).toBe(2);
  expect(graph.edges.length).toBe(1);
  expect(graph.nodes[0]!.id).toBe("a");
  expect(graph.nodes[1]!.id).toBe("b");
  expect(graph.edges[0]!.source).toBe("a");
  expect(graph.edges[0]!.target).toBe("b");
  expect(graph.edges[0]!.type).toBe("wikilink");
});

test("load() attaches Bearer auth when configured", async () => {
  mockFetch(() =>
    new Response(JSON.stringify({ items: [], nextCursor: null, total: 0 }), { status: 200 }),
  );

  const source = createPowerSource({
    baseUrl: "https://example.test",
    bearer: "test-token-123",
  });
  await source.load();

  // Every fetch call should include the bearer header
  for (const call of fetchCalls) {
    const headers = call.init?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer test-token-123");
  }
});

test("load() uses credentials: include when no bearer is set", async () => {
  mockFetch(() =>
    new Response(JSON.stringify({ items: [], nextCursor: null, total: 0 }), { status: 200 }),
  );

  const source = createPowerSource({ baseUrl: "https://example.test" });
  await source.load();

  for (const call of fetchCalls) {
    expect(call.init?.credentials).toBe("include");
  }
});

test("search() returns the results array from /api/search", async () => {
  mockFetch((url) => {
    expect(url).toContain("/api/search?q=karpathy");
    return new Response(JSON.stringify({ results: ["a", "b", "c"] }), { status: 200 });
  });

  const source = createPowerSource({ baseUrl: "https://example.test" });
  const results = await source.search("karpathy");
  expect(results).toEqual(["a", "b", "c"]);
});

test("getNote() returns raw text from /api/note", async () => {
  mockFetch((url) => {
    expect(url).toContain("/api/note?path=notes%2Ffoo");
    return new Response("# Foo\n\nBody text", { status: 200 });
  });

  const source = createPowerSource({ baseUrl: "https://example.test" });
  const body = await source.getNote("notes/foo");
  expect(body).toBe("# Foo\n\nBody text");
});

test("search() throws on non-ok responses", async () => {
  mockFetch(() => new Response("error", { status: 500 }));
  const source = createPowerSource({ baseUrl: "https://example.test" });
  await expect(source.search("x")).rejects.toThrow(/power-mode \/api\/search/);
});

test("load() throws on non-ok page response", async () => {
  mockFetch(() => new Response("error", { status: 500 }));
  const source = createPowerSource({ baseUrl: "https://example.test" });
  await expect(source.load()).rejects.toThrow(/power-mode/);
});

test("fetchBridges() returns null on non-ok response", async () => {
  mockFetch(() => new Response("error", { status: 503 }));
  const res = await fetchBridges(
    { baseUrl: "https://example.test" },
    "a",
    "b",
  );
  expect(res).toBeNull();
});

test("fetchBridges() returns parsed response on success", async () => {
  const payload = {
    from: "a",
    to: "b",
    paths: [{ nodes: ["a", "mid", "b"], cost: 0.42, semantic_score: 0.87 }],
    truncated: false,
    budget_ms_used: 120,
    disconnected: false,
  };
  mockFetch((url) => {
    expect(url).toContain("/api/bridges?from=a&to=b");
    expect(url).toContain("max_hops=3");
    expect(url).toContain("k=5");
    return new Response(JSON.stringify(payload), { status: 200 });
  });

  const res = await fetchBridges(
    { baseUrl: "https://example.test" },
    "a",
    "b",
    { maxHops: 3, k: 5 },
  );
  expect(res).not.toBeNull();
  expect(res!.paths.length).toBe(1);
  expect(res!.paths[0]!.nodes).toEqual(["a", "mid", "b"]);
});
