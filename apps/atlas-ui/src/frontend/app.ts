import Graph from "graphology";
import { marked } from "marked";
import Sigma from "sigma";
import type { Attributes } from "graphology-types";
import {
  EdgeLineProgram,
  drawDiscNodeLabel,
  type NodeHoverDrawingFunction,
  type NodeLabelDrawingFunction,
} from "sigma/rendering";
import type { PowerSourceConfig } from "../power/adapter.ts";

type EdgeKind = "wikilink" | "tag" | "folder" | "temporal" | "tag_cooccurrence" | "related" | string;
type InspectorTab = "note" | "neighbors" | "bridges" | "hubs";

interface ApiNode {
  id: string;
  title: string;
  type?: string;
  nodeType?: string;
  folder: string;
  tags: string[];
  wordCount: number;
  created: number;
  modified: number;
  x: number;
  y: number;
  frontmatter?: Record<string, unknown>;
  clusterId?: number | null;
  componentId?: number | null;
  pagerank?: number | null;
  clusteringCoeff?: number | null;
}

interface ApiEdge {
  source: string;
  target: string;
  type: EdgeKind;
  weight: number;
}

interface MetaData {
  nodeCount: number;
  edgeCount: number;
  edgeTypes: string[];
  topTags: Array<{ tag: string; count: number }>;
  topFolders: Array<{ folder: string; count: number }>;
  lastReload: number;
  enrichmentVersion?: number;
  lastEnrichmentAt?: number;
  enrichmentCommunityCount?: number;
}

interface HealthMetrics {
  orphanCount: number;
  weakComponentCount: number;
  staleCount: number;
  staleDays: number;
  gini: number;
}

interface PowerNodePageItem {
  id: string;
  title: string;
  folder: string;
  nodeType?: string;
  frontmatter?: Record<string, unknown>;
  tags?: string[];
  wordCount?: number | null;
  created?: number | null;
  modified?: number | null;
  clusterId?: number | null;
  componentId?: number | null;
  pagerank?: number | null;
  clusteringCoeff?: number | null;
  x?: number | null;
  y?: number | null;
}

interface PowerEdgePageItem {
  id: string;
  sourceId: string;
  targetId: string;
  edgeType: string;
  weight: number;
}

interface PageResponse<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

interface SearchResponse {
  results: string[];
  totalCount: number;
}

interface LayoutNodeInput {
  x: number;
  y: number;
  size: number;
  fixed?: boolean;
}

interface LayoutEdgeInput {
  source: number;
  target: number;
  weight: number;
}

interface WorkerInitMessage {
  type: "init";
  nodes: LayoutNodeInput[];
  edges: LayoutEdgeInput[];
}

interface WorkerSyncMessage {
  type: "sync";
  updates: Array<{ index: number; x?: number; y?: number; fixed?: boolean }>;
}

interface WorkerResultMessage {
  type: "positions";
  positions: Float32Array;
  settled: boolean;
  energy: number;
  capped?: boolean;
}

interface WorkerReheatMessage {
  type: "reheat";
}

type WorkerMessage = WorkerInitMessage | WorkerSyncMessage | WorkerReheatMessage;

interface NodeAttrs extends Attributes {
  label: string;
  color: string;
  x: number;
  y: number;
  size: number;
  title: string;
  shortLabel: string;
  nodeType: string;
  folder: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  wordCount: number;
  created: number;
  modified: number;
  clusterId: number | null;
  componentId: number | null;
  pagerank: number | null;
  clusteringCoeff: number | null;
  nodeIndex?: number;
  degree: number;
  fixed: boolean;
  pinned: boolean;
}

interface EdgeAttrs extends Attributes {
  color: string;
  size: number;
  edgeType: string;
  label: string;
  weight: number;
}

interface NeighborRow {
  id: string;
  title: string;
  direction: "incoming" | "outgoing" | "undirected";
  edgeType: string;
  weight: number;
  pagerank: number | null;
  pagerankRank: number | null;
}

interface NodeNeighbors {
  nodeId: string;
  groups: Array<{ edgeType: string; rows: NeighborRow[] }>;
}

const TYPE_COLORS: Record<string, string> = {
  wiki: "#6fb8ae",
  concept: "#8f7fc0",
  person: "#d4a862",
  project: "#c97f49",
  idea: "#72b8ad",
  question: "#d4a862",
  heuristic: "#caa46f",
  value: "#819969",
  mental_model: "#8f7fc0",
  assumption: "#d78585",
  tension: "#5da0ad",
  preference: "#c97f49",
  transcript: "#6b5e4e",
  channel: "#5da0ad",
  research: "#72b8ad",
  knowledge: "#819969",
  archive: "#8a7a65",
  memory: "#caa46f",
  note: "#b3a186",
  "transcript-stub": "#6b5e4e",
  "mcts-convergence": "#8f7fc0",
  "channel-log": "#5da0ad",
  conversation: "#72b8ad",
  "feed-entry": "#819969",
};

const EDGE_LABELS: Record<string, string> = {
  wikilink: "Links",
  related: "Related",
  tag: "Shared tags",
  folder: "Same folder",
  temporal: "Time neighbors",
  tag_cooccurrence: "Tag overlap",
  spoke_in: "Speaker",
  discusses: "Discusses",
  claims: "Claims",
  predicts: "Predicts",
  part_of: "Part of",
  has_part: "Has part",
  references: "References",
  derived_from: "Derived from",
  version_of: "Version of",
  replaces: "Replaces",
  replaced_by: "Replaced by",
  requires: "Requires",
  required_by: "Required by",
  instance_of: "Instance of",
  broader: "Broader",
  narrower: "Narrower",
  supports: "Supports",
  contradicts: "Contradicts",
  evolved_into: "Evolved into",
  inspired_by: "Inspired by",
  depends_on: "Depends on",
  overrides: "Overrides",
  learned_from: "Learned from",
  scoped_by: "Scoped by",
  rejected: "Rejected",
  belongs_to: "Belongs to",
};

const EDGE_COLORS: Record<string, string> = {
  wikilink: "#d2a25e",
  tag: "#8f7fc0",
  folder: "#6b5e4e",
  temporal: "#6b5e4e",
  tag_cooccurrence: "#a893d4",
  related: "#72b8ad",
  discusses: "#c97f49",
  spoke_in: "#d4a862",
  claims: "#819969",
  predicts: "#5da0ad",
  part_of: "#b78f5c",
  has_part: "#caa46f",
  references: "#72b8ad",
  derived_from: "#c97f49",
  version_of: "#caa46f",
  replaces: "#b87643",
  replaced_by: "#99603b",
  requires: "#8f7fc0",
  required_by: "#a893d4",
  instance_of: "#72b8ad",
  broader: "#819969",
  narrower: "#9bb37e",
  supports: "#a5b57f",
  contradicts: "#d78585",
  evolved_into: "#b39ad3",
  inspired_by: "#72b8ad",
  depends_on: "#c97f49",
  overrides: "#8a7a65",
  learned_from: "#5da0ad",
  scoped_by: "#917d66",
  rejected: "#d78585",
  belongs_to: "#819969",
};

function communityColor(clusterId: number | null): string {
  if (clusterId == null) return DEFAULT_NODE_COLOR;
  const hue = Math.round((clusterId * 137.508) % 360);
  const saturation = 70 + (clusterId % 3) * 6;
  const lightness = 50 + (clusterId % 4) * 5;
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function mapPageRankToSize(pr: number | null, maxPr: number): number {
  if (pr == null || maxPr <= 0) return 4;
  // Log-scale mapping: emphasize differences at the low end
  const normalized = Math.log1p(pr * 1000) / Math.log1p(maxPr * 1000);
  return 2 + normalized * 14;
}

const DEFAULT_NODE_COLOR = "#b3a186";
const DEFAULT_EDGE_COLOR = "rgba(226, 204, 170, 0.18)";
const BACKGROUND = "#171310";
const SELECTION_RING = "#6fb8ae";
const DEFAULT_EDGE_TYPES = ["wikilink", "tag", "related", "discusses", "spoke_in", "references", "claims", "predicts"];
const MAX_LABEL_CHARS = 25;

// fullGraph: complete vault graph for neighbor lookups and data.
// state.graph: only the visible subgraph, bound to Sigma. This is the key perf trick —
// Sigma iterates ALL nodes/edges through reducers on every frame. At 112K edges, that freezes the tab.
const fullGraph = new Graph<NodeAttrs, EdgeAttrs>();

const state = {
  graph: new Graph<NodeAttrs, EdgeAttrs>(),
  renderer: null as Sigma<NodeAttrs, EdgeAttrs> | null,
  meta: null as MetaData | null,
  seedNode: null as string | null,
  seedNodes: new Set<string>(),
  visibleNodes: new Set<string>(),
  manuallyExpanded: new Set<string>(),
  activeEdgeTypes: new Set<string>(DEFAULT_EDGE_TYPES),
  disabledNodeTypes: new Set<string>(),
  hoveredNode: null as string | null,
  hoveredNeighbors: new Set<string>(),
  hoveredEdge: null as string | null,
  selectedNode: null as string | null,
  activeInspectorTab: "note" as InspectorTab,
  focusedInspectorNode: null as string | null,
  // null = not yet loaded (show loading state)
  // "" = loaded successfully, note body is empty (show empty-note state)
  // "..." = loaded, renders as markdown
  currentNoteMarkdown: null as string | null,
  currentNodeNeighbors: null as NodeNeighbors | null,
  draggingNode: null as string | null,
  depth: 1,
  searchResults: [] as string[],
  searchTotalCount: 0,
  searchIndex: -1,
  layoutWorker: null as Worker | null,
  layoutNodeOrder: [] as string[],
  layoutNodeIndex: new Map<string, number>(),
  layoutState: "idle" as "idle" | "running" | "settled",
  lastLayoutEnergy: 0,
  searchDebounce: 0 as number | ReturnType<typeof setTimeout>,
  colorMode: "type" as "type" | "community",
  sizeMode: "pagerank" as "degree" | "pagerank",
  enrichment: null as { version: number; communityCount: number; lastRunAt: number } | null,
  maxPageRank: 0,
  pagerankRanks: new Map<string, number>(),
  searchMode: "seed" as "seed" | "filter",
  filterQuery: "" as string,
  filterMatches: new Set<string>() as Set<string>,
  filterOverlayOpen: false,
  layoutAlgorithm: "fa3" as "fa3" | "circular" | "random" | "fruchterman" | "grid" | "concentric" | "noverlap",
  activeView: "graph" as "graph" | "datalab",
  datalabSort: { col: "label", dir: "asc" } as { col: string; dir: "asc" | "desc" },
  datalabFilter: "" as string,
  datalabScrollToNode: null as string | null,
  extendedEnrichment: null as ExtendedEnrichmentData | null,
  extendedEnrichmentLoading: false,
  extendedEnrichmentError: false,
  health: null as HealthMetrics | null,
  explorationTrail: [] as Array<{ nodeId: string; label: string; timestamp: number; depth: number }>,
  highlightedNodes: new Set<string>(),
  pinnedNodes: new Set<string>(),
  pivotTag: null as string | null,
  lastExpandedNode: null as string | null,
};

const elements = {
  app: document.getElementById("app") as HTMLDivElement,
  container: document.getElementById("sigma-container") as HTMLDivElement,
  emptyState: document.getElementById("empty-state") as HTMLDivElement,
  emptySearchButton: document.getElementById("empty-search-button") as HTMLButtonElement,
  topBar: document.getElementById("top-bar") as HTMLDivElement,
  leftSidebar: document.getElementById("left-sidebar") as HTMLElement,
  sidebarToggle: document.getElementById("sidebar-toggle") as HTMLButtonElement,
  seedFocusTitle: document.getElementById("seed-focus-title") as HTMLHeadingElement,
  seedDescription: document.getElementById("seed-description") as HTMLParagraphElement,
  seedSignalBadge: document.getElementById("seed-signal-badge") as HTMLDivElement,
  seedSignalText: document.getElementById("seed-signal-text") as HTMLSpanElement,
  seedMetrics: document.getElementById("seed-metrics") as HTMLDivElement,
  metricPagerank: document.getElementById("metric-pagerank") as HTMLSpanElement,
  metricPagerankDetail: document.getElementById("metric-pagerank-detail") as HTMLSpanElement,
  metricDegree: document.getElementById("metric-degree") as HTMLSpanElement,
  metricDegreeDetail: document.getElementById("metric-degree-detail") as HTMLSpanElement,
  metricCommunity: document.getElementById("metric-community") as HTMLSpanElement,
  metricCommunityDetail: document.getElementById("metric-community-detail") as HTMLSpanElement,
  metricBridge: document.getElementById("metric-bridge") as HTMLSpanElement,
  metricBridgeDetail: document.getElementById("metric-bridge-detail") as HTMLSpanElement,
  seedStory: document.getElementById("seed-story") as HTMLDivElement,
  storyWhy: document.getElementById("story-why") as HTMLSpanElement,
  storyNext: document.getElementById("story-next") as HTMLSpanElement,
  communitySection: document.getElementById("community-section") as HTMLElement,
  communityCountBadge: document.getElementById("community-count-badge") as HTMLSpanElement,
  communityListEl: document.getElementById("community-list") as HTMLDivElement,
  trailSection: document.getElementById("trail-section") as HTMLElement,
  trailCountBadge: document.getElementById("trail-count-badge") as HTMLSpanElement,
  trailList: document.getElementById("trail-list") as HTMLDivElement,
  readoutSection: document.getElementById("readout-section") as HTMLElement,
  readoutDensity: document.getElementById("readout-density") as HTMLElement,
  readoutAvgPath: document.getElementById("readout-avg-path") as HTMLElement,
  readoutComponents: document.getElementById("readout-components") as HTMLElement,
  readoutPeripheral: document.getElementById("readout-peripheral") as HTMLElement,
  readoutHighlights: document.getElementById("readout-highlights") as HTMLUListElement,
  clearSeed: document.getElementById("clear-seed") as HTMLButtonElement,
  bottomDock: document.getElementById("bottom-dock") as HTMLElement,
  dockLegendGrid: document.getElementById("dock-legend-grid") as HTMLDivElement,
  dockBlurb: document.getElementById("dock-blurb") as HTMLSpanElement,
  dockKpis: document.getElementById("dock-kpis") as HTMLDivElement,
  dockToggle: document.getElementById("dock-toggle") as HTMLButtonElement,
  dockPanel: document.getElementById("dock-panel") as HTMLDivElement,
  depthSlider: document.getElementById("depth-slider") as HTMLInputElement,
  depthValue: document.getElementById("depth-value") as HTMLSpanElement,
  searchModal: document.getElementById("search-modal") as HTMLDivElement,
  searchInput: document.getElementById("search-input") as HTMLInputElement,
  searchResults: document.getElementById("search-results") as HTMLDivElement,
  searchClose: document.getElementById("search-close") as HTMLButtonElement,
  detailPanel: document.getElementById("detail-panel") as HTMLDivElement,
  detailType: document.getElementById("detail-type") as HTMLDivElement,
  detailTitle: document.getElementById("detail-title") as HTMLHeadingElement,
  detailMeta: document.getElementById("detail-meta") as HTMLDivElement,
  detailBody: document.getElementById("detail-body") as HTMLDivElement,
  inspectorTabs: [...document.querySelectorAll<HTMLButtonElement>("[data-inspector-tab]")],
  detailLink: document.getElementById("detail-link") as HTMLAnchorElement,
  detailPin: document.getElementById("detail-pin") as HTMLButtonElement,
  detailClose: document.getElementById("detail-close") as HTMLButtonElement,
  statusSummary: document.getElementById("status-summary") as HTMLSpanElement,
  statusLayout: document.getElementById("status-layout") as HTMLSpanElement,
  statusEnrichment: document.getElementById("status-enrichment") as HTMLSpanElement,
  colorModeBtn: document.getElementById("color-mode-btn") as HTMLButtonElement,
  sizeModeBtn: document.getElementById("size-mode-btn") as HTMLButtonElement,
  metaNotes: document.getElementById("meta-notes") as HTMLSpanElement,
  metaEdges: document.getElementById("meta-edges") as HTMLSpanElement,
  metaCommunities: document.getElementById("meta-communities") as HTMLSpanElement,
  healthOrphans: document.getElementById("health-orphans") as HTMLSpanElement | null,
  healthWeakComponents: document.getElementById("health-weak-components") as HTMLSpanElement | null,
  healthStale: document.getElementById("health-stale") as HTMLSpanElement | null,
  healthGini: document.getElementById("health-gini") as HTMLSpanElement | null,
  searchTrigger: document.getElementById("search-trigger") as HTMLButtonElement,
  canvasControls: document.getElementById("canvas-controls") as HTMLDivElement,
  filterOverlay: document.getElementById("filter-overlay") as HTMLDivElement,
  filterInput: document.getElementById("filter-input") as HTMLInputElement,
  filterHint: document.getElementById("filter-hint") as HTMLSpanElement,
  layoutSelect: document.getElementById("layout-select") as HTMLSelectElement,
  layoutTooltip: document.getElementById("layout-tooltip") as HTMLParagraphElement,
  viewTabs: document.getElementById("view-tabs") as HTMLDivElement,
  tabGraph: document.getElementById("tab-graph") as HTMLButtonElement,
  tabDatalab: document.getElementById("tab-datalab") as HTMLButtonElement,
  dataLab: document.getElementById("data-lab") as HTMLDivElement,
  datalabFilter: document.getElementById("datalab-filter") as HTMLInputElement,
  datalabExport: document.getElementById("datalab-export") as HTMLButtonElement,
  datalabTbody: document.getElementById("datalab-tbody") as HTMLTableSectionElement,
  emptyStatNodes: document.getElementById("empty-stat-nodes") as HTMLSpanElement | null,
  emptyStatEdges: document.getElementById("empty-stat-edges") as HTMLSpanElement | null,
  emptyStatCommunities: document.getElementById("empty-stat-communities") as HTMLSpanElement | null,
  emptyFullGraphButton: document.getElementById("empty-full-graph-button") as HTMLButtonElement | null,
};

function typeColor(type: string): string {
  return TYPE_COLORS[type] ?? DEFAULT_NODE_COLOR;
}

function edgeColor(type: string): string {
  return EDGE_COLORS[type] ?? DEFAULT_EDGE_COLOR;
}

function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("rgba(")) {
    return color.replace(/rgba\(([^)]+),\s*[\d.]+\)$/, `rgba($1, ${alpha})`);
  }
  if (color.startsWith("rgb(")) {
    return color.replace("rgb(", "rgba(").replace(")", `, ${alpha})`);
  }
  if (color.startsWith("hsla(")) {
    return color.replace(/hsla\(([^)]+),\s*[\d.]+\)$/, `hsla($1, ${alpha})`);
  }
  if (color.startsWith("hsl(")) {
    return color.replace("hsl(", "hsla(").replace(")", ` / ${alpha})`);
  }
  const hex = color.replace("#", "");
  const normalized = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mapDegreeToSize(degree: number): number {
  const normalized = Math.sqrt(Math.max(0, degree)) / Math.sqrt(60);
  return clamp(3 + normalized * 9, 3, 12);
}

