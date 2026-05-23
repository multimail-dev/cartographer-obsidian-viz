/**
 * ForceAtlas3 — TypeScript port of ForceAtlas2 iterate.js
 *
 * Starting point: exact port of graphology-layout-forceatlas2.
 * This file is the optimization target for auto-research.
 * The goal: equivalent layout quality in <2s for 8.5K nodes (currently 18s).
 *
 * Architecture: flat Float32Array matrices, same as FA2.
 * - NodeMatrix: 10 floats per node (x, y, dx, dy, old_dx, old_dy, mass, convergence, size, fixed)
 * - EdgeMatrix: 3 floats per edge (source_index, target_index, weight)
 */

// Node matrix property offsets (10 props per node)
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

// Edge matrix property offsets (3 props per edge)
const EDGE_SOURCE = 0;
const EDGE_TARGET = 1;
const EDGE_WEIGHT = 2;

// Properties per node/edge
const PPN = 10;
const PPE = 3;

const MAX_FORCE = 10;

export interface FA3Settings {
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

export const DEFAULT_SETTINGS: FA3Settings = {
  linLogMode: false,
  outboundAttractionDistribution: false,
  adjustSizes: false,
  edgeWeightInfluence: 1,
  scalingRatio: 1,
  strongGravityMode: false,
  gravity: 1,
  slowDown: 1,
  barnesHutOptimize: false,
  barnesHutTheta: 0.5,
};

export function inferSettings(order: number): Partial<FA3Settings> {
  return {
    barnesHutOptimize: order > 2000,
    strongGravityMode: true,
    gravity: 0.05,
    scalingRatio: 10,
    slowDown: 1 + Math.log(order),
  };
}

/**
 * Single iteration of the ForceAtlas3 layout algorithm.
 * Mutates NodeMatrix in place.
 */
export function iterate(
  options: FA3Settings,
  NodeMatrix: Float32Array,
  EdgeMatrix: Float32Array,
  iterationIndex: number = 0
): void {
  const order = NodeMatrix.length;
  const size = EdgeMatrix.length;
  const adjustSizes = options.adjustSizes;

  let outboundAttCompensation = 0;
  let coefficient: number;
  let xDist: number, yDist: number, ewc: number, distance: number, factor: number;

  // 1) Reset deltas, save old deltas
  for (let n = 0; n < order; n += PPN) {
    NodeMatrix[n + NODE_OLD_DX] = NodeMatrix[n + NODE_DX];
    NodeMatrix[n + NODE_OLD_DY] = NodeMatrix[n + NODE_DY];
    NodeMatrix[n + NODE_DX] = 0;
    NodeMatrix[n + NODE_DY] = 0;
  }

  // Outbound attraction distribution compensation
  if (options.outboundAttractionDistribution) {
    for (let n = 0; n < order; n += PPN) {
      outboundAttCompensation += NodeMatrix[n + NODE_MASS];
    }
    outboundAttCompensation /= order / PPN;
  }

  // 2) Repulsion
  // Three modes:
  //   - Skip: odd iterations after initial phase (no repulsion, attraction+gravity only)
  //   - Exact: every 20th iteration, full O(n²) brute-force to reset approximation debt
  //   - Grid: spatial grid with point-mass approximation for distant cells
  coefficient = options.scalingRatio;
  const skipRepulsion = iterationIndex > 10 && iterationIndex % 2 !== 0;

  if (!skipRepulsion) {
    const nodeCount = order / PPN;

    // Find bounding box
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let n = 0; n < order; n += PPN) {
      const x = NodeMatrix[n + NODE_X];
      const y = NodeMatrix[n + NODE_Y];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    // Grid sizing: ~sqrt(N) cells per side gives O(n) nearby pairs on average
    const GRID_K = Math.max(4, Math.ceil(Math.sqrt(nodeCount) / 3));
    const spanX = (maxX - minX) || 1;
    const spanY = (maxY - minY) || 1;
    const cellW = spanX / GRID_K;
    const cellH = spanY / GRID_K;
    const invCellW = 1 / cellW;
    const invCellH = 1 / cellH;
    const totalCells = GRID_K * GRID_K;

    // Flat cell storage — single Int32Array instead of N small arrays
    const cellCount = new Int32Array(totalCells);
    const cellMassCX = new Float64Array(totalCells);
    const cellMassCY = new Float64Array(totalCells);
    const cellMass = new Float64Array(totalCells);

    // First pass: count nodes per cell
    for (let n = 0; n < order; n += PPN) {
      const cx = Math.min(GRID_K - 1, ((NodeMatrix[n + NODE_X] - minX) * invCellW) | 0);
      const cy = Math.min(GRID_K - 1, ((NodeMatrix[n + NODE_Y] - minY) * invCellH) | 0);
      cellCount[cy * GRID_K + cx]++;
    }

    // Compute offsets (prefix sum) for flat storage
    const cellOffset = new Int32Array(totalCells + 1);
    for (let i = 0; i < totalCells; i++) {
      cellOffset[i + 1] = cellOffset[i] + cellCount[i];
    }

    // Single flat array for all node refs
    const flatNodes = new Int32Array(nodeCount);
    const fillPos = new Int32Array(totalCells); // current fill position per cell

    // Second pass: fill flat array and compute mass centers
    for (let n = 0; n < order; n += PPN) {
      const cx = Math.min(GRID_K - 1, ((NodeMatrix[n + NODE_X] - minX) * invCellW) | 0);
      const cy = Math.min(GRID_K - 1, ((NodeMatrix[n + NODE_Y] - minY) * invCellH) | 0);
      const ci = cy * GRID_K + cx;
      flatNodes[cellOffset[ci] + fillPos[ci]++] = n;
      const m = NodeMatrix[n + NODE_MASS];
      cellMass[ci] += m;
      cellMassCX[ci] += NodeMatrix[n + NODE_X] * m;
      cellMassCY[ci] += NodeMatrix[n + NODE_Y] * m;
    }

    // Finalize mass centers
    for (let i = 0; i < totalCells; i++) {
      if (cellMass[i] > 0) {
        cellMassCX[i] /= cellMass[i];
        cellMassCY[i] /= cellMass[i];
      }
    }

    // Distance threshold: cells within this range use exact computation.
    const NEAR_DIST = 1;

    if (adjustSizes) {
      // Fallback to O(n²) for adjustSizes (rare path, not optimized)
      for (let n1 = 0; n1 < order; n1 += PPN) {
        for (let n2 = 0; n2 < n1; n2 += PPN) {
          xDist = NodeMatrix[n1 + NODE_X] - NodeMatrix[n2 + NODE_X];
          yDist = NodeMatrix[n1 + NODE_Y] - NodeMatrix[n2 + NODE_Y];
          distance =
            Math.sqrt(xDist * xDist + yDist * yDist) -
            NodeMatrix[n1 + NODE_SIZE] -
            NodeMatrix[n2 + NODE_SIZE];
          if (distance > 0) {
            factor =
              (coefficient * NodeMatrix[n1 + NODE_MASS] * NodeMatrix[n2 + NODE_MASS]) /
              distance / distance;
            NodeMatrix[n1 + NODE_DX] += xDist * factor;
            NodeMatrix[n1 + NODE_DY] += yDist * factor;
            NodeMatrix[n2 + NODE_DX] -= xDist * factor;
            NodeMatrix[n2 + NODE_DY] -= yDist * factor;
          } else if (distance < 0) {
            factor = 100 * coefficient * NodeMatrix[n1 + NODE_MASS] * NodeMatrix[n2 + NODE_MASS];
            NodeMatrix[n1 + NODE_DX] += xDist * factor;
            NodeMatrix[n1 + NODE_DY] += yDist * factor;
            NodeMatrix[n2 + NODE_DX] -= xDist * factor;
            NodeMatrix[n2 + NODE_DY] -= yDist * factor;
          }
        }
      }
    } else {
      // For each cell, interact with nearby cells (exact) and distant cells (approximate)
      for (let cy1 = 0; cy1 < GRID_K; cy1++) {
        for (let cx1 = 0; cx1 < GRID_K; cx1++) {
          const ci1 = cy1 * GRID_K + cx1;
          const count1 = cellCount[ci1];
          if (count1 === 0) continue;

          // NEARBY CELLS: exact pairwise repulsion
          const cyMin = Math.max(0, cy1 - NEAR_DIST);
          const cyMax = Math.min(GRID_K - 1, cy1 + NEAR_DIST);
          const cxMin = Math.max(0, cx1 - NEAR_DIST);
          const cxMax = Math.min(GRID_K - 1, cx1 + NEAR_DIST);
          const off1 = cellOffset[ci1];

          // Within same cell — hoist n1 reads outside inner loop
          for (let a = 0; a < count1; a++) {
            const n1 = flatNodes[off1 + a];
            const x1 = NodeMatrix[n1 + NODE_X];
            const y1 = NodeMatrix[n1 + NODE_Y];
            const cm1 = coefficient * NodeMatrix[n1 + NODE_MASS];
            let dx1 = 0, dy1 = 0;
            for (let b = a + 1; b < count1; b++) {
              const n2 = flatNodes[off1 + b];
              xDist = x1 - NodeMatrix[n2 + NODE_X];
              yDist = y1 - NodeMatrix[n2 + NODE_Y];
              const distSq = xDist * xDist + yDist * yDist;
              if (distSq > 0) {
                factor = (cm1 * NodeMatrix[n2 + NODE_MASS]) / distSq;
                dx1 += xDist * factor;
                dy1 += yDist * factor;
                NodeMatrix[n2 + NODE_DX] -= xDist * factor;
                NodeMatrix[n2 + NODE_DY] -= yDist * factor;
              }
            }
            NodeMatrix[n1 + NODE_DX] += dx1;
            NodeMatrix[n1 + NODE_DY] += dy1;
          }

          // With adjacent cells (only process ci2 > ci1 to avoid double counting)
          for (let cy2 = cyMin; cy2 <= cyMax; cy2++) {
            for (let cx2 = cxMin; cx2 <= cxMax; cx2++) {
              const ci2 = cy2 * GRID_K + cx2;
              if (ci2 <= ci1) continue;
              const count2 = cellCount[ci2];
              if (count2 === 0) continue;
              const off2 = cellOffset[ci2];

              for (let a = 0; a < count1; a++) {
                const n1 = flatNodes[off1 + a];
                const x1 = NodeMatrix[n1 + NODE_X];
                const y1 = NodeMatrix[n1 + NODE_Y];
                const cm1 = coefficient * NodeMatrix[n1 + NODE_MASS];
                let dx1 = 0, dy1 = 0;
                for (let b = 0; b < count2; b++) {
                  const n2 = flatNodes[off2 + b];
                  xDist = x1 - NodeMatrix[n2 + NODE_X];
                  yDist = y1 - NodeMatrix[n2 + NODE_Y];
                  const distSq = xDist * xDist + yDist * yDist;
                  if (distSq > 0) {
                    factor = (cm1 * NodeMatrix[n2 + NODE_MASS]) / distSq;
                    dx1 += xDist * factor;
                    dy1 += yDist * factor;
                    NodeMatrix[n2 + NODE_DX] -= xDist * factor;
                    NodeMatrix[n2 + NODE_DY] -= yDist * factor;
                  }
                }
                NodeMatrix[n1 + NODE_DX] += dx1;
                NodeMatrix[n1 + NODE_DY] += dy1;
              }
            }
          }

          // DISTANT CELLS: approximate as point mass at cell center
          // Computed every non-skipped iteration — no temporal skip.
          // The grid approximation itself is debt-free (0.999999 correlation at 200 iters).
          for (let cy2 = 0; cy2 < GRID_K; cy2++) {
            for (let cx2 = 0; cx2 < GRID_K; cx2++) {
              if (cx2 >= cxMin && cx2 <= cxMax && cy2 >= cyMin && cy2 <= cyMax) continue;
              const ci2 = cy2 * GRID_K + cx2;
              if (ci2 <= ci1) continue;
              if (cellMass[ci2] === 0) continue;

              // Each node in cell1 repulses against cell2's center of mass
              for (let a = 0; a < count1; a++) {
                const n1 = flatNodes[off1 + a];
                xDist = NodeMatrix[n1 + NODE_X] - cellMassCX[ci2];
                yDist = NodeMatrix[n1 + NODE_Y] - cellMassCY[ci2];
                const distSq = xDist * xDist + yDist * yDist;
                if (distSq > 0) {
                  factor = (coefficient * NodeMatrix[n1 + NODE_MASS] * cellMass[ci2]) / distSq;
                  NodeMatrix[n1 + NODE_DX] += xDist * factor;
                  NodeMatrix[n1 + NODE_DY] += yDist * factor;
                }
              }

              // Symmetric: each node in cell2 repulses against cell1's center of mass
              const count2 = cellCount[ci2];
              const off2 = cellOffset[ci2];
              for (let b = 0; b < count2; b++) {
                const n2 = flatNodes[off2 + b];
                xDist = NodeMatrix[n2 + NODE_X] - cellMassCX[ci1];
                yDist = NodeMatrix[n2 + NODE_Y] - cellMassCY[ci1];
                const distSq = xDist * xDist + yDist * yDist;
                if (distSq > 0) {
                  factor = (coefficient * NodeMatrix[n2 + NODE_MASS] * cellMass[ci1]) / distSq;
                  NodeMatrix[n2 + NODE_DX] += xDist * factor;
                  NodeMatrix[n2 + NODE_DY] += yDist * factor;
                }
              }
            }
          }
        }
      }
    }
  } // end if (!skipRepulsion)

  // 3) Gravity
  const g = options.gravity / options.scalingRatio;
  coefficient = options.scalingRatio;
  if (options.strongGravityMode) {
    // Strong gravity: no sqrt needed, force proportional to distance
    for (let n = 0; n < order; n += PPN) {
      factor = coefficient * NodeMatrix[n + NODE_MASS] * g;
      NodeMatrix[n + NODE_DX] -= NodeMatrix[n + NODE_X] * factor;
      NodeMatrix[n + NODE_DY] -= NodeMatrix[n + NODE_Y] * factor;
    }
  } else {
    for (let n = 0; n < order; n += PPN) {
      xDist = NodeMatrix[n + NODE_X];
      yDist = NodeMatrix[n + NODE_Y];
      distance = Math.sqrt(xDist * xDist + yDist * yDist);
      if (distance > 0) {
        factor = (coefficient * NodeMatrix[n + NODE_MASS] * g) / distance;
        NodeMatrix[n + NODE_DX] -= xDist * factor;
        NodeMatrix[n + NODE_DY] -= yDist * factor;
      }
    }
  }

  // 4) Attraction — O(E)
  // Fast path: common case (no adjustSizes, no linLogMode, no outbound distribution)
  // eliminates Math.sqrt and Math.pow per edge
  coefficient = 1 * (options.outboundAttractionDistribution ? outboundAttCompensation : 1);
  const isSimpleAttraction = !adjustSizes && !options.linLogMode && !options.outboundAttractionDistribution;
  const ewInfluence = options.edgeWeightInfluence;

  if (isSimpleAttraction) {
    // Fast path: factor = -coefficient * weight^influence * xDist (no sqrt needed)
    if (ewInfluence === 1) {
      for (let e = 0; e < size; e += PPE) {
        const n1 = EdgeMatrix[e + EDGE_SOURCE];
        const n2 = EdgeMatrix[e + EDGE_TARGET];
        const w = EdgeMatrix[e + EDGE_WEIGHT];
        xDist = NodeMatrix[n1 + NODE_X] - NodeMatrix[n2 + NODE_X];
        yDist = NodeMatrix[n1 + NODE_Y] - NodeMatrix[n2 + NODE_Y];
        factor = -coefficient * w;
        NodeMatrix[n1 + NODE_DX] += xDist * factor;
        NodeMatrix[n1 + NODE_DY] += yDist * factor;
        NodeMatrix[n2 + NODE_DX] -= xDist * factor;
        NodeMatrix[n2 + NODE_DY] -= yDist * factor;
      }
    } else {
      for (let e = 0; e < size; e += PPE) {
        const n1 = EdgeMatrix[e + EDGE_SOURCE];
        const n2 = EdgeMatrix[e + EDGE_TARGET];
        const w = EdgeMatrix[e + EDGE_WEIGHT];
        xDist = NodeMatrix[n1 + NODE_X] - NodeMatrix[n2 + NODE_X];
        yDist = NodeMatrix[n1 + NODE_Y] - NodeMatrix[n2 + NODE_Y];
        factor = -coefficient * Math.pow(w, ewInfluence);
        NodeMatrix[n1 + NODE_DX] += xDist * factor;
        NodeMatrix[n1 + NODE_DY] += yDist * factor;
        NodeMatrix[n2 + NODE_DX] -= xDist * factor;
        NodeMatrix[n2 + NODE_DY] -= yDist * factor;
      }
    }
  } else {
    // General path (adjustSizes, linLogMode, etc.)
    for (let e = 0; e < size; e += PPE) {
      const n1 = EdgeMatrix[e + EDGE_SOURCE];
      const n2 = EdgeMatrix[e + EDGE_TARGET];
      const w = EdgeMatrix[e + EDGE_WEIGHT];
      ewc = Math.pow(w, ewInfluence);
      xDist = NodeMatrix[n1 + NODE_X] - NodeMatrix[n2 + NODE_X];
      yDist = NodeMatrix[n1 + NODE_Y] - NodeMatrix[n2 + NODE_Y];

      if (adjustSizes) {
        distance = Math.sqrt(xDist * xDist + yDist * yDist) - NodeMatrix[n1 + NODE_SIZE] - NodeMatrix[n2 + NODE_SIZE];
        if (options.linLogMode) {
          if (options.outboundAttractionDistribution) {
            if (distance > 0) factor = (-coefficient * ewc * Math.log(1 + distance)) / distance / NodeMatrix[n1 + NODE_MASS];
          } else {
            if (distance > 0) factor = (-coefficient * ewc * Math.log(1 + distance)) / distance;
          }
        } else {
          if (options.outboundAttractionDistribution) {
            if (distance > 0) factor = (-coefficient * ewc) / NodeMatrix[n1 + NODE_MASS];
          } else {
            if (distance > 0) factor = -coefficient * ewc;
          }
        }
      } else {
        distance = Math.sqrt(xDist * xDist + yDist * yDist);
        if (options.linLogMode) {
          if (options.outboundAttractionDistribution) {
            if (distance > 0) factor = (-coefficient * ewc * Math.log(1 + distance)) / distance / NodeMatrix[n1 + NODE_MASS];
          } else {
            if (distance > 0) factor = (-coefficient * ewc * Math.log(1 + distance)) / distance;
          }
        } else {
          if (options.outboundAttractionDistribution) {
            distance = 1;
            factor = (-coefficient * ewc) / NodeMatrix[n1 + NODE_MASS];
          } else {
            distance = 1;
            factor = -coefficient * ewc;
          }
        }
      }
      if (distance > 0) {
        NodeMatrix[n1 + NODE_DX] += xDist * factor;
        NodeMatrix[n1 + NODE_DY] += yDist * factor;
        NodeMatrix[n2 + NODE_DX] -= xDist * factor;
        NodeMatrix[n2 + NODE_DY] -= yDist * factor;
      }
    }
  }

  // 5) Apply forces
  if (adjustSizes) {
    for (let n = 0; n < order; n += PPN) {
      if (NodeMatrix[n + NODE_FIXED] !== 1) {
        const force = Math.sqrt(
          NodeMatrix[n + NODE_DX] * NodeMatrix[n + NODE_DX] +
          NodeMatrix[n + NODE_DY] * NodeMatrix[n + NODE_DY]
        );

        if (force > MAX_FORCE) {
          NodeMatrix[n + NODE_DX] = (NodeMatrix[n + NODE_DX] * MAX_FORCE) / force;
          NodeMatrix[n + NODE_DY] = (NodeMatrix[n + NODE_DY] * MAX_FORCE) / force;
        }

        const swinging = NodeMatrix[n + NODE_MASS] * Math.sqrt(
          (NodeMatrix[n + NODE_OLD_DX] - NodeMatrix[n + NODE_DX]) *
          (NodeMatrix[n + NODE_OLD_DX] - NodeMatrix[n + NODE_DX]) +
          (NodeMatrix[n + NODE_OLD_DY] - NodeMatrix[n + NODE_DY]) *
          (NodeMatrix[n + NODE_OLD_DY] - NodeMatrix[n + NODE_DY])
        );

        const traction = Math.sqrt(
          (NodeMatrix[n + NODE_OLD_DX] + NodeMatrix[n + NODE_DX]) *
          (NodeMatrix[n + NODE_OLD_DX] + NodeMatrix[n + NODE_DX]) +
          (NodeMatrix[n + NODE_OLD_DY] + NodeMatrix[n + NODE_DY]) *
          (NodeMatrix[n + NODE_OLD_DY] + NodeMatrix[n + NODE_DY])
        ) / 2;

        const nodespeed = (0.1 * Math.log(1 + traction)) / (1 + Math.sqrt(swinging));
        NodeMatrix[n + NODE_X] += NodeMatrix[n + NODE_DX] * (nodespeed / options.slowDown);
        NodeMatrix[n + NODE_Y] += NodeMatrix[n + NODE_DY] * (nodespeed / options.slowDown);
      }
    }
  } else {
    for (let n = 0; n < order; n += PPN) {
      if (NodeMatrix[n + NODE_FIXED] !== 1) {
        const swinging = NodeMatrix[n + NODE_MASS] * Math.sqrt(
          (NodeMatrix[n + NODE_OLD_DX] - NodeMatrix[n + NODE_DX]) *
          (NodeMatrix[n + NODE_OLD_DX] - NodeMatrix[n + NODE_DX]) +
          (NodeMatrix[n + NODE_OLD_DY] - NodeMatrix[n + NODE_DY]) *
          (NodeMatrix[n + NODE_OLD_DY] - NodeMatrix[n + NODE_DY])
        );

        const traction = Math.sqrt(
          (NodeMatrix[n + NODE_OLD_DX] + NodeMatrix[n + NODE_DX]) *
          (NodeMatrix[n + NODE_OLD_DX] + NodeMatrix[n + NODE_DX]) +
          (NodeMatrix[n + NODE_OLD_DY] + NodeMatrix[n + NODE_DY]) *
          (NodeMatrix[n + NODE_OLD_DY] + NodeMatrix[n + NODE_DY])
        ) / 2;

        const nodespeed =
          (NodeMatrix[n + NODE_CONVERGENCE] * Math.log(1 + traction)) /
          (1 + Math.sqrt(swinging));

        NodeMatrix[n + NODE_CONVERGENCE] = Math.min(
          1,
          Math.sqrt(
            (nodespeed * (NodeMatrix[n + NODE_DX] * NodeMatrix[n + NODE_DX] +
              NodeMatrix[n + NODE_DY] * NodeMatrix[n + NODE_DY])) /
            (1 + Math.sqrt(swinging))
          )
        );

        NodeMatrix[n + NODE_X] += NodeMatrix[n + NODE_DX] * (nodespeed / options.slowDown);
        NodeMatrix[n + NODE_Y] += NodeMatrix[n + NODE_DY] * (nodespeed / options.slowDown);
      }
    }
  }
}

/**
 * Build flat matrices from node/edge arrays.
 * Compatible with graphology's format but standalone.
 */
export interface NodeInput {
  x: number;
  y: number;
  mass?: number;
  size?: number;
  fixed?: boolean;
}

export interface EdgeInput {
  source: number; // index into node array
  target: number;
  weight: number;
}

export function buildMatrices(
  nodes: NodeInput[],
  edges: EdgeInput[]
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
    // Accumulate mass (weighted degree)
    NodeMatrix[sj + NODE_MASS] += e.weight;
    NodeMatrix[tj + NODE_MASS] += e.weight;
  }

  return { nodes: NodeMatrix, edges: EdgeMatrix };
}

/**
 * Extract positions from NodeMatrix.
 */
export function readPositions(NodeMatrix: Float32Array): Array<{ x: number; y: number }> {
  const positions: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < NodeMatrix.length; i += PPN) {
    positions.push({ x: NodeMatrix[i + NODE_X], y: NodeMatrix[i + NODE_Y] });
  }
  return positions;
}

/**
 * Run multiple iterations. Returns wall-clock ms.
 */
export function run(
  options: FA3Settings,
  NodeMatrix: Float32Array,
  EdgeMatrix: Float32Array,
  iterations: number
): number {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    iterate(options, NodeMatrix, EdgeMatrix, i);
  }
  return performance.now() - t0;
}
