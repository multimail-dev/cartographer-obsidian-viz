/**
 * components.ts — Weakly connected components via BFS.
 *
 * O(N + M) time and space. Flat Int32Array output.
 *
 * API:
 *   connectedComponents(nodeCount, edges) →
 *     { components: Int32Array, count: number, sizes: Int32Array }
 */

export interface CCEdge {
  source: number;
  target: number;
}

export interface CCResult {
  components: Int32Array;  // component ID per node (0-indexed, contiguous)
  count: number;           // number of components
  sizes: Int32Array;       // size of each component (indexed by component ID)
}

export function connectedComponents(
  nodeCount: number,
  edges: CCEdge[],
): CCResult {
  if (nodeCount === 0) {
    return { components: new Int32Array(0), count: 0, sizes: new Int32Array(0) };
  }

  // Build CSR adjacency
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

  // BFS
  const comp = new Int32Array(nodeCount).fill(-1);
  const queue = new Int32Array(nodeCount); // reused BFS queue
  let compId = 0;

  for (let start = 0; start < nodeCount; start++) {
    if (comp[start] >= 0) continue;
    let head = 0, tail = 0;
    queue[tail++] = start;
    comp[start] = compId;
    while (head < tail) {
      const n = queue[head++];
      for (let j = offsets[n]; j < offsets[n + 1]; j++) {
        const nb = neighbors[j];
        if (comp[nb] < 0) {
          comp[nb] = compId;
          queue[tail++] = nb;
        }
      }
    }
    compId++;
  }

  // Compute sizes
  const sizes = new Int32Array(compId);
  for (let i = 0; i < nodeCount; i++) sizes[comp[i]]++;

  return { components: comp, count: compId, sizes };
}
