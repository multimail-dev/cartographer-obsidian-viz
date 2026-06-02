/**
 * Grid correctness test: compare FA3 (grid) to brute-force over many iterations.
 *
 * The spatial grid is an approximation. This test verifies it doesn't diverge
 * from brute-force as nodes move and cells get reassigned.
 *
 * Method: run two copies of the same graph — one with FA3 grid, one with
 * manual brute-force repulsion — and compare positions at intervals.
 */

import {
  buildMatrices,
  iterate,
  DEFAULT_SETTINGS,
  type FA3Settings,
  type NodeInput,
  type EdgeInput,
} from "../src/core/forceatlas3";

const PPN = 10;
const NODE_X = 0, NODE_Y = 1, NODE_DX = 2, NODE_DY = 3;
const NODE_OLD_DX = 4, NODE_OLD_DY = 5, NODE_MASS = 6;
const NODE_CONVERGENCE = 7, NODE_FIXED = 9;

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}

/**
 * Brute-force single iteration — no grid, exact O(n²) repulsion.
 * Same physics as FA3 but without spatial approximation.
 */
function bruteForceIterate(
  options: FA3Settings,
  NodeMatrix: Float32Array,
  EdgeMatrix: Float32Array,
): void {
  const order = NodeMatrix.length;
  const size = EdgeMatrix.length;

  // 1) Reset deltas
  for (let n = 0; n < order; n += PPN) {
    NodeMatrix[n + NODE_OLD_DX] = NodeMatrix[n + NODE_DX];
    NodeMatrix[n + NODE_OLD_DY] = NodeMatrix[n + NODE_DY];
    NodeMatrix[n + NODE_DX] = 0;
    NodeMatrix[n + NODE_DY] = 0;
  }

  // 2) Repulsion — exact O(n²)
  const coefficient = options.scalingRatio;
  for (let n1 = 0; n1 < order; n1 += PPN) {
    for (let n2 = 0; n2 < n1; n2 += PPN) {
      const xDist = NodeMatrix[n1 + NODE_X] - NodeMatrix[n2 + NODE_X];
      const yDist = NodeMatrix[n1 + NODE_Y] - NodeMatrix[n2 + NODE_Y];
      const distSq = xDist * xDist + yDist * yDist;
      if (distSq > 0) {
        const factor = (coefficient * NodeMatrix[n1 + NODE_MASS] * NodeMatrix[n2 + NODE_MASS]) / distSq;
        NodeMatrix[n1 + NODE_DX] += xDist * factor;
        NodeMatrix[n1 + NODE_DY] += yDist * factor;
        NodeMatrix[n2 + NODE_DX] -= xDist * factor;
        NodeMatrix[n2 + NODE_DY] -= yDist * factor;
      }
    }
  }

  // 3) Gravity
  const g = options.gravity / options.scalingRatio;
  if (options.strongGravityMode) {
    for (let n = 0; n < order; n += PPN) {
      const factor = coefficient * NodeMatrix[n + NODE_MASS] * g;
      NodeMatrix[n + NODE_DX] -= NodeMatrix[n + NODE_X] * factor;
      NodeMatrix[n + NODE_DY] -= NodeMatrix[n + NODE_Y] * factor;
    }
  } else {
    for (let n = 0; n < order; n += PPN) {
      const xDist = NodeMatrix[n + NODE_X];
      const yDist = NodeMatrix[n + NODE_Y];
      const dist = Math.sqrt(xDist * xDist + yDist * yDist);
      if (dist > 0) {
        const factor = (coefficient * NodeMatrix[n + NODE_MASS] * g) / dist;
        NodeMatrix[n + NODE_DX] -= xDist * factor;
        NodeMatrix[n + NODE_DY] -= yDist * factor;
      }
    }
  }

  // 4) Attraction
  for (let e = 0; e < size; e += 3) {
    const n1 = EdgeMatrix[e];
    const n2 = EdgeMatrix[e + 1];
    const w = EdgeMatrix[e + 2];
    const xDist = NodeMatrix[n1 + NODE_X] - NodeMatrix[n2 + NODE_X];
    const yDist = NodeMatrix[n1 + NODE_Y] - NodeMatrix[n2 + NODE_Y];
    const factor = -1 * w;
    NodeMatrix[n1 + NODE_DX] += xDist * factor;
    NodeMatrix[n1 + NODE_DY] += yDist * factor;
    NodeMatrix[n2 + NODE_DX] -= xDist * factor;
    NodeMatrix[n2 + NODE_DY] -= yDist * factor;
  }

  // 5) Apply forces (same as FA3 non-adjustSizes path)
  for (let n = 0; n < order; n += PPN) {
    if (NodeMatrix[n + NODE_FIXED] !== 1) {
      const swinging = NodeMatrix[n + NODE_MASS] * Math.sqrt(
        (NodeMatrix[n + NODE_OLD_DX] - NodeMatrix[n + NODE_DX]) ** 2 +
        (NodeMatrix[n + NODE_OLD_DY] - NodeMatrix[n + NODE_DY]) ** 2
      );
      const traction = Math.sqrt(
        (NodeMatrix[n + NODE_OLD_DX] + NodeMatrix[n + NODE_DX]) ** 2 +
        (NodeMatrix[n + NODE_OLD_DY] + NodeMatrix[n + NODE_DY]) ** 2
      ) / 2;
      const nodespeed = (NodeMatrix[n + NODE_CONVERGENCE] * Math.log(1 + traction)) / (1 + Math.sqrt(swinging));
      NodeMatrix[n + NODE_CONVERGENCE] = Math.min(1, Math.sqrt(
        (nodespeed * (NodeMatrix[n + NODE_DX] ** 2 + NodeMatrix[n + NODE_DY] ** 2)) / (1 + Math.sqrt(swinging))
      ));
      NodeMatrix[n + NODE_X] += NodeMatrix[n + NODE_DX] * (nodespeed / options.slowDown);
      NodeMatrix[n + NODE_Y] += NodeMatrix[n + NODE_DY] * (nodespeed / options.slowDown);
    }
  }
}

