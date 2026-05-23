/**
 * algorithms.test.ts — Regression + correctness tests for the ported
 * graph algorithms (pagerank, louvain, components, clustering).
 *
 * Regression note: vault-mcp's broken computeCentrality() SQL loop
 * (src/index.ts:1693–1739) produces SUM(pagerank) ≈ 0.1587 on the vault
 * graph because it accumulates raw centrality scores without normalising.
 * The pagerank() test below asserts probability conservation (SUM ≈ 1.0),
 * locking in the fix and catching any future regression.
 */

import { describe, expect, test } from "bun:test";
import { pagerank } from "../src/algorithms/pagerank.ts";
import { louvain } from "../src/algorithms/louvain.ts";
import { connectedComponents } from "../src/algorithms/components.ts";
import { clusteringCoefficient } from "../src/algorithms/clustering.ts";
import type { PREdge } from "../src/algorithms/pagerank.ts";
import type { LouvainEdge } from "../src/algorithms/louvain.ts";
import type { CCEdge } from "../src/algorithms/components.ts";

// ---------------------------------------------------------------------------
// Deterministic fixture generator (seeded LCG, no external deps)
// ---------------------------------------------------------------------------

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 50-node / 200-edge random graph fixture (single connected component). */
function makeRandomGraph(nodes = 50, edges = 200, seed = 42) {
  const rng = lcg(seed);
  const edgeSet = new Set<string>();
  const result: PREdge[] = [];

  // First ensure connectivity with a chain
  for (let i = 0; i < nodes - 1; i++) {
    const key = `${i}:${i + 1}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      result.push({ source: i, target: i + 1, weight: 1 });
    }
  }

  // Fill remaining edges randomly
  let attempts = 0;
  while (result.length < edges && attempts < edges * 20) {
    attempts++;
    const s = Math.floor(rng() * nodes);
    const t = Math.floor(rng() * nodes);
    if (s === t) continue;
    const key = s < t ? `${s}:${t}` : `${t}:${s}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);
    result.push({ source: s, target: t, weight: 1 });
  }

  return result;
}

/**
 * Clustered fixture: 3 cliques of ~15 nodes each, connected by single bridge
 * edges. Louvain should find at least 3 communities.
 */
function makeClusteredGraph() {
  const edges: LouvainEdge[] = [];
  const cliqueSizes = [15, 15, 15];
  const offsets = [0, 15, 30];

  // Dense within-clique edges
  for (let c = 0; c < cliqueSizes.length; c++) {
    const base = offsets[c];
    const size = cliqueSizes[c];
    for (let i = 0; i < size; i++) {
      for (let j = i + 1; j < size; j++) {
        edges.push({ source: base + i, target: base + j, weight: 1 });
      }
    }
  }

  // Single bridge edges between cliques (weak inter-community links)
  edges.push({ source: 14, target: 15, weight: 1 }); // clique 0 → clique 1
  edges.push({ source: 29, target: 30, weight: 1 }); // clique 1 → clique 2

  return { nodeCount: 45, edges };
}

/** Two disjoint components: nodes 0–24 (component A) and 25–49 (component B). */
function makeDisjointGraph() {
  const edges: CCEdge[] = [];
  const rng = lcg(99);

  // Component A: chain + some extra edges within 0–24
  for (let i = 0; i < 24; i++) edges.push({ source: i, target: i + 1 });
  for (let k = 0; k < 20; k++) {
    const s = Math.floor(rng() * 25);
    const t = Math.floor(rng() * 25);
    if (s !== t) edges.push({ source: s, target: t });
  }

  // Component B: chain within 25–49
  for (let i = 25; i < 49; i++) edges.push({ source: i, target: i + 1 });

  return edges;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pagerank", () => {
  test("probability conservation on 50-node/200-edge fixture (regression: vault-mcp SUM=0.1587)", () => {
    const edges = makeRandomGraph(50, 200, 42);
    const ranks = pagerank(50, edges);

    let sum = 0;
    for (let i = 0; i < ranks.length; i++) sum += ranks[i];

    // Regression test: broken computeCentrality() produces SUM≈0.1587.
    // Correct pagerank sums to ≈1.0 (probability conservation).
    expect(sum).toBeGreaterThan(0.95);
    expect(sum).toBeLessThan(1.05);

    // No NaN values
    for (let i = 0; i < ranks.length; i++) {
      expect(Number.isNaN(ranks[i])).toBe(false);
    }

    // Every rank is positive
    for (let i = 0; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(0);
    }
  });

  test("empty graph returns empty array", () => {
    const result = pagerank(0, []);
    expect(result.length).toBe(0);
  });

  test("single node sums to 1", () => {
    const result = pagerank(1, []);
    expect(result[0]).toBeCloseTo(1.0, 5);
  });
});