function inferNodeType(node: { nodeType?: string; type?: string; folder?: string; id?: string }): string {
  if (node.nodeType && node.nodeType !== "note") return node.nodeType;
  if (node.type && node.type !== "note") return node.type;

  const path = node.id ?? "";
  const folder = node.folder ?? "";

  if (path.startsWith("transcripts/") || folder.startsWith("transcripts/") || folder === "transcripts") {
    return "transcript";
  }
  if (path.startsWith("channels/")) return "channel";
  if (path.startsWith("Wiki/")) return "wiki";
  if (path.startsWith("People/")) return "person";
  if (path.startsWith("Concepts/")) return "concept";
  if (path.startsWith("Projects/")) return "project";
  if (path.startsWith("Research/")) return "research";
  if (path.startsWith("Knowledge/")) return "knowledge";
  if (path.startsWith("Archive/")) return "archive";
  if (path.startsWith("memory/")) return "memory";

  return "note";
}

function truncateLabel(label: string): string {
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;
}

function formatNodeLabel(title: string, nodeId = ""): string {
  const fallback = title || nodeId;
  const raw = fallback.split("/").pop() ?? fallback;
  const withoutExtension = raw.replace(/\.[^.]+$/, "");
  const withoutDatePrefix = withoutExtension.replace(/^\d{4}-\d{2}-\d{2}[-_]+/, "");
  const normalized = withoutDatePrefix.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized || withoutExtension || raw || "Untitled";
}

function formatDate(value: number): string {
  return value ? new Date(value).toLocaleDateString() : "Unknown";
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value);
}

function formatPercentile(rank: number, total: number): string {
  if (total <= 1) return "100th percentile";
  const percentile = 100 - ((rank - 1) / (total - 1)) * 100;
  const rounded = percentile >= 99 ? percentile.toFixed(1) : Math.round(percentile).toString();
  const numeric = Number.parseFloat(rounded);
  const suffix = numeric % 10 === 1 && numeric % 100 !== 11
    ? "st"
    : numeric % 10 === 2 && numeric % 100 !== 12
      ? "nd"
      : numeric % 10 === 3 && numeric % 100 !== 13
        ? "rd"
        : "th";
  return `${rounded}${suffix} percentile`;
}

function formatFrontmatterValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => formatFrontmatterValue(item)).join(", ");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildObsidianUrl(nodeId: string): string {
  const vault = "vault";
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(nodeId)}`;
}

function savePinnedNodes(): void {
  try {
    localStorage.setItem("atlas:pinned", JSON.stringify([...state.pinnedNodes]));
  } catch { /* localStorage may be blocked */ }
}

function loadPinnedNodes(): void {
  try {
    const raw = localStorage.getItem("atlas:pinned");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      state.pinnedNodes = new Set(parsed.filter((value): value is string => typeof value === "string"));
    }
  } catch { /* ignore */ }
}

function applyPinnedStateToGraphs(): void {
  fullGraph.forEachNode((nodeId) => {
    fullGraph.setNodeAttribute(nodeId, "pinned", state.pinnedNodes.has(nodeId));
  });
  state.graph.forEachNode((nodeId) => {
    state.graph.setNodeAttribute(nodeId, "pinned", state.pinnedNodes.has(nodeId));
  });
}

function computeGini(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;
  let weighted = 0;
  for (let index = 0; index < sorted.length; index++) {
    weighted += (index + 1) * sorted[index]!;
  }
  return ((2 * weighted) / (sorted.length * total)) - ((sorted.length + 1) / sorted.length);
}

function computeFullGraphHealth(): void {
  const componentSizes: number[] = [];
  const visited = new Set<string>();
  let orphanCount = 0;
  const now = Date.now();
  const staleDays = 180;
  let staleCount = 0;
  const degrees: number[] = [];

  fullGraph.forEachNode((nodeId, attrs) => {
    const degree = fullGraph.degree(nodeId);
    degrees.push(degree);
    if (degree === 0) orphanCount++;
    const ageMs = now - (attrs.modified || attrs.created || now);
    if (ageMs > staleDays * 24 * 60 * 60 * 1000) staleCount++;
  });

  fullGraph.forEachNode((nodeId) => {
    if (visited.has(nodeId)) return;
    let size = 0;
    const queue = [nodeId];
    while (queue.length) {
      const current = queue.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      size++;
      fullGraph.forEachNeighbor(current, (neighbor) => {
        if (!visited.has(neighbor)) queue.push(neighbor);
      });
    }
    componentSizes.push(size);
  });

  state.health = {
    orphanCount,
    weakComponentCount: componentSizes.filter((size) => size <= 3).length,
    staleCount,
    staleDays,
    gini: computeGini(degrees),
  };
}

function updateHealthPanel(): void {
  const health = state.health;
  if (!health) return;
  if (elements.healthOrphans) elements.healthOrphans.innerHTML = `${health.orphanCount.toLocaleString()}<span class="stat-badge">full graph</span>`;
  if (elements.healthWeakComponents) elements.healthWeakComponents.innerHTML = `${health.weakComponentCount.toLocaleString()}<span class="stat-badge">≤3 notes</span>`;
  if (elements.healthStale) elements.healthStale.innerHTML = `${health.staleCount.toLocaleString()}<span class="stat-badge">&gt;${health.staleDays}d</span>`;
  if (elements.healthGini) elements.healthGini.innerHTML = `${health.gini.toFixed(3)}<span class="stat-badge">degree</span>`;
}

function setMetricTooltips(): void {
  const titles: Array<[Element | null, string]> = [
    [elements.metaNotes, "Total notes in the vault. This frames the size of the space you are exploring."],
    [elements.metaEdges, "Total edges in the vault. Higher counts mean denser linking across notes."],
    [elements.metaCommunities, "Distinct visible communities. More communities usually means the current slice spans more conceptual neighborhoods."],
    [elements.healthOrphans, "Orphan notes have zero graph connections in the full vault. They are isolated and often need links."],
    [elements.healthWeakComponents, "Weak components here means tiny disconnected components of three notes or fewer. Many small islands suggest fragmented knowledge."],
    [elements.healthStale, "Stale notes have not been modified for over 180 days. Use this to spot neglected areas of the vault."],
    [elements.healthGini, "Hub concentration: Gini coefficient over full-graph node degrees (0 = even, 1 = hub-dominated). High values mean a few notes concentrate connections."],
    [elements.layoutSelect, "Choose how nodes are arranged. The graph reflows immediately when this changes."],
    [elements.depthSlider, "Neighborhood depth from the seed note. Higher hops reveal more context but add cognitive load."],
  ];
  for (const [element, title] of titles) {
    element?.setAttribute("title", title);
  }
}

function rebuildPagerankRanks(): void {
  state.pagerankRanks.clear();
  const ranked: Array<{ node: string; pagerank: number }> = [];
  fullGraph.forEachNode((node, attrs) => {
    if (attrs.pagerank == null) return;
    ranked.push({ node, pagerank: attrs.pagerank });
  });
  ranked.sort((a, b) => b.pagerank - a.pagerank);
  ranked.forEach((entry, index) => {
    state.pagerankRanks.set(entry.node, index + 1);
  });
}

function updateEmptyStateMetrics(): void {
  if (elements.emptyStatNodes) {
    elements.emptyStatNodes.textContent = formatCompactNumber(state.meta?.nodeCount ?? 10639);
  }
  if (elements.emptyStatEdges) {
    elements.emptyStatEdges.textContent = formatCompactNumber(state.meta?.edgeCount ?? 126458);
  }
  if (elements.emptyStatCommunities) {
    elements.emptyStatCommunities.textContent = formatCompactNumber(
      state.meta?.enrichmentCommunityCount ?? state.enrichment?.communityCount ?? 4046,
    );
  }
}

function updateDepthLabel(): void {
  elements.depthValue.textContent = `${state.depth} hop${state.depth === 1 ? "" : "s"}`;
}

function setChromeVisible(isVisible: boolean): void {
  elements.emptyState.classList.toggle("hidden", isVisible);
  elements.canvasControls.classList.toggle("hidden", !isVisible);
  if (!isVisible) setFilterOverlayOpen(false);
  // Show/hide tab bar and add/remove .has-tabs class when graph is seeded
  elements.viewTabs.classList.toggle("hidden", !isVisible);
  elements.app.classList.toggle("has-tabs", isVisible);
  elements.app.classList.toggle("pre-seed", !isVisible);
  updateDockVisibility();
}

function setLayoutStatus(layoutState: typeof state.layoutState, energy = state.lastLayoutEnergy): void {
  state.layoutState = layoutState;
  state.lastLayoutEnergy = energy;
  const text =
    layoutState === "running"
      ? `Layout running (${energy.toFixed(4)})`
      : layoutState === "settled"
        ? `Layout settled (${energy.toFixed(4)})`
        : "Layout idle";
  elements.statusLayout.textContent = text;
}

// Cached visible edge count — recomputed only when visibility or filters change, not on every frame
let cachedVisibleEdgeCount = 0;

/**
 * Rebuild state.graph (the Sigma-bound graph) to contain only visible nodes
 * and edges between them. This is the key perf trick: Sigma iterates ALL
 * nodes/edges in its bound graph through the reducers on every frame, so
 * keeping that graph small (~50 nodes typical) instead of 8.5K is critical.
 *
 * Positions and pin state are PRESERVED for nodes that were already visible.
 * New nodes (e.g. after expand or depth increase) get a circle seed so the
 * layout worker can place them without scattering the existing layout.
 */
function syncVisibleGraph(): void {
  // Snapshot existing positions and pin state before clearing
  const preserved = new Map<string, { x: number; y: number; fixed: boolean; pinned: boolean }>();
  state.graph.forEachNode((id, attrs) => {
    preserved.set(id, { x: attrs.x, y: attrs.y, fixed: !!attrs.fixed, pinned: !!attrs.pinned });
  });

  state.graph.clear();
  let edgeCount = 0;

  const nodeIds = [...state.visibleNodes];
  const N = nodeIds.length;
  const RADIUS = 100;

  for (let i = 0; i < N; i++) {
    const nodeId = nodeIds[i];
    if (!fullGraph.hasNode(nodeId)) continue;
    const attrs = { ...fullGraph.getNodeAttributes(nodeId) };

    const prev = preserved.get(nodeId);
    if (prev) {
      // Node was already visible — keep its position and pin state intact
      attrs.x = prev.x;
      attrs.y = prev.y;
      attrs.fixed = prev.fixed;
      attrs.pinned = prev.pinned;
    } else if (nodeId === state.seedNode) {
      attrs.x = 0;
      attrs.y = 0;
      attrs.fixed = false;
      attrs.pinned = state.pinnedNodes.has(nodeId);
    } else {
      // New node — seed in a circle around origin
      const angle = (2 * Math.PI * i) / N;
      attrs.x = RADIUS * Math.cos(angle);
      attrs.y = RADIUS * Math.sin(angle);
      attrs.fixed = false;
      attrs.pinned = state.pinnedNodes.has(nodeId);
    }
    state.graph.addNode(nodeId, attrs);
  }

  // Add edges between visible nodes that match active edge types
  for (const nodeId of nodeIds) {
    if (!fullGraph.hasNode(nodeId)) continue;
    fullGraph.forEachEdge(nodeId, (_edge, attrs, source, target) => {
      if (source > target) return; // count each edge once
      if (source !== nodeId && target !== nodeId) return;
      const other = source === nodeId ? target : source;
      if (!state.visibleNodes.has(other)) return;
      if (!state.activeEdgeTypes.has(attrs.edgeType)) return;
      try {
        state.graph.addEdge(source, target, { ...attrs });
        edgeCount++;
      } catch {
        // Duplicate, skip
      }
    });
  }

  cachedVisibleEdgeCount = edgeCount;
}

function updateStatusBar(): void {
  if (!state.seedNode) {
    const modeSuffix = POWER_CONFIG ? " · power mode" : "";
    const summary = `${state.meta?.nodeCount ?? 0} nodes loaded. Search to seed a local graph.${modeSuffix}`;
    elements.statusSummary.textContent = summary;
    updateEmptyStateMetrics();
    updateStatsPanel();
    updateHealthPanel();
    elements.clearSeed.classList.add("hidden");
    elements.seedFocusTitle.textContent = "No seed selected";
    elements.seedDescription.textContent = "Search for a note to explore its neighborhood.";
    elements.seedSignalBadge.classList.add("hidden");
    elements.seedMetrics.classList.add("hidden");
    elements.seedStory.classList.add("hidden");
    elements.communitySection.classList.add("hidden");
    elements.readoutSection.classList.add("hidden");
    return;
  }
  const isFullGraph = state.seedNodes.size > 0 && state.seedNodes.size === fullGraph.order;
  const seedCount = state.seedNodes.size;
  const seedSuffix = isFullGraph
    ? "Full graph"
    : seedCount > 1
      ? `${seedCount} seeds`
      : fullGraph.hasNode(state.seedNode) ? fullGraph.getNodeAttribute(state.seedNode, "title") : state.seedNode;
  const summary = `${state.visibleNodes.size} nodes · ${cachedVisibleEdgeCount} edges · ${seedSuffix}`;
  elements.statusSummary.textContent = summary;
  updateEmptyStateMetrics();
  updateStatsPanel();
  updateHealthPanel();
}

function updateStatsPanel(): void {
  const nc = state.meta?.nodeCount ?? fullGraph.order;
  const ec = state.meta?.edgeCount ?? fullGraph.size;
  elements.metaNotes.textContent = nc.toLocaleString();
  elements.metaEdges.textContent = ec.toLocaleString();

  const visibleCommunities = new Set<number>();
  state.graph.forEachNode((_node, attrs) => {
    if (attrs.clusterId != null) visibleCommunities.add(attrs.clusterId);
  });
  elements.metaCommunities.textContent = visibleCommunities.size > 0 ? visibleCommunities.size.toLocaleString() : "—";
}

function nodeMatchesFilterQuery(nodeId: string, attrs: NodeAttrs, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (attrs.title.toLowerCase().includes(q)) return true;
  if (nodeId.toLowerCase().includes(q)) return true;
  if (attrs.folder.toLowerCase().includes(q)) return true;
  if (attrs.tags.some((tag) => tag.toLowerCase().includes(q))) return true;
  return Object.entries(attrs.frontmatter ?? {}).some(([key, value]) => (
    key.toLowerCase().includes(q) || formatFrontmatterValue(value).toLowerCase().includes(q)
  ));
}

function nodePassesStaticFilters(nodeId: string): boolean {
  if (!fullGraph.hasNode(nodeId)) return false;
  const attrs = fullGraph.getNodeAttributes(nodeId);
  if (state.disabledNodeTypes.has(attrs.nodeType)) return false;
  return true;
}

function formatRelativeTime(timestamp: number): string {
  const deltaMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getNeighborsForBridgeScore(nodeId: string): Set<string> {
  const neighbors = new Set<string>();
  fullGraph.forEachEdge(nodeId, (_edge, attrs, source, target) => {
    if (!state.activeEdgeTypes.has(attrs.edgeType)) return;
    const other = source === nodeId ? target : source;
    if (fullGraph.hasNode(other)) neighbors.add(other);
  });
  return neighbors;
}

function computeSingleBridgeScore(nodeId: string): number {
  if (!fullGraph.hasNode(nodeId)) return 0;
  const neighbors = getNeighborsForBridgeScore(nodeId);
  if (neighbors.size === 0) return 0;

  let total = 0;
  let count = 0;
  for (const neighborId of neighbors) {
    const crossLinkedNeighbors = new Set<string>();
    fullGraph.forEachEdge(neighborId, (_edge, attrs, source, target) => {
      if (!state.activeEdgeTypes.has(attrs.edgeType)) return;
      const other = source === neighborId ? target : source;
      if (other !== nodeId && neighbors.has(other)) crossLinkedNeighbors.add(other);
    });
    const totalNeighborDegree = fullGraph.degree(neighborId);
    const bridgeScore = totalNeighborDegree > 0
      ? (1 - crossLinkedNeighbors.size / Math.max(1, neighbors.size - 1)) * totalNeighborDegree
      : 0;
    total += bridgeScore;
    count++;
  }

  return count > 0 ? total / count : 0;
}

function computeBridgeScoresForVisibleNodes(): Map<string, number> {
  const scores = new Map<string, number>();
  state.graph.forEachNode((nodeId) => {
    scores.set(nodeId, computeSingleBridgeScore(nodeId));
  });
  return scores;
}

function getCommunityName(clusterId: number | null): string {
  if (clusterId == null) return "Unclustered";
  const counts = new Map<string, number>();
  state.graph.forEachNode((_nodeId, attrs) => {
    if (attrs.clusterId !== clusterId) return;
    for (const tag of attrs.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  });
  const topTags = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([tag]) => tag.replace(/^#/, ""));
  return topTags.length > 0 ? topTags.join(" · ") : `Cluster ${clusterId}`;
}

function updateTrail(nodeId: string, label: string, depth: number): void {
  state.explorationTrail.push({ nodeId, label, timestamp: Date.now(), depth });
  if (state.explorationTrail.length > 10) state.explorationTrail.shift();

  const recent = state.explorationTrail.slice(-6);
  elements.trailCountBadge.textContent = `${recent.length} stops`;
  elements.trailList.innerHTML = recent.map((entry, index) => `
    <div class="trail-item">
      <span class="trail-index">${index + 1}</span>
      <div><div class="trail-title">${escapeHtml(entry.label)}</div><div class="trail-meta">${escapeHtml(formatRelativeTime(entry.timestamp))}</div></div>
      <span class="trail-hop">${entry.depth} hop${entry.depth === 1 ? "" : "s"}</span>
    </div>
  `).join("");
  elements.trailSection.classList.toggle("hidden", recent.length === 0);
}

function updateCommunityPressure(): void {
  const clusters = new Map<number, { count: number; titles: string[] }>();
  state.graph.forEachNode((_nodeId, attrs) => {
    if (attrs.clusterId == null) return;
    const entry = clusters.get(attrs.clusterId) ?? { count: 0, titles: [] };
    entry.count++;
    if (entry.titles.length < 3) entry.titles.push(attrs.title);
    clusters.set(attrs.clusterId, entry);
  });

  const topClusters = [...clusters.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 4);

  elements.communityCountBadge.textContent = `Top ${topClusters.length}`;
  elements.communityListEl.innerHTML = topClusters.map(([clusterId, entry]) => {
    const pct = state.graph.order > 0 ? (entry.count / state.graph.order) * 100 : 0;
    return `
      <div class="community-item">
        <div class="community-top"><div class="community-name">${escapeHtml(getCommunityName(clusterId))}</div><div class="community-count">${entry.count} notes</div></div>
        <div class="community-sub">Key nodes: ${entry.titles.map((title) => `"${escapeHtml(title)}"`).join(", ")}</div>
        <div class="community-bar"><span style="width: ${pct}%"></span></div>
      </div>
    `;
  }).join("");
  elements.communitySection.classList.toggle("hidden", topClusters.length === 0);
}

function countComponents(graph: Graph<NodeAttrs, EdgeAttrs>): number {
  const visited = new Set<string>();
  let count = 0;
  graph.forEachNode((node) => {
    if (visited.has(node)) return;
    count++;
    const queue = [node];
    while (queue.length) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      graph.forEachNeighbor(current, (neighbor) => {
        if (!visited.has(neighbor)) queue.push(neighbor);
      });
    }
  });
  return count;
}

function estimateAveragePathLength(graph: Graph<NodeAttrs, EdgeAttrs>): number {
  const nodes = graph.nodes().slice(0, Math.min(5, graph.order));
  if (nodes.length === 0) return 0;
  let total = 0;
  let count = 0;
  for (const source of nodes) {
    const visited = new Set<string>([source]);
    const queue: Array<{ node: string; distance: number }> = [{ node: source, distance: 0 }];
    while (queue.length) {
      const current = queue.shift()!;
      graph.forEachNeighbor(current.node, (neighbor) => {
        if (visited.has(neighbor)) return;
        visited.add(neighbor);
        const nextDistance = current.distance + 1;
        total += nextDistance;
        count++;
        queue.push({ node: neighbor, distance: nextDistance });
      });
    }
  }
  return count > 0 ? total / count : 0;
}

function updateStructuralReadout(): void {
  const order = state.graph.order;
  const possibleEdges = order > 1 ? (order * (order - 1)) / 2 : 0;
  const density = possibleEdges > 0 ? Math.min(1, state.graph.size / possibleEdges) : 0;
  const avgPath = estimateAveragePathLength(state.graph);
  const components = countComponents(state.graph);
  let peripheral = 0;
  state.graph.forEachNode((nodeId) => {
    if (state.graph.degree(nodeId) <= 1) peripheral++;
  });

  elements.readoutDensity.textContent = density.toFixed(2);
  elements.readoutAvgPath.textContent = avgPath > 0 ? avgPath.toFixed(2) : "—";
  elements.readoutComponents.textContent = components.toLocaleString();
  elements.readoutPeripheral.textContent = peripheral.toLocaleString();

  const bridgeScores = computeBridgeScoresForVisibleNodes();
  const strongestBridge = [...bridgeScores.entries()].sort((a, b) => b[1] - a[1])[0];
  const crowdedEdgeType = [...computeEdgeLegendCounts().entries()].sort((a, b) => b[1] - a[1])[0];

  let missingSynthesis = "No obvious synthesis gap.";
  const clusterTags = new Map<number, Set<string>>();
  state.graph.forEachNode((_nodeId, attrs) => {
    if (attrs.clusterId == null) return;
    const tags = clusterTags.get(attrs.clusterId) ?? new Set<string>();
    attrs.tags.forEach((tag) => tags.add(tag));
    clusterTags.set(attrs.clusterId, tags);
  });
  const clusterIds = [...clusterTags.keys()];
  outer: for (let i = 0; i < clusterIds.length; i++) {
    for (let j = i + 1; j < clusterIds.length; j++) {
      const a = clusterIds[i]!;
      const b = clusterIds[j]!;
      let connected = false;
      state.graph.forEachEdge((_edge, attrs, source, target) => {
        if (!state.activeEdgeTypes.has(attrs.edgeType)) return;
        const sourceCluster = state.graph.getNodeAttribute(source, "clusterId");
        const targetCluster = state.graph.getNodeAttribute(target, "clusterId");
        if ((sourceCluster === a && targetCluster === b) || (sourceCluster === b && targetCluster === a)) connected = true;
      });
      if (connected) continue;
      const sharedTag = [...(clusterTags.get(a) ?? new Set<string>())].find((tag) => (clusterTags.get(b) ?? new Set<string>()).has(tag));
      if (sharedTag) {
        missingSynthesis = `${getCommunityName(a)} and ${getCommunityName(b)} both use ${sharedTag}.`;
        break outer;
      }
    }
  }

  elements.readoutHighlights.innerHTML = [
    strongestBridge && fullGraph.hasNode(strongestBridge[0])
      ? `<li><span>Strongest bridge</span><strong>${escapeHtml(fullGraph.getNodeAttribute(strongestBridge[0], "title"))}</strong></li>`
      : `<li><span>Strongest bridge</span><strong>—</strong></li>`,
    crowdedEdgeType
      ? `<li><span>Most crowded edge type</span><strong>${escapeHtml(EDGE_LABELS[crowdedEdgeType[0]] ?? crowdedEdgeType[0])}</strong></li>`
      : `<li><span>Most crowded edge type</span><strong>—</strong></li>`,
    `<li><span>Likely missing synthesis</span><strong>${escapeHtml(missingSynthesis)}</strong></li>`,
  ].join("");
  elements.readoutSection.classList.toggle("hidden", order === 0);
}

function updateSeedFocus(nodeId: string | null): void {
  const isFullGraph = state.seedNodes.size > 0 && state.seedNodes.size === fullGraph.order;
  const isMultiSeed = state.seedNodes.size > 1 && !isFullGraph;
  elements.clearSeed.classList.toggle("hidden", !nodeId);

  if (!nodeId) {
    elements.seedFocusTitle.textContent = "No seed selected";
    elements.seedDescription.textContent = "Search for a note to explore its neighborhood.";
    elements.seedSignalBadge.classList.add("hidden");
    elements.seedMetrics.classList.add("hidden");
    elements.seedStory.classList.add("hidden");
    return;
  }

  if (isFullGraph) {
    elements.seedFocusTitle.textContent = "Full graph";
    elements.seedDescription.textContent = "The entire atlas is visible. Use community pressure and the structural readout to orient.";
    elements.seedSignalBadge.classList.add("hidden");
    elements.seedMetrics.classList.add("hidden");
    elements.seedStory.classList.add("hidden");
    return;
  }

  if (isMultiSeed) {
    elements.seedFocusTitle.textContent = `Multi-seed: ${state.seedNodes.size} notes`;
    elements.seedDescription.textContent = "This view combines several anchors into one shared neighborhood.";
    elements.seedSignalBadge.classList.add("hidden");
    elements.seedMetrics.classList.add("hidden");
    elements.seedStory.classList.add("hidden");
    return;
  }

  if (!fullGraph.hasNode(nodeId)) return;
  const attrs = fullGraph.getNodeAttributes(nodeId);
  const degree = fullGraph.degree(nodeId);
  const rank = state.pagerankRanks.get(nodeId) ?? state.pagerankRanks.size;
  const bridgeScore = computeSingleBridgeScore(nodeId);
  const visibleBridgeScores = [...computeBridgeScoresForVisibleNodes().entries()].sort((a, b) => b[1] - a[1]);
  const visibleRank = Math.max(1, visibleBridgeScores.findIndex(([id]) => id === nodeId) + 1 || visibleBridgeScores.length);
  const higherThan = visibleBridgeScores.length > 1
    ? Math.round(((visibleBridgeScores.length - visibleRank) / (visibleBridgeScores.length - 1)) * 100)
    : 100;
  const neighbors = getNeighborsForBridgeScore(nodeId);
  const bridgeNeighborCount = [...neighbors].filter((neighborId) => computeSingleBridgeScore(neighborId) > 0).length;
  const communityName = getCommunityName(attrs.clusterId);

  elements.seedFocusTitle.textContent = attrs.title;
  elements.seedDescription.textContent = "Structural signals are computed from the currently visible graph slice.";
  elements.metricPagerank.textContent = `#${rank}`;
  elements.metricPagerankDetail.textContent = `of ${state.pagerankRanks.size} notes`;
  elements.metricDegree.textContent = degree.toLocaleString();
  elements.metricDegreeDetail.textContent = `${bridgeNeighborCount} bridges`;
  elements.metricCommunity.textContent = attrs.clusterId == null ? "—" : `C-${String(attrs.clusterId).padStart(2, "0")}`;
  elements.metricCommunityDetail.textContent = communityName;
  elements.metricBridge.textContent = bridgeScore.toFixed(2);
  elements.metricBridgeDetail.textContent = `higher than ${higherThan}% of visible nodes`;

  const communitySpread = new Set<number>();
  neighbors.forEach((neighborId) => {
    const clusterId = fullGraph.getNodeAttribute(neighborId, "clusterId");
    if (clusterId != null) communitySpread.add(clusterId);
  });

  let why = "Explore this node's neighborhood to discover how it connects to the broader knowledge graph.";
  if (bridgeScore > 0.3 && communitySpread.size >= 2) {
    why = "This note carries cross-cluster traffic that could be split into more specific synthesis notes.";
  } else if (rank < 50 && degree < 10) {
    why = "High structural importance despite few direct connections — likely a synthesis node that curates rather than collects.";
  } else if (degree > 30 && bridgeScore < 0.1) {
    why = "Many connections but low bridging value — most neighbors already know each other.";
  }

  const topBridgeNeighbor = [...neighbors]
    .map((neighborId) => {
      const edgeTypes = new Set<string>();
      fullGraph.forEachEdge(nodeId, (_edge, edgeAttrs, source, target) => {
        const other = source === nodeId ? target : source;
        if (other === neighborId && state.activeEdgeTypes.has(edgeAttrs.edgeType)) edgeTypes.add(edgeAttrs.edgeType);
      });
      return { neighborId, score: computeSingleBridgeScore(neighborId), edgeType: [...edgeTypes][0] ?? "related" };
    })
    .sort((a, b) => b.score - a.score)[0];

  elements.storyWhy.textContent = why;
  elements.storyNext.textContent = topBridgeNeighbor && fullGraph.hasNode(topBridgeNeighbor.neighborId)
    ? `Check the link toward "${fullGraph.getNodeAttribute(topBridgeNeighbor.neighborId, "title")}" for ${EDGE_LABELS[topBridgeNeighbor.edgeType] ?? topBridgeNeighbor.edgeType} overlap.`
    : "Inspect neighboring bridges to see where this neighborhood opens into adjacent clusters.";

  const topPct = visibleBridgeScores.length > 0 ? Math.max(1, Math.round((visibleRank / visibleBridgeScores.length) * 100)) : 100;
  elements.seedSignalText.textContent = `Bridge Top ${topPct}%`;
  elements.seedSignalBadge.classList.toggle("hidden", visibleBridgeScores.length === 0);
  elements.seedMetrics.classList.remove("hidden");
  elements.seedStory.classList.remove("hidden");
}