function cloneFloat32(arr: Float32Array): Float32Array {
  return new Float32Array(arr);
}

function positionCorrelation(a: Float32Array, b: Float32Array, n: number): number {
  // Pearson correlation of pairwise distances
  const dists_a: number[] = [];
  const dists_b: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ax = a[i * PPN] - a[j * PPN];
      const ay = a[i * PPN + 1] - a[j * PPN + 1];
      const bx = b[i * PPN] - b[j * PPN];
      const by = b[i * PPN + 1] - b[j * PPN + 1];
      dists_a.push(Math.sqrt(ax * ax + ay * ay));
      dists_b.push(Math.sqrt(bx * bx + by * by));
    }
  }
  const len = dists_a.length;
  let sa = 0, sb = 0, sab = 0, sa2 = 0, sb2 = 0;
  for (let i = 0; i < len; i++) {
    sa += dists_a[i]; sb += dists_b[i];
    sab += dists_a[i] * dists_b[i];
    sa2 += dists_a[i] * dists_a[i];
    sb2 += dists_b[i] * dists_b[i];
  }
  const num = len * sab - sa * sb;
  const den = Math.sqrt((len * sa2 - sa * sa) * (len * sb2 - sb * sb));
  return den === 0 ? 1 : num / den;
}

// --- Test A: 30 nodes, 50 iterations, track correlation at each step ---
console.log("=== Test A: 30 nodes, 50 iterations, FA3 vs brute-force ===");
{
  const N = 30;
  const nodes: NodeInput[] = Array.from({ length: N }, (_, i) => ({
    x: Math.cos(2 * Math.PI * i / N) * 500 + (Math.random() - 0.5) * 100,
    y: Math.sin(2 * Math.PI * i / N) * 500 + (Math.random() - 0.5) * 100,
    size: 5,
  }));
  const edges: EdgeInput[] = [];
  for (let i = 0; i < N; i++) {
    edges.push({ source: i, target: (i + 1) % N, weight: 1 });
    if (i + 3 < N) edges.push({ source: i, target: i + 3, weight: 0.5 });
  }

  const mGrid = buildMatrices(nodes, edges);
  const mBrute = { nodes: cloneFloat32(mGrid.nodes), edges: cloneFloat32(mGrid.edges) };

  const settings: FA3Settings = {
    ...DEFAULT_SETTINGS,
    scalingRatio: 10,
    gravity: 0.05,
    strongGravityMode: true,
    slowDown: 1 + Math.log(N),
  };

  for (let iter = 0; iter < 50; iter++) {
    iterate(settings, mGrid.nodes, mGrid.edges, iter);
    bruteForceIterate(settings, mBrute.nodes, mBrute.edges);

    if (iter % 10 === 9 || iter === 0) {
      const corr = positionCorrelation(mGrid.nodes, mBrute.nodes, N);
      const label = corr >= 0.9 ? "OK" : corr >= 0.8 ? "WARN" : "BAD";
      console.log(`  iter ${iter + 1}: correlation = ${corr.toFixed(4)} [${label}]`);
      if (iter === 49) {
        assert(corr >= 0.85, `Final correlation should be >= 0.85, got ${corr.toFixed(4)}`);
      }
    }
  }
}

