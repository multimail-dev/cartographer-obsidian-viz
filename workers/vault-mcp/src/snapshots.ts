import type { Env } from "./env";

export interface VaultSnapshotNode {
  path: string;
  title: string;
  note_type: string | null;
  folder: string;
  tags: string;
  aliases: string | null;
  size: number;
  modified_at: string;
  indexed_at: string | null;
  in_degree: number | null;
  out_degree: number | null;
}

export interface VaultSnapshotEdge {
  id: number;
  source: string;
  target: string;
  edge_type: string;
  weight: number;
  created_at: string | null;
}

export const VAULT_SNAPSHOT_PREFIX = "vault-snapshots";
export const EDGES_SEPARATOR = "---EDGES---";

function snapshotObjectKey(runId: string): string {
  return `${VAULT_SNAPSHOT_PREFIX}/${runId}/snapshot.jsonl`;
}

export async function writeVaultSnapshot(env: Env): Promise<string> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const createdAt = Date.now();
  const r2Key = snapshotObjectKey(runId);

  await env.DB.prepare(
    `INSERT INTO snapshot_runs (run_id, created_at, node_count, edge_count, r2_key, status)
     VALUES (?, ?, 0, 0, ?, 'pending')`
  ).bind(runId, createdAt, r2Key).run();

  try {
    const lines: string[] = [];
    let nodeCount = 0;
    let edgeCount = 0;
    let nodeCursor = "";

    while (true) {
      const page = await env.DB.prepare(
        `SELECT path, title, note_type, folder, tags, aliases, size, modified_at, indexed_at, in_degree, out_degree
         FROM vault_nodes
         WHERE path NOT GLOB '__*' AND (? = '' OR path > ?)
         ORDER BY path
         LIMIT 1000`
      ).bind(nodeCursor, nodeCursor).all<VaultSnapshotNode>();

      const rows = page.results ?? [];
      if (rows.length === 0) break;
      for (const row of rows) {
        lines.push(JSON.stringify(row));
        nodeCount++;
      }
      nodeCursor = rows[rows.length - 1]!.path;
    }

    lines.push(EDGES_SEPARATOR);

    let edgeCursor = 0;
    while (true) {
      const page = await env.DB.prepare(
        `SELECT id, source, target, edge_type, weight, created_at
         FROM vault_edges
         WHERE id > ?
         ORDER BY id
         LIMIT 1000`
      ).bind(edgeCursor).all<VaultSnapshotEdge>();

      const rows = page.results ?? [];
      if (rows.length === 0) break;
      for (const row of rows) {
        lines.push(JSON.stringify(row));
        edgeCount++;
      }
      edgeCursor = rows[rows.length - 1]!.id;
    }

    const body = `${lines.join("\n")}\n`;
    await env.VAULT_SNAPSHOTS.put(r2Key, body, {
      httpMetadata: {
        contentType: "application/jsonl",
      },
      customMetadata: {
        run_id: runId,
        node_count: String(nodeCount),
        edge_count: String(edgeCount),
        written_at: String(Date.now()),
      },
    });

    await env.DB.prepare(
      `UPDATE snapshot_runs
       SET node_count = ?, edge_count = ?, status = 'persisted'
       WHERE run_id = ?`
    ).bind(nodeCount, edgeCount, runId).run();

    return runId;
  } catch (error) {
    await env.DB.prepare(
      "UPDATE snapshot_runs SET status = 'failed' WHERE run_id = ?"
    ).bind(runId).run().catch(() => undefined);
    throw error;
  }
}

export async function readVaultSnapshot(
  env: Env,
  runId: string,
): Promise<{ nodes: VaultSnapshotNode[]; edges: VaultSnapshotEdge[]; raw: string } | null> {
  const obj = await env.VAULT_SNAPSHOTS.get(snapshotObjectKey(runId));
  if (!obj) return null;

  const raw = await obj.text();
  const nodes: VaultSnapshotNode[] = [];
  const edges: VaultSnapshotEdge[] = [];
  let inEdges = false;

  for (const line of raw.split("\n")) {
    if (!line) continue;
    if (line === EDGES_SEPARATOR) {
      inEdges = true;
      continue;
    }
    if (line.startsWith("#")) continue;
    try {
      const parsed = JSON.parse(line);
      if (inEdges) edges.push(parsed as VaultSnapshotEdge);
      else nodes.push(parsed as VaultSnapshotNode);
    } catch {
      // Ignore malformed lines so read endpoints stay resilient.
    }
  }

  return { nodes, edges, raw };
}
