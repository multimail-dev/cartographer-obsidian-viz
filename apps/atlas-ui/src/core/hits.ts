/**
 * hits.ts — HITS (Kleinberg's Hubs & Authorities) algorithm.
 *
 * Iterative power method with L2 normalization. Converges when max
 * relative change < epsilon.
 *
 * For undirected graphs, hub and authority scores converge to the same
 * values (equivalent to eigenvector centrality). Most useful on directed
 * graphs but works on both.
 *
 * API:
 *   hits(nodeCount, edges, opts?) →
 *     { hubs: Float64Array, authorities: Float64Array, iterations: number }
 */

export interface HITSEdge {
  source: number;
  target: number;
}

export interface HITSOptions {
  epsilon?: number;    // default 1e-8
  maxIter?: number;    // default 100
}

export interface HITSResult {
  hubs: Float64Array;
  authorities: Float64Array;
  iterations: number;
}

export function hits(
  nodeCount: number,
  edges: HITSEdge[],
  opts?: HITSOptions,
): HITSResult {
  const epsilon = opts?.epsilon ?? 1e-8;
  const maxIter = opts?.maxIter ?? 100;

  const hubs = new Float64Array(nodeCount).fill(1);
  const auth = new Float64Array(nodeCount);

  if (nodeCount === 0) {
    return { hubs: new Float64Array(0), authorities: new Float64Array(0), iterations: 0 };
  }

  // Build CSR for outgoing (source→target) and incoming (target←source)
  const outDeg = new Int32Array(nodeCount);
  const inDeg = new Int32Array(nodeCount);
  for (const e of edges) {
    if (e.source === e.target) continue;
    outDeg[e.source]++;
    inDeg[e.target]++;
    // Undirected: also reverse
    outDeg[e.target]++;
    inDeg[e.source]++;
  }
  // Out CSR
  const outOff = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) outOff[i + 1] = outOff[i] + outDeg[i];
  const outNb = new Int32Array(outOff[nodeCount]);
  const outCur = new Int32Array(nodeCount);
  outCur.set(outOff.subarray(0, nodeCount));
  // In CSR
  const inOff = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) inOff[i + 1] = inOff[i] + inDeg[i];
  const inNb = new Int32Array(inOff[nodeCount]);
  const inCur = new Int32Array(nodeCount);
  inCur.set(inOff.subarray(0, nodeCount));

  for (const e of edges) {
    if (e.source === e.target) continue;
    outNb[outCur[e.source]++] = e.target;
    inNb[inCur[e.target]++] = e.source;
    // Undirected reverse
    outNb[outCur[e.target]++] = e.source;
    inNb[inCur[e.source]++] = e.target;
  }

  let iter = 0;
  for (; iter < maxIter; iter++) {
    // Authority update: auth[i] = sum of hub[j] for all j→i
    auth.fill(0);
    for (let n = 0; n < nodeCount; n++) {
      for (let j = inOff[n]; j < inOff[n + 1]; j++) {
        auth[n] += hubs[inNb[j]];
      }
    }
    // L2 normalize authorities
    let norm = 0;
    for (let n = 0; n < nodeCount; n++) norm += auth[n] * auth[n];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let n = 0; n < nodeCount; n++) auth[n] /= norm;

    // Hub update: hub[i] = sum of auth[j] for all i→j
    let maxDiff = 0;
    for (let n = 0; n < nodeCount; n++) {
      let newHub = 0;
      for (let j = outOff[n]; j < outOff[n + 1]; j++) {
        newHub += auth[outNb[j]];
      }
      const diff = Math.abs(newHub - hubs[n]);
      if (diff > maxDiff) maxDiff = diff;
      hubs[n] = newHub;
    }
    // L2 normalize hubs
    norm = 0;
    for (let n = 0; n < nodeCount; n++) norm += hubs[n] * hubs[n];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let n = 0; n < nodeCount; n++) hubs[n] /= norm;

    if (maxDiff < epsilon) break;
  }

  return { hubs, authorities: auth, iterations: iter };
}