function pruneDisconnectedVisibleNodes(candidateNodes: Iterable<string>, allowIsolated: Set<string>): Set<string> {
  const visible = new Set<string>();
  for (const nodeId of candidateNodes) {
    if (nodePassesStaticFilters(nodeId)) visible.add(nodeId);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const nodeId of [...visible]) {
      if (allowIsolated.has(nodeId)) continue;
      let hasVisibleEdge = false;
      fullGraph.forEachEdge(nodeId, (_edge, attrs, source, target) => {
        if (hasVisibleEdge) return;
        if (!state.activeEdgeTypes.has(attrs.edgeType)) return;
        const other = source === nodeId ? target : source;
        if (!visible.has(other)) return;
        hasVisibleEdge = true;
      });
      if (!hasVisibleEdge) {
        visible.delete(nodeId);
        changed = true;
      }
    }
  }

  return visible;
}

/**
 * Read a power-mode config from the URL. Supports:
 *   ?power=<baseUrl>              — full URL
 *   ?power=<baseUrl>&bearer=<tok> — with optional Bearer for local dev
 * Persists the choice in localStorage so reloads stay in power mode.
 */
function readPowerConfig(): PowerSourceConfig | null {
  const params = new URLSearchParams(window.location.search);
  let baseUrl = params.get("power");
  let bearer = params.get("bearer") ?? undefined;

  // localStorage fallback for cross-reload persistence
  if (!baseUrl) {
    try {
      const stored = window.localStorage.getItem("atlas:power");
      if (stored) {
        const parsed = JSON.parse(stored) as { baseUrl: string; bearer?: string };
        baseUrl = parsed.baseUrl;
        bearer = parsed.bearer;
      }
    } catch {
      // ignore localStorage errors (private mode, etc.)
    }
  } else {
    // Save to localStorage when explicitly set via URL
    try {
      window.localStorage.setItem(
        "atlas:power",
        JSON.stringify({ baseUrl, bearer }),
      );
    } catch {
      // ignore
    }
  }

  return baseUrl ? { baseUrl, bearer } : null;
}

const POWER_CONFIG = readPowerConfig();

/**
 * Build a fetch URL + credentials for a given /api/* path. In local mode
 * this is just `path` with default credentials. In power mode it rewrites
 * the origin to the worker and attaches Bearer/Access auth.
 */
function apiUrl(path: string): string {
  if (!POWER_CONFIG) return path;
  return new URL(path, POWER_CONFIG.baseUrl).toString();
}

function apiFetchInit(): RequestInit {
  if (!POWER_CONFIG) return {};
  const headers: Record<string, string> = { Accept: "application/json" };
  if (POWER_CONFIG.bearer) headers.Authorization = `Bearer ${POWER_CONFIG.bearer}`;
  return {
    headers,
    credentials: POWER_CONFIG.bearer ? "omit" : "include",
  };
}

async function fetchAllPowerPages<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let cursor = "";
  while (true) {
    const url = new URL(path, POWER_CONFIG!.baseUrl);
    url.searchParams.set("cursor", cursor);
    url.searchParams.set("limit", "2000");
    const response = await fetch(url.toString(), apiFetchInit());
    if (!response.ok) {
      throw new Error(`Power-mode ${path} failed: ${response.status}`);
    }
    const page = await response.json() as PageResponse<T>;
    items.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return items;
}

async function loadGraphFromPower(config: PowerSourceConfig): Promise<void> {
  const metaUrl = new URL("/api/meta", config.baseUrl).toString();
  const metaHeaders: Record<string, string> = { Accept: "application/json" };
  if (config.bearer) metaHeaders.Authorization = `Bearer ${config.bearer}`;

  const [nodes, edges, metaJson] = await Promise.all([
    fetchAllPowerPages<PowerNodePageItem>("/api/graph/nodes"),
    fetchAllPowerPages<PowerEdgePageItem>("/api/graph/edges"),
    fetch(metaUrl, {
      headers: metaHeaders,
      credentials: config.bearer ? "omit" : "include",
    }).then((r) => r.json() as Promise<MetaData>),
  ]);

  state.meta = metaJson;
  state.enrichment = {
    version: metaJson.enrichmentVersion ?? 0,
    communityCount: metaJson.enrichmentCommunityCount ?? 0,
    lastRunAt: metaJson.lastEnrichmentAt ?? 0,
  };
  fullGraph.clear();
  state.graph.clear();

  const degreeCounts = new Map<string, number>();
  for (const edge of edges) {
    degreeCounts.set(edge.sourceId, (degreeCounts.get(edge.sourceId) ?? 0) + 1);
    degreeCounts.set(edge.targetId, (degreeCounts.get(edge.targetId) ?? 0) + 1);
  }

  for (const node of nodes) {
    const degree = degreeCounts.get(node.id) ?? 0;
    const frontmatter = (node.frontmatter ?? {}) as Record<string, unknown>;
    const nodeType = inferNodeType({
      id: node.id,
      folder: node.folder,
      nodeType: typeof node.nodeType === "string"
        ? node.nodeType
        : undefined,
      type: typeof frontmatter?.type === "string"
        ? (frontmatter.type as string)
        : undefined,
    });
    const tags = Array.isArray(node.tags)
      ? node.tags.filter((t): t is string => typeof t === "string")
      : Array.isArray(frontmatter?.tags)
        ? (frontmatter.tags as unknown[]).filter((t): t is string => typeof t === "string")
        : [];
    fullGraph.addNode(node.id, {
      x: node.x ?? 0,
      y: node.y ?? 0,
      label: truncateLabel(formatNodeLabel(node.title, node.id)),
      shortLabel: truncateLabel(formatNodeLabel(node.title, node.id)),
      title: node.title,
      nodeType,
      folder: node.folder,
      tags,
      frontmatter,
      wordCount: node.wordCount ?? 0,
      created: node.created ?? 0,
      modified: node.modified ?? 0,
      clusterId: node.clusterId ?? null,
      componentId: node.componentId ?? null,
      pagerank: node.pagerank ?? null,
      clusteringCoeff: node.clusteringCoeff ?? null,
      degree,
      size: mapDegreeToSize(degree),
      color: typeColor(nodeType),
      fixed: false,
      pinned: state.pinnedNodes.has(node.id),
    });
  }

  state.maxPageRank = 0;
  fullGraph.forEachNode((_, attrs) => {
    if (attrs.pagerank != null && attrs.pagerank > state.maxPageRank) {
      state.maxPageRank = attrs.pagerank;
    }
  });
  rebuildPagerankRanks();

  // Apply initial size mode (pagerank by default — re-size after maxPageRank is known)
  // Guard: only override degree-based sizes when pagerank data actually exists,
  // otherwise all nodes collapse to uniform size 4 (the mapPageRankToSize fallback)
  if (state.sizeMode === "pagerank" && state.maxPageRank > 0) {
    fullGraph.forEachNode((nodeId, attrs) => {
      fullGraph.setNodeAttribute(nodeId, "size", mapPageRankToSize(attrs.pagerank, state.maxPageRank));
    });
  }

  for (const edge of edges) {
    if (!fullGraph.hasNode(edge.sourceId) || !fullGraph.hasNode(edge.targetId)) continue;
    try {
      fullGraph.addEdge(edge.sourceId, edge.targetId, {
        edgeType: edge.edgeType,
        label: edge.edgeType,
        color: edgeColor(edge.edgeType),
        weight: edge.weight,
        size: clamp(0.5 + edge.weight * 0.5, 0.5, 3),
      });
    } catch {
      continue;
    }
  }

  const urlState = parseUrlState();
  state.activeEdgeTypes = new Set(urlState.edges.length ? urlState.edges : DEFAULT_EDGE_TYPES);
  state.disabledNodeTypes = new Set(urlState.types.length ? urlState.types : ["transcript", "archive"]);
  state.depth = urlState.depth;
  elements.depthSlider.value = String(state.depth);
  updateDepthLabel();
  computeFullGraphHealth();
  updateHealthPanel();
  updateEmptyStateMetrics();
  if (typeof window !== "undefined" && /^(localhost|127\.0\.0\.1|::1)$/.test(window.location.hostname)) {
    console.debug("cluster colors", [...fullGraph.nodes()].slice(0, 8).map((id) => {
      const attrs = fullGraph.getNodeAttributes(id);
      return { id, clusterId: attrs.clusterId, color: communityColor(attrs.clusterId) };
    }));
  }
}

