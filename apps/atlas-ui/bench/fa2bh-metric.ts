/**
 * fa2bh-metric.ts — autoresearch metric for the FA2+BH TS port.
 *
 * Mirrors bench/fa3-metric.ts's structure: runs FA2 reference (graphology JS)
 * for the quality baseline, runs our FA2-BH port, computes Pearson + crossings,
 * combines into a single METRIC value for the autoresearch loop.
 *
 * Formula: METRIC = (pearson * crossings_score) / time_seconds
 *   pearson         — correlation of sampled pairwise distances vs JS FA2
 *   crossings_score — clamp(fa2_crossings / fa2bh_crossings, 0, 1.5)
 *
 * Higher is better. Baseline = initial port performance on the vault.
 *
 * Usage: bun run bench/fa2bh-metric.ts [--vault path] [--iterations N]
 */

import { parseArgs } from "util";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { circular } from "graphology-layout";
import { parseVault } from "../src/core/parser";
import { buildEdges } from "../src/core/graph-builder";
import {
  buildMatrices,
  readPositions,
  inferSettings,
  DEFAULT_SETTINGS,
  run,
  type FA2BHSettings,
  type NodeInput,
  type EdgeInput,
} from "../src/core/forceatlas2_bh";

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

const notes = await parseVault(vaultPath);
const edges = buildEdges(notes);
console.log(`Vault: ${notes.length} notes, ${edges.length} edges`);

// --- FA2 reference layout (graphology JS FA2 with BH) ---
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
    /* skip duplicates */
  }
}

console.log("Computing FA2 reference layout (graphology JS BH)...");
circular.assign(graph, { scale: 1000 });
const fa2Settings = forceAtlas2.inferSettings(graph);
const fa2Start = performance.now();
forceAtlas2.assign(graph, { iterations, settings: fa2Settings });
const fa2Time = performance.now() - fa2Start;
console.log(`FA2 reference: ${iterations} iters in ${fa2Time.toFixed(0)}ms`);

const fa2Positions: Array<{ x: number; y: number }> = [];
graph.forEachNode((_node, attr) => {
  fa2Positions.push({ x: attr.x, y: attr.y });
});

// --- FA2-BH (our port) ---
const startX = new Float32Array(notes.length);
const startY = new Float32Array(notes.length);
for (let i = 0; i < notes.length; i++) {
  const angle = (2 * Math.PI * i) / notes.length;
  startX[i] = 1000 * Math.cos(angle);
  startY[i] = 1000 * Math.sin(angle);
}
const fa2bhNodes: NodeInput[] = notes.map((_n, i) => ({
  x: startX[i],
  y: startY[i],
  size: 5,
}));

const fa2bhEdges: EdgeInput[] = [];
for (const edge of edges) {
  const si = nodeIndex.get(edge.source);
  const ti = nodeIndex.get(edge.target);
  if (si !== undefined && ti !== undefined) {
    fa2bhEdges.push({ source: si, target: ti, weight: edge.weight });
  }
}

// Dedupe (graphology rejects duplicates, so FA2-BH must match for fair Pearson)
const seen = new Set<string>();
const dedupEdges: EdgeInput[] = [];
for (const e of fa2bhEdges) {
  const key = e.source < e.target ? `${e.source}:${e.target}` : `${e.target}:${e.source}`;
  if (!seen.has(key)) {
    seen.add(key);
    dedupEdges.push(e);
  }
}

const matrices = buildMatrices(fa2bhNodes, dedupEdges);

console.log("Running FA2-BH (TS port)...");
const mergedSettings: FA2BHSettings = {
  ...DEFAULT_SETTINGS,
  ...inferSettings(notes.length),
};
const fa2bhTime = run(mergedSettings, matrices.nodes, matrices.edges, iterations);
console.log(`FA2-BH: ${iterations} iters in ${fa2bhTime.toFixed(0)}ms`);

const fa2bhPositions = readPositions(matrices.nodes);

