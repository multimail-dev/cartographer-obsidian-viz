/**
 * Benchmark ForceAtlas2 layout performance on real vault data.
 *
 * Measures:
 * - Parse time (vault → notes)
 * - Graph build time (notes → edges)
 * - Layout time (ForceAtlas2 convergence)
 * - Memory usage
 *
 * Usage: bun run bench/layout.ts --vault ~/.obsidian-vault
 */

import { parseArgs } from "util";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { circular, random } from "graphology-layout";
import { parseVault } from "../src/core/parser";
import { buildEdges } from "../src/core/graph-builder";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    vault: { type: "string", short: "v" },
    iterations: { type: "string", short: "i", default: "100" },
    seed: { type: "string", short: "s", default: "circular" },
  },
  strict: true,
});

const vaultPath = values.vault || "~/.obsidian-vault";
const iterations = parseInt(values.iterations ?? "100");
const seedLayout = values.seed ?? "circular";

console.log(`\nAtlas Layout Benchmark`);
console.log(`Vault: ${vaultPath}`);
console.log(`Iterations: ${iterations}`);
console.log(`Seed layout: ${seedLayout}`);
console.log(`---`);

// 1. Parse
const memBefore = process.memoryUsage();
const t0 = performance.now();
const notes = await parseVault(vaultPath.replace("~", process.env.HOME!));
const parseTime = performance.now() - t0;
console.log(`Parse: ${notes.length} notes in ${parseTime.toFixed(0)}ms`);

// 2. Build edges
const t1 = performance.now();
const edges = buildEdges(notes);
const buildTime = performance.now() - t1;
console.log(`Edges: ${edges.length} edges in ${buildTime.toFixed(0)}ms`);

// Edge type breakdown
const typeCounts = new Map<string, number>();
for (const e of edges) {
  typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
}
for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type}: ${count}`);
}

// 3. Build graphology instance
const t2 = performance.now();
const graph = new Graph();
for (const note of notes) {
  graph.addNode(note.id, {
    label: note.title,
    size: 5,
    type: note.frontmatter.type || "note",
  });
}
for (const edge of edges) {
  try {
    graph.addEdge(edge.source, edge.target, {
      weight: edge.weight,
      edgeType: edge.type,
    });
  } catch {
    // Skip duplicate edges
  }
}
const graphBuildTime = performance.now() - t2;
console.log(`Graph object: ${graph.order} nodes, ${graph.size} edges in ${graphBuildTime.toFixed(0)}ms`);

// 4. Seed positions
const t3 = performance.now();
if (seedLayout === "circular") {
  circular.assign(graph, { scale: 1000 });
} else {
  random.assign(graph, { scale: 1000 });
}
const seedTime = performance.now() - t3;
console.log(`Seed layout (${seedLayout}): ${seedTime.toFixed(0)}ms`);

// 5. ForceAtlas2
const settings = forceAtlas2.inferSettings(graph);
console.log(`FA2 settings: gravity=${settings.gravity?.toFixed(3)}, scalingRatio=${settings.scalingRatio?.toFixed(3)}`);

const t4 = performance.now();
forceAtlas2.assign(graph, { iterations, settings });
const fa2Time = performance.now() - t4;
console.log(`\nForceAtlas2: ${iterations} iterations in ${fa2Time.toFixed(0)}ms (${(fa2Time / iterations).toFixed(1)}ms/iter)`);

// 6. Memory
const memAfter = process.memoryUsage();
console.log(`\nMemory:`);
console.log(`  Heap: ${((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(1)}MB`);
console.log(`  RSS:  ${((memAfter.rss - memBefore.rss) / 1024 / 1024).toFixed(1)}MB`);

// Summary
console.log(`\nTotal pipeline: ${(parseTime + buildTime + graphBuildTime + seedTime + fa2Time).toFixed(0)}ms`);