async function loadGraph(): Promise<void> {
  if (POWER_CONFIG) {
    return loadGraphFromPower(POWER_CONFIG);
  }
  const [graphRes, metaRes] = await Promise.all([
    fetch("/api/graph").then((r) => r.json() as Promise<{ nodes: ApiNode[]; edges: ApiEdge[]; health?: { orphanCount: number; weakComponentCount: number; staleCount: number; staleDays: number; gini: number } }>),
    fetch("/api/meta").then((r) => r.json() as Promise<MetaData>),
  ]);

  state.meta = metaRes;
  state.enrichment = {
    version: metaRes.enrichmentVersion ?? 0,
    communityCount: metaRes.enrichmentCommunityCount ?? 0,
    lastRunAt: metaRes.lastEnrichmentAt ?? 0,
  };
  fullGraph.clear();
  state.graph.clear();

  const degreeCounts = new Map<string, number>();
  for (const edge of graphRes.edges) {
    degreeCounts.set(edge.source, (degreeCounts.get(edge.source) ?? 0) + 1);
    degreeCounts.set(edge.target, (degreeCounts.get(edge.target) ?? 0) + 1);
  }

  for (let ni = 0; ni < graphRes.nodes.length; ni++) {
    const node = graphRes.nodes[ni];
    const degree = degreeCounts.get(node.id) ?? 0;
    const nodeType = inferNodeType(node);
    fullGraph.addNode(node.id, {
      x: node.x,
      y: node.y,
      label: truncateLabel(formatNodeLabel(node.title, node.id)),
      shortLabel: truncateLabel(formatNodeLabel(node.title, node.id)),
      title: node.title,
      nodeType,
      folder: node.folder,
      tags: node.tags,
      frontmatter: node.frontmatter ?? {},
      wordCount: node.wordCount,
      created: node.created,
      modified: node.modified,
      clusterId: node.clusterId ?? null,
      componentId: node.componentId ?? null,
      pagerank: node.pagerank ?? null,
      clusteringCoeff: node.clusteringCoeff ?? null,
      nodeIndex: ni,
      degree,
      size: mapDegreeToSize(degree),
      color: typeColor(nodeType),
      fixed: false,
      pinned: state.pinnedNodes.has(node.id),
    });
  }

  state.maxPageRank = 0;
  fullGraph.forEachNode((_, attrs) => {
    if (attrs.pagerank != null && attrs.pagerank > state.maxPageRank) {
      state.maxPageRank = attrs.pagerank;
    }
  });
  rebuildPagerankRanks();

  // Apply initial size mode (pagerank by default — re-size after maxPageRank is known)
  // Guard: only override degree-based sizes when pagerank data actually exists
  if (state.sizeMode === "pagerank" && state.maxPageRank > 0) {
    fullGraph.forEachNode((nodeId, attrs) => {
      fullGraph.setNodeAttribute(nodeId, "size", mapPageRankToSize(attrs.pagerank, state.maxPageRank));
    });
  }

  for (const edge of graphRes.edges) {
    if (!fullGraph.hasNode(edge.source) || !fullGraph.hasNode(edge.target)) continue;
    try {
      fullGraph.addEdge(edge.source, edge.target, {
        edgeType: edge.type,
        label: edge.type,
        color: edgeColor(edge.type),
        weight: edge.weight,
        size: clamp(0.5 + edge.weight * 0.5, 0.5, 3),
      });
    } catch {
      continue;
    }
  }

  const urlState = parseUrlState();
  state.activeEdgeTypes = new Set(urlState.edges.length ? urlState.edges : DEFAULT_EDGE_TYPES);
  state.disabledNodeTypes = new Set(urlState.types.length ? urlState.types : ["transcript", "archive"]);
  state.depth = urlState.depth;
  elements.depthSlider.value = String(state.depth);
  updateDepthLabel();
  state.health = graphRes.health ?? null;
  if (!state.health) computeFullGraphHealth();
  updateHealthPanel();
  updateEmptyStateMetrics();
  if (typeof window !== "undefined" && /^(localhost|127\.0\.0\.1|::1)$/.test(window.location.hostname)) {
    console.debug("cluster colors", [...fullGraph.nodes()].slice(0, 8).map((id) => {
      const attrs = fullGraph.getNodeAttributes(id);
      return { id, clusterId: attrs.clusterId, color: communityColor(attrs.clusterId) };
    }));
  }
}

const customNodeLabel: NodeLabelDrawingFunction<NodeAttrs, EdgeAttrs> = (context, data, settings) => {
  const nextData = { ...data, label: truncateLabel(data.label ?? "") };
  drawDiscNodeLabel(context, nextData, settings);
};

const customNodeHover: NodeHoverDrawingFunction<NodeAttrs, EdgeAttrs> = (context, data) => {
  const size = data.size;
  const label = truncateLabel(data.label ?? "");
  const selected = Boolean((data as Record<string, unknown>).selected);
  const pinned = Boolean((data as Record<string, unknown>).pinned);
  const hovered = Boolean((data as Record<string, unknown>).hovered);
  const highlightedNode = Boolean((data as Record<string, unknown>).highlightedNode);
  const ringColor = ((data as Record<string, unknown>).ringColor as string | undefined) ?? data.color;
  const labelWidth = context.measureText(label).width;

  if (selected) {
    context.beginPath();
    context.strokeStyle = SELECTION_RING;
    context.lineWidth = 2;
    context.arc(data.x, data.y, size + 6, 0, Math.PI * 2);
    context.stroke();
  }

  if (pinned) {
    context.save();
    context.beginPath();
    context.strokeStyle = withAlpha("#f3bf4d", 0.95);
    context.lineWidth = 2.5;
    context.arc(data.x, data.y, size + 3, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.fillStyle = "#f3bf4d";
    context.arc(data.x + size * 0.68, data.y - size * 0.68, 3, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  if (hovered) {
    context.beginPath();
    context.strokeStyle = ringColor;
    context.lineWidth = 2;
    context.arc(data.x, data.y, size + 2, 0, Math.PI * 2);
    context.stroke();
  }

  if (highlightedNode) {
    context.beginPath();
    context.strokeStyle = withAlpha("#fbbf24", 0.95);
    context.lineWidth = 2;
    context.arc(data.x, data.y, size + 5, 0, Math.PI * 2);
    context.stroke();
  }

  if (label) {
    const paddingX = 8;
    const labelX = data.x + size + 10;
    const labelY = data.y - 11;
    context.save();
    context.fillStyle = withAlpha(BACKGROUND, 0.82);
    context.beginPath();
    context.roundRect(labelX - 4, labelY - 8, labelWidth + paddingX * 2, 22, 10);
    context.fill();
    context.strokeStyle = withAlpha("#ffffff", 0.12);
    context.stroke();
    context.fillStyle = "#e7eaee";
    context.font = "12px IBM Plex Sans, sans-serif";
    context.fillText(label, labelX + paddingX - 2, labelY + 7);
    context.restore();
  }
};

function initRenderer(): void {
  const renderer = new Sigma(state.graph, elements.container, {
    hideEdgesOnMove: true,
    labelRenderedSizeThreshold: 12,
    labelDensity: 0.5,
    defaultEdgeType: "edges-fast",
    edgeProgramClasses: { "edges-fast": EdgeLineProgram },
    enableEdgeEvents: true,
    renderEdgeLabels: true,
    nodesPowRatio: 0.5,
    minCameraRatio: 0.02,
    maxCameraRatio: 10,
    defaultEdgeColor: DEFAULT_EDGE_COLOR,
    defaultNodeColor: DEFAULT_NODE_COLOR,
    labelColor: { color: "#999999" },
    labelFont: "11px IBM Plex Sans, sans-serif",
    stagePadding: 40,
    defaultDrawNodeLabel: customNodeLabel,
    defaultDrawNodeHover: customNodeHover,
    zIndex: true,
  });

  renderer.setSetting("nodeReducer", (node, data) => {
    const attrs = state.graph.getNodeAttributes(node);
    const result: Record<string, unknown> = {
      ...data,
      label: attrs.shortLabel,
    };

    if (!state.visibleNodes.has(node)) {
      result.hidden = true;
      return result;
    }

    const isHovered = node === state.hoveredNode;
    const isNeighbor = state.hoveredNeighbors.has(node);
    const isSelected = node === state.selectedNode;
    const pinned = Boolean(attrs.pinned);
    const isHighlighted = state.highlightedNodes.has(node);
    const focusMode = Boolean(state.hoveredNode);

    let color = state.colorMode === "community" ? communityColor(attrs.clusterId) : attrs.color;
    let size = state.sizeMode === "pagerank" && state.maxPageRank > 0 ? mapPageRankToSize(attrs.pagerank, state.maxPageRank) : attrs.size;
    let label = attrs.shortLabel;
    let hidden = false;

    if (attrs.nodeType === "transcript" || attrs.nodeType === "archive") {
      size *= 0.5;
    }

    const isFilterMatch = state.searchMode === "filter" && state.filterQuery.length > 0 && state.filterMatches.has(node);
    const isFilterDim = state.searchMode === "filter" && state.filterQuery.length > 0 && !state.filterMatches.has(node);

    if (isFilterDim) {
      color = withAlpha(color, 0.1);
      label = "";
    } else if (focusMode && !isHovered && !isNeighbor) {
      color = withAlpha(color, 0.15);
      label = "";
    }

    if (isHovered) {
      size *= 1.3;
      label = attrs.shortLabel;
    } else if (isSelected) {
      label = attrs.shortLabel;
    }

    if (isHighlighted && !isSelected) {
      size = Math.min(14, size + 2);
      label = attrs.shortLabel;
    }

    if (hidden) result.hidden = true;
    result.color = color;
    result.size = size;
    result.forceLabel = isHovered || isSelected || isFilterMatch || isHighlighted;
    result.zIndex = isHovered || isSelected || pinned || isHighlighted ? 2 : 1;
    result.highlighted = isHovered || isSelected || pinned || isHighlighted;
    result.hovered = isHovered;
    result.selected = isSelected;
    result.pinned = pinned;
    result.highlightedNode = isHighlighted;
    result.ringColor = isHighlighted ? "#fbbf24" : attrs.color;
    result.label = label;
    return result;
  });

  renderer.setSetting("edgeReducer", (edge, data) => {
    const edgeType = state.graph.getEdgeAttribute(edge, "edgeType");
    const source = state.graph.source(edge);
    const target = state.graph.target(edge);
    const result: Record<string, unknown> = { ...data };

    if (!state.visibleNodes.has(source) || !state.visibleNodes.has(target)) {
      result.hidden = true;
      return result;
    }

    if (!state.activeEdgeTypes.has(edgeType)) {
      result.hidden = true;
      return result;
    }

    const isHovered = edge === state.hoveredEdge;
    const connectedToHovered = source === state.hoveredNode || target === state.hoveredNode;
    if (state.hoveredNode) {
      result.color = connectedToHovered ? withAlpha(edgeColor(edgeType), 1) : withAlpha(edgeColor(edgeType), 0.15);
      result.size = connectedToHovered ? 1.5 : 0.5;
    } else if (isHovered) {
      result.color = withAlpha(edgeColor(edgeType), 1);
      result.size = Math.max(1.5, state.graph.getEdgeAttribute(edge, "size"));
    } else {
      result.color = withAlpha(edgeColor(edgeType), 0.4);
      result.size = Math.max(0.7, state.graph.getEdgeAttribute(edge, "size"));
    }

    result.label = state.graph.getEdgeAttribute(edge, "label");
    result.forceLabel = isHovered;
    result.zIndex = isHovered ? 2 : 1;

    return result;
  });

  renderer.on("enterNode", ({ node }) => {
    state.hoveredNode = node;
    // Neighbors come from state.graph (visible) since we only highlight what's on screen
    state.hoveredNeighbors = new Set(state.graph.hasNode(node) ? state.graph.neighbors(node) : []);
    refreshRenderer();
  });

  renderer.on("leaveNode", () => {
    state.hoveredNode = null;
    state.hoveredNeighbors.clear();
    refreshRenderer();
  });

  renderer.on("enterEdge", ({ edge }) => {
    state.hoveredEdge = edge;
    refreshRenderer();
  });

  renderer.on("leaveEdge", () => {
    state.hoveredEdge = null;
    refreshRenderer();
  });

  renderer.on("clickNode", ({ node, event }) => {
    event.preventSigmaDefault();
    const originalEvent = event.original as MouseEvent;
    if ((originalEvent.metaKey || originalEvent.ctrlKey) && state.seedNodes.size > 0) {
      // Cmd/Ctrl+click: add to existing seed set
      if (fullGraph.hasNode(node)) {
        state.seedNodes.add(node);
        recomputeVisibleNodes();
        fitVisibleNodes();
      }
      return;
    }
    state.selectedNode = node;
    showDetailPanel(node);
    refreshRenderer();
  });

  renderer.on("clickStage", () => {
    if (!state.draggingNode) {
      state.selectedNode = null;
      hideDetailPanel();
      refreshRenderer();
    }
  });

  renderer.on("doubleClickNode", ({ node, event }) => {
    event.preventSigmaDefault();
    expandNode(node);
  });

  renderer.on("rightClickNode", ({ node, event }) => {
    event.preventSigmaDefault();
    if (state.graph.getNodeAttribute(node, "fixed")) {
      state.graph.setNodeAttribute(node, "fixed", false);
      if (fullGraph.hasNode(node)) fullGraph.setNodeAttribute(node, "fixed", false);
      syncDraggedNode(node);
      setLayoutStatus("running");
      sendWorkerMessage({ type: "reheat" });
      refreshRenderer();
      return;
    }
    collapseNode(node);
  });

  renderer.on("downNode", ({ node, event }) => {
    event.preventSigmaDefault();
    state.draggingNode = node;
    state.graph.setNodeAttribute(node, "fixed", true);
    if (fullGraph.hasNode(node)) fullGraph.setNodeAttribute(node, "fixed", true);
    syncDraggedNode(node);
    setLayoutStatus("running");
    sendWorkerMessage({ type: "reheat" });
    refreshRenderer();
  });

  renderer.getMouseCaptor().on("mousemovebody", (event) => {
    if (!state.draggingNode || !state.renderer) return;
    const position = state.renderer.viewportToGraph({ x: event.x, y: event.y });
    state.graph.mergeNodeAttributes(state.draggingNode, {
      x: position.x,
      y: position.y,
      fixed: true,
    });
    if (fullGraph.hasNode(state.draggingNode)) {
      fullGraph.mergeNodeAttributes(state.draggingNode, {
        x: position.x,
        y: position.y,
        fixed: true,
      });
    }
    syncDraggedNode(state.draggingNode, position.x, position.y, true);
    refreshRenderer([state.draggingNode]);
  });

  renderer.getMouseCaptor().on("mouseup", () => {
    if (!state.draggingNode) return;
    syncDraggedNode(state.draggingNode);
    state.draggingNode = null;
    setLayoutStatus("running");
    sendWorkerMessage({ type: "reheat" });
    refreshRenderer();
  });

  state.renderer = renderer;
}

function refreshRenderer(nodes?: string[], skipStatusUpdate = false): void {
  if (!state.renderer) return;
  if (nodes?.length) {
    state.renderer.refresh({ partialGraph: { nodes }, skipIndexation: true });
  } else {
    state.renderer.refresh({ skipIndexation: true });
  }
  if (!skipStatusUpdate) updateStatusBar();
}

function fitVisibleNodes(): void {
  if (!state.renderer || state.visibleNodes.size === 0) return;
  // Sigma normalizes graph coords to a [0,1] box internally — the camera operates
  // in that normalized space, NOT raw graph coords. animatedReset() resets to
  // (0.5, 0.5, 1) which fits the entire graph (which is just visible nodes).
  state.renderer.getCamera().animatedReset({ duration: 300 });
}

function buildNeighborhood(seeds: string | string[], depth: number): Set<string> {
  const seedArray = Array.isArray(seeds) ? seeds : [seeds];
  const visible = new Set<string>(seedArray.filter((id) => fullGraph.hasNode(id)));
  const queue: Array<{ node: string; depth: number }> = seedArray
    .filter((id) => fullGraph.hasNode(id))
    .map((id) => ({ node: id, depth: 0 }));
  while (queue.length) {
    const current = queue.shift()!;
    if (current.depth >= depth) continue;
    fullGraph.forEachEdge(current.node, (_edge, attrs, source, target) => {
      if (!state.activeEdgeTypes.has(attrs.edgeType)) return;
      const neighbor = source === current.node ? target : source;
      if (visible.has(neighbor)) return;
      visible.add(neighbor);
      queue.push({ node: neighbor, depth: current.depth + 1 });
    });
  }
  return visible;
}

function recomputeVisibleNodes(): void {
  if (!state.seedNode) {
    state.visibleNodes = new Set<string>();
    state.highlightedNodes.clear();
    state.pivotTag = null;
    state.lastExpandedNode = null;
    setChromeVisible(false);
    syncVisibleGraph();
    updateUrlState();
    renderEdgeLegend();
    updateStatusBar();
    stopLayoutWorker();
    refreshRenderer();
    return;
  }

  const seeds = state.seedNodes.size > 0 ? [...state.seedNodes] : [state.seedNode];
  const nextVisible = buildNeighborhood(seeds, state.depth);
  for (const expanded of state.manuallyExpanded) {
    if (!fullGraph.hasNode(expanded)) continue;
    nextVisible.add(expanded);
    for (const neighbor of fullGraph.neighbors(expanded)) nextVisible.add(neighbor);
  }
  for (const nodeId of state.highlightedNodes) {
    if (fullGraph.hasNode(nodeId)) nextVisible.add(nodeId);
  }

  const isolatedAllowed = new Set<string>(state.seedNodes.size > 0 ? [...state.seedNodes] : [state.seedNode]);
  for (const nodeId of state.highlightedNodes) isolatedAllowed.add(nodeId);
  state.visibleNodes = pruneDisconnectedVisibleNodes(nextVisible, isolatedAllowed);
  setChromeVisible(true);
  syncVisibleGraph();
  updateUrlState();
  renderEdgeLegend();
  updateStatusBar();
  updateSeedFocus(state.seedNode);
  updateCommunityPressure();
  updateStructuralReadout();
  applySelectedLayout();
  refreshRenderer();
}

function seedFullGraph(): void {
  const allNodes = fullGraph.nodes();
  if (allNodes.length === 0) return;

  // For very large graphs (>500 nodes), warn the user
  if (allNodes.length > 500) {
    const confirmed = window.confirm(
      `The full graph has ${allNodes.length.toLocaleString()} nodes.\n\nRendering all of them may be slow. Continue?`,
    );
    if (!confirmed) return;
  }

  // Make ALL nodes visible (no seed-based BFS — just show everything)
  state.seedNodes = new Set(allNodes);
  state.seedNode = allNodes[0];
  state.manuallyExpanded.clear();
  state.highlightedNodes.clear();
  state.pivotTag = null;
  state.lastExpandedNode = null;
  state.visibleNodes = new Set(allNodes);
  setChromeVisible(true);
  syncVisibleGraph();
  updateUrlState();
  renderEdgeLegend();
  updateStatusBar();
  updateSeedFocus(state.seedNode);
  updateCommunityPressure();
  updateStructuralReadout();
  updateTrail("__full__", "Full graph", 0);
  applySelectedLayout();
  refreshRenderer();
  fitVisibleNodes();
}

function seedMultipleNodes(ids: string[]): void {
  const valid = ids.filter((id) => fullGraph.hasNode(id));
  if (valid.length === 0) return;
  state.seedNodes = new Set(valid);
  state.seedNode = valid[0];
  state.manuallyExpanded.clear();
  state.highlightedNodes.clear();
  state.pivotTag = null;
  state.lastExpandedNode = null;
  updateTrail("__multi__", `Multi-seed: ${valid.length} notes`, 0);
  recomputeVisibleNodes();
  fitVisibleNodes();
}

function seedNode(nodeId: string): void {
  if (!fullGraph.hasNode(nodeId)) return;
  state.seedNodes = new Set([nodeId]);
  state.seedNode = nodeId;
  state.manuallyExpanded.clear();
  state.highlightedNodes.clear();
  state.pivotTag = null;
  state.lastExpandedNode = null;
  state.selectedNode = nodeId;
  updateTrail(nodeId, fullGraph.getNodeAttribute(nodeId, "title"), state.depth);
  recomputeVisibleNodes();
  showDetailPanel(nodeId);
  fitVisibleNodes();
  // Re-fit once the worker converges — handled by worker onmessage now.
}

function expandNode(nodeId: string): void {
  if (!state.seedNode || !fullGraph.hasNode(nodeId)) return;
  const degree = fullGraph.degree(nodeId);
  if (degree > 100) {
    // Require explicit confirmation before flooding the view with 100+ nodes
    const title = fullGraph.getNodeAttribute(nodeId, "title");
    const confirmed = window.confirm(
      `"${title}" has ${degree} neighbors.\n\nAdding this many nodes may slow layout. Continue?`,
    );
    if (!confirmed) {
      elements.statusSummary.textContent = `Skipped expand — ${title} has ${degree} neighbors.`;
      return;
    }
  }
  state.manuallyExpanded.add(nodeId);
  state.lastExpandedNode = nodeId;
  const title = fullGraph.getNodeAttribute(nodeId, "title");
  recomputeVisibleNodes();
  fitVisibleNodes();
  elements.statusSummary.textContent = `Expanded ${title}`;
}

function collapseNode(nodeId: string): void {
  if (!state.seedNode) return;

  // If collapsing a seed node, remove it from seedNodes and rebuild
  if (state.seedNodes.has(nodeId)) {
    state.seedNodes.delete(nodeId);
    if (state.seedNodes.size === 0) {
      // All seeds removed — return to empty state
      state.seedNode = null;
      state.manuallyExpanded.clear();
      state.selectedNode = null;
      hideDetailPanel();
      recomputeVisibleNodes();
      return;
    }
    // Update primary seed to first remaining seed
    state.seedNode = [...state.seedNodes][0];
    state.manuallyExpanded.clear();
    if (state.selectedNode === nodeId) {
      state.selectedNode = null;
      hideDetailPanel();
    }
    recomputeVisibleNodes();
    return;
  }

  state.manuallyExpanded.delete(nodeId);
  state.visibleNodes.delete(nodeId);

  // Compute the baseline neighborhood ONCE outside the loop — the previous
  // implementation recomputed BFS for every candidate on every pass, which
  // degraded to O(N²·E) and froze the UI on dense graphs.
  const seeds = state.seedNodes.size > 0 ? [...state.seedNodes] : [state.seedNode];
  const baseline = buildNeighborhood(seeds, state.depth);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of [...state.visibleNodes]) {
      if (state.seedNodes.has(candidate)) continue;
      if (state.manuallyExpanded.has(candidate)) continue;
      if (baseline.has(candidate)) continue;
      const hasVisibleNeighbor = fullGraph.neighbors(candidate).some((neighbor) => state.visibleNodes.has(neighbor));
      if (!hasVisibleNeighbor) {
        state.visibleNodes.delete(candidate);
        changed = true;
      }
    }
  }

  if (state.selectedNode === nodeId) {
    state.selectedNode = null;
    hideDetailPanel();
  }

  syncVisibleGraph();
  updateUrlState();
  renderEdgeLegend();
  updateStatusBar();
  applySelectedLayout();
  refreshRenderer();
}

function syncDraggedNode(nodeId: string, x?: number, y?: number, fixed?: boolean): void {
  const index = state.layoutNodeIndex.get(nodeId);
  if (index === undefined) return;
  sendWorkerMessage({
    type: "sync",
    updates: [
      {
        index,
        x: x ?? state.graph.getNodeAttribute(nodeId, "x"),
        y: y ?? state.graph.getNodeAttribute(nodeId, "y"),
        fixed: fixed ?? state.graph.getNodeAttribute(nodeId, "fixed"),
      },
    ],
  });
}

function stopLayoutWorker(): void {
  if (state.layoutWorker) {
    state.layoutWorker.terminate();
    state.layoutWorker = null;
  }
  state.layoutNodeOrder = [];
  state.layoutNodeIndex.clear();
  setLayoutStatus("idle", 0);
}

function sendWorkerMessage(message: WorkerMessage): void {
  state.layoutWorker?.postMessage(message);
}

function rebuildLayoutWorker(): void {
  stopLayoutWorker();
  if (state.visibleNodes.size === 0) return;

  const visibleNodeOrder = [...state.visibleNodes];
  const visibleIndex = new Map<string, number>();
  visibleNodeOrder.forEach((node, index) => visibleIndex.set(node, index));

  const layoutNodes: LayoutNodeInput[] = visibleNodeOrder.map((node) => ({
    x: state.graph.getNodeAttribute(node, "x"),
    y: state.graph.getNodeAttribute(node, "y"),
    size: state.graph.getNodeAttribute(node, "size"),
    fixed: state.graph.getNodeAttribute(node, "fixed"),
  }));

  const layoutEdges: LayoutEdgeInput[] = [];
  const seenEdges = new Set<string>();
  for (const node of visibleNodeOrder) {
    state.graph.forEachEdge(node, (edge, attrs, source, target) => {
      if (seenEdges.has(edge)) return;
      seenEdges.add(edge);
      if (!state.activeEdgeTypes.has(attrs.edgeType)) return;
      const sourceIndex = visibleIndex.get(source);
      const targetIndex = visibleIndex.get(target);
      if (sourceIndex === undefined || targetIndex === undefined) return;
      layoutEdges.push({ source: sourceIndex, target: targetIndex, weight: attrs.weight });
    });
  }

  const worker = new Worker("/dist/fa3-worker.js", { type: "module" });
  state.layoutWorker = worker;
  state.layoutNodeOrder = visibleNodeOrder;
  state.layoutNodeIndex = visibleIndex;
  setLayoutStatus("running");

  // Capture identity in closure — if a later rebuild swaps out state.layoutWorker,
  // stale messages from the old worker must be ignored. Without this guard,
  // the old worker's position indices (which reference the OLD visibleNodeOrder)
  // get applied to the NEW state.layoutNodeOrder, scattering positions.
  const myOrder = visibleNodeOrder;
  worker.onmessage = (rawEvent: MessageEvent<WorkerResultMessage>) => {
    if (state.layoutWorker !== worker) return; // stale — new worker has taken over
    const event = rawEvent.data;
    if (event.type !== "positions") return;
    const positions = event.positions;
    for (let index = 0; index < myOrder.length; index++) {
      const nodeId = myOrder[index];
      if (state.draggingNode === nodeId) continue;
      const x = positions[index * 2];
      const y = positions[index * 2 + 1];
      // Update both graphs so reseeding/expanding picks up the new positions
      if (state.graph.hasNode(nodeId)) state.graph.mergeNodeAttributes(nodeId, { x, y });
      if (fullGraph.hasNode(nodeId)) fullGraph.mergeNodeAttributes(nodeId, { x, y });
    }
    setLayoutStatus(event.settled ? "settled" : "running", event.energy);
    refreshRenderer(myOrder, true);
    // Final fit once the first converged message arrives — the setTimeout
    // fits in seedNode() are wishful; this is deterministic.
    if (event.settled && !event.capped) {
      fitVisibleNodes();
    }
  };

  worker.postMessage({
    type: "init",
    nodes: layoutNodes,
    edges: layoutEdges,
  } satisfies WorkerInitMessage);
}

function applyCircularLayout(): void {
  stopLayoutWorker();
  const nodeIds = [...state.visibleNodes];
  const N = nodeIds.length;
  if (N === 0) return;

  // Sort by clusterId ascending (nulls last), then degree descending
  nodeIds.sort((a, b) => {
    const ca = fullGraph.hasNode(a) ? fullGraph.getNodeAttribute(a, "clusterId") : null;
    const cb = fullGraph.hasNode(b) ? fullGraph.getNodeAttribute(b, "clusterId") : null;
    if (ca === null && cb === null) return 0;
    if (ca === null) return 1;
    if (cb === null) return -1;
    if (ca !== cb) return ca - cb;
    const da = state.graph.hasNode(a) ? state.graph.degree(a) : 0;
    const db = state.graph.hasNode(b) ? state.graph.degree(b) : 0;
    return db - da;
  });

  const R = Math.max(100, N * 3);
  for (let i = 0; i < N; i++) {
    const nodeId = nodeIds[i];
    const angle = (2 * Math.PI * i) / N;
    const x = R * Math.cos(angle);
    const y = R * Math.sin(angle);
    if (state.graph.hasNode(nodeId)) state.graph.mergeNodeAttributes(nodeId, { x, y });
    if (fullGraph.hasNode(nodeId)) fullGraph.mergeNodeAttributes(nodeId, { x, y });
  }

  refreshRenderer();
  fitVisibleNodes();
  setLayoutStatus("idle");
}

function applyRandomLayout(): void {
  stopLayoutWorker();
  const nodeIds = [...state.visibleNodes];
  for (const nodeId of nodeIds) {
    const x = (Math.random() - 0.5) * 400;
    const y = (Math.random() - 0.5) * 400;
    if (state.graph.hasNode(nodeId)) state.graph.mergeNodeAttributes(nodeId, { x, y });
    if (fullGraph.hasNode(nodeId)) fullGraph.mergeNodeAttributes(nodeId, { x, y });
  }

  refreshRenderer();
  fitVisibleNodes();
  setLayoutStatus("idle");
}

function applyFruchtermanReingold(): void {
  stopLayoutWorker();
  const nodeIds = [...state.visibleNodes].filter((n) => state.graph.hasNode(n));
  const N = nodeIds.length;
  if (N === 0) return;

  const area = N * 100;
  const k = Math.sqrt(area / N);
  const iterations = 50;
  let temperature = N * 0.1;
  const cooling = temperature / (iterations + 1);

  // Initialize from current positions
  const pos = new Map<string, { x: number; y: number }>();
  for (const id of nodeIds) {
    pos.set(id, { x: state.graph.getNodeAttribute(id, "x"), y: state.graph.getNodeAttribute(id, "y") });
  }

  for (let iter = 0; iter < iterations; iter++) {
    // Repulsive forces between all pairs
    const disp = new Map<string, { dx: number; dy: number }>();
    for (const id of nodeIds) disp.set(id, { dx: 0, dy: 0 });

    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const pi = pos.get(nodeIds[i])!;
        const pj = pos.get(nodeIds[j])!;
        let dx = pi.x - pj.x;
        let dy = pi.y - pj.y;
        const dist = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
        const force = (k * k) / dist;
        dx = (dx / dist) * force;
        dy = (dy / dist) * force;
        disp.get(nodeIds[i])!.dx += dx;
        disp.get(nodeIds[i])!.dy += dy;
        disp.get(nodeIds[j])!.dx -= dx;
        disp.get(nodeIds[j])!.dy -= dy;
      }
    }

    // Attractive forces along edges
    state.graph.forEachEdge((_edge, _attrs, source, target) => {
      const ps = pos.get(source);
      const pt = pos.get(target);
      if (!ps || !pt) return;
      const dx = ps.x - pt.x;
      const dy = ps.y - pt.y;
      const dist = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      disp.get(source)!.dx -= fx;
      disp.get(source)!.dy -= fy;
      disp.get(target)!.dx += fx;
      disp.get(target)!.dy += fy;
    });

    // Apply displacements clamped by temperature
    for (const id of nodeIds) {
      const d = disp.get(id)!;
      const dist = Math.max(0.01, Math.sqrt(d.dx * d.dx + d.dy * d.dy));
      const p = pos.get(id)!;
      p.x += (d.dx / dist) * Math.min(dist, temperature);
      p.y += (d.dy / dist) * Math.min(dist, temperature);
    }
    temperature -= cooling;
  }

  for (const id of nodeIds) {
    const p = pos.get(id)!;
    state.graph.mergeNodeAttributes(id, { x: p.x, y: p.y });
    if (fullGraph.hasNode(id)) fullGraph.mergeNodeAttributes(id, { x: p.x, y: p.y });
  }

  refreshRenderer();
  fitVisibleNodes();
  setLayoutStatus("idle");
}

