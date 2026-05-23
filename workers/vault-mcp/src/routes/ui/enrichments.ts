import type { Env } from "../../env";
import type { EnrichmentsResponse } from "@vault-graph/contract";

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/** Probe which enrichment table name exists in this D1 instance.
 *  Deterministically prefers vault_enrichment when both exist during the
 *  plan-B9 transition window. (Codex P2 round-4.) */
async function resolveEnrichmentTable(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name IN ('vault_enrichment', 'vault_centrality')
     ORDER BY CASE WHEN name = 'vault_enrichment' THEN 0 ELSE 1 END
     LIMIT 1`
  ).first<{ name: string }>().catch(() => null);
  return row?.name ?? null;
}

export async function handleEnrichmentsRequest(env: Env): Promise<Response> {
  // Read enrichment state from the `meta` table (key/value store) and from
  // vault_enrichment (or vault_centrality during the transition window).
  // Return zeros when tables exist but have no rows; table absence also returns zeros.

  const metaRows = await env.DB.prepare(
    `SELECT key, value
     FROM meta
     WHERE key IN ('enrichment_version', 'last_enrichment_at', 'enrichment_community_count')`
  ).all<{ key: string; value: string }>().catch(() => ({ results: [] as Array<{ key: string; value: string }> }));

  const byKey = new Map<string, string>();
  for (const row of metaRows.results ?? []) {
    byKey.set(row.key, row.value);
  }

  // Live phase lives in enrich_cursor, not meta. The orchestrator transitions
  // algorithm → running_algorithms → algorithm. The /api/enrichments response
  // previously read a nonexistent meta key and always reported 'idle'.
  // (Codex P2 round-2 finding.)
  const cursorRow = await env.DB.prepare(
    `SELECT phase FROM enrich_cursor WHERE id = 1`
  ).first<{ phase: string }>().catch(() => null);
  const phase = cursorRow?.phase ?? "idle";

  // Probe cluster_count from the enrichment table if neither meta table key exists.
  const enrichTable = await resolveEnrichmentTable(env);
  let communityCount = 0;
  if (enrichTable) {
    const clusterRow = await env.DB.prepare(
      `SELECT COUNT(DISTINCT cluster_id) AS count FROM ${enrichTable} WHERE cluster_id IS NOT NULL`
    ).first<{ count: number }>().catch(() => null);
    if (clusterRow?.count != null) communityCount = clusterRow.count;
  }

  const parseOrZero = (value: string | undefined): number => {
    if (value === undefined) return 0;
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  };

  const metaCommunity = parseOrZero(byKey.get("enrichment_community_count"));
  const response: EnrichmentsResponse = {
    version: parseOrZero(byKey.get("enrichment_version")),
    lastRunAt: parseOrZero(byKey.get("last_enrichment_at")),
    communityCount: metaCommunity > 0 ? metaCommunity : communityCount,
    phase,
  };

  return json(response);
}

