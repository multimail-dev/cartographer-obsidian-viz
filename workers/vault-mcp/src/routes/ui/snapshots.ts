import type { Env } from "../../env";
import { readVaultSnapshot } from "../../snapshots";

interface SnapshotRunRow {
  run_id: string;
  created_at: number;
  node_count: number;
  edge_count: number;
  r2_key: string;
  status: string;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

export async function handleSnapshotsRequest(_request: Request, env: Env, segments: string[]): Promise<Response> {
  if (segments.length === 0) {
    const res = await env.DB.prepare(
      `SELECT run_id, created_at, node_count, edge_count, r2_key, status
       FROM snapshot_runs
       ORDER BY created_at DESC
       LIMIT 50`
    ).all<SnapshotRunRow>();

    return json({
      runs: (res.results ?? []).map((row) => ({
        run_id: row.run_id,
        created_at: row.created_at,
        node_count: row.node_count,
        edge_count: row.edge_count,
        r2_key: row.r2_key,
        status: row.status,
      })),
    });
  }

  const runId = segments[0];
  if (!runId) {
    return json({ error: "runId required" }, { status: 400 });
  }

  const snapshot = await readVaultSnapshot(env, runId);
  if (!snapshot) {
    return json({ error: "snapshot not found", run_id: runId }, { status: 404 });
  }

  return json({
    run_id: runId,
    node_count: snapshot.nodes.length,
    edge_count: snapshot.edges.length,
    has_edges_separator: snapshot.raw.includes("---EDGES---"),
    has_header: snapshot.raw.startsWith("# snapshot v1"),
    bytes: new TextEncoder().encode(snapshot.raw).byteLength,
    sample_node: snapshot.nodes[0] ?? null,
    sample_edge: snapshot.edges[0] ?? null,
  });
}

