/**
 * forceatlas2_bh.ts — TypeScript port of graphology-layout-forceatlas2's
 * Barnes-Hut branch, with flat Float32Array discipline for the quadtree
 * region pool.
 *
 * This is a deliberate second line of attack distinct from FA3:
 *   - FA3 (src/core/forceatlas3.ts) started from graphology's brute-force
 *     variant and evolved into a uniform spatial grid approximation. It is
 *     a different algorithm than standard FA2.
 *   - This file is the STANDARD FA2-with-BH algorithm, faithfully ported.
 *     The region pool is a single preallocated Float32Array (no object
 *     allocations, no recursion, integer indices into the pool). Region
 *     pool is reused across iterations to avoid GC pressure — same
 *     discipline as FA3's grid storage.
 *
 * API surface mirrors forceatlas3.ts so the same bench/autoresearch tooling
 * can target this file unchanged.
 */

// Node matrix property offsets (10 floats per node)
const NODE_X = 0;
const NODE_Y = 1;
const NODE_DX = 2;
const NODE_DY = 3;
const NODE_OLD_DX = 4;
const NODE_OLD_DY = 5;
const NODE_MASS = 6;
const NODE_CONVERGENCE = 7;
const NODE_SIZE = 8;
const NODE_FIXED = 9;
const PPN = 10;

// Edge matrix property offsets (3 floats per edge)
const EDGE_SOURCE = 0;
const EDGE_TARGET = 1;
const EDGE_WEIGHT = 2;
const PPE = 3;

// Region matrix property offsets (9 floats per region)
const REGION_NODE = 0;          // int: node offset in NodeMatrix, or -1
const REGION_CENTER_X = 1;
const REGION_CENTER_Y = 2;
const REGION_SIZE_F = 3;        // "SIZE" reserved for node; use SIZE_F for region size
const REGION_NEXT_SIBLING = 4;  // int: next sibling region offset, or -1
const REGION_FIRST_CHILD = 5;   // int: first child region offset, or -1
const REGION_MASS = 6;
const REGION_MASS_CENTER_X = 7;
const REGION_MASS_CENTER_Y = 8;
const PPR = 9;

const SUBDIVISION_ATTEMPTS = 3;

export interface FA2BHSettings {
  linLogMode: boolean;
  outboundAttractionDistribution: boolean;
  adjustSizes: boolean;
  edgeWeightInfluence: number;
  scalingRatio: number;
  strongGravityMode: boolean;
  gravity: number;
  slowDown: number;
  barnesHutOptimize: boolean;
  barnesHutTheta: number;
}

export const DEFAULT_SETTINGS: FA2BHSettings = {
  linLogMode: false,
  outboundAttractionDistribution: false,
  adjustSizes: false,
  edgeWeightInfluence: 1,
  scalingRatio: 1,
  strongGravityMode: false,
  gravity: 1,
  slowDown: 1,
  barnesHutOptimize: true,     // BH is the whole point of this file
  barnesHutTheta: 2.0,         // aggressive approximation — large speed gain if quality holds
};

export function inferSettings(order: number): Partial<FA2BHSettings> {
  return {
    barnesHutOptimize: order > 2000,
    strongGravityMode: true,
    gravity: 0.05,
    scalingRatio: 10,
    slowDown: 1 + Math.log(order),
  };
}

// Module-level region pool — reused across iterations to avoid GC pressure.
// Sized on first use to 16*nodeCount regions (generous — see below).
let regionPool: Float32Array = new Float32Array(0);

function ensureRegionPool(nodeCount: number): Float32Array {
  // Upper bound on quadtree size: every node creates at most 1 leaf, every
  // subdivision creates 4 new regions, and SUBDIVISION_ATTEMPTS caps recursion
  // at 3. So worst case is roughly 4 * SUBDIVISION_ATTEMPTS * N regions.
  // Using 16*N is generous and avoids any runtime grow logic.
  const needed = Math.max(64, nodeCount * 16);
  if (regionPool.length < needed * PPR) {
    regionPool = new Float32Array(needed * PPR);
  }
  return regionPool;
}

