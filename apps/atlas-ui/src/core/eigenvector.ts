/**
 * eigenvector.ts — Eigenvector centrality via power iteration.
 *
 * The dominant eigenvector of the adjacency matrix, computed by
 * repeated matrix-vector multiplication and L2 normalization.
 *
 * API:
 *   eigenvectorCentrality(nodeCount, edges, opts?) → Float64Array
 */

export interface EVEdge {
  source: number;
  target: number;
  weight: number;
}

export interface EVOptions {
  iterations?: number;   // default 100
  epsilon?: number;      // default 1e-6 — convergence threshold
}

export function eigenvectorCentrality(
  nodeCount: number,
  edges: EVEdge[],
  opts?: EVOptions,
): Float64Array {
  const maxIter = opts?.iterations ?? 100;
  const epsilon = opts?.epsilon ?? 1e-6;

  if (nodeCount === 0) return new Float64Array(0);

  // Build CSR adjacency (undirected)
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

  // Initialize with uniform values
  let vec = new Float64Array(nodeCount).fill(1 / Math.sqrt(nodeCount));
  let next = new Float64Array(nodeCount);

  for (let iter = 0; iter < maxIter; iter++) {
    // Matrix-vector multiply: next[i] = sum(weight[j] * vec[neighbor[j]])
    next.fill(0);
    for (let n = 0; n < nodeCount; n++) {
      const v = vec[n];
      for (let j = offsets[n]; j < offsets[n + 1]; j++) {
        next[neighbors[j]] += weights[j] * v;
      }
    }

    // L2 normalize
    let norm = 0;
    for (let n = 0; n < nodeCount; n++) norm += next[n] * next[n];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      const invNorm = 1 / norm;
      for (let n = 0; n < nodeCount; n++) next[n] *= invNorm;
    }

    // Check convergence (max absolute change)
    let maxDiff = 0;
    for (let n = 0; n < nodeCount; n++) {
      const diff = Math.abs(next[n] - vec[n]);
      if (diff > maxDiff) maxDiff = diff;
    }

    const tmp = vec;
    vec = next;
    next = tmp;

    if (maxDiff < epsilon) break;
  }

  return vec;
}