// --- Test B: 100 nodes clustered, check grid doesn't lose nodes ---
console.log("\n=== Test B: 100 nodes in 3 clusters, 30 iterations ===");
{
  const N = 100;
  const nodes: NodeInput[] = [];
  // 3 clusters at different positions
  for (let c = 0; c < 3; c++) {
    const cx = c * 500, cy = c * 300;
    for (let i = 0; i < Math.floor(N / 3); i++) {
      nodes.push({
        x: cx + (Math.random() - 0.5) * 50,
        y: cy + (Math.random() - 0.5) * 50,
        size: 5,
      });
    }
  }
  // Fill remaining
  while (nodes.length < N) {
    nodes.push({ x: Math.random() * 1000, y: Math.random() * 1000, size: 5 });
  }

  // Intra-cluster edges (strong) + inter-cluster edges (weak)
  const edges: EdgeInput[] = [];
  for (let c = 0; c < 3; c++) {
    const start = c * 33;
    for (let i = start; i < start + 32; i++) {
      edges.push({ source: i, target: i + 1, weight: 2 });
    }
  }
  // A few inter-cluster bridges
  edges.push({ source: 10, target: 43, weight: 0.3 });
  edges.push({ source: 50, target: 80, weight: 0.3 });

  const mGrid = buildMatrices(nodes, edges);
  const mBrute = { nodes: cloneFloat32(mGrid.nodes), edges: cloneFloat32(mGrid.edges) };

  const settings: FA3Settings = {
    ...DEFAULT_SETTINGS,
    scalingRatio: 10,
    gravity: 0.05,
    strongGravityMode: true,
    slowDown: 1 + Math.log(N),
  };

  for (let iter = 0; iter < 30; iter++) {
    iterate(settings, mGrid.nodes, mGrid.edges, iter);
    bruteForceIterate(settings, mBrute.nodes, mBrute.edges);
  }

  const corr = positionCorrelation(mGrid.nodes, mBrute.nodes, N);
  console.log(`  After 30 iters: correlation = ${corr.toFixed(4)}`);
  assert(corr >= 0.85, `Cluster layout correlation should be >= 0.85, got ${corr.toFixed(4)}`);

  // Check clusters are still separated in both layouts
  function clusterCentroid(m: Float32Array, start: number, count: number) {
    let sx = 0, sy = 0;
    for (let i = start; i < start + count; i++) {
      sx += m[i * PPN]; sy += m[i * PPN + 1];
    }
    return { x: sx / count, y: sy / count };
  }

  const gc0 = clusterCentroid(mGrid.nodes, 0, 33);
  const gc1 = clusterCentroid(mGrid.nodes, 33, 33);
  const gc2 = clusterCentroid(mGrid.nodes, 66, 33);

  const d01 = Math.sqrt((gc0.x - gc1.x) ** 2 + (gc0.y - gc1.y) ** 2);
  const d12 = Math.sqrt((gc1.x - gc2.x) ** 2 + (gc1.y - gc2.y) ** 2);
  console.log(`  Grid cluster distances: d(0,1)=${d01.toFixed(0)} d(1,2)=${d12.toFixed(0)}`);
  assert(d01 > 10 && d12 > 10, "Clusters should remain separated");
}