function applyGridLayout(): void {
  stopLayoutWorker();
  const nodeIds = [...state.visibleNodes].filter((n) => state.graph.hasNode(n));
  const N = nodeIds.length;
  if (N === 0) return;

  // Sort by type then degree descending
  nodeIds.sort((a, b) => {
    const ta = fullGraph.hasNode(a) ? fullGraph.getNodeAttribute(a, "nodeType") : "";
    const tb = fullGraph.hasNode(b) ? fullGraph.getNodeAttribute(b, "nodeType") : "";
    if (ta !== tb) return ta.localeCompare(tb);
    const da = state.graph.hasNode(a) ? state.graph.degree(a) : 0;
    const db = state.graph.hasNode(b) ? state.graph.degree(b) : 0;
    return db - da;
  });

  const cols = Math.ceil(Math.sqrt(N));
  const spacing = 30;
  for (let i = 0; i < N; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * spacing - (cols * spacing) / 2;
    const y = row * spacing - (Math.ceil(N / cols) * spacing) / 2;
    if (state.graph.hasNode(nodeIds[i])) state.graph.mergeNodeAttributes(nodeIds[i], { x, y });
    if (fullGraph.hasNode(nodeIds[i])) fullGraph.mergeNodeAttributes(nodeIds[i], { x, y });
  }

  refreshRenderer();
  fitVisibleNodes();
  setLayoutStatus("idle");
}

function applyConcentricLayout(): void {
  stopLayoutWorker();
  const nodeIds = [...state.visibleNodes].filter((n) => state.graph.hasNode(n));
  const N = nodeIds.length;
  if (N === 0) return;

  // Sort by degree descending — highest degree at center
  nodeIds.sort((a, b) => {
    const da = state.graph.hasNode(a) ? state.graph.degree(a) : 0;
    const db = state.graph.hasNode(b) ? state.graph.degree(b) : 0;
    return db - da;
  });

  // Place in concentric rings — ring 0 has 1 node, ring 1 has 6, ring 2 has 12, etc.
  let placed = 0;
  let ring = 0;
  const ringSpacing = 40;
  while (placed < N) {
    const nodesInRing = ring === 0 ? 1 : ring * 6;
    const r = ring * ringSpacing;
    for (let i = 0; i < nodesInRing && placed < N; i++) {
      const angle = (2 * Math.PI * i) / nodesInRing;
      const x = r * Math.cos(angle);
      const y = r * Math.sin(angle);
      if (state.graph.hasNode(nodeIds[placed])) state.graph.mergeNodeAttributes(nodeIds[placed], { x, y });
      if (fullGraph.hasNode(nodeIds[placed])) fullGraph.mergeNodeAttributes(nodeIds[placed], { x, y });
      placed++;
    }
    ring++;
  }

  refreshRenderer();
  fitVisibleNodes();
  setLayoutStatus("idle");
}

function applyNoverlap(): void {
  stopLayoutWorker();
  // Post-processing: push apart overlapping nodes based on their rendered size
  const nodeIds = [...state.visibleNodes].filter((n) => state.graph.hasNode(n));
  const N = nodeIds.length;
  if (N < 2) return;

  const margin = 10;
  const maxIterations = 120;

  for (let iter = 0; iter < maxIterations; iter++) {
    let moved = false;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const ai = nodeIds[i];
        const aj = nodeIds[j];
        if (state.graph.getNodeAttribute(ai, "fixed") && state.graph.getNodeAttribute(aj, "fixed")) continue;
        const xi = state.graph.getNodeAttribute(ai, "x");
        const yi = state.graph.getNodeAttribute(ai, "y");
        const si = (state.graph.getNodeAttribute(ai, "size") * 2.1) + margin;
        const xj = state.graph.getNodeAttribute(aj, "x");
        const yj = state.graph.getNodeAttribute(aj, "y");
        const sj = (state.graph.getNodeAttribute(aj, "size") * 2.1) + margin;

        const dx = xj - xi;
        const dy = yj - yi;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const minDist = si + sj;

        if (dist < minDist) {
          const overlap = ((minDist - dist) / 2) + 0.5;
          const nx = (dx / dist) * overlap;
          const ny = (dy / dist) * overlap;
          const aiFixed = state.graph.getNodeAttribute(ai, "fixed");
          const ajFixed = state.graph.getNodeAttribute(aj, "fixed");
          const nextAi = aiFixed ? { x: xi, y: yi } : { x: xi - nx, y: yi - ny };
          const nextAj = ajFixed ? { x: xj, y: yj } : { x: xj + nx, y: yj + ny };
          state.graph.mergeNodeAttributes(ai, nextAi);
          state.graph.mergeNodeAttributes(aj, nextAj);
          if (fullGraph.hasNode(ai)) fullGraph.mergeNodeAttributes(ai, nextAi);
          if (fullGraph.hasNode(aj)) fullGraph.mergeNodeAttributes(aj, nextAj);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  refreshRenderer();
  fitVisibleNodes();
  setLayoutStatus("idle");
}

function applySelectedLayout(): void {
  switch (state.layoutAlgorithm) {
    case "fa3": rebuildLayoutWorker(); break;
    case "circular": applyCircularLayout(); break;
    case "random": applyRandomLayout(); break;
    case "fruchterman": applyFruchtermanReingold(); break;
    case "grid": applyGridLayout(); break;
    case "concentric": applyConcentricLayout(); break;
    case "noverlap": applyNoverlap(); break;
  }
}

function updateDockVisibility(): void {
  const isVisible = !!state.seedNode && state.activeView === "graph";
  elements.bottomDock.classList.toggle("hidden", !isVisible);
}

function computeEdgeLegendCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const type of state.meta?.edgeTypes ?? []) counts.set(type, 0);

  fullGraph.forEachEdge((_edge, attrs, source, target) => {
    const type = attrs.edgeType;
    if (!counts.has(type)) counts.set(type, 0);
    if (state.visibleNodes.size > 0 && (!state.visibleNodes.has(source) || !state.visibleNodes.has(target))) {
      return;
    }
    counts.set(type, (counts.get(type) ?? 0) + 1);
  });

  return counts;
}

