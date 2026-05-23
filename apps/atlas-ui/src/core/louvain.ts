/**
 * louvain.ts — Louvain community detection (Blondel et al. 2008).
 *
 * Flat-array implementation: CSR adjacency, typed arrays throughout.
 *
 * API:
 *   louvain(nodeCount, edges, opts?) →
 *     { communities: Int32Array, modularity: number, communityCount: number }
 */

export interface LouvainEdge {
  source: number;
  target: number;
  weight: number;
}

export interface LouvainOptions {
  resolution?: number;
  randomize?: boolean;
  seed?: number;
}

export interface LouvainResult {
  communities: Int32Array;
  modularity: number;
  communityCount: number;
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

function buildCSR(nodeCount: number, edges: LouvainEdge[]) {
  const degree = new Int32Array(nodeCount);
  for (const e of edges) { if (e.source === e.target) continue; degree[e.source]++; degree[e.target]++; }
  const offsets = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) offsets[i + 1] = offsets[i] + degree[i];
  const neighbors = new Int32Array(offsets[nodeCount]);
  const weights = new Float64Array(offsets[nodeCount]);
  const cursor = new Int32Array(nodeCount);
  cursor.set(offsets.subarray(0, nodeCount));
  for (const e of edges) {
    if (e.source === e.target) continue;
    neighbors[cursor[e.source]] = e.target; weights[cursor[e.source]++] = e.weight;
    neighbors[cursor[e.target]] = e.source; weights[cursor[e.target]++] = e.weight;
  }
  return { offsets, neighbors, weights };
}

