/**
 * Power-mode GraphSource adapter.
 *
 * Thin HTTP client against a vault-mcp-power Cloudflare Worker. Implements
 * the same `GraphSource` interface
 * as the local parser so the frontend can swap between local and remote
 * without touching any rendering code.
 *
 * ZERO cloud deps. Pure fetch. This file is the ONLY file in src/power/
 * that the frontend imports — keeps the import graph clean and lets the
 * OSS atlas ship without pulling in wrangler, the CF Worker types, or
 * any auth library.
 *
 * DOES NOT:
 *   - Embed or index anything locally — delegates to the remote worker
 *   - Stream /api/graph results — accumulates paginated pages into a single
 *     VaultGraph in memory before resolving the load() promise (matches
 *     the existing interface contract)
 *   - Handle CF Access login flow — the browser must already have a valid
 *     CF Access session cookie, OR the caller supplies a Bearer token for
 *     local-dev backends
 */
import type { VaultGraph, VaultNote, GraphEdge, GraphSource } from "../core/types.ts";

export interface PowerSourceConfig {
  /** Base URL of the vault-mcp-power worker, e.g. https://your-atlas-domain.com */
  baseUrl: string;

  /**
   * Optional Bearer token for local development or headless clients.
   * In production, CF Access handles auth via session cookies — leave this
   * undefined and the adapter will send `credentials: "include"`.
   */
  bearer?: string;

  /** Page size for /api/graph/{nodes,edges} pagination. Defaults to 2000. */
  pageLimit?: number;

  /** Abort signal to cancel in-flight fetches. */
  signal?: AbortSignal;
}

interface RemoteNode {
  id: string;
  title: string;
  folder: string;
  nodeType: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  wordCount: number;
  created: number;
  modified: number;
  contentHash: string;
  embeddingVersion: number;
  ingestRunId: string;
  x: number | null;
  y: number | null;
}

interface RemoteEdge {
  id: string;
  sourceId: string;
  targetId: string;
  edgeType: string;
  weight: number;
  ingestRunId: string;
}

interface PageResponse<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

interface SearchResponse {
  results: string[];
}

export function createPowerSource(config: PowerSourceConfig): GraphSource {
  const pageLimit = config.pageLimit ?? 2000;

  function buildUrl(path: string, params: Record<string, string | number> = {}): string {
    const url = new URL(path, config.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  function buildHeaders(): HeadersInit {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (config.bearer) headers.Authorization = `Bearer ${config.bearer}`;
    return headers;
  }

  function fetchOptions(): RequestInit {
    return {
      headers: buildHeaders(),
      credentials: config.bearer ? "omit" : "include",
      signal: config.signal,
    };
  }

  /** Paginate a list endpoint until nextCursor === null. */
  async function fetchAllPages<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let cursor = "";
    while (true) {
      const url = buildUrl(path, { cursor, limit: pageLimit });
      const res = await fetch(url, fetchOptions());
      if (!res.ok) {
        throw new Error(`power-mode ${path} failed: ${res.status} ${res.statusText}`);
      }
      const page = (await res.json()) as PageResponse<T>;
      items.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return items;
  }

  async function load(): Promise<VaultGraph> {
    // Fetch nodes + edges in parallel. Each endpoint paginates independently.
    const [remoteNodes, remoteEdges] = await Promise.all([
      fetchAllPages<RemoteNode>("/api/graph/nodes"),
      fetchAllPages<RemoteEdge>("/api/graph/edges"),
    ]);

    const nodes: VaultNote[] = remoteNodes.map((n) => ({
      id: n.id,
      title: n.title,
      path: `${n.id}.md`,
      folder: n.folder,
      frontmatter: n.frontmatter ?? {},
      wikilinks: [], // not returned by the remote — wikilinks are already
                     // represented as edges, the client doesn't need them
      wordCount: n.wordCount,
      created: n.created,
      modified: n.modified,
    }));

    const edges: GraphEdge[] = remoteEdges.map((e) => ({
      id: e.id,
      source: e.sourceId,
      target: e.targetId,
      type: e.edgeType,
      weight: e.weight,
    }));

    return { nodes, edges };
  }

  async function search(query: string): Promise<string[]> {
    const url = buildUrl("/api/search", { q: query });
    const res = await fetch(url, fetchOptions());
    if (!res.ok) {
      throw new Error(`power-mode /api/search failed: ${res.status}`);
    }
    const data = (await res.json()) as SearchResponse;
    return data.results ?? [];
  }

  async function getNote(id: string): Promise<string> {
    const url = buildUrl("/api/note", { path: id });
    const res = await fetch(url, fetchOptions());
    if (!res.ok) {
      throw new Error(`power-mode /api/note failed: ${res.status}`);
    }
    return res.text();
  }

  return {
    load,
    search,
    getNote,
    reload: load,
  };
}

/**
 * Power-mode bonus endpoint — not part of the GraphSource interface, but
 * exposed separately so the frontend can render semantic bridges when the
 * worker backend is in use.
 *
 * Returns `null` if the endpoint fails for any reason (including local-mode
 * where the adapter isn't in use).
 */
export interface BridgePath {
  nodes: string[];
  cost: number;
  semantic_score: number;
  disconnected?: boolean;
}

export interface BridgesResponse {
  from: string;
  to: string;
  paths: BridgePath[];
  truncated: boolean;
  budget_ms_used: number;
  disconnected: boolean;
}

export async function fetchBridges(
  config: PowerSourceConfig,
  from: string,
  to: string,
  options: { maxHops?: number; k?: number } = {},
): Promise<BridgesResponse | null> {
  const params: Record<string, string | number> = { from, to };
  if (options.maxHops !== undefined) params.max_hops = options.maxHops;
  if (options.k !== undefined) params.k = options.k;

  const url = new URL("/api/bridges", config.baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.bearer) headers.Authorization = `Bearer ${config.bearer}`;

  try {
    const res = await fetch(url.toString(), {
      headers,
      credentials: config.bearer ? "omit" : "include",
      signal: config.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as BridgesResponse;
  } catch {
    return null;
  }
}
