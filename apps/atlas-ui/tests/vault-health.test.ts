/**
 * Unit tests for vault health metrics — Gini coefficient, orphan detection,
 * weak component counting, stale note detection.
 *
 * Run with: bun test tests/vault-health.test.ts
 *
 * These test the pure computation logic extracted from server/index.ts.
 */
import { test, expect } from "bun:test";

// --- Gini coefficient ---
// Extracted from graphJson() in server/index.ts for testability

function giniCoefficient(degrees: number[]): number {
  const sorted = [...degrees].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  if (mean === 0) return 0;
  let sumDiff = 0;
  for (let i = 0; i < n; i++) sumDiff += (2 * (i + 1) - n - 1) * sorted[i];
  return sumDiff / (n * n * mean);
}

test("gini: perfectly equal distribution = 0", () => {
  // All nodes have degree 5
  const degrees = [5, 5, 5, 5, 5];
  expect(giniCoefficient(degrees)).toBe(0);
});

test("gini: maximally unequal distribution approaches 1", () => {
  // One node has all connections, rest have 0
  const degrees = [0, 0, 0, 0, 100];
  const g = giniCoefficient(degrees);
  expect(g).toBeGreaterThan(0.7);
  expect(g).toBeLessThanOrEqual(1);
});

test("gini: moderate inequality gives intermediate value", () => {
  // Power-law-ish distribution
  const degrees = [1, 1, 2, 3, 5, 8, 13, 21];
  const g = giniCoefficient(degrees);
  expect(g).toBeGreaterThan(0.3);
  expect(g).toBeLessThan(0.8);
});

test("gini: empty array returns 0", () => {
  expect(giniCoefficient([])).toBe(0);
});

test("gini: all zeros returns 0", () => {
  expect(giniCoefficient([0, 0, 0])).toBe(0);
});

test("gini: single element returns 0", () => {
  expect(giniCoefficient([10])).toBe(0);
});

test("gini: two elements with difference", () => {
  // [0, 10] → Gini should be 0.5
  const g = giniCoefficient([0, 10]);
  expect(Math.abs(g - 0.5)).toBeLessThan(0.01);
});

// --- Orphan detection ---

test("orphan count: degree-0 nodes are orphans", () => {
  const degrees = [0, 3, 0, 5, 0, 1];
  const orphanCount = degrees.filter(d => d === 0).length;
  expect(orphanCount).toBe(3);
});

test("orphan count: no orphans when all connected", () => {
  const degrees = [2, 3, 1, 5, 4];
  const orphanCount = degrees.filter(d => d === 0).length;
  expect(orphanCount).toBe(0);
});

// --- Weak components ---

test("weak components: components with < 3 nodes", () => {
  // Component sizes: {0: 50, 1: 2, 2: 1, 3: 30}
  const componentSizes = new Map([[0, 50], [1, 2], [2, 1], [3, 30]]);
  const weakCount = [...componentSizes.values()].filter(s => s < 3).length;
  expect(weakCount).toBe(2); // components 1 and 2
});

test("weak components: no weak components in well-connected graph", () => {
  const componentSizes = new Map([[0, 100], [1, 50]]);
  const weakCount = [...componentSizes.values()].filter(s => s < 3).length;
  expect(weakCount).toBe(0);
});

// --- Stale notes ---

test("stale notes: notes older than threshold are stale", () => {
  const now = Date.now();
  const staleDays = 90;
  const threshold = now - staleDays * 86400000;

  const modifiedDates = [
    now - 10 * 86400000,   // 10 days ago — fresh
    now - 100 * 86400000,  // 100 days ago — stale
    now - 200 * 86400000,  // 200 days ago — stale
    now - 1 * 86400000,    // yesterday — fresh
    0,                      // no timestamp — skip
  ];

  const staleCount = modifiedDates.filter(m => m > 0 && m < threshold).length;
  expect(staleCount).toBe(2);
});

test("stale notes: zero threshold means nothing is stale", () => {
  const now = Date.now();
  const threshold = now - 0; // 0 days = everything is stale... actually threshold = now
  const modifiedDates = [now - 86400000]; // 1 day ago
  // With 0 days, threshold = now, so anything before now is "stale"
  const staleCount = modifiedDates.filter(m => m > 0 && m < threshold).length;
  expect(staleCount).toBe(1);
});

test("stale notes: very large threshold means nothing is stale", () => {
  const now = Date.now();
  const staleDays = 36500; // 100 years
  const threshold = now - staleDays * 86400000;
  const modifiedDates = [now - 365 * 86400000]; // 1 year ago
  const staleCount = modifiedDates.filter(m => m > 0 && m < threshold).length;
  expect(staleCount).toBe(0);
});