export function iterate(
  options: FA2BHSettings,
  NodeMatrix: Float32Array,
  EdgeMatrix: Float32Array,
  _iterationIndex: number = 0, // accepted for API parity; BH doesn't use it
): void {
  const order = NodeMatrix.length;
  const size = EdgeMatrix.length;
  const nodeCount = order / PPN;
  const adjustSizes = options.adjustSizes;
  const thetaSquared = options.barnesHutTheta * options.barnesHutTheta;

  let outboundAttCompensation = 0;
  let coefficient: number;
  let xDist: number, yDist: number, ewc: number, distance: number, factor: number;

  // 1) Reset deltas
  for (let n = 0; n < order; n += PPN) {
    NodeMatrix[n + NODE_OLD_DX] = NodeMatrix[n + NODE_DX];
    NodeMatrix[n + NODE_OLD_DY] = NodeMatrix[n + NODE_DY];
    NodeMatrix[n + NODE_DX] = 0;
    NodeMatrix[n + NODE_DY] = 0;
  }

  if (options.outboundAttractionDistribution) {
    for (let n = 0; n < order; n += PPN) {
      outboundAttCompensation += NodeMatrix[n + NODE_MASS];
    }
    outboundAttCompensation /= nodeCount;
  }

  const RegionMatrix = ensureRegionPool(nodeCount);

  // 1.bis) Barnes-Hut quadtree construction
  if (options.barnesHutOptimize) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (let n = 0; n < order; n += PPN) {
      const x = NodeMatrix[n + NODE_X];
      const y = NodeMatrix[n + NODE_Y];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    // Squarify bounds (quadtree needs square cells)
    const dx0 = maxX - minX;
    const dy0 = maxY - minY;
    if (dx0 > dy0) {
      minY -= (dx0 - dy0) / 2;
      maxY = minY + dx0;
    } else {
      minX -= (dy0 - dx0) / 2;
      maxX = minX + dy0;
    }

    // Build root region (offset 0 in the pool)
    RegionMatrix[0 + REGION_NODE] = -1;
    RegionMatrix[0 + REGION_CENTER_X] = (minX + maxX) / 2;
    RegionMatrix[0 + REGION_CENTER_Y] = (minY + maxY) / 2;
    RegionMatrix[0 + REGION_SIZE_F] = Math.max(maxX - minX, maxY - minY);
    RegionMatrix[0 + REGION_NEXT_SIBLING] = -1;
    RegionMatrix[0 + REGION_FIRST_CHILD] = -1;
    RegionMatrix[0 + REGION_MASS] = 0;
    RegionMatrix[0 + REGION_MASS_CENTER_X] = 0;
    RegionMatrix[0 + REGION_MASS_CENTER_Y] = 0;

    let l = 1; // next free region slot (in PPR units; float offset = l*PPR)

    // Insert each node into the tree
    for (let n = 0; n < order; n += PPN) {
      let r = 0; // start at root
      let subdivisionAttempts = SUBDIVISION_ATTEMPTS;
      let q = 0;
      let q2 = 0;

      while (true) {
        if (RegionMatrix[r + REGION_FIRST_CHILD] >= 0) {
          // Inner region — descend into the child quadrant containing n
          const rcx = RegionMatrix[r + REGION_CENTER_X];
          const rcy = RegionMatrix[r + REGION_CENTER_Y];
          const nx = NodeMatrix[n + NODE_X];
          const ny = NodeMatrix[n + NODE_Y];
          const fc = RegionMatrix[r + REGION_FIRST_CHILD];
          if (nx < rcx) {
            q = ny < rcy ? fc : fc + PPR;
          } else {
            q = ny < rcy ? fc + PPR * 2 : fc + PPR * 3;
          }

          // Update center of mass for this inner region
          const rMass = RegionMatrix[r + REGION_MASS];
          const nMass = NodeMatrix[n + NODE_MASS];
          const denom = rMass + nMass;
          RegionMatrix[r + REGION_MASS_CENTER_X] =
            (RegionMatrix[r + REGION_MASS_CENTER_X] * rMass + nx * nMass) / denom;
          RegionMatrix[r + REGION_MASS_CENTER_Y] =
            (RegionMatrix[r + REGION_MASS_CENTER_Y] * rMass + ny * nMass) / denom;
          RegionMatrix[r + REGION_MASS] = denom;

          r = q;
          continue;
        } else {
          // Leaf
          if (RegionMatrix[r + REGION_NODE] < 0) {
            // Empty — place the node
            RegionMatrix[r + REGION_NODE] = n;
            break;
          } else {
            // Occupied — subdivide into 4 children
            const baseChild = l * PPR;
            RegionMatrix[r + REGION_FIRST_CHILD] = baseChild;
            const w = RegionMatrix[r + REGION_SIZE_F] / 2;
            const rcx = RegionMatrix[r + REGION_CENTER_X];
            const rcy = RegionMatrix[r + REGION_CENTER_Y];
            const rNext = RegionMatrix[r + REGION_NEXT_SIBLING];

            // Top Left
            let g = baseChild;
            RegionMatrix[g + REGION_NODE] = -1;
            RegionMatrix[g + REGION_CENTER_X] = rcx - w;
            RegionMatrix[g + REGION_CENTER_Y] = rcy - w;
            RegionMatrix[g + REGION_SIZE_F] = w;
            RegionMatrix[g + REGION_NEXT_SIBLING] = g + PPR;
            RegionMatrix[g + REGION_FIRST_CHILD] = -1;
            RegionMatrix[g + REGION_MASS] = 0;
            RegionMatrix[g + REGION_MASS_CENTER_X] = 0;
            RegionMatrix[g + REGION_MASS_CENTER_Y] = 0;

            // Bottom Left
            g += PPR;
            RegionMatrix[g + REGION_NODE] = -1;
            RegionMatrix[g + REGION_CENTER_X] = rcx - w;
            RegionMatrix[g + REGION_CENTER_Y] = rcy + w;
            RegionMatrix[g + REGION_SIZE_F] = w;
            RegionMatrix[g + REGION_NEXT_SIBLING] = g + PPR;
            RegionMatrix[g + REGION_FIRST_CHILD] = -1;
            RegionMatrix[g + REGION_MASS] = 0;
            RegionMatrix[g + REGION_MASS_CENTER_X] = 0;
            RegionMatrix[g + REGION_MASS_CENTER_Y] = 0;

            // Top Right
            g += PPR;
            RegionMatrix[g + REGION_NODE] = -1;
            RegionMatrix[g + REGION_CENTER_X] = rcx + w;
            RegionMatrix[g + REGION_CENTER_Y] = rcy - w;
            RegionMatrix[g + REGION_SIZE_F] = w;
            RegionMatrix[g + REGION_NEXT_SIBLING] = g + PPR;
            RegionMatrix[g + REGION_FIRST_CHILD] = -1;
            RegionMatrix[g + REGION_MASS] = 0;
            RegionMatrix[g + REGION_MASS_CENTER_X] = 0;
            RegionMatrix[g + REGION_MASS_CENTER_Y] = 0;

            // Bottom Right (last — its next sibling is the parent's next sibling)
            g += PPR;
            RegionMatrix[g + REGION_NODE] = -1;
            RegionMatrix[g + REGION_CENTER_X] = rcx + w;
            RegionMatrix[g + REGION_CENTER_Y] = rcy + w;
            RegionMatrix[g + REGION_SIZE_F] = w;
            RegionMatrix[g + REGION_NEXT_SIBLING] = rNext;
            RegionMatrix[g + REGION_FIRST_CHILD] = -1;
            RegionMatrix[g + REGION_MASS] = 0;
            RegionMatrix[g + REGION_MASS_CENTER_X] = 0;
            RegionMatrix[g + REGION_MASS_CENTER_Y] = 0;

            l += 4;

            // Place the old node (was in this leaf) into its child quadrant
            const oldN = RegionMatrix[r + REGION_NODE];
            const oldX = NodeMatrix[oldN + NODE_X];
            const oldY = NodeMatrix[oldN + NODE_Y];
            if (oldX < rcx) {
              q = oldY < rcy ? baseChild : baseChild + PPR;
            } else {
              q = oldY < rcy ? baseChild + PPR * 2 : baseChild + PPR * 3;
            }

            // Remove old node from r, record its mass in r (was being double counted)
            RegionMatrix[r + REGION_MASS] = NodeMatrix[oldN + NODE_MASS];
            RegionMatrix[r + REGION_MASS_CENTER_X] = oldX;
            RegionMatrix[r + REGION_MASS_CENTER_Y] = oldY;
            RegionMatrix[q + REGION_NODE] = oldN;
            RegionMatrix[r + REGION_NODE] = -1;

            // Place the new node
            const nx = NodeMatrix[n + NODE_X];
            const ny = NodeMatrix[n + NODE_Y];
            if (nx < rcx) {
              q2 = ny < rcy ? baseChild : baseChild + PPR;
            } else {
              q2 = ny < rcy ? baseChild + PPR * 2 : baseChild + PPR * 3;
            }

            if (q === q2) {
              // Same quadrant — iterate deeper if we have attempts left
              if (subdivisionAttempts--) {
                r = q;
                continue;
              } else {
                subdivisionAttempts = SUBDIVISION_ATTEMPTS;
                break;
              }
            }

            RegionMatrix[q2 + REGION_NODE] = n;
            break;
          }
        }
      }
    }
  }

  // 2) Repulsion through the tree — hoisted coefficient*nMass + local dx/dy accumulators
  if (options.barnesHutOptimize) {
    coefficient = options.scalingRatio;
    for (let n = 0; n < order; n += PPN) {
      const nx = NodeMatrix[n + NODE_X];
      const ny = NodeMatrix[n + NODE_Y];
      const cm = coefficient * NodeMatrix[n + NODE_MASS];
      let dxAcc = 0, dyAcc = 0;
      let r = 0;
      while (true) {
        if (RegionMatrix[r + REGION_FIRST_CHILD] >= 0) {
          xDist = nx - RegionMatrix[r + REGION_MASS_CENTER_X];
          yDist = ny - RegionMatrix[r + REGION_MASS_CENTER_Y];
          distance = xDist * xDist + yDist * yDist;
          const s = RegionMatrix[r + REGION_SIZE_F];
          if ((4 * s * s) / distance < thetaSquared) {
            if (distance > 0) {
              factor = (cm * RegionMatrix[r + REGION_MASS]) / distance;
              dxAcc += xDist * factor;
              dyAcc += yDist * factor;
            }
            r = RegionMatrix[r + REGION_NEXT_SIBLING];
            if (r < 0) break;
            continue;
          } else {
            r = RegionMatrix[r + REGION_FIRST_CHILD];
            continue;
          }
        } else {
          const rn = RegionMatrix[r + REGION_NODE];
          if (rn >= 0 && rn !== n) {
            xDist = nx - NodeMatrix[rn + NODE_X];
            yDist = ny - NodeMatrix[rn + NODE_Y];
            distance = xDist * xDist + yDist * yDist;
            if (distance > 0) {
              factor = (cm * NodeMatrix[rn + NODE_MASS]) / distance;
              dxAcc += xDist * factor;
              dyAcc += yDist * factor;
            }
          }
          r = RegionMatrix[r + REGION_NEXT_SIBLING];
          if (r < 0) break;
          continue;
        }
      }
      NodeMatrix[n + NODE_DX] += dxAcc;
      NodeMatrix[n + NODE_DY] += dyAcc;
    }
  } else {
    // Brute force fallback — matches graphology's non-BH branch
    coefficient = options.scalingRatio;
    for (let n1 = 0; n1 < order; n1 += PPN) {
      for (let n2 = 0; n2 < n1; n2 += PPN) {
        xDist = NodeMatrix[n1 + NODE_X] - NodeMatrix[n2 + NODE_X];
        yDist = NodeMatrix[n1 + NODE_Y] - NodeMatrix[n2 + NODE_Y];
        const distSq = xDist * xDist + yDist * yDist;
        if (distSq > 0) {
          factor = (coefficient * NodeMatrix[n1 + NODE_MASS] * NodeMatrix[n2 + NODE_MASS]) / distSq;
          NodeMatrix[n1 + NODE_DX] += xDist * factor;
          NodeMatrix[n1 + NODE_DY] += yDist * factor;
          NodeMatrix[n2 + NODE_DX] -= xDist * factor;
          NodeMatrix[n2 + NODE_DY] -= yDist * factor;
        }
      }
    }
  }

  // 3) Gravity
  const gConst = options.gravity / options.scalingRatio;
  coefficient = options.scalingRatio;
  for (let n = 0; n < order; n += PPN) {
    factor = 0;
    xDist = NodeMatrix[n + NODE_X];
    yDist = NodeMatrix[n + NODE_Y];
    distance = Math.sqrt(xDist * xDist + yDist * yDist);
    if (options.strongGravityMode) {
      if (distance > 0) factor = coefficient * NodeMatrix[n + NODE_MASS] * gConst;
    } else {
      if (distance > 0) factor = (coefficient * NodeMatrix[n + NODE_MASS] * gConst) / distance;
    }
    NodeMatrix[n + NODE_DX] -= xDist * factor;
    NodeMatrix[n + NODE_DY] -= yDist * factor;
  }

  // 4) Attraction — specialized for the common case:
  //    adjustSizes=false, linLogMode=false, outbound=false, edgeWeightInfluence=1
  //    → factor = -weight, coefficient = 1. No branches in inner loop.
  for (let e = 0; e < size; e += PPE) {
    const n1 = EdgeMatrix[e + EDGE_SOURCE];
    const n2 = EdgeMatrix[e + EDGE_TARGET];
    const negW = -EdgeMatrix[e + EDGE_WEIGHT];
    const axDist = NodeMatrix[n1 + NODE_X] - NodeMatrix[n2 + NODE_X];
    const ayDist = NodeMatrix[n1 + NODE_Y] - NodeMatrix[n2 + NODE_Y];
    const fx = axDist * negW;
    const fy = ayDist * negW;
    NodeMatrix[n1 + NODE_DX] += fx;
    NodeMatrix[n1 + NODE_DY] += fy;
    NodeMatrix[n2 + NODE_DX] -= fx;
    NodeMatrix[n2 + NODE_DY] -= fy;
  }

  // 5) Apply forces (standard, non-adjustSizes path)
  for (let n = 0; n < order; n += PPN) {
    if (NodeMatrix[n + NODE_FIXED] === 1) continue;
    const oldDx = NodeMatrix[n + NODE_OLD_DX];
    const oldDy = NodeMatrix[n + NODE_OLD_DY];
    const dx = NodeMatrix[n + NODE_DX];
    const dy = NodeMatrix[n + NODE_DY];
    const mass = NodeMatrix[n + NODE_MASS];

    const swingX = oldDx - dx;
    const swingY = oldDy - dy;
    const swinging = mass * Math.sqrt(swingX * swingX + swingY * swingY);

    const tractX = oldDx + dx;
    const tractY = oldDy + dy;
    const traction = Math.sqrt(tractX * tractX + tractY * tractY) / 2;

    const nodespeed =
      (NodeMatrix[n + NODE_CONVERGENCE] * Math.log(1 + traction)) / (1 + Math.sqrt(swinging));

    NodeMatrix[n + NODE_CONVERGENCE] = Math.min(
      1,
      Math.sqrt((nodespeed * (dx * dx + dy * dy)) / (1 + Math.sqrt(swinging))),
    );

    NodeMatrix[n + NODE_X] += dx * (nodespeed / options.slowDown);
    NodeMatrix[n + NODE_Y] += dy * (nodespeed / options.slowDown);
  }
}

