import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { circular } from "graphology-layout";
import { parseVault } from "../src/core/parser";
import { buildEdges } from "../src/core/graph-builder";

const vaultPath = (Bun.argv[2] || "~/.obsidian-vault").replace("~", process.env.HOME!);
const notes = await parseVault(vaultPath);
const edges = buildEdges(notes);

const graph = new Graph();
for (const n of notes) graph.addNode(n.id, { label: n.title, size: 5 });
for (const e of edges) { try { graph.addEdge(e.source, e.target, { weight: e.weight }); } catch {} }

// Find a high-degree node as seed
const degrees = notes.map(n => ({ id: n.id, deg: graph.degree(n.id) })).sort((a, b) => b.deg - a.deg);
const seed = degrees[0].id;
console.log(`Seed: "${seed}" (degree ${degrees[0].deg})`);

function extractSubgraph(center: string, depth: number): Graph {
  const sub = new Graph();
  const visited = new Set<string>();
  const queue: Array<[string, number]> = [[center, 0]];
  visited.add(center);
  
  while (queue.length > 0) {
    const [node, d] = queue.shift()!;
    if (!sub.hasNode(node)) sub.addNode(node, { size: 5 });
    if (d < depth) {
      for (const neighbor of graph.neighbors(node)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push([neighbor, d + 1]);
        }
      }
    }
  }
  // Add edges between nodes in subgraph
  for (const node of sub.nodes()) {
    for (const neighbor of graph.neighbors(node)) {
      if (sub.hasNode(neighbor) && !sub.hasEdge(node, neighbor)) {
        try { sub.addEdge(node, neighbor); } catch {}
      }
    }
  }
  return sub;
}

// Test different subgraph sizes and iteration counts
for (const depth of [1, 2]) {
  const sub = extractSubgraph(seed, depth);
  console.log(`\nDepth ${depth}: ${sub.order} nodes, ${sub.size} edges`);
  
  for (const iters of [20, 50, 100]) {
    circular.assign(sub, { scale: 100 });
    const settings = forceAtlas2.inferSettings(sub);
    const t = performance.now();
    forceAtlas2.assign(sub, { iterations: iters, settings });
    console.log(`  ${iters} iters: ${(performance.now() - t).toFixed(0)}ms`);
  }
  
  // Barnes-Hut
  circular.assign(sub, { scale: 100 });
  const settings = { ...forceAtlas2.inferSettings(sub), barnesHutOptimize: true };
  const t = performance.now();
  forceAtlas2.assign(sub, { iterations: 50, settings });
  console.log(`  BH 50 iters: ${(performance.now() - t).toFixed(0)}ms`);
}

// Full graph with reduced iterations
console.log(`\nFull graph: ${graph.order} nodes, ${graph.size} edges`);
for (const iters of [10, 20, 50]) {
  circular.assign(graph, { scale: 1000 });
  const settings = forceAtlas2.inferSettings(graph);
  const t = performance.now();
  forceAtlas2.assign(graph, { iterations: iters, settings });
  console.log(`  ${iters} iters: ${(performance.now() - t).toFixed(0)}ms`);
}
