/**
 * ForceAtlas3 Auto-Research Metric
 *
 * Measures TWO things and combines them into a single score:
 * 1. SPEED: wall-clock time for layout convergence
 * 2. QUALITY: layout quality vs FA2 reference (stress correlation)
 *
 * Metric = quality_score / time_seconds
 *   Higher is better. Units: "quality per second"
 *
 * Quality is measured as Pearson correlation between pairwise distances
 * in the FA3 layout vs the FA2 reference layout (sampled, not exhaustive).
 *
 * Usage: bun run bench/fa3-metric.ts [--vault path] [--iterations N]
 *
 * Output format (auto-research reads the last METRIC line):
 *   METRIC: <number>
 */

import { parseArgs } from "util";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { circular } from "graphology-layout";
import { parseVault } from "../src/core/parser";
import { buildEdges } from "../src/core/graph-builder";
import {
  iterate,
  buildMatrices,
  readPositions,
  inferSettings,
  DEFAULT_SETTINGS,
  run,
  type FA3Settings,
  type NodeInput,
  type EdgeInput,
} from "../src/core/forceatlas3";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    vault: { type: "string", short: "v", default: "~/.obsidian-vault" },
    iterations: { type: "string", short: "i", default: "100" },
  },
  strict: true,
});

const vaultPath = (values.vault ?? "~/.obsidian-vault").replace("~", process.env.HOME!);
const iterations = parseInt(values.iterations ?? "100");

// --- Load vault data ---
const notes = await parseVault(vaultPath);
const edges = buildEdges(notes);
console.log(`Vault: ${notes.length} notes, ${edges.length} edges`);

// --- Build graphology graph for FA2 reference ---
const graph = new Graph();
const nodeIndex = new Map<string, number>();
for (let i = 0; i < notes.length; i++) {
  const note = notes[i];
  nodeIndex.set(note.id, i);
  graph.addNode(note.id, { label: note.title, size: 5 });
}
for (const edge of edges) {
  try {
    graph.addEdge(edge.source, edge.target, { weight: edge.weight, edgeType: edge.type });
  } catch {
    // skip duplicates
  }
}

// --- FA2 reference layout ---
console.log("Computing FA2 reference layout...");
circular.assign(graph, { scale: 1000 });
const fa2Settings = forceAtlas2.inferSettings(graph);
const fa2Start = performance.now();
forceAtlas2.assign(graph, { iterations, settings: fa2Settings });
const fa2Time = performance.now() - fa2Start;
console.log(`FA2 reference: ${iterations} iterations in ${fa2Time.toFixed(0)}ms`);

// Extract FA2 reference positions
const fa2Positions: Array<{ x: number; y: number }> = [];
graph.forEachNode((_node, attr) => {
  fa2Positions.push({ x: attr.x, y: attr.y });
});

// --- Build FA3 matrices ---
// Build node inputs with circular positions (same starting point)
const fa3Nodes: NodeInput[] = notes.map((_note, i) => {
  const angle = (2 * Math.PI * i) / notes.length;
  return {
    x: 1000 * Math.cos(angle),
    y: 1000 * Math.sin(angle),
    size: 5,
  };
});

// Build edge inputs — need to map string IDs to indices
const fa3Edges: EdgeInput[] = [];
for (const edge of edges) {
  const si = nodeIndex.get(edge.source);
  const ti = nodeIndex.get(edge.target);
  if (si !== undefined && ti !== undefined) {
    fa3Edges.push({ source: si, target: ti, weight: edge.weight });
  }
}

// Deduplicate edges (same as graphology does)
const seenEdges = new Set<string>();
const dedupEdges: EdgeInput[] = [];
for (const e of fa3Edges) {
  const key = e.source < e.target ? `${e.source}:${e.target}` : `${e.target}:${e.source}`;
  if (!seenEdges.has(key)) {
    seenEdges.add(key);
    dedupEdges.push(e);
  }
}

const matrices = buildMatrices(fa3Nodes, dedupEdges);

// --- Run FA3 ---
console.log("Running FA3...");
const mergedSettings: FA3Settings = { ...DEFAULT_SETTINGS, ...inferSettings(notes.length) };
const fa3Time = run(mergedSettings, matrices.nodes, matrices.edges, iterations);
console.log(`FA3: ${iterations} iterations in ${fa3Time.toFixed(0)}ms`);

const fa3Positions = readPositions(matrices.nodes);

// --- Quality metric: sampled pairwise distance correlation ---
// Full pairwise is O(n²) — sample 2000 random pairs
const SAMPLE_SIZE = 2000;
const numNodes = notes.length;
const fa2Dists: number[] = [];
const fa3Dists: number[] = [];

// Deterministic "random" pairs via stride
const stride = Math.max(1, Math.floor((numNodes * numNodes) / SAMPLE_SIZE));
let pairCount = 0;

for (let k = 0; k < numNodes * numNodes && pairCount < SAMPLE_SIZE; k += stride) {
  const i = Math.floor(k / numNodes);
  const j = k % numNodes;
  if (i >= j) continue;

  const fa2dx = fa2Positions[i].x - fa2Positions[j].x;
  const fa2dy = fa2Positions[i].y - fa2Positions[j].y;
  const fa2d = Math.sqrt(fa2dx * fa2dx + fa2dy * fa2dy);

  const fa3dx = fa3Positions[i].x - fa3Positions[j].x;
  const fa3dy = fa3Positions[i].y - fa3Positions[j].y;
  const fa3d = Math.sqrt(fa3dx * fa3dx + fa3dy * fa3dy);

  fa2Dists.push(fa2d);
  fa3Dists.push(fa3d);
  pairCount++;
}

