import Graph from "graphology";
import { circular } from "graphology-layout";
import { parseVault } from "../src/core/parser";
import { buildEdges } from "../src/core/graph-builder";
import { buildMatrices, inferSettings, DEFAULT_SETTINGS, type FA3Settings } from "../src/core/forceatlas3";

const vaultPath = (Bun.argv[2] || "~/.obsidian-vault").replace("~", process.env.HOME!);
const notes = await parseVault(vaultPath);
const edges = buildEdges(notes);

const nodeIndex = new Map<string, number>();
for (let i = 0; i < notes.length; i++) nodeIndex.set(notes[i].id, i);

const fa3Nodes = notes.map((_n, i) => ({
  x: 1000 * Math.cos((2 * Math.PI * i) / notes.length),
  y: 1000 * Math.sin((2 * Math.PI * i) / notes.length),
  size: 5,
}));

const seen = new Set<string>();
const dedup = [];
for (const e of edges) {
  const si = nodeIndex.get(e.source), ti = nodeIndex.get(e.target);
  if (si === undefined || ti === undefined) continue;
  const key = si < ti ? `${si}:${ti}` : `${ti}:${si}`;
  if (!seen.has(key)) { seen.add(key); dedup.push({ source: si, target: ti, weight: e.weight }); }
}

const m = buildMatrices(fa3Nodes, dedup);
const settings: FA3Settings = { ...DEFAULT_SETTINGS, ...inferSettings(notes.length) };

// Import iterate directly and time sections
const { iterate } = await import("../src/core/forceatlas3");

// Warm up
for (let i = 0; i < 5; i++) iterate(settings, m.nodes, m.edges, i);

// Profile 20 iterations
const t0 = performance.now();
for (let i = 0; i < 20; i++) iterate(settings, m.nodes, m.edges, i);
const total = performance.now() - t0;

console.log(`20 iterations: ${total.toFixed(0)}ms (${(total/20).toFixed(1)}ms/iter)`);
console.log(`Projected 100 iterations: ${(total*5).toFixed(0)}ms`);
