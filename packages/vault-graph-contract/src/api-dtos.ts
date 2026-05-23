/**
 * Shared API response DTOs for /api/* endpoints on vault-mcp and vault-mcp-power.
 *
 * Only contains types for response shapes that are returned over HTTP today.
 * Does NOT contain:
 *   - VaultEdge or EdgeRow DB row shapes (those are per-Worker, path vs node-id)
 *   - NodeRow or VaultNode DB row shapes
 *   - zod schemas
 *   - D1 SQL row aliases
 */

// =============================================================================
// vault-mcp: /api/ingest_triples
// =============================================================================

export interface IngestTriplesResponse {
  ingested: number;
  skipped: number;
  total: number;
}

// =============================================================================
// vault-mcp: /api/entity-lookup
// =============================================================================

export interface EntityLookupResponse {
  entries: number;
  lookup: Record<string, string>;
}

// =============================================================================
// vault-mcp: /api/digest
// =============================================================================

export interface DigestItemDto {
  timestamp: string;
  source: string;
  type: string;
  summary: string;
  id: string;
  metadata: Record<string, unknown>;
}

export interface DigestResponse {
  date: string;
  items: DigestItemDto[];
  total: number;
}

// =============================================================================
// vault-mcp-power: /api/graph/nodes and /api/graph/edges
// =============================================================================

export interface GraphPageResponse<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

// =============================================================================
// vault-mcp-power: /api/meta
// =============================================================================

export interface MetaResponse {
  nodeCount: number;
  edgeCount: number;
  edgeTypes: string[];
  topTags: Array<{ tag: string; count: number }>;
  topFolders: Array<{ folder: string; count: number }>;
  lastReload: number;
  enrichmentVersion: number;
  /** Unix seconds (NOT millis). Orchestrator writes String(Math.floor(Date.now()/1000)).
   *  Consumers converting to Date must multiply by 1000: new Date(value * 1000). */
  lastEnrichmentAt: number;
  enrichmentCommunityCount: number;
}

// =============================================================================
// vault-mcp-power: /api/search
// =============================================================================

export interface SearchResponse {
  results: string[];
}

// =============================================================================
// vault-mcp-power: /api/semantic-search
// =============================================================================

export interface SemanticSearchResultDto {
  id: string;
  score: number;
  nodeType: string | null;
  folder: string | null;
}

export interface SemanticSearchResponse {
  query: string;
  results: SemanticSearchResultDto[];
  elapsed_ms: number;
  status: "ok" | "pending";
  hint?: string;
}

// =============================================================================
// vault-mcp-power: /api/views
// =============================================================================

export interface SavedViewDto {
  slug: string;
  public_id: string;
  title: string;
  description: string;
  state: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export interface SavedViewsListResponse {
  views: SavedViewDto[];
}

// =============================================================================
// vault-mcp: /api/enrichments
// =============================================================================

export interface EnrichmentsResponse {
  version: number;
  /** Unix seconds (NOT millis). Same encoding as VaultMetaResponse.lastEnrichmentAt —
   *  multiply by 1000 to convert to a JS Date. */
  lastRunAt: number;
  communityCount: number;
  /** Current cursor phase. 'embedding' | 'algorithm' | 'running_algorithms' | 'backfill' */
  phase: string;
}

// =============================================================================
// vault-mcp: /api/meta (extended with enrichment fields)
// =============================================================================

/** Extended MetaResponse returned by vault-mcp (superset of atlas MetaResponse). */
export interface VaultMetaResponse extends MetaResponse {
  /** Epoch seconds of the last completed ingest run. Null pre-first-ingest. */
  lastIngestRunId: string | null;
}

// =============================================================================
// vault-mcp: /api/graph/nodes — node DTO including enrichment fields
// =============================================================================
//
// This shape mirrors the actual handler output in
// workers/vault-mcp/src/routes/ui/graph.ts handleGraphNodesRequest.
// Field naming (`id` not `path`, `modified` not `modifiedAt`, etc.) is
// load-bearing for public/dist/app.js — the Sigma.js bundle reads these
// fields directly and changing them breaks rendering.
// (Codex P2 round-8 finding: DTO was drifted from handler.)

export interface NodeDto {
  id: string;
  title: string;
  folder: string;
  nodeType: string;
  /** Frontmatter shape synthesized by the handler for the Sigma bundle —
   *  `{ type, tags }` — not the full parsed frontmatter from vault_nodes.
   *  Clients that need full frontmatter should call /api/frontmatter. */
  frontmatter: { type: string; tags: string[] } | Record<string, unknown> | null;
  tags: string[];
  wordCount: number | null;
  created: string | null;
  modified: number | null;
  contentHash: string | null;
  embeddingVersion: number | null;
  ingestRunId: string | null;
  x: number | null;
  y: number | null;
  body: string | null;
  /** Enrichment fields — null until first algorithm enrichment run
   *  AND only non-null when the request was made with ?include=enrichment
   *  (except pagerank which is always populated when the LEFT JOIN fires). */
  pagerank: number | null;
  clusterId: number | null;
  componentId: number | null;
  clusteringCoeff: number | null;
}

// =============================================================================
// vault-mcp: /api/vault/drift — cognitive drift route (Phase D6)
// =============================================================================

export interface DriftPointDto {
  capturedAt: number;
  enrichmentVersion: number;
  pagerank: number;
  clusterId: number | null;
  componentId: number | null;
}

export interface VaultDriftResponse {
  nodeId: string;
  title: string;
  points: DriftPointDto[];
}

// =============================================================================
// vault-mcp: /api/vault/propagate — cognitive propagation route (Phase D6)
// =============================================================================

export interface PropagationChangeDto {
  nodeId: string;
  title: string;
  pagerankBefore: number;
  pagerankAfter: number;
  pagerankDelta: number;
  clusterBefore: number | null;
  clusterAfter: number | null;
}

export interface VaultPropagateResponse {
  seed: string;
  enrichmentVersion: number;
  changed: PropagationChangeDto[];
  /** "exact" when the request version matches the latest enrichment run
   *  (live edges equal historical edges). "approximate" when querying an
   *  older version — the neighbor set is restricted to nodes with snapshot
   *  rows at that version, but live edge topology is used for traversal.
   *  Edges deleted since the snapshot are missed; edges added since are
   *  also excluded because the target nodes won't have snapshot rows. */
  historicalAccuracy: "exact" | "approximate";
}

// =============================================================================
// vault-mcp: /api/backfill?kind=body — plan-E2 body/content_hash backfill
// =============================================================================

/**
 * Response shape for POST /api/backfill?kind=body. Every HTTP call returns
 * this DTO; the operator polling loop reissues POSTs until `status` becomes
 * `"completed"`. See docs/plans/2026-04-14-001-feat-plan-e2-body-backfill-
 * implementation-plan.md for the lease / cooldown / resume semantics.
 *
 * Status → HTTP code mapping (plan spec-flow F4):
 *   in_progress    → 200
 *   completed      → 200
 *   skipped        → 409 (cooldown active, no force)
 *   lease_held     → 409 (another phase holds the cursor)
 *   rate_limit     → 429 (force bucket exhausted)
 *   not_implemented→ 501 (pre-migration-0004 database)
 */
export interface BackfillResponse {
  status:
    | "in_progress"
    | "completed"
    | "skipped"
    | "rate_limit"
    | "not_implemented"
    | "lease_held";
  kind: "body";

