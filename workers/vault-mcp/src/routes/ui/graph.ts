import type { Env } from "../../env";

interface GraphNodeRow {
  id: string;
  title: string;
  folder: string;
  nodeType: string | null;
  tags: string;
  modifiedAt: string | null;
  createdAt: string | null;
  wordCount: number | null;
  frontmatterRaw: string | null;
  pagerank: number | null;
  clusterId: number | null;
  componentId: number | null;
  clusteringCoeff: number | null;
}

interface GraphEdgeRow {
  id: number;
  sourceId: string;
  targetId: string;
  edgeType: string;
  weight: number;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60, s-maxage=300",
      ...(init.headers ?? {}),
    },
  });
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function toEpochMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Probe which enrichment table name exists. Returns name or null.
 *  Deterministically prefers vault_enrichment during plan-B9 transition.
 *  (Codex P2 round-4.) */
async function resolveEnrichmentTable(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name IN ('vault_enrichment', 'vault_centrality')
     ORDER BY CASE WHEN name = 'vault_enrichment' THEN 0 ELSE 1 END
     LIMIT 1`
  ).first<{ name: string }>().catch(() => null);
  return row?.name ?? null;
}

export async function handleGraphNodesRequest(url: URL, env: Env): Promise<Response> {
  const cursor = url.searchParams.get("cursor") ?? "";
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "2000", 10) || 2000, 1), 5000);
  const includeEnrichment = url.searchParams.get("include") === "enrichment";

  const enrichTable = await resolveEnrichmentTable(env);
  const joinEnabled = enrichTable !== null;

  // Probe whether the enrichment table actually has the 0004 extension
  // columns. On a deploy that lands BEFORE migration 0004, the table has
  // only pagerank/prev_pagerank/computed_at; selecting the new columns
  // would fail. (Codex P1 round-16 finding reverses round-9 assumption.)
  let hasExtCols = false;
  if (enrichTable) {
    try {
      const cols = await env.DB.prepare(`PRAGMA table_info('${enrichTable}')`).all<{ name: string }>();
      const names = new Set((cols.results ?? []).map((r) => r.name));
      hasExtCols = ["cluster_id", "component_id", "clustering_coeff"].every((c) => names.has(c));
    } catch { /* ignore */ }
  }

  // Probe for the plan-E2 backfilled columns so the response can include
  // word_count / created_at / the real frontmatter JSON blob when present.
  // On pre-0004 databases these columns are absent and the SELECT would
  // fail; fall through to NULLs in that case.
  let hasBodyCols = false;
  try {
    const cols = await env.DB.prepare(`PRAGMA table_info('vault_nodes')`).all<{ name: string }>();
    const names = new Set((cols.results ?? []).map((r) => r.name));
    hasBodyCols = ["word_count", "frontmatter", "created_at"].every((c) => names.has(c));
  } catch { /* ignore */ }

  const bodyCols = hasBodyCols
    ? `n.word_count AS wordCount, n.frontmatter AS frontmatterRaw, n.created_at AS createdAt`
    : `NULL AS wordCount, NULL AS frontmatterRaw, NULL AS createdAt`;

  let nodesSql: string;
  if (joinEnabled) {
    // LEFT JOIN to whichever enrichment table exists. Only select the new
    // columns if the probe confirmed they exist; otherwise fall back to
    // pagerank only and null the rest.
    const enrichCols = hasExtCols
      ? `e.pagerank, e.cluster_id AS clusterId, e.component_id AS componentId, e.clustering_coeff AS clusteringCoeff`
      : `e.pagerank, NULL AS clusterId, NULL AS componentId, NULL AS clusteringCoeff`;
    nodesSql = `SELECT n.path AS id,
              n.title,
              n.folder,
              n.note_type AS nodeType,
              n.tags,
              n.modified_at AS modifiedAt,
              ${bodyCols},
              ${enrichCols}
       FROM vault_nodes n
       LEFT JOIN ${enrichTable} e ON e.path = n.path
       WHERE n.path NOT GLOB '__*' AND (? = '' OR n.path > ?)
       ORDER BY n.path
       LIMIT ?`;
  } else {
    nodesSql = `SELECT n.path AS id,
              n.title,
              n.folder,
              n.note_type AS nodeType,
              n.tags,
              n.modified_at AS modifiedAt,
              ${bodyCols},
              NULL AS pagerank,
              NULL AS clusterId,
              NULL AS componentId,
              NULL AS clusteringCoeff
       FROM vault_nodes n
       WHERE n.path NOT GLOB '__*' AND (? = '' OR n.path > ?)
       ORDER BY n.path
       LIMIT ?`;
  }

  const [pageRes, totalRes] = await Promise.all([
    env.DB.prepare(nodesSql).bind(cursor, cursor, limit).all<GraphNodeRow>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM vault_nodes WHERE path NOT GLOB '__*'").first<{ count: number }>(),
  ]);

  const rows = pageRes.results ?? [];
  const items = rows.map((row) => {
    const nodeType = row.nodeType ?? "note";
    const tags = parseTags(row.tags);
    // Parse the real frontmatter JSON blob written by plan-E2's backfill
    // and by sync/build graph when vault_nodes.frontmatter is populated.
    // Fall back to synthesized {type, tags} on NULL/parse-failure so the
    // bundled UI still renders — the synthesized shape is the legacy
    // contract and was the permanent behavior before plan-E2.
    let frontmatter: Record<string, unknown> = { type: nodeType, tags };
    if (row.frontmatterRaw) {
      try {
        const parsed = JSON.parse(row.frontmatterRaw) as Record<string, unknown>;
        // Merge parsed fields over the defaults so `type` and `tags` are
        // always present even if the note's YAML omits them.
        frontmatter = { type: nodeType, tags, ...parsed };
      } catch { /* parse failure — keep the synthesized defaults */ }
    }
    return {
      id: row.id,
      title: row.title,
      folder: row.folder,
      nodeType,
      frontmatter,
      tags,
      wordCount: row.wordCount ?? null,
      created: toEpochMs(row.createdAt),
      modified: toEpochMs(row.modifiedAt),
      contentHash: null,
      embeddingVersion: null,
      ingestRunId: null,
      x: null,
      y: null,
      body: null,
      // Enrichment fields — always present in response shape. Populated
      // whenever the join was possible (enrichment table exists) regardless
      // of the ?include=enrichment query param, because the bundled UI
      // (public/dist/app.js) reads these fields unconditionally for
      // community coloring and the node-detail panel. Gating them behind
      // include= silently broke community-color mode after enrichment.
      // (Codex round-45 P1 finding.) The row values are already NULL when
      // the DB has no enrichment data, so this is a no-op for unenriched
      // nodes and a non-regression for API consumers that ignored them.
      pagerank: joinEnabled ? (row.pagerank ?? null) : null,
      clusterId: joinEnabled ? (row.clusterId ?? null) : null,
      componentId: joinEnabled ? (row.componentId ?? null) : null,
      clusteringCoeff: joinEnabled ? (row.clusteringCoeff ?? null) : null,
    };
  });
  // Reference the unused query param so TypeScript doesn't flag it; we
  // intentionally keep the `includeEnrichment` read as a no-op for now to
  // avoid breaking third-party callers that set it.
  void includeEnrichment;

  return json({
    items,
    nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null,
    total: totalRes?.count ?? 0,
  });
}

export async function handleGraphEdgesRequest(url: URL, env: Env): Promise<Response> {
  const cursor = Math.max(Number.parseInt(url.searchParams.get("cursor") ?? "0", 10) || 0, 0);
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "2000", 10) || 2000, 1), 5000);

  const [pageRes, totalRes] = await Promise.all([
    env.DB.prepare(
      `SELECT id,
              source AS sourceId,
              target AS targetId,
              edge_type AS edgeType,
              weight
       FROM vault_edges
       WHERE id > ?
       ORDER BY id
       LIMIT ?`
    ).bind(cursor, limit).all<GraphEdgeRow>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM vault_edges").first<{ count: number }>(),
  ]);

  const rows = pageRes.results ?? [];
  const items = rows.map((row) => ({
    id: String(row.id),
    sourceId: row.sourceId,
    targetId: row.targetId,
    edgeType: row.edgeType,
    weight: row.weight,
    ingestRunId: null,
  }));

  return json({
    items,
    nextCursor: rows.length === limit ? String(rows[rows.length - 1]!.id) : null,
    total: totalRes?.count ?? 0,
  });
}

