import type { Env } from "../../env";
import { readVaultSnapshot, type VaultSnapshotEdge, type VaultSnapshotNode } from "../../snapshots";

interface FieldChange {
  id: string;
  field_changes: string[];
}

interface EdgeKey {
  source: string;
  target: string;
  type: string;
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

function nodeFieldChanges(fromNode: VaultSnapshotNode, toNode: VaultSnapshotNode): string[] {
  const changes: string[] = [];
  if (fromNode.title !== toNode.title) changes.push("title");
  if (fromNode.folder !== toNode.folder) changes.push("folder");
  if (fromNode.note_type !== toNode.note_type) changes.push("node_type");
  if (fromNode.tags !== toNode.tags) changes.push("tags");
  if (fromNode.aliases !== toNode.aliases) changes.push("aliases");
  if (fromNode.size !== toNode.size) changes.push("size");
  if (fromNode.modified_at !== toNode.modified_at) changes.push("modified_at");
  if (fromNode.indexed_at !== toNode.indexed_at) changes.push("indexed_at");
  if (fromNode.in_degree !== toNode.in_degree) changes.push("in_degree");
  if (fromNode.out_degree !== toNode.out_degree) changes.push("out_degree");
  return changes;
}

function diffNodes(fromNodes: VaultSnapshotNode[], toNodes: VaultSnapshotNode[]) {
  const fromMap = new Map(fromNodes.map((node) => [node.path, node]));
  const toMap = new Map(toNodes.map((node) => [node.path, node]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: FieldChange[] = [];

  for (const [path, node] of toMap) {
    const previous = fromMap.get(path);
    if (!previous) {
      added.push(path);
      continue;
    }
    const fieldChanges = nodeFieldChanges(previous, node);
    if (fieldChanges.length > 0) {
      changed.push({ id: path, field_changes: fieldChanges });
    }
  }

  for (const path of fromMap.keys()) {
    if (!toMap.has(path)) removed.push(path);
  }

  added.sort();
  removed.sort();
  changed.sort((a, b) => a.id.localeCompare(b.id));
  return { added, removed, changed };
}

function edgeKey(edge: VaultSnapshotEdge): string {
  return `${edge.source}|${edge.target}|${edge.edge_type}`;
}

function diffEdges(fromEdges: VaultSnapshotEdge[], toEdges: VaultSnapshotEdge[]) {
  const fromMap = new Map(fromEdges.map((edge) => [edgeKey(edge), edge]));
  const toMap = new Map(toEdges.map((edge) => [edgeKey(edge), edge]));
  const added: EdgeKey[] = [];
  const removed: EdgeKey[] = [];

  for (const [key, edge] of toMap) {
    if (!fromMap.has(key)) {
      added.push({ source: edge.source, target: edge.target, type: edge.edge_type });
    }
  }

  for (const [key, edge] of fromMap) {
    if (!toMap.has(key)) {
      removed.push({ source: edge.source, target: edge.target, type: edge.edge_type });
    }
  }

  added.sort((a, b) => `${a.source}|${a.target}|${a.type}`.localeCompare(`${b.source}|${b.target}|${b.type}`));
  removed.sort((a, b) => `${a.source}|${a.target}|${a.type}`.localeCompare(`${b.source}|${b.target}|${b.type}`));
  return { added, removed };
}

export async function handleDiffRequest(url: URL, env: Env): Promise<Response> {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  if (!from || !to) {
    return json({ error: "from and to run_ids required" }, { status: 400 });
  }
  if (from === to) {
    return json({ error: "from and to must differ" }, { status: 400 });
  }

  const start = Date.now();
  const [fromSnapshot, toSnapshot] = await Promise.all([
    readVaultSnapshot(env, from),
    readVaultSnapshot(env, to),
  ]);

  if (!fromSnapshot) {
    return json({ error: "from snapshot not found", run_id: from }, { status: 404 });
  }
  if (!toSnapshot) {
    return json({ error: "to snapshot not found", run_id: to }, { status: 404 });
  }

  const nodeDiff = diffNodes(fromSnapshot.nodes, toSnapshot.nodes);
  const edgeDiff = diffEdges(fromSnapshot.edges, toSnapshot.edges);

  return json({
    from,
    to,
    nodes: nodeDiff,
    edges: edgeDiff,
    summary: {
      node_added: nodeDiff.added.length,
      node_removed: nodeDiff.removed.length,
      node_changed: nodeDiff.changed.length,
      edge_added: edgeDiff.added.length,
      edge_removed: edgeDiff.removed.length,
    },
    elapsed_ms: Date.now() - start,
  });
}

