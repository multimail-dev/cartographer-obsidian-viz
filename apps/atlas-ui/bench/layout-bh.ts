import { parseArgs } from "util";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { circular } from "graphology-layout";
import { parseVault } from "../src/core/parser";
import { buildEdges } from "../src/core/graph-builder";

const vaultPath = (Bun.argv[3] || "~/.obsidian-vault").replace("~", process.env.HOME!);
const notes = await parseVault(vaultPath);
const edges = buildEdges(notes);

const graph = new Graph();
for (const n of notes) graph.addNode(n.id, { label: n.title, size: 5 });
for (const e of edges) { try { graph.addEdge(e.source, e.target, { weight: e.weight }); } catch {} }

circular.assign(graph, { scale: 1000 });
const settings = forceAtlas2.inferSettings(graph);

// Standard
let t = performance.now();
forceAtlas2.assign(graph, { iterations: 100, settings });
console.log(`Standard:    ${(performance.now() - t).toFixed(0)}ms`);

// Barnes-Hut
circular.assign(graph, { scale: 1000 }); // reset
t = performance.now();
forceAtlas2.assign(graph, { iterations: 100, settings: { ...settings, barnesHutOptimize: true } });
console.log(`Barnes-Hut:  ${(performance.now() - t).toFixed(0)}ms`);

// Subgraph (100 nodes)
const sub = new Graph();
const seed = notes[0].id;
sub.addNode(seed, { size: 5 });
for (const n of graph.neighbors(seed).slice(0, 99)) {
  if (!sub.hasNode(n)) sub.addNode(n, { size: 5 });
  try { sub.addEdge(seed, n); } catch {}
}
circular.assign(sub, { scale: 100 });
t = performance.now();
forceAtlas2.assign(sub, { iterations: 100, settings: forceAtlas2.inferSettings(sub) });
console.log(`Subgraph(${sub.order}): ${(performance.now() - t).toFixed(0)}ms`);