  /** Rows whose UPDATE actually fired on this HTTP call. Counted by
   *  per-statement batch success, NOT by prepared-statement array length
   *  (adversary WARNING — D1 batch atomicity is per-statement, partial
   *  failures do not throw). */
  processedThisCall: number;
  /** Rows skipped on this call because content_hash already matched. */
  skippedThisCall: number;
  /** Rows whose R2 object returned null on this call. Non-destructive:
   *  the vault_nodes row is NOT deleted — the next syncGraph handles
   *  orphan cleanup. */
  missingFromR2ThisCall: number;
  elapsedMs: number;

  /** Cumulative across all slices of the current cycle. Stored in
   *  `enrich_cursor.nodes_processed`, reset to 0 on fresh cycle start. */
  totalProcessed: number;
  totalSkipped: number;
  totalMissingFromR2: number;

  /** Resume marker for the next HTTP call. Null when status = "completed". */
  lastNodeId: string | null;

  /** unixepoch seconds at which the lease was first claimed for this cycle. */
  cycleStartedAt: number;
  /** unixepoch seconds at cycle completion. Null until status = "completed". */
  cycleCompletedAt: number | null;

  /** Human-readable diagnostic for operator polling loops. */
  message?: string;
  /** Populated only when status = "lease_held", so the caller can see which
   *  phase is holding the cursor and when its lease expires. */
  leaseHolder?: { phase: string; leaseExpires: number };
}

// =============================================================================
// vault-mcp: /api/wiki/*
// =============================================================================

export interface WikiPageDto {
  path: string;
  kind: "entity" | "concept" | "cluster" | "index" | "log";
  title: string;
  body: string;                 // markdown, fetched from R2 and inlined on /api/wiki/page
  r2Key: string;
  sourcePaths: string[];        // parsed from source_paths JSON
  clusterId: number | null;
  pagerank: number | null;
  wordCount: number | null;
  wikiVersion: number;
  compiledAt: number;           // unixepoch seconds
  compiledBy: string;
  promptHash: string;
  sourceHash: string;
}

export interface WikiSearchHit {
  path: string;
  title: string;
  kind: "entity" | "concept" | "cluster" | "index" | "log";
  snippet: string;              // FTS5 bm25 highlight
  score: number;                // bm25
}

export interface WikiSearchResponse {
  query: string;
  hits: WikiSearchHit[];
  totalMatches: number;
}

export interface WikiLinkDto {
  sourcePath: string;
  targetPath: string;
  targetKind: "wiki" | "vault";
  anchorText: string | null;
}

export interface WikiNeighborsResponse {
  path: string;
  depth: number;
  nodes: Array<{ path: string; kind: WikiPageDto["kind"] | "vault"; title: string }>;
  links: WikiLinkDto[];
}

export interface WikiStatusResponse {
  schemaVersion: number;
  promptVersion: number;
  pagesByKind: Record<WikiPageDto["kind"], number>;
  lastCompileAt: number | null;      // unixepoch seconds
  lastCompileSummary: {
    cycleStartedAt: number;
    cycleCompletedAt: number;
    pagesCompiled: number;
    pagesSkipped: number;
    pagesErrored: number;
    durationMs: number;
    byModel: Record<string, number>;
  } | null;
  compileBackend: "local-script";
}

export interface WikiBulkUpsertRequest {
  cycleStartedAt: number;          // unixepoch seconds; constant across one local-script invocation
  cycleCompletedAt: number;        // unixepoch seconds; same as cycleStartedAt for single-page runs
  promptVersion: number;           // MUST equal server-side WIKI_PROMPT_VERSION
  pages: Array<{
    path: string;
    kind: WikiPageDto["kind"];
    title: string;
    body: string;
    sourcePaths: string[];
    clusterId?: number | null;
    pagerank?: number | null;
    compiledBy: string;
    promptHash: string;
    sourceHash: string;
  }>;
}

export interface WikiBulkUpsertResponse {
  inserted: number;
  updated: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
}
