import { buildMatrices, iterate, inferSettings, DEFAULT_SETTINGS, type FA3Settings, type NodeInput, type EdgeInput } from "../src/core/forceatlas3";

const PPN = 10;

// Simulate a hotspot: 500 nodes crammed into one small area, 500 spread out
const N = 1000;
const nodes: NodeInput[] = [];
// Dense cluster at origin
for (let i = 0; i < 500; i++) {
  nodes.push({ x: (Math.random() - 0.5) * 10, y: (Math.random() - 0.5) * 10, size: 5 });
}
// Spread out
for (let i = 500; i < N; i++) {
  nodes.push({ x: Math.random() * 2000 - 1000, y: Math.random() * 2000 - 1000, size: 5 });
}
const edges: EdgeInput[] = [];
for (let i = 0; i < N - 1; i++) edges.push({ source: i, target: (i + 7) % N, weight: 1 });

const m = buildMatrices(nodes, edges);
const settings: FA3Settings = { ...DEFAULT_SETTINGS, ...inferSettings(N) };

// Time 20 iterations
const t0 = performance.now();
for (let i = 0; i < 20; i++) iterate(settings, m.nodes, m.edges, i);
const elapsed = performance.now() - t0;
console.log(`Hotspot test: ${N} nodes (500 in tight cluster), 20 iters: ${elapsed.toFixed(0)}ms (${(elapsed/20).toFixed(1)}ms/iter)`);

// What does the grid look like? Count max nodes per cell
const nodeCount = N;
const GRID_K = Math.max(4, Math.ceil(Math.sqrt(nodeCount) / 3));
console.log(`Grid: ${GRID_K}×${GRID_K} = ${GRID_K*GRID_K} cells`);
console.log(`500 nodes in ~10×10 area → they all land in ~1 cell`);
console.log(`That cell does 500×499/2 = ${500*499/2} pair comparisons per iteration`);
console.log(`A uniform distribution would do ~${Math.ceil(N/(GRID_K*GRID_K))}² ≈ ${Math.ceil(N/(GRID_K*GRID_K))**2} per cell`);
