import type { Env } from "../../env";

const MAX_RESULTS = 50;
const MAX_SCAN = 20000;

interface LikeRow {
  id: string;
  title: string;
  tags: string;
  nodeType: string | null;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function ftsQuote(raw: string): string {
  const cleaned = raw.replace(/["]/g, " ").replace(/[()]/g, " ").trim();
  if (!cleaned) return '""';
  return `"${cleaned}"*`;
}

async function searchViaFts5(env: Env, q: string): Promise<string[] | null> {
  try {
    const res = await env.DB.prepare(
      `SELECT path
       FROM vault_fts
       WHERE vault_fts MATCH ?
       ORDER BY bm25(vault_fts, 6.0, 10.0, 1.0, 4.0)
       LIMIT ?`
    ).bind(ftsQuote(q), MAX_RESULTS).all<{ path: string }>();
    return (res.results ?? []).map((row) => row.path);
  } catch (error) {
    const message = String(error);
    if (message.includes("no such table: vault_fts") || message.includes("fts5: syntax error")) {
      return null;
    }
    throw error;
  }
}

async function searchViaLikeScan(env: Env, q: string): Promise<string[]> {
  const pattern = `%${q.toLowerCase()}%`;
  const res = await env.DB.prepare(
    `SELECT path AS id, title, tags, note_type AS nodeType
     FROM vault_nodes
     WHERE path NOT GLOB '__*'
       AND (
         LOWER(title) LIKE ?
         OR LOWER(path) LIKE ?
         OR LOWER(tags) LIKE ?
         OR LOWER(COALESCE(note_type, '')) LIKE ?
       )
     LIMIT ?`
  ).bind(pattern, pattern, pattern, pattern, MAX_SCAN).all<LikeRow>();

  const query = q.toLowerCase();
  const scored: Array<{ id: string; score: number }> = [];
  for (const row of res.results ?? []) {
    let score = 0;
    if (row.title.toLowerCase().includes(query)) score += 10;
    if (row.id.toLowerCase().includes(query)) score += 5;
    if ((row.tags ?? "").toLowerCase().includes(query)) score += 8;
    if ((row.nodeType ?? "").toLowerCase().includes(query)) score += 3;
    if (score > 0) scored.push({ id: row.id, score });
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, MAX_RESULTS).map((row) => row.id);
}

export async function handleSearchRequest(url: URL, env: Env): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return json({ results: [] });

  const ftsResults = await searchViaFts5(env, q);
  if (ftsResults !== null) {
    return json({ results: ftsResults });
  }

  return json({ results: await searchViaLikeScan(env, q) });
}