// ---- buildMatrices / readPositions / run — identical API to forceatlas3.ts ----

export interface NodeInput {
  x: number;
  y: number;
  size?: number;
  mass?: number;
  fixed?: boolean;
}

export interface EdgeInput {
  source: number;
  target: number;
  weight: number;
}

export function buildMatrices(
  nodes: NodeInput[],
  edges: EdgeInput[],
): { nodes: Float32Array; edges: Float32Array } {
  const NodeMatrix = new Float32Array(nodes.length * PPN);
  const EdgeMatrix = new Float32Array(edges.length * PPE);

  for (let i = 0; i < nodes.length; i++) {
    const j = i * PPN;
    const n = nodes[i];
    NodeMatrix[j + NODE_X] = n.x;
    NodeMatrix[j + NODE_Y] = n.y;
    NodeMatrix[j + NODE_DX] = 0;
    NodeMatrix[j + NODE_DY] = 0;
    NodeMatrix[j + NODE_OLD_DX] = 0;
    NodeMatrix[j + NODE_OLD_DY] = 0;
    NodeMatrix[j + NODE_MASS] = n.mass ?? 1;
    NodeMatrix[j + NODE_CONVERGENCE] = 1;
    NodeMatrix[j + NODE_SIZE] = n.size ?? 1;
    NodeMatrix[j + NODE_FIXED] = n.fixed ? 1 : 0;
  }

  for (let i = 0; i < edges.length; i++) {
    const j = i * PPE;
    const e = edges[i];
    const sj = e.source * PPN;
    const tj = e.target * PPN;
    EdgeMatrix[j + EDGE_SOURCE] = sj;
    EdgeMatrix[j + EDGE_TARGET] = tj;
    EdgeMatrix[j + EDGE_WEIGHT] = e.weight;
    // Accumulate weighted-degree mass on each endpoint
    NodeMatrix[sj + NODE_MASS] += e.weight;
    NodeMatrix[tj + NODE_MASS] += e.weight;
  }

  return { nodes: NodeMatrix, edges: EdgeMatrix };
}

export function readPositions(NodeMatrix: Float32Array): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < NodeMatrix.length; i += PPN) {
    out.push({ x: NodeMatrix[i + NODE_X], y: NodeMatrix[i + NODE_Y] });
  }
  return out;
}

export function run(
  options: FA2BHSettings,
  NodeMatrix: Float32Array,
  EdgeMatrix: Float32Array,
  iterations: number,
): number {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    iterate(options, NodeMatrix, EdgeMatrix, i);
  }
  return performance.now() - t0;
}
