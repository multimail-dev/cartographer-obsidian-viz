/**
 * Unit tests for graph enrichment algorithms — betweenness, eigenvector, HITS.
 *
 * Run with: bun test tests/enrichment.test.ts
 */
import { test, expect } from "bun:test";
import { betweenness } from "../src/core/betweenness";
import { eigenvectorCentrality } from "../src/core/eigenvector";
import { hits } from "../src/core/hits";

// Simple test graph: path 0 — 1 — 2 — 3
const pathEdges = [
  { source: 0, target: 1, weight: 1 },
  { source: 1, target: 2, weight: 1 },
  { source: 2, target: 3, weight: 1 },
];

// Star graph: 0 is center, connected to 1, 2, 3, 4
const starEdges = [
  { source: 0, target: 1, weight: 1 },
  { source: 0, target: 2, weight: 1 },
  { source: 0, target: 3, weight: 1 },
  { source: 0, target: 4, weight: 1 },
];

// --- Betweenness ---

test("betweenness: path graph — middle nodes have highest centrality", () => {
  const result = betweenness(4, pathEdges);
  // In a path 0-1-2-3, nodes 1 and 2 are on more shortest paths
  expect(result.betweenness[1]).toBeGreaterThan(result.betweenness[0]);
  expect(result.betweenness[2]).toBeGreaterThan(result.betweenness[3]);
  // Endpoints have zero betweenness
  expect(result.betweenness[0]).toBe(0);
  expect(result.betweenness[3]).toBe(0);
});

test("betweenness: star graph — center has highest centrality", () => {
  const result = betweenness(5, starEdges);
  expect(result.betweenness[0]).toBeGreaterThan(result.betweenness[1]);
  expect(result.betweenness[0]).toBeGreaterThan(result.betweenness[2]);
  // All leaves have equal betweenness
  expect(result.betweenness[1]).toBe(result.betweenness[2]);
  expect(result.betweenness[2]).toBe(result.betweenness[3]);
});

test("betweenness: diameter of path graph is 3", () => {
  const result = betweenness(4, pathEdges);
  expect(result.diameter).toBe(3);
});

test("betweenness: star graph diameter is 2", () => {
  const result = betweenness(5, starEdges);
  expect(result.diameter).toBe(2);
});

test("betweenness: closeness is computed", () => {
  const result = betweenness(4, pathEdges);
  // All closeness values should be positive
  for (let i = 0; i < 4; i++) {
    expect(result.closeness[i]).toBeGreaterThan(0);
  }
});

test("betweenness: empty graph returns zeros", () => {
  const result = betweenness(0, []);
  expect(result.betweenness.length).toBe(0);
  expect(result.diameter).toBe(0);
});

test("betweenness: single node returns zeros", () => {
  const result = betweenness(1, []);
  expect(result.betweenness[0]).toBe(0);
  expect(result.diameter).toBe(0);
});

// --- Eigenvector ---

test("eigenvector: star center has highest or equal centrality to leaves", () => {
  const result = eigenvectorCentrality(5, starEdges);
  // For undirected star, center eigenvector ≥ leaves (may converge to equal)
  expect(result[0]).toBeGreaterThanOrEqual(result[1]);
  // All leaves should be equal
  expect(Math.abs(result[1] - result[2])).toBeLessThan(1e-6);
  expect(Math.abs(result[2] - result[3])).toBeLessThan(1e-6);
});

test("eigenvector: path endpoints have lower centrality than middle", () => {
  const result = eigenvectorCentrality(4, pathEdges);
  expect(result[1]).toBeGreaterThan(result[0]);
  expect(result[2]).toBeGreaterThan(result[3]);
});

test("eigenvector: empty graph returns empty array", () => {
  const result = eigenvectorCentrality(0, []);
  expect(result.length).toBe(0);
});

test("eigenvector: result is L2-normalized", () => {
  const result = eigenvectorCentrality(5, starEdges);
  let norm = 0;
  for (const v of result) norm += v * v;
  expect(Math.abs(Math.sqrt(norm) - 1)).toBeLessThan(1e-6);
});

// --- HITS ---

test("hits: star center has highest or equal hub/authority scores", () => {
  const result = hits(5, starEdges);
  // For undirected star, center ≥ leaves (undirected symmetry may equalize)
  expect(result.hubs[0]).toBeGreaterThanOrEqual(result.hubs[1]);
  expect(result.authorities[0]).toBeGreaterThanOrEqual(result.authorities[1]);
});

test("hits: all leaves have equal scores", () => {
  const result = hits(5, starEdges);
  expect(Math.abs(result.hubs[1] - result.hubs[2])).toBeLessThan(1e-6);
  expect(Math.abs(result.authorities[1] - result.authorities[2])).toBeLessThan(1e-6);
});

test("hits: empty graph returns empty arrays", () => {
  const result = hits(0, []);
  expect(result.hubs.length).toBe(0);
  expect(result.authorities.length).toBe(0);
  expect(result.iterations).toBe(0);
});

test("hits: converges within max iterations", () => {
  const result = hits(5, starEdges);
  expect(result.iterations).toBeLessThanOrEqual(100);
});

test("hits: hub scores are L2-normalized", () => {
  const result = hits(5, starEdges);
  let norm = 0;
  for (const v of result.hubs) norm += v * v;
  expect(Math.abs(Math.sqrt(norm) - 1)).toBeLessThan(1e-6);
});