describe("louvain", () => {
  test("detects ≥3 communities on 3-clique clustered fixture", () => {
    const { nodeCount, edges } = makeClusteredGraph();
    const result = louvain(nodeCount, edges);

    expect(result.communityCount).toBeGreaterThanOrEqual(3);
    expect(result.communities.length).toBe(nodeCount);
    expect(result.modularity).toBeGreaterThan(0);
  });

  test("every node is assigned a community", () => {
    const { nodeCount, edges } = makeClusteredGraph();
    const { communities } = louvain(nodeCount, edges);

    for (let i = 0; i < nodeCount; i++) {
      expect(communities[i]).toBeGreaterThanOrEqual(0);
    }
  });

  test("empty graph returns 0 communities", () => {
    const result = louvain(0, []);
    expect(result.communityCount).toBe(0);
  });
});

describe("connectedComponents", () => {
  test("two disjoint components returns componentCount === 2", () => {
    const edges = makeDisjointGraph();
    const result = connectedComponents(50, edges);

    expect(result.count).toBe(2);
    expect(result.components.length).toBe(50);
  });

  test("nodes 0–24 are in the same component", () => {
    const edges = makeDisjointGraph();
    const { components } = connectedComponents(50, edges);

    const compA = components[0];
    for (let i = 1; i < 25; i++) {
      expect(components[i]).toBe(compA);
    }
  });

  test("nodes 25–49 are in a different component from 0–24", () => {
    const edges = makeDisjointGraph();
    const { components } = connectedComponents(50, edges);

    const compA = components[0];
    const compB = components[25];
    expect(compA).not.toBe(compB);
    for (let i = 25; i < 50; i++) {
      expect(components[i]).toBe(compB);
    }
  });

  test("fully connected graph has 1 component", () => {
    const edges = makeRandomGraph(50, 200, 42) as CCEdge[];
    const result = connectedComponents(50, edges);
    expect(result.count).toBe(1);
  });

  test("empty graph returns 0 components", () => {
    const result = connectedComponents(0, []);
    expect(result.count).toBe(0);
  });
});

describe("clusteringCoefficient", () => {
  test("all coefficients are in [0, 1]", () => {
    const edges = makeRandomGraph(50, 200, 42) as CLEdge[];
    const { coefficients } = clusteringCoefficient(50, edges);

    for (let i = 0; i < coefficients.length; i++) {
      expect(coefficients[i]).toBeGreaterThanOrEqual(0);
      expect(coefficients[i]).toBeLessThanOrEqual(1);
    }
  });

  test("no NaN values", () => {
    const edges = makeRandomGraph(50, 200, 42) as CLEdge[];
    const { coefficients } = clusteringCoefficient(50, edges);

    for (let i = 0; i < coefficients.length; i++) {
      expect(Number.isNaN(coefficients[i])).toBe(false);
    }
  });

  test("fully-connected 5-node clique has CC=1 for all nodes", () => {
    const edges: CLEdge[] = [];
    for (let i = 0; i < 5; i++) {
      for (let j = i + 1; j < 5; j++) {
        edges.push({ source: i, target: j });
      }
    }
    const { coefficients } = clusteringCoefficient(5, edges);
    for (let i = 0; i < 5; i++) {
      expect(coefficients[i]).toBeCloseTo(1.0, 5);
    }
  });

  test("average is in [0, 1]", () => {
    const edges = makeRandomGraph(50, 200, 42) as CLEdge[];
    const { average } = clusteringCoefficient(50, edges);
    expect(average).toBeGreaterThanOrEqual(0);
    expect(average).toBeLessThanOrEqual(1);
  });

  test("empty graph returns average 0", () => {
    const { average } = clusteringCoefficient(0, []);
    expect(average).toBe(0);
  });
});
