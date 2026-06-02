import { parseVault } from "../src/core/parser";
import { buildEdges } from "../src/core/graph-builder";

const vaultPath = (Bun.argv[2] || "~/.obsidian-vault").replace("~", process.env.HOME!);
const notes = await parseVault(vaultPath);
const N = notes.length;

// Simulate circular layout (what FA3 starts with)
const positions = notes.map((_, i) => ({
  x: 1000 * Math.cos(2 * Math.PI * i / N),
  y: 1000 * Math.sin(2 * Math.PI * i / N),
}));

const GRID_K = Math.max(4, Math.ceil(Math.sqrt(N) / 3));
const cellCount = new Int32Array(GRID_K * GRID_K);

let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (const p of positions) {
  if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
  if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
}
const invCellW = GRID_K / ((maxX - minX) || 1);
const invCellH = GRID_K / ((maxY - minY) || 1);

for (const p of positions) {
  const cx = Math.min(GRID_K - 1, ((p.x - minX) * invCellW) | 0);
  const cy = Math.min(GRID_K - 1, ((p.y - minY) * invCellH) | 0);
  cellCount[cy * GRID_K + cx]++;
}

const counts = Array.from(cellCount).filter(c => c > 0).sort((a, b) => b - a);
const maxCell = counts[0];
const top5 = counts.slice(0, 5);
const emptyCount = GRID_K * GRID_K - counts.length;

console.log(`Vault: ${N} nodes, Grid: ${GRID_K}×${GRID_K} = ${GRID_K*GRID_K} cells`);
console.log(`Non-empty cells: ${counts.length}, Empty: ${emptyCount}`);
console.log(`Top 5 cells: ${top5.join(", ")} nodes`);
console.log(`Worst cell pairs: ${maxCell * (maxCell-1) / 2}`);
console.log(`Average (non-empty): ${(N / counts.length).toFixed(1)} nodes/cell`);
console.log(`Uniform ideal: ${(N / (GRID_K*GRID_K)).toFixed(1)} nodes/cell`);

// After FA3 runs and nodes spread out, the distribution changes.
// Simulate by running a few iterations and re-checking.
import { buildMatrices, iterate, inferSettings, DEFAULT_SETTINGS, type FA3Settings } from "../src/core/forceatlas3";
const nodeIndex = new Map<string, number>();
for (let i = 0; i < notes.length; i++) nodeIndex.set(notes[i].id, i);

const edges = buildEdges(notes);
const seen = new Set<string>();
const dedup: Array<{source:number,target:number,weight:number}> = [];
for (const e of edges) {
  const si = nodeIndex.get(e.source), ti = nodeIndex.get(e.target);
  if (si === undefined || ti === undefined) continue;
  const key = si < ti ? `${si}:${ti}` : `${ti}:${si}`;
  if (!seen.has(key)) { seen.add(key); dedup.push({ source: si, target: ti, weight: e.weight }); }
}

const fa3Nodes = notes.map((_, i) => ({
  x: 1000 * Math.cos(2 * Math.PI * i / N),
  y: 1000 * Math.sin(2 * Math.PI * i / N),
  size: 5,
}));
const m = buildMatrices(fa3Nodes, dedup);
const settings: FA3Settings = { ...DEFAULT_SETTINGS, ...inferSettings(N) };

for (let i = 0; i < 50; i++) iterate(settings, m.nodes, m.edges, i);

// Recheck distribution
const cellCount2 = new Int32Array(GRID_K * GRID_K);
let minX2 = Infinity, maxX2 = -Infinity, minY2 = Infinity, maxY2 = -Infinity;
for (let i = 0; i < N; i++) {
  const x = m.nodes[i * 10], y = m.nodes[i * 10 + 1];
  if (x < minX2) minX2 = x; if (x > maxX2) maxX2 = x;
  if (y < minY2) minY2 = y; if (y > maxY2) maxY2 = y;
}
const invCW2 = GRID_K / ((maxX2 - minX2) || 1);
const invCH2 = GRID_K / ((maxY2 - minY2) || 1);
for (let i = 0; i < N; i++) {
  const x = m.nodes[i * 10], y = m.nodes[i * 10 + 1];
  const cx = Math.min(GRID_K - 1, ((x - minX2) * invCW2) | 0);
  const cy = Math.min(GRID_K - 1, ((y - minY2) * invCH2) | 0);
  cellCount2[cy * GRID_K + cx]++;
}
const counts2 = Array.from(cellCount2).filter(c => c > 0).sort((a, b) => b - a);
console.log(`\nAfter 50 iterations:`);
console.log(`Top 5 cells: ${counts2.slice(0, 5).join(", ")} nodes`);
console.log(`Worst cell pairs: ${counts2[0] * (counts2[0]-1) / 2}`);
console.log(`Average (non-empty): ${(N / counts2.filter(c=>c>0).length).toFixed(1)} nodes/cell`);