// --- Quality: sampled pairwise distance Pearson correlation vs FA2 reference ---
const SAMPLE_SIZE = 2000;
const numNodes = notes.length;
const fa2Dists: number[] = [];
const fa2bhDists: number[] = [];
const stride = Math.max(1, Math.floor((numNodes * numNodes) / SAMPLE_SIZE));
let pairCount = 0;
for (let k = 0; k < numNodes * numNodes && pairCount < SAMPLE_SIZE; k += stride) {
  const i = Math.floor(k / numNodes);
  const j = k % numNodes;
  if (i >= j) continue;
  const f2dx = fa2Positions[i].x - fa2Positions[j].x;
  const f2dy = fa2Positions[i].y - fa2Positions[j].y;
  fa2Dists.push(Math.sqrt(f2dx * f2dx + f2dy * f2dy));
  const f2bdx = fa2bhPositions[i].x - fa2bhPositions[j].x;
  const f2bdy = fa2bhPositions[i].y - fa2bhPositions[j].y;
  fa2bhDists.push(Math.sqrt(f2bdx * f2bdx + f2bdy * f2bdy));
  pairCount++;
}
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let sa = 0, sb = 0, sab = 0, sa2 = 0, sb2 = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i]; sb += b[i]; sab += a[i] * b[i]; sa2 += a[i] * a[i]; sb2 += b[i] * b[i];
  }
  const num = n * sab - sa * sb;
  const den = Math.sqrt((n * sa2 - sa * sa) * (n * sb2 - sb * sb));
  return den === 0 ? 0 : num / den;
}
const quality = pearson(fa2Dists, fa2bhDists);
console.log(`Pearson vs JS FA2: ${quality.toFixed(4)}  (${pairCount} pairs)`);

// --- Edge crossings for both, then crossings_score ---
const CROSSINGS_CAP = 2000;
function countCrossings(
  positions: Array<{ x: number; y: number }>,
  edgeList: typeof edges,
  cap: number,
): number {
  const src: number[] = [];
  const tgt: number[] = [];
  for (const e of edgeList) {
    const si = nodeIndex.get(e.source);
    const ti = nodeIndex.get(e.target);
    if (si === undefined || ti === undefined || si === ti) continue;
    src.push(si);
    tgt.push(ti);
    if (src.length >= cap) break;
  }
  const m = src.length;
  const ccw = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): boolean =>
    (ry - py) * (qx - px) > (qy - py) * (rx - px);
  let c = 0;
  for (let i = 0; i < m - 1; i++) {
    const ax = positions[src[i]].x, ay = positions[src[i]].y;
    const bx = positions[tgt[i]].x, by = positions[tgt[i]].y;
    const si = src[i], ti = tgt[i];
    for (let j = i + 1; j < m; j++) {
      const sj = src[j], tj = tgt[j];
      if (sj === si || sj === ti || tj === si || tj === ti) continue;
      const cx = positions[sj].x, cy = positions[sj].y;
      const dx = positions[tj].x, dy = positions[tj].y;
      if (
        ccw(ax, ay, cx, cy, dx, dy) !== ccw(bx, by, cx, cy, dx, dy) &&
        ccw(ax, ay, bx, by, cx, cy) !== ccw(ax, ay, bx, by, dx, dy)
      ) c++;
    }
  }
  return c;
}
const fa2Crossings = countCrossings(fa2Positions, edges, CROSSINGS_CAP);
const fa2bhCrossings = countCrossings(fa2bhPositions, edges, CROSSINGS_CAP);
console.log(`Crossings  FA2: ${fa2Crossings}  FA2-BH: ${fa2bhCrossings}`);

const crossingsScore = Math.max(
  0,
  Math.min(1.5, fa2bhCrossings === 0 ? 1.5 : fa2Crossings / fa2bhCrossings),
);

// --- Combined metric ---
const timeSeconds = fa2bhTime / 1000;
const combinedQuality = quality * crossingsScore;
const metric = combinedQuality / timeSeconds;

console.log(`\nFA2 time:      ${(fa2Time / 1000).toFixed(2)}s`);
console.log(`FA2-BH time:   ${timeSeconds.toFixed(2)}s`);
console.log(`Speedup:       ${(fa2Time / fa2bhTime).toFixed(2)}x`);
console.log(`Pearson:       ${quality.toFixed(4)}`);
console.log(`Cross score:   ${crossingsScore.toFixed(4)}  (FA2 ${fa2Crossings} / FA2-BH ${fa2bhCrossings})`);
console.log(`Comb quality:  ${combinedQuality.toFixed(4)}`);
console.log(`\nMETRIC: ${metric.toFixed(4)}`);