// Pearson correlation
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
    sumAB += a[i] * b[i];
    sumA2 += a[i] * a[i];
    sumB2 += b[i] * b[i];
  }
  const num = n * sumAB - sumA * sumB;
  const den = Math.sqrt((n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB));
  return den === 0 ? 0 : num / den;
}

const quality = pearson(fa2Dists, fa3Dists);
console.log(`Quality (Pearson correlation vs FA2): ${quality.toFixed(4)}`);
console.log(`Sampled ${pairCount} pairs`);

// --- Edge-crossing count on both layouts ---
// Vectorized O(E²) segment-intersection on the first N edges (deterministic
// slice, not random). Cap at 2000 edges → ~2M pairs → sub-second in TS.
// Rationale: Pearson correlation on pairwise distances doesn't catch edge
// tangling — an optimization can preserve distances while making the picture
// visually worse. The crossings penalty bakes visual cleanliness directly
// into the metric.
const CROSSINGS_CAP = 2000;
function countEdgeCrossings(
  positions: Array<{ x: number; y: number }>,
  edgeList: Array<{ source: string | number; target: string | number }>,
  indexByNoteId: Map<string, number>,
  cap: number,
): number {
  // Materialize a typed edge array: (si, ti) pairs, skipping dangling.
  const src: number[] = [];
  const tgt: number[] = [];
  for (const e of edgeList) {
    const si = typeof e.source === "number" ? e.source : indexByNoteId.get(e.source as string);
    const ti = typeof e.target === "number" ? e.target : indexByNoteId.get(e.target as string);
    if (si === undefined || ti === undefined || si === ti) continue;
    src.push(si);
    tgt.push(ti);
    if (src.length >= cap) break;
  }
  const m = src.length;
  function ccw(px: number, py: number, qx: number, qy: number, rx: number, ry: number): boolean {
    return (ry - py) * (qx - px) > (qy - py) * (rx - px);
  }
  let crossings = 0;
  for (let i = 0; i < m - 1; i++) {
    const ax = positions[src[i]].x;
    const ay = positions[src[i]].y;
    const bx = positions[tgt[i]].x;
    const by = positions[tgt[i]].y;
    const si = src[i], ti = tgt[i];
    for (let j = i + 1; j < m; j++) {
      const sj = src[j], tj = tgt[j];
      if (sj === si || sj === ti || tj === si || tj === ti) continue; // share endpoint
      const cx = positions[sj].x;
      const cy = positions[sj].y;
      const dx = positions[tj].x;
      const dy = positions[tj].y;
      if (
        ccw(ax, ay, cx, cy, dx, dy) !== ccw(bx, by, cx, cy, dx, dy) &&
        ccw(ax, ay, bx, by, cx, cy) !== ccw(ax, ay, bx, by, dx, dy)
      ) {
        crossings++;
      }
    }
  }
  return crossings;
}

console.log("Counting edge crossings (first 2000 edges)...");
const edgeListForCrossings = edges.map((e) => ({ source: e.source, target: e.target }));
const fa2CrossStart = performance.now();
const fa2Crossings = countEdgeCrossings(fa2Positions, edgeListForCrossings, nodeIndex, CROSSINGS_CAP);
const fa2CrossTime = performance.now() - fa2CrossStart;
const fa3CrossStart = performance.now();
const fa3Crossings = countEdgeCrossings(fa3Positions, edgeListForCrossings, nodeIndex, CROSSINGS_CAP);
const fa3CrossTime = performance.now() - fa3CrossStart;
console.log(`FA2 crossings: ${fa2Crossings}  (${fa2CrossTime.toFixed(0)}ms)`);
console.log(`FA3 crossings: ${fa3Crossings}  (${fa3CrossTime.toFixed(0)}ms)`);

// Crossings score: ratio of FA2 (reference) crossings to FA3 crossings.
// 1.0 = FA3 matches FA2. >1 = FA3 has fewer crossings (better). <1 = FA3 is worse.
// Clamped to [0, 1.5] so a huge regression can't make the metric zero and a
// huge improvement can't dominate the speed axis.
const crossingsScoreRaw = fa3Crossings === 0 ? 1.5 : fa2Crossings / fa3Crossings;
const crossingsScore = Math.max(0, Math.min(1.5, crossingsScoreRaw));

// --- Combined metric ---
// metric = (pearson * crossings_score) / time_seconds
// - Pearson rewards distance preservation
// - Crossings_score rewards visual cleanliness relative to the FA2 reference
// - Dividing by time rewards speed
// Higher = better. A port that exactly matches FA2 on quality AND crossings
// at the same speed would score 1.0 / fa2_seconds.
const timeSeconds = fa3Time / 1000;
const combinedQuality = quality * crossingsScore;
const metric = combinedQuality / timeSeconds;

console.log(`\nFA2 time: ${(fa2Time / 1000).toFixed(2)}s`);
console.log(`FA3 time: ${timeSeconds.toFixed(2)}s`);
console.log(`Speedup: ${(fa2Time / fa3Time).toFixed(2)}x`);
console.log(`Pearson quality: ${quality.toFixed(4)}`);
console.log(`Crossings score: ${crossingsScore.toFixed(4)}  (FA2 ${fa2Crossings} / FA3 ${fa3Crossings})`);
console.log(`Combined quality: ${combinedQuality.toFixed(4)}`);
console.log(`\nMETRIC: ${metric.toFixed(4)}`);
