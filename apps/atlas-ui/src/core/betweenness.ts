/**
 * betweenness.ts — Brandes' betweenness centrality algorithm.
 *
 * O(N * (N + M)) time, O(N + M) space. Port of Gephi's GraphDistance.java.
 * Also computes closeness, harmonic closeness, and eccentricity as byproducts.
 *
 * API:
 *   betweenness(nodeCount, edges, opts?) →
 *     { betweenness: Float64Array, closeness: Float64Array,
 *       harmonic: Float64Array, eccentricity: Int32Array,
 *       diameter: number, radius: number, avgPathLength: number }
 */

export interface BTEdge {
  source: number;
  target: number;
  weight: number;
}

export interface BetweennessOptions {
  normalized?: boolean;  // default true
}

export interface BetweennessResult {
  betweenness: Float64Array;
  closeness: Float64Array;
  harmonic: Float64Array;
  eccentricity: Int32Array;
  diameter: number;
  radius: number;
  avgPathLength: number;
}

export function betweenness(
  nodeCount: number,
  edges: BTEdge[],
  opts?: BetweennessOptions,
): BetweennessResult {
  const normalized = opts?.normalized ?? true;

  const bet = new Float64Array(nodeCount);
  const closeness = new Float64Array(nodeCount);
  const harmonic = new Float64Array(nodeCount);
  const eccentricity = new Int32Array(nodeCount);

  if (nodeCount === 0) {
    return { betweenness: bet, closeness, harmonic, eccentricity, diameter: 0, radius: 0, avgPathLength: 0 };
  }

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
  const cursor = new Int32Array(nodeCount);
  cursor.set(offsets.subarray(0, nodeCount));
  for (const e of edges) {
    if (e.source === e.target) continue;
    neighbors[cursor[e.source]++] = e.target;
    neighbors[cursor[e.target]++] = e.source;
  }

  // Brandes' algorithm — BFS from each source
  const stack = new Int32Array(nodeCount);
  const dist = new Int32Array(nodeCount);
  const sigma = new Float64Array(nodeCount);
  const delta = new Float64Array(nodeCount);
  const queue = new Int32Array(nodeCount);
  // Predecessor lists: per-node dynamic storage using a flat pool.
  // Each node can have up to degree[n] predecessors per BFS.
  // We use a pool + per-node start/count.
  const predPool = new Int32Array(offsets[nodeCount]); // worst case: all edges
  const predStart = new Int32Array(nodeCount); // start index in predPool for node w
  const predCount = new Int32Array(nodeCount); // count of predecessors for node w

  let diameter = 0;
  let radius = Infinity;
  let totalPathLength = 0;
  let totalPaths = 0;

  for (let s = 0; s < nodeCount; s++) {
    let stackTop = 0;
    dist.fill(-1);
    sigma.fill(0);
    delta.fill(0);
    predCount.fill(0);
    let predPoolTop = 0;

    dist[s] = 0;
    sigma[s] = 1;
    let qHead = 0, qTail = 0;
    queue[qTail++] = s;

    while (qHead < qTail) {
      const v = queue[qHead++];
      stack[stackTop++] = v;
      for (let j = offsets[v]; j < offsets[v + 1]; j++) {
        const w = neighbors[j];
        if (dist[w] < 0) {
          dist[w] = dist[v] + 1;
          queue[qTail++] = w;
        }
        if (dist[w] === dist[v] + 1) {
          sigma[w] += sigma[v];
          if (predCount[w] === 0) predStart[w] = predPoolTop;
          predPool[predPoolTop++] = v;
          predCount[w]++;
        }
      }
    }

    let ecc = 0;
    let closeSum = 0;
    let harmonicSum = 0;
    let reachable = 0;
    for (let n = 0; n < nodeCount; n++) {
      if (dist[n] > 0) {
        if (dist[n] > ecc) ecc = dist[n];
        closeSum += dist[n];
        harmonicSum += 1 / dist[n];
        reachable++;
        totalPathLength += dist[n];
        totalPaths++;
      }
    }
    eccentricity[s] = ecc;
    closeness[s] = reachable > 0 ? reachable / closeSum : 0;
    harmonic[s] = harmonicSum;

    if (ecc > diameter) diameter = ecc;
    if (ecc > 0 && ecc < radius) radius = ecc;

    // Back-propagation
    while (stackTop > 0) {
      const w = stack[--stackTop];
      const ps = predStart[w];
      const pc = predCount[w];
      for (let j = ps; j < ps + pc; j++) {
        const v = predPool[j];
        delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      }
      if (w !== s) {
        bet[w] += delta[w];
      }
    }
  }

  // Undirected: each path counted twice
  for (let n = 0; n < nodeCount; n++) bet[n] /= 2;

  // Normalize
  if (normalized && nodeCount > 2) {
    const norm = 1 / ((nodeCount - 1) * (nodeCount - 2));
    for (let n = 0; n < nodeCount; n++) bet[n] *= norm;
  }

  const avgPathLength = totalPaths > 0 ? totalPathLength / totalPaths : 0;
  if (radius === Infinity) radius = 0;

  return { betweenness: bet, closeness, harmonic, eccentricity, diameter, radius, avgPathLength };
}