function toggleEdgeType(type: string): void {
  if (state.activeEdgeTypes.has(type)) state.activeEdgeTypes.delete(type);
  else state.activeEdgeTypes.add(type);
  renderEdgeLegend();
  if (state.seedNode) recomputeVisibleNodes();
  else refreshRenderer();
}

function renderEdgeLegend(): void {
  if (!state.meta) return;
  const counts = computeEdgeLegendCounts();
  const activeTotal = [...counts.entries()]
    .filter(([type]) => state.activeEdgeTypes.has(type))
    .reduce((sum, [, count]) => sum + count, 0);

  const activeTypes = state.meta.edgeTypes.filter((type) => state.activeEdgeTypes.has(type));
  elements.dockBlurb.textContent = `${activeTypes.length} types, ${activeTotal.toLocaleString()} edges`;
  elements.dockLegendGrid.innerHTML = "";

  for (const type of state.meta.edgeTypes) {
    const isActive = state.activeEdgeTypes.has(type);
    const label = EDGE_LABELS[type] ?? type;
    const item = document.createElement("button");
    item.type = "button";
    item.className = `edge-legend-item ${isActive ? "active" : ""}`;
    item.dataset.edgeType = type;
    item.setAttribute("aria-pressed", String(isActive));
    item.style.setProperty("--edge-color", edgeColor(type));
    item.style.borderColor = withAlpha(edgeColor(type), isActive ? 0.54 : 0.18);
    item.title = `${label}: ${(counts.get(type) ?? 0).toLocaleString()} visible edges`;
    item.innerHTML = [
      `<span class="edge-legend-swatch" aria-hidden="true"></span>`,
      `<span class="edge-legend-label">${escapeHtml(label)}</span>`,
      `<span class="edge-legend-count">${(counts.get(type) ?? 0).toLocaleString()}</span>`,
    ].join("");
    item.addEventListener("click", () => toggleEdgeType(type));
    elements.dockLegendGrid.appendChild(item);
  }
  const topThree = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  elements.dockKpis.innerHTML = topThree.map(([type, count]) => `
    <span class="dock-kpi" title="${escapeHtml(EDGE_LABELS[type] ?? type)}">
      <span>${escapeHtml(EDGE_LABELS[type] ?? type)}</span>
      <span>${count.toLocaleString()}</span>
    </span>
  `).join("");
}

let searchAbortController: AbortController | null = null;

async function searchNotes(query: string): Promise<void> {
  if (!query.trim()) {
    state.searchResults = [];
    state.searchIndex = -1;
    renderSearchResults();
    return;
  }
  // Cancel previous in-flight search so the newest query wins the race
  if (searchAbortController) searchAbortController.abort();
  const controller = new AbortController();
  searchAbortController = controller;
  try {
    const response = await fetch(
      apiUrl(`/api/search?q=${encodeURIComponent(query.trim())}`),
      { ...apiFetchInit(), signal: controller.signal },
    );
    if (searchAbortController !== controller) return;
    const data = (await response.json()) as SearchResponse;
    state.searchResults = data.results;
    state.searchTotalCount = data.totalCount ?? data.results.length;
    state.searchIndex = state.searchResults.length ? 0 : -1;
    renderSearchResults();
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      state.searchResults = [];
      state.searchIndex = -1;
      renderSearchResults();
    }
  } finally {
    if (searchAbortController === controller) searchAbortController = null;
  }
}

function renderSearchResults(): void {
  elements.searchResults.innerHTML = "";
  state.searchResults.forEach((id, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `search-result ${index === state.searchIndex ? "selected" : ""}`;
    button.dataset.id = id;
    const title = fullGraph.hasNode(id) ? fullGraph.getNodeAttribute(id, "title") : id;
    const folder = fullGraph.hasNode(id) ? fullGraph.getNodeAttribute(id, "folder") : "";
    button.innerHTML = `
      <div class="search-result-title">${escapeHtml(title)}</div>
      <div class="search-result-path">${escapeHtml(folder || "/")}</div>
    `;
    button.addEventListener("click", (e) => {
      if (e.shiftKey && state.seedNodes.size > 0) {
        // Shift-click: add to existing seed set
        if (fullGraph.hasNode(id)) {
          state.seedNodes.add(id);
          recomputeVisibleNodes();
          fitVisibleNodes();
        }
        closeSearch();
      } else {
        closeSearch();
        seedNode(id);
      }
    });
    elements.searchResults.appendChild(button);
  });

  // "Seed all N results" button — only shown when there are multiple results
  if (state.searchResults.length > 1) {
    const seedAllBtn = document.createElement("button");
    seedAllBtn.type = "button";
    seedAllBtn.className = "search-seed-all";
    seedAllBtn.textContent = state.searchTotalCount > state.searchResults.length
      ? `Seed top ${state.searchResults.length} of ${state.searchTotalCount} results`
      : `Seed all ${state.searchResults.length} results`;
    const allIds = [...state.searchResults];
    seedAllBtn.addEventListener("click", () => {
      closeSearch();
      seedMultipleNodes(allIds);
    });
    elements.searchResults.appendChild(seedAllBtn);
  }
}

function openSearch(): void {
  elements.searchInput.value = "";
  state.searchResults = [];
  state.searchIndex = -1;
  renderSearchResults();
  elements.searchModal.classList.remove("hidden");
  elements.searchModal.setAttribute("aria-hidden", "false");
  queueMicrotask(() => elements.searchInput.focus());
}

function closeSearch(): void {
  elements.searchModal.classList.add("hidden");
  elements.searchModal.setAttribute("aria-hidden", "true");
  elements.searchInput.value = "";
  state.searchResults = [];
  state.searchIndex = -1;
  renderSearchResults();
}

// Abort controller for in-flight note fetch — prevents stale fetch responses
// from clobbering the panel after the user clicks a different node or closes it.
let detailFetchController: AbortController | null = null;

function setInspectorTab(tab: InspectorTab): void {
  state.activeInspectorTab = tab;
  elements.inspectorTabs.forEach((button) => {
    const isActive = button.dataset.inspectorTab === tab;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
    if (isActive) elements.detailBody.setAttribute("aria-labelledby", button.id);
  });
  // Show detail-meta and detail-actions only on the Note tab;
  // other tabs render their own content into detail-body
  const isNoteTab = tab === "note";
  elements.detailMeta.style.display = isNoteTab ? "" : "none";
  const actionsEl = document.getElementById("detail-actions");
  if (actionsEl) actionsEl.style.display = isNoteTab ? "" : "none";
  renderInspectorTab();
}

function renderInspectorTab(): void {
  switch (state.activeInspectorTab) {
    case "neighbors":
      renderNeighborsTab();
      return;
    case "bridges":
      renderBridgesTab();
      return;
    case "hubs":
      renderHubsTab();
      return;
    case "note":
    default:
      renderNoteTab();
  }
}

function prepareWikilinks(markdown: string): string {
  return markdown.replace(/\[\[([^\]\|\n]+?)(?:\|([^\]\n]+?))?\]\]/g, (_match, target: string, label?: string) => {
    const normalizedTarget = target.trim();
    const normalizedLabel = (label ?? target).trim();
    if (!normalizedTarget) return _match;
    return `<a href="[[${escapeHtml(normalizedTarget)}]]">${escapeHtml(normalizedLabel || normalizedTarget)}</a>`;
  });
}

function resolveWikilinkTarget(rawTarget: string): string | null {
  const target = rawTarget.trim().replace(/^#*/, "");
  if (!target) return null;
  const candidates = new Set<string>([
    target,
    `${target}.md`,
    target.replace(/\.md$/i, ""),
  ]);
  for (const candidate of candidates) {
    if (fullGraph.hasNode(candidate)) return candidate;
  }

  const normalized = target.replace(/\.md$/i, "").toLowerCase();
  let match: string | null = null;
  fullGraph.forEachNode((nodeId, attrs) => {
    if (match) return;
    const title = attrs.title.replace(/\.md$/i, "").toLowerCase();
    const label = formatNodeLabel(attrs.title, nodeId).toLowerCase();
    const pathStem = nodeId.replace(/\.md$/i, "").toLowerCase();
    if (title === normalized || label === normalized || pathStem.endsWith(`/${normalized}`)) {
      match = nodeId;
    }
  });
  return match;
}

function wikilinkHandler(anchor: HTMLAnchorElement): void {
  anchor.classList.add("note-wikilink");
  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    const target = href.replace(/^\[\[/, "").replace(/\]\]$/, "");
    const nodeId = resolveWikilinkTarget(target);
    if (nodeId) seedNode(nodeId);
  });
}

function renderNoteTab(): void {
  const md = state.currentNoteMarkdown;
  if (md === null) {
    elements.detailBody.innerHTML = `<div class="detail-empty-state">Loading note…</div>`;
    return;
  }
  if (md === "") {
    elements.detailBody.innerHTML = `<div class="detail-empty-state">This note is empty.</div>`;
    return;
  }
  const html = marked.parse(prepareWikilinks(md), { breaks: true, gfm: true, async: false }) as string;
  elements.detailBody.innerHTML = html;
  elements.detailBody.querySelectorAll<HTMLAnchorElement>("a[href^='[[']").forEach(wikilinkHandler);
}

function buildNodeNeighbors(nodeId: string): NodeNeighbors {
  const grouped = new Map<string, NeighborRow[]>();
  fullGraph.forEachEdge(nodeId, (_edge, attrs, source, target) => {
    const neighborId = source === nodeId ? target : target === nodeId ? source : null;
    if (!neighborId || !fullGraph.hasNode(neighborId)) return;
    const neighborAttrs = fullGraph.getNodeAttributes(neighborId);
    const direction: NeighborRow["direction"] = source === nodeId
      ? "outgoing"
      : target === nodeId
        ? "incoming"
        : "undirected";
    const row: NeighborRow = {
      id: neighborId,
      title: neighborAttrs.title,
      direction,
      edgeType: attrs.edgeType,
      weight: attrs.weight,
      pagerank: neighborAttrs.pagerank,
      pagerankRank: state.pagerankRanks.get(neighborId) ?? null,
    };
    if (!grouped.has(attrs.edgeType)) grouped.set(attrs.edgeType, []);
    grouped.get(attrs.edgeType)?.push(row);
  });

  const groups = [...grouped.entries()]
    .map(([edgeType, rows]) => ({
      edgeType,
      rows: rows.sort((a, b) => {
        const aRank = a.pagerankRank ?? Number.POSITIVE_INFINITY;
        const bRank = b.pagerankRank ?? Number.POSITIVE_INFINITY;
        return aRank - bRank || a.title.localeCompare(b.title);
      }),
    }))
    .sort((a, b) => (EDGE_LABELS[a.edgeType] ?? a.edgeType).localeCompare(EDGE_LABELS[b.edgeType] ?? b.edgeType));

  return { nodeId, groups };
}

function pagerankPercent(pagerank: number | null): number {
  if (pagerank == null || state.maxPageRank <= 0) return 0;
  return clamp((pagerank / state.maxPageRank) * 100, 0, 100);
}

function renderPagerankBar(pagerank: number | null): string {
  const width = pagerankPercent(pagerank);
  const value = pagerank != null ? pagerank.toFixed(6) : "—";
  return `
    <span class="pagerank-bar" aria-label="PageRank ${escapeHtml(value)}">
      <span class="pagerank-bar-fill" style="width:${width.toFixed(2)}%"></span>
    </span>
    <span class="pagerank-value mono">${escapeHtml(value)}</span>
  `;
}

function renderNodeRow(row: NeighborRow | { id: string; title: string; folder: string; pagerank: number | null; pagerankRank: number | null }): string {
  const attrs = fullGraph.getNodeAttributes(row.id);
  const folder = "folder" in row ? row.folder : attrs.folder;
  const direction = "direction" in row ? `<span class="detail-row-direction">${row.direction}</span>` : "";
  const rank = row.pagerankRank != null ? `#${row.pagerankRank}` : "—";
  return `
    <button type="button" class="detail-data-row" data-node-jump="${escapeHtml(row.id)}">
      <span class="detail-row-main">
        <span class="detail-row-title">${escapeHtml(row.title)}</span>
        <span class="detail-row-subtitle">${escapeHtml(folder || "/")}</span>
      </span>
      ${direction}
      <span class="detail-row-rank mono">${escapeHtml(rank)}</span>
      <span class="detail-row-pagerank">${renderPagerankBar(row.pagerank)}</span>
    </button>
  `;
}

function bindDetailNodeRows(): void {
  elements.detailBody.querySelectorAll<HTMLButtonElement>("[data-node-jump]").forEach((button) => {
    button.addEventListener("click", () => {
      const nodeId = button.dataset.nodeJump;
      if (nodeId) seedNode(nodeId);
    });
  });
}

function renderNeighborsTab(): void {
  const neighbors = state.currentNodeNeighbors;
  if (!neighbors || neighbors.groups.length === 0) {
    elements.detailBody.innerHTML = `<div class="detail-empty-state">No neighbors found for this note.</div>`;
    return;
  }

  elements.detailBody.innerHTML = neighbors.groups.map((group) => `
    <section class="detail-section detail-data-section">
      <div class="detail-section-title">${escapeHtml(EDGE_LABELS[group.edgeType] ?? group.edgeType)}</div>
      <div class="detail-data-list">
        ${group.rows.map(renderNodeRow).join("")}
      </div>
    </section>
  `).join("");
  bindDetailNodeRows();
}

function renderBridgesTab(): void {
  const nodeId = state.focusedInspectorNode;
  if (!nodeId || !fullGraph.hasNode(nodeId)) {
    elements.detailBody.innerHTML = `<div class="detail-empty-state">Select a node to see bridge analysis.</div>`;
    return;
  }

  // Find bridge nodes: nodes that connect otherwise-disconnected clusters
  // in the selected node's neighborhood. A bridge node is one whose removal
  // would increase the number of connected components among visible nodes.
  const neighbors = new Set<string>();
  fullGraph.forEachEdge(nodeId, (_edge, attrs, source, target) => {
    if (!state.activeEdgeTypes.has(attrs.edgeType)) return;
    const other = source === nodeId ? target : source;
    if (fullGraph.hasNode(other)) neighbors.add(other);
  });

  if (neighbors.size === 0) {
    elements.detailBody.innerHTML = `<div class="detail-empty-state">No neighbors with active edge types. Enable more edge types in the dock below.</div>`;
    return;
  }

  // Compute betweenness-like bridge score: for each neighbor, count how many
  // other neighbors it connects to (via the selected node's local neighborhood)
  const bridgeScores: Array<{ id: string; title: string; folder: string; pagerank: number | null; pagerankRank: number | null; bridgeScore: number; edgeTypes: string[] }> = [];

  for (const neighborId of neighbors) {
    const neighborAttrs = fullGraph.getNodeAttributes(neighborId);
    // How many of the OTHER neighbors does this neighbor also connect to?
    // Use a Set to count unique neighbor nodes (not edges — parallel edges between
    // the same pair would inflate the count and produce negative bridge scores)
    const crossLinkedNeighbors = new Set<string>();
    const edgeTypes = new Set<string>();
    fullGraph.forEachEdge(neighborId, (_edge, attrs, source, target) => {
      if (!state.activeEdgeTypes.has(attrs.edgeType)) return;
      const other = source === neighborId ? target : source;
      if (other !== nodeId && neighbors.has(other)) {
        crossLinkedNeighbors.add(other);
        edgeTypes.add(attrs.edgeType);
      }
    });
    // Bridge score: neighbors with fewer cross-links are more bridge-like
    // (they connect to parts of the graph that aren't otherwise connected)
    const totalNeighborDegree = fullGraph.degree(neighborId);
    const bridgeScore = totalNeighborDegree > 0 ? (1 - crossLinkedNeighbors.size / Math.max(1, neighbors.size - 1)) * totalNeighborDegree : 0;
    bridgeScores.push({
      id: neighborId,
      title: neighborAttrs.title,
      folder: neighborAttrs.folder,
      pagerank: neighborAttrs.pagerank,
      pagerankRank: state.pagerankRanks.get(neighborId) ?? null,
      bridgeScore,
      edgeTypes: [...edgeTypes],
    });
  }

  // Sort by bridge score descending, show top 20
  bridgeScores.sort((a, b) => b.bridgeScore - a.bridgeScore);
  const topBridges = bridgeScores.slice(0, 20);

  if (topBridges.length === 0) {
    elements.detailBody.innerHTML = `<div class="detail-empty-state">No bridge nodes found in this neighborhood.</div>`;
    return;
  }

  const selectedTitle = fullGraph.getNodeAttribute(nodeId, "title");
  elements.detailBody.innerHTML = `
    <section class="detail-section detail-data-section">
      <div class="detail-section-title">Bridge Nodes from "${escapeHtml(truncateLabel(selectedTitle))}"</div>
      <p class="detail-empty-state" style="margin-bottom:8px">Nodes that connect different parts of this neighborhood. Higher scores indicate stronger bridging between clusters.</p>
      <div class="detail-data-list">
        ${topBridges.map((b) => `
          <button type="button" class="detail-data-row" data-node-jump="${escapeHtml(b.id)}">
            <span class="detail-row-main">
              <span class="detail-row-title">${escapeHtml(b.title)}</span>
              <span class="detail-row-subtitle">${escapeHtml(b.folder || "/")}${b.edgeTypes.length > 0 ? ` · ${b.edgeTypes.map((t) => EDGE_LABELS[t] ?? t).join(", ")}` : ""}</span>
            </span>
            <span class="detail-row-direction" title="Bridge score">${b.bridgeScore.toFixed(1)}</span>
            <span class="detail-row-rank mono">${b.pagerankRank != null ? `#${b.pagerankRank}` : "—"}</span>
            <span class="detail-row-pagerank">${renderPagerankBar(b.pagerank)}</span>
          </button>
        `).join("")}
      </div>
    </section>
  `;
  bindDetailNodeRows();
}

