import type { Env } from "../../env";
import type { VaultMetaResponse } from "@vault-graph/contract";

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60, s-maxage=300",
    },
  });
}

function toEpochMs(value: string | null): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function parseOrZero(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export async function handleMetaRequest(env: Env): Promise<Response> {
  const [nodeCount, edgeCount, edgeTypes, topFolders, lastReloadRow, metaRows] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM vault_nodes WHERE path NOT GLOB '__*'").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM vault_edges").first<{ count: number }>(),
    env.DB.prepare(
      "SELECT edge_type AS edgeType FROM vault_edges GROUP BY edge_type ORDER BY COUNT(*) DESC, edge_type ASC"
    ).all<{ edgeType: string }>(),
    env.DB.prepare(
      `SELECT folder, COUNT(*) AS count
       FROM vault_nodes
       WHERE path NOT GLOB '__*'
       GROUP BY folder
       ORDER BY count DESC, folder ASC
       LIMIT 20`
    ).all<{ folder: string; count: number }>(),
    env.DB.prepare(
      "SELECT indexed_at FROM vault_nodes WHERE path = '__last_build_completed__'"
    ).first<{ indexed_at: string | null }>(),
    env.DB.prepare(
      `SELECT key, value
       FROM meta
       WHERE key IN ('enrichment_version', 'last_enrichment_at', 'enrichment_community_count', 'last_ingest_run_id')`
    ).all<{ key: string; value: string }>().catch(() => ({ results: [] as Array<{ key: string; value: string }> })),
  ]);

  const topTagsRes = await env.DB.prepare(
    // Qualify `path` as vault_nodes.path — json_each exposes its own `path`
    // column (it's a JSON-pointer field in the virtual table), so the
    // unqualified reference is ambiguous and some SQLite builds error.
    // Found by cross-seam.test.ts on 2026-04-13.
    `SELECT json_each.value AS tag, COUNT(*) AS count
     FROM vault_nodes, json_each(CASE WHEN json_valid(tags) THEN tags ELSE '[]' END)
     WHERE vault_nodes.path NOT GLOB '__*'
     GROUP BY json_each.value
     ORDER BY count DESC, tag ASC
     LIMIT 20`
  ).all<{ tag: string; count: number }>().catch(() => ({ results: [] as Array<{ tag: string; count: number }> }));

  const byKey = new Map<string, string>();
  for (const row of (metaRows as { results: Array<{ key: string; value: string }> }).results ?? []) {
    byKey.set(row.key, row.value);
  }

  const response: VaultMetaResponse = {
    nodeCount: nodeCount?.count ?? 0,
    edgeCount: edgeCount?.count ?? 0,
    edgeTypes: (edgeTypes.results ?? []).map((row) => row.edgeType),
    topTags: (topTagsRes.results ?? []).map((row) => ({ tag: row.tag, count: row.count })),
    topFolders: (topFolders.results ?? []).map((row) => ({ folder: row.folder, count: row.count })),
    lastReload: toEpochMs(lastReloadRow?.indexed_at ?? null),
    enrichmentVersion: parseOrZero(byKey.get("enrichment_version")),
    lastEnrichmentAt: parseOrZero(byKey.get("last_enrichment_at")),
    enrichmentCommunityCount: parseOrZero(byKey.get("enrichment_community_count")),
    // Populate from meta table — syncGraph writes this on each completed ingest.
    // Migration 0004 seeds the key with 'bootstrap' so the orchestrator's
    // subquery guard has a non-NULL starting point. Surface that sentinel
    // as null to API consumers so UI logic that treats any non-null id as
    // "ingest completed" doesn't trip on an empty database.
    // (Codex P2 round-3 + round-5 findings.)
    lastIngestRunId: (() => {
      const v = byKey.get("last_ingest_run_id");
      return v && v !== "bootstrap" ? v : null;
    })(),
  };

  return json(response);
}

