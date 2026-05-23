/**
 * clustering.ts — Local clustering coefficient (triangle counting).
 *
 * For each node: CC(v) = 2T(v) / (deg(v) * (deg(v) - 1))
 * where T(v) = number of triangles containing v.
 *
 * Uses sorted neighbor lists + binary search for O(N · deg · log(deg))
 * triangle counting (Latapy-style).
 *
 * API:
 *   clusteringCoefficient(nodeCount, edges) →
 *     { coefficients: Float64Array, triangles: Int32Array, average: number }
 */

export interface CLEdge {
  source: number;
  target: number;
}

export interface ClusteringResult {
  coefficients: Float64Array;  // CC per node [0, 1]
  triangles: Int32Array;       // triangle count per node
  average: number;             // average CC across all nodes
}

export function clusteringCoefficient(
  nodeCount: number,
  edges: CLEdge[],
): ClusteringResult {
  const cc = new Float64Array(nodeCount);
  const tri = new Int32Array(nodeCount);

  if (nodeCount === 0) {
    return { coefficients: cc, triangles: tri, average: 0 };
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

  // Sort each node's neighbor list for binary search
  for (let n = 0; n < nodeCount; n++) {
    const start = offsets[n], end = offsets[n + 1];
    // In-place sort of the subarray
    const sub = neighbors.subarray(start, end);
    sub.sort();
  }

  // Count triangles: for each edge (u, v) where u < v, find common neighbors w > v.
  // This ensures each triangle u < v < w is found exactly once. We credit +1 to
  // all three vertices.
  for (let u = 0; u < nodeCount; u++) {
    for (let j = offsets[u]; j < offsets[u + 1]; j++) {
      const v = neighbors[j];
      if (v <= u) continue; // only process u < v
      // Merge sorted neighbor lists of u and v, only counting w > v
      let pu = offsets[u], pv = offsets[v];
      const eu = offsets[u + 1], ev = offsets[v + 1];
      // Advance pu and pv past anything ≤ v
      while (pu < eu && neighbors[pu] <= v) pu++;
      while (pv < ev && neighbors[pv] <= v) pv++;
      while (pu < eu && pv < ev) {
        const nu = neighbors[pu], nv = neighbors[pv];
        if (nu === nv) {
          // Triangle: u-v-nu where u < v < nu
          tri[u]++;
          tri[v]++;
          tri[nu]++;
          pu++;
          pv++;
        } else if (nu < nv) {
          pu++;
        } else {
          pv++;
        }
      }
    }
  }

  // Compute coefficients
  let sum = 0;
  let counted = 0;
  for (let n = 0; n < nodeCount; n++) {
    const d = degree[n];
    if (d >= 2) {
      cc[n] = (2 * tri[n]) / (d * (d - 1));
      // Each triangle was counted twice per node in the merge (once per edge pair),
      // but the way we counted (u<v intersection), each triangle adds +1 to each
      // vertex once. So tri[n] = actual triangle count for node n. The formula is correct.
    }
    sum += cc[n];
    counted++;
  }

  return { coefficients: cc, triangles: tri, average: counted > 0 ? sum / counted : 0 };
}