function renderHubsTab(): void {
  const nodeId = state.focusedInspectorNode;

  // Section 1: Local hubs — top PageRank nodes in the visible neighborhood
  const localHubs: Array<{ id: string; title: string; folder: string; pagerank: number | null; pagerankRank: number | null }> = [];
  const visibleSet = state.visibleNodes.size > 0 ? state.visibleNodes : new Set(fullGraph.nodes());

  for (const nid of visibleSet) {
    if (!fullGraph.hasNode(nid)) continue;
    const attrs = fullGraph.getNodeAttributes(nid);
    if (attrs.pagerank == null) continue;
    localHubs.push({
      id: nid,
      title: attrs.title,
      folder: attrs.folder,
      pagerank: attrs.pagerank,
      pagerankRank: state.pagerankRanks.get(nid) ?? null,
    });
  }
  localHubs.sort((a, b) => (b.pagerank ?? 0) - (a.pagerank ?? 0));
  const topLocal = localHubs.slice(0, 15);

  // Section 2: Global hubs — top across entire graph (for context)
  const globalHubs: Array<{ id: string; title: string; folder: string; pagerank: number | null; pagerankRank: number | null }> = [];
  fullGraph.forEachNode((nid, attrs) => {
    if (attrs.pagerank == null) return;
    globalHubs.push({
      id: nid,
      title: attrs.title,
      folder: attrs.folder,
      pagerank: attrs.pagerank,
      pagerankRank: state.pagerankRanks.get(nid) ?? null,
    });
  });
  globalHubs.sort((a, b) => (b.pagerank ?? 0) - (a.pagerank ?? 0));
  const topGlobal = globalHubs.slice(0, 10);

  if (topLocal.length === 0 && topGlobal.length === 0) {
    elements.detailBody.innerHTML = `<div class="detail-empty-state">No PageRank enrichment available yet. Run the enrichment pipeline to compute centrality scores.</div>`;
    return;
  }

  const selectedTitle = nodeId && fullGraph.hasNode(nodeId) ? fullGraph.getNodeAttribute(nodeId, "title") : "";
  const localSection = topLocal.length > 0 ? `
    <section class="detail-section detail-data-section">
      <div class="detail-section-title">${state.visibleNodes.size > 0 ? "Neighborhood Hubs" : "All Hubs by PageRank"}</div>
      ${selectedTitle ? `<p class="detail-empty-state" style="margin-bottom:8px">Most central nodes in the visible graph around "${escapeHtml(truncateLabel(selectedTitle))}".</p>` : ""}
      <div class="detail-data-list">
        ${topLocal.map(renderNodeRow).join("")}
      </div>
    </section>
  ` : "";

  const globalSection = topGlobal.length > 0 && state.visibleNodes.size > 0 ? `
    <section class="detail-section detail-data-section">
      <div class="detail-section-title">Global Top Hubs</div>
      <p class="detail-empty-state" style="margin-bottom:8px">Highest PageRank across the entire vault for comparison.</p>
      <div class="detail-data-list">
        ${topGlobal.map(renderNodeRow).join("")}
      </div>
    </section>
  ` : "";

  elements.detailBody.innerHTML = localSection + globalSection;
  bindDetailNodeRows();
}

