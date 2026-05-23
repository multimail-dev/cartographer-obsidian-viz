import type { Env } from "../../env";

// Module-level counters for D1-first cache behaviour (zero-cost, useful in tests).
export let d1HitCount = 0;
export let d1MissCount = 0;
/** Reset counters — call between tests. */
export function resetNoteCounts(): void {
  d1HitCount = 0;
  d1MissCount = 0;
}

function normalizePath(notePath: string): string {
  let normalized = notePath.replace(/^\/+/, "");
  if (!normalized.endsWith(".md")) normalized += ".md";
  return normalized;
}

/** Strip leading slash + trailing .md to match the key used in vault_nodes.path
 *  (the canonical vault path without extension). (Codex P2 round-14 finding.) */
function normalizeD1Path(notePath: string): string {
  return notePath.replace(/^\/+/, "").replace(/\.md$/, "");
}

export async function handleNoteRequest(url: URL, env: Env): Promise<Response> {
  const path = url.searchParams.get("path");
  if (!path) {
    return new Response("missing path param", { status: 400 });
  }

  // R2-first: R2 is the source of truth. Distinguish R2 error (degraded →
  // D1 fallback ok) from R2 definitive miss (deleted note → 404, don't
  // serve stale D1). (Codex P1 round-13 correctness + P2 round-16 refinement.)
  let note: R2ObjectBody | null = null;
  let r2Errored = false;
  try {
    note = await env.VAULT.get(normalizePath(path));
  } catch {
    r2Errored = true;
  }
  if (note) {
    return new Response(await note.text(), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  // R2 definitively missing (not errored) — note deleted or never existed.
  // Return 404 without consulting the stale D1 cache.
  if (!r2Errored) {
    return new Response("not found", { status: 404 });
  }

  // R2 errored — degraded mode. Try D1 as last resort.
  d1MissCount++;
  const d1Path = normalizeD1Path(path);
  const nodeRow = await env.DB.prepare(
    "SELECT body FROM vault_nodes WHERE path = ?"
  ).bind(d1Path).first<{ body: string | null }>().catch(() => null);
  if (nodeRow?.body != null) {
    d1HitCount++;
    return new Response(nodeRow.body, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "X-Cartographer-Source": "d1-fallback",
      },
    });
  }

  return new Response("r2 unavailable", { status: 503 });
}

