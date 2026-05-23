/**
 * pagerank.ts — Power-iteration PageRank.
 *
 * Flat-array port of Gephi's PageRank.java. Two Float64Arrays for rank
 * ping-pong, pre-built CSR adjacency, dangling-node handling.
 *
 * API:
 *   pagerank(nodeCount, edges, opts?) → Float64Array  (rank per node, sums to ~1)
 */

export interface PREdge {
  source: number;
  target: number;
  weight: number;
}

export interface PageRankOptions {
  damping?: number;    // default 0.85
  epsilon?: number;    // default 0.001 — convergence threshold
  maxIter?: number;    // default 100
}

export function pagerank(
  nodeCount: number,
  edges: PREdge[],
  opts?: PageRankOptions,
): Float64Array {
  const d = opts?.damping ?? 0.85;
  const epsilon = opts?.epsilon ?? 0.001;
  const maxIter = opts?.maxIter ?? 100;

  if (nodeCount === 0) return new Float64Array(0);

  // Build CSR for undirected graph (each edge stored both ways)
  const degree = new Int32Array(nodeCount);
  for (const e of edges) {
    if (e.source === e.target) continue;
    degree[e.source]++;
    degree[e.target]++;
  }
  const offsets = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) offsets[i + 1] = offsets[i] + degree[i];
  const neighbors = new Int32Array(offsets[nodeCount]);
  const weights = new Float64Array(offsets[nodeCount]);
  const cursor = new Int32Array(nodeCount);
  cursor.set(offsets.subarray(0, nodeCount));
  for (const e of edges) {
    if (e.source === e.target) continue;
    neighbors[cursor[e.source]] = e.target;
    weights[cursor[e.source]++] = e.weight;
    neighbors[cursor[e.target]] = e.source;
    weights[cursor[e.target]++] = e.weight;
  }

  // Weighted degree for normalization
  const wDeg = new Float64Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) {
    let s = 0;
    for (let j = offsets[n]; j < offsets[n + 1]; j++) s += weights[j];
    wDeg[n] = s;
  }

  // Identify dangling nodes (no outgoing edges)
  const isDangling = new Uint8Array(nodeCount);
  let danglingCount = 0;
  for (let n = 0; n < nodeCount; n++) {
    if (wDeg[n] === 0) { isDangling[n] = 1; danglingCount++; }
  }

  // Initialize ranks
  const invN = 1 / nodeCount;
  let rank = new Float64Array(nodeCount).fill(invN);
  let next = new Float64Array(nodeCount);

  const teleport = (1 - d) * invN;

  for (let iter = 0; iter < maxIter; iter++) {
    // Dangling node contribution: their rank leaks uniformly to all nodes
    let danglingSum = 0;
    for (let n = 0; n < nodeCount; n++) {
      if (isDangling[n]) danglingSum += rank[n];
    }
    const danglingContrib = d * danglingSum * invN;
    const base = teleport + danglingContrib;

    // Compute next rank
    next.fill(base);
    for (let n = 0; n < nodeCount; n++) {
      if (wDeg[n] === 0) continue;
      const contrib = d * rank[n] / wDeg[n];
      for (let j = offsets[n]; j < offsets[n + 1]; j++) {
        next[neighbors[j]] += contrib * weights[j];
      }
    }

    // Check convergence
    let converged = true;
    for (let n = 0; n < nodeCount; n++) {
      if (rank[n] > 0 && Math.abs(next[n] - rank[n]) / rank[n] >= epsilon) {
        converged = false;
        break;
      }
    }

    // Swap
    const tmp = rank;
    rank = next;
    next = tmp;

    if (converged) break;
  }

  return rank;
}