async function showDetailPanel(nodeId: string): Promise<void> {
  if (!fullGraph.hasNode(nodeId)) return;
  state.focusedInspectorNode = nodeId;
  state.activeInspectorTab = "note";
  state.currentNoteMarkdown = null;
  state.currentNodeNeighbors = buildNodeNeighbors(nodeId);
  const attrs = fullGraph.getNodeAttributes(nodeId);
  elements.detailType.textContent = attrs.nodeType;
  elements.detailTitle.textContent = attrs.title;
  const pagerankRank = state.pagerankRanks.get(nodeId);
  const pagerankMeta = attrs.pagerank != null && pagerankRank != null
    ? `#${pagerankRank} · ${formatPercentile(pagerankRank, state.pagerankRanks.size)}`
    : "—";
  const edgeTypeCounts = new Map<string, number>();
  fullGraph.forEachEdge(nodeId, (_edge, edgeAttrs) => {
    edgeTypeCounts.set(edgeAttrs.edgeType, (edgeTypeCounts.get(edgeAttrs.edgeType) ?? 0) + 1);
  });
  const edgeTypeMarkup = edgeTypeCounts.size > 0
    ? [...edgeTypeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => {
        const color = edgeColor(type);
        return `<span class="detail-chip" style="color:${escapeHtml(color)}"><span class="detail-chip-swatch"></span>${escapeHtml(EDGE_LABELS[type] ?? type)} · ${count}</span>`;
      })
      .join("")
    : `<span class="detail-list-value">No visible edge types.</span>`;
  const tagMarkup = attrs.tags.length > 0
    ? attrs.tags.map((tag) => `<button type="button" class="detail-chip" data-tag-pivot="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join("")
    : `<span class="detail-list-value">No tags</span>`;
  const frontmatterEntries = Object.entries(attrs.frontmatter ?? {}).filter(([key]) => key !== "tags");
  const frontmatterMarkup = frontmatterEntries.length > 0
    ? frontmatterEntries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => (
        `<div class="detail-list-item"><span class="detail-list-key">${escapeHtml(key)}</span><span class="detail-list-value">${escapeHtml(formatFrontmatterValue(value))}</span></div>`
      ))
      .join("")
    : `<div class="detail-list-item"><span class="detail-list-key">frontmatter</span><span class="detail-list-value">No YAML fields available.</span></div>`;
  const clusterMarkup = attrs.clusterId != null
    ? `<span class="detail-chip" style="color:${escapeHtml(communityColor(attrs.clusterId))}"><span class="detail-chip-swatch"></span>Cluster ${attrs.clusterId}</span>`
    : `<span class="detail-list-value">Unclustered</span>`;
  elements.detailMeta.innerHTML = `
    <section class="detail-section">
      <div class="detail-section-title">Overview</div>
      <div class="detail-grid">
        <div class="detail-card">
          <span class="detail-card-label">Folder</span>
          <span class="detail-card-value mono">${escapeHtml(attrs.folder || "/")}</span>
        </div>
        <div class="detail-card">
          <span class="detail-card-label">Words</span>
          <span class="detail-card-value mono">${attrs.wordCount.toLocaleString()}</span>
        </div>
        <div class="detail-card">
          <span class="detail-card-label">PageRank</span>
          <span class="detail-card-value mono">${attrs.pagerank != null ? attrs.pagerank.toFixed(6) : "—"}</span>
          <span class="detail-list-value">${escapeHtml(pagerankMeta)}</span>
        </div>
        <div class="detail-card">
          <span class="detail-card-label">Modified</span>
          <span class="detail-card-value">${escapeHtml(formatDate(attrs.modified))}</span>
        </div>
        <div class="detail-card">
          <span class="detail-card-label">Created</span>
          <span class="detail-card-value">${escapeHtml(formatDate(attrs.created))}</span>
        </div>
      </div>
    </section>
    <section class="detail-section">
      <div class="detail-section-title">Graph Signals</div>
      <div class="detail-grid">
        <div class="detail-card">
          <span class="detail-card-label">Cluster</span>
          <div class="detail-chip-row">${clusterMarkup}</div>
        </div>
        <div class="detail-card">
          <span class="detail-card-label">Degree</span>
          <span class="detail-card-value mono">${attrs.degree}</span>
        </div>
        <div class="detail-card">
          <span class="detail-card-label">Component</span>
          <span class="detail-card-value mono">${attrs.componentId ?? "—"}</span>
        </div>
        <div class="detail-card">
          <span class="detail-card-label">PageRank</span>
          <span class="detail-card-value mono">${attrs.pagerank != null ? attrs.pagerank.toFixed(6) : "0.000000"}</span>
        </div>
        <div class="detail-card">
          <span class="detail-card-label">Clustering</span>
          <span class="detail-card-value mono">${attrs.clusteringCoeff != null ? attrs.clusteringCoeff.toFixed(4) : "—"}</span>
        </div>
      </div>
    </section>
    <section class="detail-section">
      <div class="detail-section-title">Connected Edge Types</div>
      <div class="detail-chip-row">${edgeTypeMarkup}</div>
    </section>
    <section class="detail-section">
      <div class="detail-section-title">Tags</div>
      <div class="detail-chip-row">${tagMarkup}</div>
    </section>
    <section class="detail-section">
      <div class="detail-section-title">Frontmatter</div>
      <div class="detail-list">${frontmatterMarkup}</div>
    </section>
  `;
  elements.detailLink.href = buildObsidianUrl(nodeId);
  elements.detailLink.textContent = "Open in Obsidian";
  elements.detailPin.textContent = state.pinnedNodes.has(nodeId) ? "Unpin this note" : "Pin this note";
  elements.detailPin.classList.toggle("active", state.pinnedNodes.has(nodeId));
  elements.detailPanel.classList.remove("hidden");
  elements.detailPanel.setAttribute("aria-hidden", "false");
  elements.app.style.setProperty("--sidebar-right-width", "420px");
  setInspectorTab("note");

  // Cancel any previous in-flight fetch so its response can't race this one
  if (detailFetchController) detailFetchController.abort();
  const controller = new AbortController();
  detailFetchController = controller;

  try {
    const response = await fetch(
      apiUrl(`/api/note?path=${encodeURIComponent(nodeId)}`),
      { ...apiFetchInit(), signal: controller.signal },
    );
    // Bail if a newer request has taken over, or the panel closed
    if (detailFetchController !== controller) return;
    state.currentNoteMarkdown = response.ok ? await response.text() : `Failed to load note (${response.status}).`;
    renderInspectorTab();
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    if (detailFetchController === controller) {
      state.currentNoteMarkdown = "Failed to load note.";
      renderInspectorTab();
    }
  } finally {
    if (detailFetchController === controller) detailFetchController = null;
  }
}

function hideDetailPanel(): void {
  elements.detailPanel.classList.add("hidden");
  elements.detailPanel.setAttribute("aria-hidden", "true");
  elements.app.style.setProperty("--sidebar-right-width", "0px");
  state.focusedInspectorNode = null;
  state.activeInspectorTab = "note";
  state.currentNoteMarkdown = null;
  state.currentNodeNeighbors = null;
  setInspectorTab("note");
  // Abort any pending fetch so it can't write into the now-closed panel
  if (detailFetchController) {
    detailFetchController.abort();
    detailFetchController = null;
  }
}

function togglePinnedNode(nodeId: string): void {
  if (state.pinnedNodes.has(nodeId)) state.pinnedNodes.delete(nodeId);
  else state.pinnedNodes.add(nodeId);
  savePinnedNodes();
  applyPinnedStateToGraphs();
  if (state.selectedNode === nodeId) {
    elements.detailPin.textContent = state.pinnedNodes.has(nodeId) ? "Unpin this note" : "Pin this note";
    elements.detailPin.classList.toggle("active", state.pinnedNodes.has(nodeId));
  }
  refreshRenderer();
}

function resetGraphView(): void {
  state.seedNode = null;
  state.seedNodes.clear();
  state.manuallyExpanded.clear();
  state.highlightedNodes.clear();
  state.pivotTag = null;
  state.lastExpandedNode = null;
  state.selectedNode = null;
  closeFilterBar();
  hideDetailPanel();
  recomputeVisibleNodes();
}

function pivotGraphByTag(tag: string, anchorNodeId: string): void {
  const normalized = tag.trim();
  if (!normalized || !state.seedNode) return;
  const matches = new Set<string>();
  fullGraph.forEachNode((nodeId, attrs) => {
    if (attrs.tags.includes(normalized)) matches.add(nodeId);
  });
  matches.add(anchorNodeId);
  state.highlightedNodes = matches;
  state.pivotTag = normalized;
  recomputeVisibleNodes();
  if (state.graph.hasNode(anchorNodeId)) {
    state.graph.mergeNodeAttributes(anchorNodeId, { x: 0, y: 0 });
    fullGraph.mergeNodeAttributes(anchorNodeId, { x: 0, y: 0 });
  }
  fitVisibleNodes();
  refreshRenderer();
}

// ─── Filter bar ─────────────────────────────────────────────────────────────

function setFilterOverlayOpen(open: boolean): void {
  state.filterOverlayOpen = open;
  elements.filterOverlay.classList.toggle("hidden", !open);
  elements.filterOverlay.setAttribute("aria-hidden", open ? "false" : "true");
}

function openFilterBar(): void {
  state.searchMode = "filter";
  setFilterOverlayOpen(true);
  elements.filterInput.value = state.filterQuery;
  elements.filterInput.focus();
}

function closeFilterBar(): void {
  state.searchMode = "seed";
  state.filterQuery = "";
  state.filterMatches.clear();
  elements.filterHint.classList.add("hidden");
  elements.filterInput.value = "";
  setFilterOverlayOpen(false);
  refreshRenderer();
}

function applyFilter(query: string): void {
  state.filterQuery = query;
  state.filterMatches.clear();
  state.searchMode = query.length > 0 ? "filter" : "seed";

  if (query.length > 0) {
    const q = query.toLowerCase();
    state.graph.forEachNode((node) => {
      const attrs = state.graph.getNodeAttributes(node);
      if (nodeMatchesFilterQuery(node, attrs, q)) {
        state.filterMatches.add(node);
      }
    });

    if (state.filterMatches.size === 0) {
      elements.filterHint.textContent = "No visible matches — Cmd+Shift+K to search all notes";
      elements.filterHint.classList.remove("hidden");
    } else {
      elements.filterHint.classList.add("hidden");
    }
  } else {
    elements.filterHint.classList.add("hidden");
  }

  refreshRenderer();
}

const MAX_SEED_LENGTH = 8192;

function parseUrlState(): { seeds: string[]; depth: number; edges: string[]; types: string[] } {
  const url = new URL(window.location.href);
  const seedParam = url.searchParams.get("seed");
  const seeds = seedParam && seedParam.length <= MAX_SEED_LENGTH
    ? seedParam.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const depth = clamp(Number.parseInt(url.searchParams.get("depth") ?? "1", 10) || 1, 1, 3);
  const edges = (url.searchParams.get("edges") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const types = (url.searchParams.get("hide") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return { seeds, depth, edges, types };
}

function updateUrlState(): void {
  const url = new URL(window.location.href);
  if (state.seedNodes.size > 0 && state.seedNodes.size === fullGraph.order) {
    // Full graph mode — use sentinel instead of serializing every node ID
    // (which would exceed MAX_SEED_LENGTH and silently drop on page reload)
    url.searchParams.set("seed", "__all__");
  } else if (state.seedNodes.size > 0) {
    // Primary seed first, then the rest
    const seedList = state.seedNode
      ? [state.seedNode, ...[...state.seedNodes].filter((id) => id !== state.seedNode)]
      : [...state.seedNodes];
    url.searchParams.set("seed", seedList.join(","));
  } else if (state.seedNode) {
    url.searchParams.set("seed", state.seedNode);
  } else {
    url.searchParams.delete("seed");
  }
  url.searchParams.set("depth", String(state.depth));
  url.searchParams.set("edges", [...state.activeEdgeTypes].join(","));
  if (state.disabledNodeTypes.size) url.searchParams.set("hide", [...state.disabledNodeTypes].join(","));
  else url.searchParams.delete("hide");
  window.history.replaceState({}, "", url);
}

// ─── Data Laboratory ────────────────────────────────────────────────────────

interface ExtendedEnrichmentData {
  betweenness: number[];
  closeness: number[];
  eigenvector: number[];
  hubs: number[];
  authorities: number[];
  diameter: number;
  radius: number;
  avgPathLength: number;
}

interface DatalabRow {
  nodeId: string;
  label: string;
  type: string;
  folder: string;
  degree: number;
  pagerank: number | null;
  community: number | null;
  component: number | null;
  clustering: number | null;
  betweenness: number | null;
  eigenvector: number | null;
  hubs: number | null;
  wordCount: number | null;
  modified: number | null;
}

function getFilteredSortedRows(): DatalabRow[] {
  const rows: DatalabRow[] = [];
  state.graph.forEachNode((nodeId, attrs) => {
    const nodeIndex = attrs.nodeIndex as number | undefined;
    const ext = state.extendedEnrichment;
    rows.push({
      nodeId,
      label: attrs.title ?? attrs.label ?? nodeId,
      type: attrs.nodeType ?? "",
      folder: attrs.folder ?? "",
      degree: attrs.degree ?? 0,
      pagerank: attrs.pagerank ?? null,
      community: attrs.clusterId ?? null,
      component: attrs.componentId ?? null,
      clustering: attrs.clusteringCoeff ?? null,
      betweenness: ext && nodeIndex != null ? ext.betweenness[nodeIndex] ?? null : null,
      eigenvector: ext && nodeIndex != null ? ext.eigenvector[nodeIndex] ?? null : null,
      hubs: ext && nodeIndex != null ? ext.hubs[nodeIndex] ?? null : null,
      wordCount: attrs.wordCount ?? null,
      modified: attrs.modified ?? null,
    });
  });

  // Filter
  if (state.datalabFilter.length > 0) {
    const q = state.datalabFilter.toLowerCase();
    return rows.filter((r) =>
      r.label.toLowerCase().includes(q) ||
      r.type.toLowerCase().includes(q) ||
      r.folder.toLowerCase().includes(q) ||
      String(r.degree).includes(q) ||
      (r.pagerank != null && r.pagerank.toFixed(6).includes(q)) ||
      (r.community != null && String(r.community).includes(q)) ||
      (r.component != null && String(r.component).includes(q)) ||
      (r.clustering != null && r.clustering.toFixed(4).includes(q))
    ).sort(makeSorter());
  }

  return rows.sort(makeSorter());
}

function makeSorter(): (a: DatalabRow, b: DatalabRow) => number {
  const { col, dir } = state.datalabSort;
  const mult = dir === "asc" ? 1 : -1;
  return (a: DatalabRow, b: DatalabRow) => {
    let av: string | number | null;
    let bv: string | number | null;
    switch (col) {
      case "label": av = a.label; bv = b.label; break;
      case "type": av = a.type; bv = b.type; break;
      case "folder": av = a.folder; bv = b.folder; break;
      case "degree": av = a.degree; bv = b.degree; break;
      case "pagerank": av = a.pagerank; bv = b.pagerank; break;
      case "community": av = a.community; bv = b.community; break;
      case "component": av = a.component; bv = b.component; break;
      case "clustering": av = a.clustering; bv = b.clustering; break;
      case "betweenness": av = a.betweenness; bv = b.betweenness; break;
      case "eigenvector": av = a.eigenvector; bv = b.eigenvector; break;
      case "hubs": av = a.hubs; bv = b.hubs; break;
      case "wordCount": av = a.wordCount; bv = b.wordCount; break;
      case "modified": av = a.modified; bv = b.modified; break;
      default: av = a.label; bv = b.label;
    }
    // Nulls always last regardless of sort direction
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "string" && typeof bv === "string") {
      return av.localeCompare(bv) * mult;
    }
    return ((av as number) - (bv as number)) * mult;
  };
}

function renderDatalabTable(): void {
  const rows = getFilteredSortedRows();
  const tbody = elements.datalabTbody;

  // Update sort arrow classes on headers
  const thead = (elements.dataLab.querySelector("thead") as HTMLTableSectionElement);
  thead.querySelectorAll("th[data-col]").forEach((th) => {
    const col = (th as HTMLElement).dataset.col ?? "";
    th.classList.remove("sort-asc", "sort-desc");
    if (col === state.datalabSort.col) {
      th.classList.add(state.datalabSort.dir === "asc" ? "sort-asc" : "sort-desc");
    }
  });

  const loadingLabel = state.extendedEnrichmentLoading ? "..." : (state.extendedEnrichmentError ? "err" : "\u2014");
  const html = rows.map((r) => {
    const isSelected = r.nodeId === state.selectedNode;
    const pr = r.pagerank != null ? r.pagerank.toFixed(6) : "\u2014";
    const cc = r.clustering != null ? r.clustering.toFixed(4) : "\u2014";
    const comm = r.community != null ? String(r.community) : "\u2014";
    const comp = r.component != null ? String(r.component) : "\u2014";
    const bt = r.betweenness != null ? r.betweenness.toFixed(6) : loadingLabel;
    const ev = r.eigenvector != null ? r.eigenvector.toFixed(6) : loadingLabel;
    const hub = r.hubs != null ? r.hubs.toFixed(6) : loadingLabel;
    const wc = r.wordCount != null ? String(r.wordCount) : "\u2014";
    const mod = r.modified != null ? new Date(r.modified).toLocaleDateString() : "\u2014";
    return `<tr data-node-id="${escapeHtml(r.nodeId)}" class="${isSelected ? "selected" : ""}">` +
      `<td title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</td>` +
      `<td>${escapeHtml(r.type)}</td>` +
      `<td title="${escapeHtml(r.folder)}">${escapeHtml(r.folder || "/")}</td>` +
      `<td>${r.degree}</td>` +
      `<td>${pr}</td>` +
      `<td>${comm}</td>` +
      `<td>${comp}</td>` +
      `<td>${cc}</td>` +
      `<td>${bt}</td>` +
      `<td>${ev}</td>` +
      `<td>${hub}</td>` +
      `<td>${wc}</td>` +
      `<td>${mod}</td>` +
      `</tr>`;
  }).join("");
  tbody.innerHTML = html;

  // Scroll selected node into view if requested
  if (state.datalabScrollToNode) {
    const target = tbody.querySelector(`tr[data-node-id="${CSS.escape(state.datalabScrollToNode)}"]`);
    if (target) target.scrollIntoView({ block: "nearest" });
    state.datalabScrollToNode = null;
  }
}

function switchToGraph(): void {
  state.activeView = "graph";
  elements.dataLab.classList.add("hidden");
  elements.container.classList.remove("hidden");
  elements.leftSidebar.classList.remove("view-hidden");
  elements.tabGraph.classList.add("active");
  elements.tabDatalab.classList.remove("active");
  updateDockVisibility();

  // Rebuild layout worker if FA3 algorithm selected and graph is seeded
  if (state.layoutAlgorithm === "fa3" && state.seedNodes.size > 0) {
    rebuildLayoutWorker();
  }

  // If there's a selected node, center camera on it and show detail panel
  if (state.selectedNode && state.renderer && state.graph.hasNode(state.selectedNode)) {
    const pos = state.graph.getNodeAttributes(state.selectedNode);
    // Use animatedReset first to get a sane camera state, then animate to node
    state.renderer.getCamera().animate({ x: 0.5, y: 0.5, ratio: 1 }, { duration: 0 });
    // Small delay to let sigma finish rendering after unhide
    window.setTimeout(() => {
      if (!state.renderer || !state.selectedNode) return;
      const nodePos = state.renderer.getNodeDisplayData(state.selectedNode);
      if (nodePos) {
        const cam = state.renderer.getCamera();
        cam.animate({ x: nodePos.x, y: nodePos.y, ratio: cam.ratio }, { duration: 300 });
      }
      if (state.selectedNode) showDetailPanel(state.selectedNode);
    }, 50);
  }

  refreshRenderer();
}

function switchToDatalab(): void {
  state.activeView = "datalab";
  elements.container.classList.add("hidden");
  elements.leftSidebar.classList.add("view-hidden");
  elements.tabDatalab.classList.add("active");
  elements.tabGraph.classList.remove("active");
  updateDockVisibility();

  // Hide detail panel when entering data lab
  hideDetailPanel();

  if (state.searchMode === "filter" || state.filterQuery.length > 0) closeFilterBar();

  // Pause layout worker to save CPU
  stopLayoutWorker();

  // Show data lab
  elements.dataLab.classList.remove("hidden");

  // If a node is selected, pre-scroll to it when table is rendered
  if (state.selectedNode) {
    state.datalabScrollToNode = state.selectedNode;
  }

  // Reset filter input to match state
  elements.datalabFilter.value = state.datalabFilter;

  // Fetch extended enrichment on first Data Lab open (on-demand, not startup)
  if (!state.extendedEnrichment && !state.extendedEnrichmentLoading && !POWER_CONFIG) {
    state.extendedEnrichmentLoading = true;
    state.extendedEnrichmentError = false;
    fetch(apiUrl("/api/enrichment/extended"), apiFetchInit())
      .then((r) => r.json() as Promise<ExtendedEnrichmentData>)
      .then((data) => {
        state.extendedEnrichment = data;
        state.extendedEnrichmentLoading = false;
        if (state.activeView === "datalab") renderDatalabTable();
      })
      .catch(() => {
        state.extendedEnrichmentLoading = false;
        state.extendedEnrichmentError = true;
        if (state.activeView === "datalab") renderDatalabTable();
      });
  }

  renderDatalabTable();
}

let datalabFilterDebounce = 0 as number | ReturnType<typeof setTimeout>;

function exportCsv(): void {
  const rows = getFilteredSortedRows();
  const header = "Label,Type,Folder,Degree,PageRank,Community,Component,Clustering,Betweenness,Eigenvector,HITS Hub,Words,Modified";
  const csvRows = rows.map((r) =>
    [
      r.label,
      r.type,
      r.folder,
      r.degree,
      r.pagerank ?? "",
      r.community ?? "",
      r.component ?? "",
      r.clustering ?? "",
      r.betweenness ?? "",
      r.eigenvector ?? "",
      r.hubs ?? "",
      r.wordCount ?? "",
      r.modified ? new Date(r.modified).toISOString().slice(0, 10) : "",
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",")
  );
  const csv = [header, ...csvRows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "atlas-data.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Left sidebar toggle ────────────────────────────────────────────────────

let sidebarResizeDebounce = 0 as number | ReturnType<typeof setTimeout>;

function setSidebarWidth(collapsed: boolean): void {
  elements.app.style.setProperty("--sidebar-left-width", collapsed ? "0px" : "336px");
  elements.sidebarToggle.innerHTML = collapsed ? "&#8250;" : "&#8249;";
}

function toggleSidebar(): void {
  const collapsed = elements.leftSidebar.classList.toggle("collapsed");
  setSidebarWidth(collapsed);
  try {
    localStorage.setItem("atlas:sidebar", collapsed ? "collapsed" : "open");
  } catch { /* localStorage may be blocked */ }
}

function initSidebar(): void {
  // Restore persisted collapse state
  try {
    const saved = localStorage.getItem("atlas:sidebar");
    if (saved === "collapsed") {
      elements.leftSidebar.classList.add("collapsed");
      setSidebarWidth(true);
    }
  } catch { /* localStorage may be blocked */ }

  elements.sidebarToggle.addEventListener("click", toggleSidebar);

  // ResizeObserver: when sigma-container resizes (sidebar open/close), resize the renderer
  const ro = new ResizeObserver(() => {
    if (sidebarResizeDebounce) clearTimeout(sidebarResizeDebounce);
    sidebarResizeDebounce = window.setTimeout(() => {
      // Skip resize when container is hidden (e.g. Data Lab active)
      if (state.activeView !== "graph") return;
      state.renderer?.resize();
    }, 50);
  });
  ro.observe(elements.container);
}

function initUi(): void {
  elements.emptySearchButton.addEventListener("click", openSearch);
  elements.emptyFullGraphButton?.addEventListener("click", seedFullGraph);
  document.querySelectorAll<HTMLButtonElement>("[data-example-query]").forEach((button) => {
    button.addEventListener("click", () => {
      openSearch();
      const query = button.dataset.exampleQuery ?? "";
      elements.searchInput.value = query;
      void searchNotes(query);
    });
  });
  elements.searchClose.addEventListener("click", closeSearch);
  elements.clearSeed.addEventListener("click", () => {
    resetGraphView();
  });
  elements.dockToggle.addEventListener("click", () => {
    const expanded = elements.app.classList.toggle("dock-expanded");
    elements.dockToggle.setAttribute("aria-expanded", String(expanded));
    const label = elements.dockToggle.querySelector("span");
    if (label) label.textContent = expanded ? "Collapse legend" : "Expand legend";
  });
  elements.detailClose.addEventListener("click", () => {
    state.selectedNode = null;
    hideDetailPanel();
    refreshRenderer();
  });
  elements.detailPin.addEventListener("click", () => {
    if (state.selectedNode) togglePinnedNode(state.selectedNode);
  });
  elements.inspectorTabs.forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.inspectorTab as InspectorTab | undefined;
      if (tab) setInspectorTab(tab);
    });
  });
  elements.detailMeta.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const pivot = target.closest("[data-tag-pivot]") as HTMLElement | null;
    if (pivot && state.selectedNode) {
      pivotGraphByTag(pivot.dataset.tagPivot ?? "", state.selectedNode);
    }
  });

  elements.colorModeBtn?.addEventListener("click", () => {
    if (!state.enrichment?.version) return;
    state.colorMode = state.colorMode === "type" ? "community" : "type";
    elements.colorModeBtn.textContent = state.colorMode === "community" ? "Color: Community" : "Color: Type";
    refreshRenderer();
  });

  elements.sizeModeBtn?.addEventListener("click", () => {
    if (!state.enrichment?.version) return;
    state.sizeMode = state.sizeMode === "degree" ? "pagerank" : "degree";
    elements.sizeModeBtn.textContent = state.sizeMode === "pagerank" ? "Size: PageRank" : "Size: Degree";
    refreshRenderer();
  });

  // Layout algorithm select
  const layoutDescriptions: Record<string, string> = {
    fa3: "Force-directed layout — nodes repel, edges attract. Best for organic structure discovery. Iterative: runs until energy settles.",
    fruchterman: "Classic spring-electric model. Edges act as springs, nodes repel. Often better than FA for small graphs. One-shot: 50 iterations.",
    circular: "Arranges nodes in a circle grouped by community, then by degree within each group.",
    concentric: "Concentric rings by degree — highest-connected nodes at the center, peripherals on outer rings.",
    grid: "Rows and columns sorted by type then degree. Good for seeing all nodes at once.",
    random: "Scatter nodes randomly. Useful as a reset before re-running another layout.",
    noverlap: "Post-processing pass — pushes overlapping nodes apart without changing the overall structure. Run after any other layout.",
  };
  elements.layoutSelect?.addEventListener("change", () => {
    const prev = state.layoutAlgorithm;
    state.layoutAlgorithm = elements.layoutSelect.value as typeof state.layoutAlgorithm;
    if (prev === "fa3" && state.layoutState === "running" && state.layoutAlgorithm !== "fa3") {
      stopLayoutWorker();
    }
    if (elements.layoutTooltip) {
      elements.layoutTooltip.textContent = layoutDescriptions[state.layoutAlgorithm] ?? "";
    }
    if (state.seedNode) applySelectedLayout();
  });

  // Search trigger in control bar
  elements.searchTrigger?.addEventListener("click", () => openSearch());

  // Filter bar
  elements.filterInput.addEventListener("input", () => {
    applyFilter(elements.filterInput.value);
  });
  elements.filterInput.addEventListener("blur", () => {
    if (!state.filterQuery) setFilterOverlayOpen(false);
  });

  elements.depthSlider.addEventListener("input", () => {
    state.depth = clamp(Number.parseInt(elements.depthSlider.value, 10), 1, 3);
    updateDepthLabel();
    if (state.seedNode) {
      recomputeVisibleNodes();
      fitVisibleNodes();
    } else {
      updateUrlState();
    }
  });

  elements.searchModal.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.dataset.closeSearch === "true") closeSearch();
  });

  elements.searchInput.addEventListener("input", () => {
    if (state.searchDebounce) clearTimeout(state.searchDebounce);
    state.searchDebounce = window.setTimeout(() => {
      searchNotes(elements.searchInput.value).catch(() => {
        state.searchResults = [];
        renderSearchResults();
      });
    }, 120);
  });

  elements.searchInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!state.searchResults.length) return;
      state.searchIndex = (state.searchIndex + 1) % state.searchResults.length;
      renderSearchResults();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!state.searchResults.length) return;
      state.searchIndex = (state.searchIndex - 1 + state.searchResults.length) % state.searchResults.length;
      renderSearchResults();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = state.searchResults[state.searchIndex];
      if (!target) return;
      closeSearch();
      seedNode(target);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
    }
  });

  document.addEventListener("keydown", (event) => {
    const isTyping = document.activeElement instanceof HTMLInputElement;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openSearch();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      if (state.seedNodes.size > 0) {
        event.preventDefault();
        openFilterBar();
      }
      return;
    }

    // Cmd+Shift+D — toggle Data Lab
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "d") {
      event.preventDefault();
      if (state.seedNodes.size > 0) {
        if (state.activeView === "datalab") switchToGraph();
        else switchToDatalab();
      }
      return;
    }

    // Cmd+\ — toggle left sidebar
    if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
      event.preventDefault();
      toggleSidebar();
      return;
    }

    // Cmd+L — layout run/stop/apply
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
      event.preventDefault();
      if (state.layoutAlgorithm === "fa3") {
        if (state.layoutState === "running") { stopLayoutWorker(); } else { rebuildLayoutWorker(); }
      } else {
        applySelectedLayout();
      }
      return;
    }

    if (event.key === "Escape") {
      if (state.searchMode === "filter" || document.activeElement === elements.filterInput) {
        event.preventDefault();
        if (state.filterQuery) {
          applyFilter("");
          elements.filterInput.value = "";
        } else {
          closeFilterBar();
        }
        return;
      }
      if (!elements.searchModal.classList.contains("hidden")) {
        closeSearch();
        return;
      }
      state.selectedNode = null;
      hideDetailPanel();
      refreshRenderer();
      return;
    }

    if (!isTyping && event.key === "1" && event.metaKey) {
      event.preventDefault();
      state.depth = 1;
      elements.depthSlider.value = "1";
      updateDepthLabel();
      if (state.seedNode) recomputeVisibleNodes();
    }
  });

  // ── Data Lab ──────────────────────────────────────────────────────────────

  // Tab bar clicks
  elements.tabGraph.addEventListener("click", () => {
    if (state.activeView !== "graph") switchToGraph();
  });
  elements.tabDatalab.addEventListener("click", () => {
    if (state.activeView !== "datalab") switchToDatalab();
  });

  // Column header sort (event delegation on <thead>)
  const datalabThead = elements.dataLab.querySelector("thead") as HTMLTableSectionElement;
  datalabThead.addEventListener("click", (event) => {
    const th = (event.target as HTMLElement).closest("th[data-col]") as HTMLElement | null;
    if (!th) return;
    const col = th.dataset.col ?? "";
    if (!col) return;
    if (state.datalabSort.col === col) {
      state.datalabSort.dir = state.datalabSort.dir === "asc" ? "desc" : "asc";
    } else {
      state.datalabSort.col = col;
      state.datalabSort.dir = "asc";
    }
    renderDatalabTable();
  });

  // Row click → select node (event delegation on <tbody>)
  elements.datalabTbody.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest("tr[data-node-id]") as HTMLElement | null;
    if (!row) return;
    const nodeId = row.dataset.nodeId ?? "";
    if (!nodeId) return;
    state.selectedNode = nodeId;
    state.datalabScrollToNode = nodeId;
    // Update selected class on all rows
    elements.datalabTbody.querySelectorAll("tr").forEach((tr) => {
      tr.classList.toggle("selected", (tr as HTMLElement).dataset.nodeId === nodeId);
    });
  });

  // Filter input (debounced 100ms)
  elements.datalabFilter.addEventListener("input", () => {
    if (datalabFilterDebounce) clearTimeout(datalabFilterDebounce);
    datalabFilterDebounce = window.setTimeout(() => {
      state.datalabFilter = elements.datalabFilter.value;
      renderDatalabTable();
    }, 100);
  });

  // CSV export
  elements.datalabExport.addEventListener("click", exportCsv);
}

function initSse(): void {
  // Power mode doesn't support SSE in v0.1 (task #16 for v0.2) — skip wiring
  // up EventSource entirely so we don't log noise and leak a reconnect loop.
  if (POWER_CONFIG) return;
  const source = new EventSource("/api/events");
  source.addEventListener("graph-updated", async () => {
    const currentUrlState = parseUrlState();
    await loadGraph();
    renderEdgeLegend();
    const currentSeed = currentUrlState.seeds[0];
    if (currentSeed && fullGraph.hasNode(currentSeed)) {
      state.depth = currentUrlState.depth;
      elements.depthSlider.value = String(state.depth);
      updateDepthLabel();
      seedNode(currentSeed);
    } else if (currentSeed) {
      // Stale seed — wipe everything and return to empty canvas per plan spec
      state.seedNode = null;
      state.selectedNode = null;
      state.manuallyExpanded.clear();
      state.visibleNodes.clear();
      hideDetailPanel();
      syncVisibleGraph();
      renderEdgeLegend();
      stopLayoutWorker();
      setChromeVisible(false);
      updateUrlState();
      elements.statusSummary.textContent = `Seed ${currentSeed} no longer exists.`;
      refreshRenderer();
    } else {
      refreshRenderer();
    }
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function main(): Promise<void> {
  updateDepthLabel();
  setChromeVisible(false);
  loadPinnedNodes();
  initSidebar();
  initUi();
  await loadGraph();

  // Fetch enrichment status for mode toggles
  try {
    const enrichRes = await fetch(apiUrl("/api/enrichments"), apiFetchInit());
    if (enrichRes.ok) {
      state.enrichment = await enrichRes.json() as typeof state.enrichment;
      updateEmptyStateMetrics();
    }
  } catch { /* enrichment status is optional */ }

  applyPinnedStateToGraphs();
  initRenderer();
  renderEdgeLegend();
  setMetricTooltips();
  updateStatusBar();
  initSse();

  const urlState = parseUrlState();
  if (urlState.seeds.length === 1 && urlState.seeds[0] === "__all__") {
    // Full-graph sentinel — restore via seedFullGraph
    seedFullGraph();
  } else if (urlState.seeds.length > 0) {
    const validSeeds = urlState.seeds.filter((id) => fullGraph.hasNode(id));
    if (validSeeds.length > 0) {
      if (validSeeds.length === 1) {
        seedNode(validSeeds[0]);
      } else {
        seedMultipleNodes(validSeeds);
      }
    } else {
      elements.statusSummary.textContent = `Seed ${urlState.seeds[0]} was not found.`;
      updateUrlState();
    }
  }
}

main().catch((error) => {
  console.error(error);
  elements.statusSummary.textContent = "Frontend failed to initialize.";
});

// Expose for debugging — only when running on localhost (dev/local vaults).
// In any deployed/power-mode context, do not leak internals to window.
if (typeof window !== "undefined" && /^(localhost|127\.0\.0\.1|::1)$/.test(window.location.hostname)) {
  (window as any).__atlas = { state, fullGraph };
}