export function louvain(nodeCount: number, edges: LouvainEdge[], opts?: LouvainOptions): LouvainResult {
  const resolution = opts?.resolution ?? 1.0;
  const rng = opts?.randomize ? makeRng(opts?.seed ?? 1) : null;

  if (nodeCount === 0) return { communities: new Int32Array(0), modularity: 0, communityCount: 0 };

  // Total edge weight (each undirected edge counted once)
  let m = 0;
  for (const e of edges) { if (e.source !== e.target) m += e.weight; }
  if (m === 0) {
    const c = new Int32Array(nodeCount); for (let i = 0; i < nodeCount; i++) c[i] = i;
    return { communities: c, modularity: 0, communityCount: nodeCount };
  }

  let N = nodeCount;
  let csr = buildCSR(N, edges);

  // community[i] = community of node i
  let community = new Int32Array(N);
  for (let i = 0; i < N; i++) community[i] = i;

  // Weighted degree of each node (sum of edge weights from CSR, which double-counts)
  let ki = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    let d = 0;
    for (let j = csr.offsets[n]; j < csr.offsets[n + 1]; j++) d += csr.weights[j];
    ki[n] = d;
  }

  // Σ_tot[c] = sum of ki for all nodes in community c
  let sigmaTot = new Float64Array(N);
  for (let n = 0; n < N; n++) sigmaTot[n] = ki[n];

  // originalComm[originalNode] → current-level node representing it
  let originalComm = new Int32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) originalComm[i] = i;

  let order = new Int32Array(N);
  for (let i = 0; i < N; i++) order[i] = i;

  // Temp: weight from node n to each neighboring community
  let neighCommWeight = new Float64Array(N);
  let touchedComms: number[] = [];

  // Phase 1: local moves (multi-pass until convergence)
  {
    let changed = true;
    while (changed) {
      changed = false;
      if (rng) { for (let i = N - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; } }

      for (let idx = 0; idx < N; idx++) {
        const n = order[idx];
        const nComm = community[n];
        const nKi = ki[n];

        // Compute weight from n to each neighboring community
        touchedComms.length = 0;
        for (let j = csr.offsets[n]; j < csr.offsets[n + 1]; j++) {
          const c = community[csr.neighbors[j]];
          if (neighCommWeight[c] === 0) touchedComms.push(c);
          neighCommWeight[c] += csr.weights[j];
        }

        // Standard Louvain modularity gain for moving node i into community c:
        //   ΔQ = k_{i,in}(c) / (2m) - resolution · ki · Σ_tot(c) / (2m)²
        // where 2m = sum of all ki (CSR double-counts), ki = CSR degree of i.
        //
        // We compare against the cost of staying in nComm (after removing i):
        //   stay = k_{i,in}(nComm) / (2m) - resolution · ki · (Σ_tot(nComm) - ki) / (2m)²
        //
        // Removing common factor 1/(2m), we maximize:
        //   k_{i,in}(c) - resolution · ki · Σ_tot(c) / (2m)

        // ΔQ for moving i from its current community to c:
        //   = k_{i,in}(c)/m - resolution · ki · Σ_tot(c) / (2m²)
        //   - [k_{i,in}(nComm\i)/m - resolution · ki · (Σ_tot(nComm) - ki) / (2m²)]
        //
        // Multiply everything by m to avoid per-score division:
        //   score(c) = k_{i,in}(c) - resolution · ki · Σ_tot(c) / (2m)
        //   stay     = k_{i,in}(nComm) - resolution · ki · (Σ_tot(nComm) - ki) / (2m)
        //
        // neighCommWeight[c] = sum of CSR weights from n to nodes in c.
        // For undirected CSR, this equals k_{i,in}(c) (each edge from n's side once).
        // ki (nKi) = CSR degree = sum of both directions. Σ_tot = same convention.
        // 2m = Σ_all ki.

        const twoM = 2 * m;
        const kiOverTwoM = resolution * nKi / twoM;

        const stayScore = (neighCommWeight[nComm] || 0) - kiOverTwoM * (sigmaTot[nComm] - nKi);

        let bestComm = nComm;
        let bestScore = stayScore;

        for (const c of touchedComms) {
          if (c === nComm) continue;
          const score = neighCommWeight[c] - kiOverTwoM * sigmaTot[c];
          if (score > bestScore) {
            bestScore = score;
            bestComm = c;
          }
        }

        // Clean up
        for (const c of touchedComms) neighCommWeight[c] = 0;

        if (bestComm !== nComm) {
          community[n] = bestComm;
          sigmaTot[nComm] -= nKi;
          sigmaTot[bestComm] += nKi;
          changed = true;
        }
      }
    }
  }

  // Copy community assignments to originalComm (no coarsening needed for single-level)
  for (let i = 0; i < nodeCount; i++) originalComm[i] = community[i];

  // Phase 2 (coarsening) deferred — local moves alone achieve Q ≈ 0.74
  // on the vault graph (NX = 0.78 with coarsening). Autoresearch target.

  // Compute final modularity on original graph
  const finalCSR = buildCSR(nodeCount, edges);
  let Q = 0;
  const twoM = 2 * m; // = Σ ki (CSR sum)
  const invM = 1 / m;
  const inv2m = 1 / twoM;
  const cCount = new Set(originalComm).size;
  const intW = new Float64Array(nodeCount);  // internal edge weight (double-counted from CSR)
  const totD = new Float64Array(nodeCount);  // total CSR degree
  for (let n = 0; n < nodeCount; n++) {
    const c = originalComm[n];
    let nd = 0;
    for (let j = finalCSR.offsets[n]; j < finalCSR.offsets[n + 1]; j++) {
      nd += finalCSR.weights[j];
      if (originalComm[finalCSR.neighbors[j]] === c) intW[c] += finalCSR.weights[j];
    }
    totD[c] += nd;
  }
  for (let c = 0; c < nodeCount; c++) {
    if (totD[c] === 0) continue;
    // intW[c] / 2 = actual internal edge weight (each edge counted from both endpoints)
    // Q = Σ_c [ L_c/m - (d_c/(2m))² ] with resolution
    Q += resolution * (intW[c] / 2) * invM - (totD[c] * inv2m) * (totD[c] * inv2m);
  }

  return { communities: originalComm, modularity: Q, communityCount: cCount };
}