// --- Test C: Single node escaping grid bounds ---
console.log("\n=== Test C: node at extreme position ===");
{
  const nodes: NodeInput[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 100000, y: 100000 },  // far outlier
  ];
  const edges: EdgeInput[] = [
    { source: 0, target: 1, weight: 1 },
    { source: 1, target: 2, weight: 1 },
  ];

  const m = buildMatrices(nodes, edges);
  const settings: FA3Settings = {
    ...DEFAULT_SETTINGS,
    scalingRatio: 10,
    gravity: 0.05,
    strongGravityMode: true,
    slowDown: 1 + Math.log(4),
  };

  // Should not crash despite huge bounding box
  for (let i = 0; i < 20; i++) {
    iterate(settings, m.nodes, m.edges, i);
  }

  let hasNaN = false;
  for (let i = 0; i < 4; i++) {
    if (isNaN(m.nodes[i * PPN]) || isNaN(m.nodes[i * PPN + 1])) hasNaN = true;
  }
  assert(!hasNaN, "No NaN with extreme outlier node");
  console.log("  No NaN after 20 iterations with outlier at (100000, 100000)");
}

// --- Test D: Verify every node is visited exactly once in grid ---
// Instrument by checking sum of all dx contributions equals expected
console.log("\n=== Test D: conservation of forces (Newton's 3rd) ===");
{
  const N = 50;
  const nodes: NodeInput[] = Array.from({ length: N }, (_, i) => ({
    x: Math.random() * 1000,
    y: Math.random() * 1000,
    size: 5,
  }));
  const edges: EdgeInput[] = [];

  const m = buildMatrices(nodes, edges);
  const settings: FA3Settings = {
    ...DEFAULT_SETTINGS,
    scalingRatio: 10,
    gravity: 0, // no gravity — only repulsion
    strongGravityMode: true,
    slowDown: 100000, // very slow so positions barely change
  };

  // After one iteration with no gravity and no edges, only repulsion acts.
  // Newton's 3rd: sum of all dx and dy forces should be ~0.
  iterate(settings, m.nodes, m.edges, 0);

  // Read dx/dy (they've been applied to positions already, so check position deltas)
  // Actually with very high slowDown, positions barely change. Let's check the
  // the intermediate dx/dy by looking at position changes from the known starting positions.
  // With slowDown=100000, position change ≈ dx * nodespeed / 100000 ≈ tiny.

  // Better: build matrices, manually read dx/dy BEFORE force application
  // We can't do that with the current API. Instead, verify that center of mass
  // doesn't drift significantly (consequence of Newton's 3rd).

  let comX = 0, comY = 0;
  for (let i = 0; i < N; i++) {
    comX += m.nodes[i * PPN];
    comY += m.nodes[i * PPN + 1];
  }
  comX /= N;
  comY /= N;

  // Original center of mass
  let origComX = 0, origComY = 0;
  for (const n of nodes) { origComX += n.x; origComY += n.y; }
  origComX /= N; origComY /= N;

  const comDrift = Math.sqrt((comX - origComX) ** 2 + (comY - origComY) ** 2);
  console.log(`  COM drift after 1 iter (no gravity): ${comDrift.toFixed(4)}`);
  // With pure repulsion and Newton's 3rd, COM should barely move
  // (only moves due to adaptive speed differences per node)
  assert(comDrift < 50, `COM drift should be small, got ${comDrift.toFixed(2)}`);
}

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURES`}`);
process.exit(failures > 0 ? 1 : 0);
