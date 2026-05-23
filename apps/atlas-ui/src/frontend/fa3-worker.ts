import {
  DEFAULT_SETTINGS,
  buildMatrices,
  inferSettings,
  iterate,
  type EdgeInput,
  type NodeInput,
} from "../core/forceatlas3";

type InitMessage = {
  type: "init";
  nodes: NodeInput[];
  edges: EdgeInput[];
};

type SyncMessage = {
  type: "sync";
  updates: Array<{ index: number; x?: number; y?: number; fixed?: boolean }>;
};

type ReheatMessage = {
  type: "reheat";
};

type IncomingMessage = InitMessage | SyncMessage | ReheatMessage;

const NODE_X = 0;
const NODE_Y = 1;
const NODE_DX = 2;
const NODE_DY = 3;
const NODE_OLD_DX = 4;
const NODE_OLD_DY = 5;
const NODE_FIXED = 9;
const PPN = 10;
const ITERATIONS_PER_TICK = 4;
const STABLE_TICKS_REQUIRED = 6;
// Energy ratio threshold (swing/traction). Tighter is harder to reach.
// Tuned for small interactive subgraphs (~5-200 nodes).
const ENERGY_THRESHOLD = 0.05;
// Hard cap on iterations to prevent infinite loops on pathological graphs.
const MAX_ITERATIONS = 800;

let nodeMatrix: Float32Array | null = null;
let edgeMatrix: Float32Array | null = null;
let iteration = 0;
let stableTicks = 0;
let running = false;
let tickScheduled = false;

const settings = {
  ...DEFAULT_SETTINGS,
  ...inferSettings(1),
};

function computeEnergy(matrix: Float32Array): number {
  let swing = 0;
  let traction = 0;
  let count = 0;
  for (let i = 0; i < matrix.length; i += PPN) {
    const dx = matrix[i + NODE_DX];
    const dy = matrix[i + NODE_DY];
    const oldDx = matrix[i + NODE_OLD_DX];
    const oldDy = matrix[i + NODE_OLD_DY];
    swing += Math.hypot(oldDx - dx, oldDy - dy);
    traction += Math.hypot(oldDx + dx, oldDy + dy) / 2;
    count++;
  }
  if (!count) return 0;
  return swing / Math.max(traction, 1e-6);
}

function emitPositions(energy: number, settled: boolean, capped = false): void {
  if (!nodeMatrix) return;
  const positions = new Float32Array((nodeMatrix.length / PPN) * 2);
  for (let i = 0, p = 0; i < nodeMatrix.length; i += PPN, p += 2) {
    positions[p] = nodeMatrix[i + NODE_X];
    positions[p + 1] = nodeMatrix[i + NODE_Y];
  }
  postMessage(
    {
      type: "positions",
      positions,
      settled,
      energy,
      capped,
    },
    { transfer: [positions.buffer] },
  );
}

function scheduleTick(): void {
  // Guard against overlapping ticks — sync/reheat during an active loop
  // would otherwise stack setTimeout callbacks and run layout multiple times per frame.
  if (!running || tickScheduled) return;
  tickScheduled = true;
  setTimeout(runTick, 0);
}

function runTick(): void {
  tickScheduled = false;
  if (!running || !nodeMatrix || !edgeMatrix) return;

  for (let tick = 0; tick < ITERATIONS_PER_TICK; tick++) {
    iterate(settings, nodeMatrix, edgeMatrix, iteration++);
  }

  const energy = computeEnergy(nodeMatrix);
  if (energy < ENERGY_THRESHOLD) stableTicks++;
  else stableTicks = 0;

  // Settle on threshold OR hard iteration cap
  const converged = stableTicks >= STABLE_TICKS_REQUIRED;
  const capped = iteration >= MAX_ITERATIONS;
  const settled = converged || capped;
  emitPositions(energy, settled, capped);

  if (settled) {
    running = false;
    return;
  }

  scheduleTick();
}

function reheat(): void {
  if (!nodeMatrix) return;
  stableTicks = 0;
  running = true;
  scheduleTick();
}

self.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const message = event.data;

  if (message.type === "init") {
    const matrices = buildMatrices(message.nodes, message.edges);
    nodeMatrix = matrices.nodes;
    edgeMatrix = matrices.edges;
    iteration = 0;
    stableTicks = 0;
    Object.assign(settings, inferSettings(message.nodes.length));
    running = true;
    scheduleTick();
    return;
  }

  if (message.type === "sync") {
    if (!nodeMatrix) return;
    for (const update of message.updates) {
      const base = update.index * PPN;
      if (update.x !== undefined) nodeMatrix[base + NODE_X] = update.x;
      if (update.y !== undefined) nodeMatrix[base + NODE_Y] = update.y;
      if (update.fixed !== undefined) nodeMatrix[base + NODE_FIXED] = update.fixed ? 1 : 0;
    }
    reheat();
    return;
  }

  if (message.type === "reheat") {
    reheat();
  }
};
