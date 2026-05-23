import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleAccessRequest } from "./access-handler";
import type { Env } from "./env";
import {
  VAULT_MCP_EDGE_TYPES,
  VAULT_MCP_OP_ORIGINS,
  VAULT_MCP_OP_TYPES,
  type VaultMcpOpOrigin,
  type VaultMcpOpType,
  EDGE_TYPE,
} from "@vault-graph/contract";
import { handleUiAssetRequest } from "./ui-handler";
import { handleUiRequest } from "./ui-routes";
import { writeVaultSnapshot } from "./snapshots";
import { verifyBearer } from "./auth/bearer";
import { ulid } from "./ulid";
import { sanitizeFtsQuery } from "./fts-sanitize";
import { verifyCfAccessJwt, CfAccessError, type AccessClaims } from "./auth/cf-access-jwt";

import { runVerifierTwoPhase, type VerifierResponse } from "./l2/two-phase-verifier";
import { runAlgorithmEnrichment } from "./cron/enrich-algorithms";
import { runBodyBackfillSlice } from "./cron/backfill-body";
import { hasPlan005VaultNodeColumns, hasVaultEdgesIngestRunId } from "./schema-probes";
import { honoApp, withFallthrough } from "./routes/hono-app";
export type { Env };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type McpState = Record<string, never>;

// VaultNode, VaultEdge, ExtractedNote moved to ./extract.ts

type AddEdgeOp = {
  op_type: "add_edge";
  origin: VaultMcpOpOrigin;
  payload: {
    source: string;
    target: string;
    edge_type: string;
    weight: number;
    ingest_run_id?: string | null;
  };
};

type RemoveEdgeOp = {
  op_type: "remove_edge";
  origin: VaultMcpOpOrigin;
  payload: {
    source: string;
    target: string;
    edge_type: string;
  };
};

type UpsertNodeOp = {
  op_type: "upsert_node";
  origin: VaultMcpOpOrigin;
  payload: Record<string, unknown> & { path: string };
};

type DeleteNodeOp = {
  op_type: "delete_node";
  origin: VaultMcpOpOrigin;
  payload: { path: string };
};

export type Op = AddEdgeOp | RemoveEdgeOp | UpsertNodeOp | DeleteNodeOp;

type ApplyOpsOptions = {
  materialize?: boolean;
  reconcileExtract?: {
    path: string;
    desiredEdges: VaultEdge[];
    nodeStmt: D1PreparedStatement;
  };
};

type ApplyOpsResult = {
  insertedOps: number;
  insertedEdges: number;
  removedEdges: number;
  upsertedNodes: number;
  deletedNodes: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePath(notePath: string): string {
  let p = notePath.replace(/^\/+/, "");
  if (!p.endsWith(".md")) p += ".md";
  return p;
}

function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
}

// parseFrontmatterExtended moved to ./parse.ts (plan-E2) so backfill-body.ts
// can share it without pulling the full index.ts OAuth import graph.
export { parseFrontmatterExtended } from "./parse";
import { parseFrontmatterExtended } from "./parse";

// extractEdgesFromNote and pure helpers moved to ./extract.ts so local
// build-graph tooling can share extraction logic without pulling the full
// Worker import graph (OAuth, Durable Objects, etc.).
export { extractEdgesFromNote, type ExtractedNote } from "./extract";
import {
  extractEdgesFromNote,
  stripExtension,
  getFolderFromPath,
  getTitleFromPath,
  type VaultNode,
  type VaultEdge,
} from "./extract";

// stripExtension, getFolderFromPath moved to ./extract.ts

function toFtsMatchQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return trimmed;
  return `"${trimmed.replace(/"/g, '""')}"`;
}

// getTitleFromPath moved to ./extract.ts

function opKey(source: string, target: string, edge_type: string): string {
  return `${source}\u0000${target}\u0000${edge_type}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// L2 snapshot fixes (#67-71) consumer inventory:
//   /api/enrich/status → polled by UI (public/index.html not in repo), external
//     cron. Response shape unchanged (5 fields, same types).
//   toolVaultHealth (stats/topics/phantoms) → MCP tool vault_health. Response
//     shapes unchanged (same JSON keys and value types).
//   buildGraph finalize (#70) → internal, return value is JSON.stringify'd
//     response to /api/build-graph. Added no new fields; renamed internal vars
//     only (finalNodeCount/finalEdgeCount).
//   /api/digest (#67) → DigestResponse DTO in packages/vault-graph-contract/
//     src/api-dtos.ts: { date, items, total }. Shape preserved; total now
//     derived from .results.length (same value as old COUNT(*)).
//   runFastScore (#71) → response to /api/fast-score. Added 2 new fields
//     (snapshot_stale, snapshot_watermark) — additive, no consumers parse them
//     yet; existing fields unchanged.

/** Parse UNION ALL {kind,val} rows into a Map. Used by L2 snapshot fixes #68/#70. */
function scalarMap(results: { kind: string; val: string }[]): Map<string, string> {
  return new Map(results.map((r) => [r.kind, r.val]));
}

const EDGES_BY_TYPE_SQL = "SELECT edge_type, COUNT(*) as count FROM vault_edges GROUP BY edge_type ORDER BY count DESC";

function badMaintenanceResult(): SyncResult {
  return {
    body: JSON.stringify({ error: "maintenance_mode", message: "tier-a maintenance mode is active; retry after reset completes" }),
    status: 503,
    headers: { "Content-Type": "application/json" },
  };
}

async function checkMaintenanceMode(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1
       FROM vault_nodes
      WHERE path = '__maintenance_mode__'
        AND indexed_at > datetime('now')
      LIMIT 1`
  ).first<{ 1: number }>().catch(() => null);
  return Boolean(row);
}

function edgeFromAddOp(op: AddEdgeOp): VaultEdge {
  return {
    source: op.payload.source,
    target: op.payload.target,
    edge_type: op.payload.edge_type,
    weight: op.payload.weight,
    ingest_run_id: op.payload.ingest_run_id ?? null,
    origin: op.origin,
  };
}

// Shared bulk-INSERT builder for vault_edges. Both applyOps branches (the
// reconcileExtract path and the materialize-add_edge-run path) use identical
// SQL + bindings shapes — only the input type differs. Centralizing here
// removes drift risk (previously two parallel 30-line copy-pasta blocks with
// independent K_EDGES comments).
type VaultEdgeInsertInput = {
  source: string;
  target: string;
  edge_type: string;
  weight: number;
  ingest_run_id?: string | null;
  origin: string;
};
function buildVaultEdgesInsertStmt(
  env: Env,
  edges: VaultEdgeInsertInput[],
  hasIngestRunId: boolean,
): D1PreparedStatement {
  const placeholders = edges.map(() =>
    hasIngestRunId ? "(?, ?, ?, ?, ?, ?)" : "(?, ?, ?, ?, ?)"
  ).join(", ");
  const bindings = edges.flatMap((edge) =>
    hasIngestRunId
      ? [edge.source, edge.target, edge.edge_type, edge.weight, edge.ingest_run_id ?? null, edge.origin]
      : [edge.source, edge.target, edge.edge_type, edge.weight, edge.origin]
  );
  const sql = hasIngestRunId
    ? `INSERT OR IGNORE INTO vault_edges (source, target, edge_type, weight, ingest_run_id, origin) VALUES ${placeholders}`
    : `INSERT OR IGNORE INTO vault_edges (source, target, edge_type, weight, origin) VALUES ${placeholders}`;
  return env.DB.prepare(sql).bind(...bindings);
}

export async function backfillTierAOps(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE vault_edges
         SET origin = 'finalize'
       WHERE edge_type IN ('folder', 'temporal', 'tag_cooccurrence')
    `),
    env.DB.prepare(`
      UPDATE vault_edges
         SET origin = 'ingest_triples'
       WHERE edge_type NOT IN ('folder', 'temporal', 'tag_cooccurrence')
         AND ingest_run_id IS NULL
    `),
  ]);

  await env.DB.prepare("DELETE FROM vault_ops").run();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO vault_ops (op_type, payload_json, origin, ts)
      SELECT
        'add_edge',
        json_object(
          'source', source,
          'target', target,
          'edge_type', edge_type,
          'weight', weight,
          'ingest_run_id', ingest_run_id
        ),
        origin,
        datetime('now')
      FROM vault_edges
    `),
    env.DB.prepare(`
      INSERT INTO vault_ops (op_type, payload_json, origin, ts)
      SELECT
        'upsert_node',
        json_object(
          'path', path,
          'title', title,
          'note_type', note_type,
          'folder', folder,
          'tags', tags,
          'aliases', aliases,
          'size', size,
          'modified_at', modified_at,
          'content_hash', content_hash
        ),
        'migration',
        datetime('now')
      FROM vault_nodes
      WHERE path NOT GLOB '__*'
    `),
  ]);
}

// ---------------------------------------------------------------------------
// Phase 3: ULID backfill for existing vault_ops rows
// ---------------------------------------------------------------------------
//
// Populates the `ulid` column for rows that predate the Phase 3 migration.
// Uses the row's existing `ts` to seed the ULID timestamp portion so that
// lexicographic ordering matches chronological ordering. Processes in chunks
// of 200 (200×2 bindings = 400, well within D1's 100-stmt batch budget via
// individual UPDATE statements batched together).
//
// Idempotent: only touches rows WHERE ulid IS NULL. Returns total backfilled.
// Called from /api/sync-ops (guarded by a fast EXISTS check).
//
// Consumer trace (Phase 3 modified exports):
//   src/ulid.ts → src/index.ts (this file: applyOps, backfillVaultOpsUlids,
//                 syncGraphInner ingestRunId, buildGraph buildRunId),
//                 tests/ulid.test.ts
//   backfillVaultOpsUlids → /api/sync-ops handler in this file (line ~4983)
//   scripts/lib/config.ts → scripts/sync-local.ts, scripts/parity-check.ts,
//                            tests/config-env-precedence.test.ts

export async function backfillVaultOpsUlids(env: Env): Promise<{ backfilled: number }> {
  let totalBackfilled = 0;
  const CHUNK_SIZE = 200;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await env.DB.prepare(
      "SELECT id, ts FROM vault_ops WHERE ulid IS NULL ORDER BY id LIMIT ?"
    ).bind(CHUNK_SIZE).all<{ id: number; ts: string }>();

    if (!rows.results?.length) break;

    const stmts = rows.results.map((row) => {
      // Parse D1 datetime string to ms epoch for ULID timestamp seeding.
      // D1 datetime('now') produces 'YYYY-MM-DD HH:MM:SS' format.
      const seedMs = new Date(row.ts.replace(" ", "T") + "Z").getTime();
      const rowUlid = ulid(Number.isFinite(seedMs) ? seedMs : Date.now());
      return env.DB.prepare("UPDATE vault_ops SET ulid = ? WHERE id = ? AND ulid IS NULL")
        .bind(rowUlid, row.id);
    });

    await env.DB.batch(stmts);
    totalBackfilled += rows.results.length;

    if (rows.results.length < CHUNK_SIZE) break;
  }

  return { backfilled: totalBackfilled };
}

export async function applyOps(
  env: Env,
  ops: Op[],
  options: ApplyOpsOptions = {},
): Promise<ApplyOpsResult> {
  const materialize = options.materialize ?? true;
  const opStmts: D1PreparedStatement[] = [];
  const opKinds: Array<"ops"> = [];
  const stmts: D1PreparedStatement[] = [];
  const resultKinds: Array<"add" | "remove" | "upsert_node" | "delete_node"> = [];
  const hasEdgeIngestRunId = (materialize || !!options.reconcileExtract)
    ? await hasVaultEdgesIngestRunId(env)
    : false;

  // PR2: Pre-scan vault_edges for delete_node cascade ordering. Must happen
  // BEFORE any mutations so cascaded remove_edge ops can interleave into
  // opsForLog before the delete_node op. Only for the materialize path;
  // reconcileExtract callers supply their own add/remove ops.
  //
  // Concurrency + safety:
  //   - Pre-scan queries run via Promise.all so K delete_node ops pay one
  //     round-trip of latency instead of K sequential.
  //   - LIMIT 801 lets us detect "more than 800 without reading more."
  //   - Cumulative cascade cap of 800 across the whole batch matches the
  //     reconcileExtract per-note edge cap; this keeps opsForLog's cascaded
  //     remove_edges from blowing past D1's 100-stmt batch budget when
  //     interleaved with the delete_node stmt and ops-log inserts.
  const deleteNodeCascades = new Map<
    string,
    Array<{ source: string; target: string; edge_type: string; origin: string }>
  >();
  if (materialize && !options.reconcileExtract) {
    const deletePaths = ops
      .filter((op): op is DeleteNodeOp => op.op_type === "delete_node")
      .map((op) => op.payload.path);
    if (deletePaths.length > 0) {
      const scans = await Promise.all(
        deletePaths.map((path) =>
          env.DB.prepare(
            "SELECT source, target, edge_type, origin FROM vault_edges WHERE source = ?1 OR target = ?1 LIMIT 801"
          )
            .bind(path)
            .all<{ source: string; target: string; edge_type: string; origin: string }>()
        )
      );
      let totalCascades = 0;
      for (let i = 0; i < deletePaths.length; i++) {
        const path = deletePaths[i];
        const results = scans[i].results ?? [];
        totalCascades += results.length;
        if (totalCascades > 800) {
          throw new Error(
            `delete_node cascade overflow: total touching edges across ${deletePaths.length} delete_node op(s) exceeds 800 (overflow triggered on path ${path}, which contributed ${results.length >= 801 ? "801+ (query capped at LIMIT 801)" : `${results.length}`} edges; aggregate ran over when added to prior paths). D1 100-stmt batch budget cap. Operator: split the batch or delete touching edges in a separate applyOps call before issuing delete_node.`
          );
        }
        deleteNodeCascades.set(path, results);
      }
    }
  }

  if (options.reconcileExtract) {
    const { path, desiredEdges, nodeStmt } = options.reconcileExtract;
    if (desiredEdges.length > 800) {
      throw new Error(
        `extractEdgesFromNote produced ${desiredEdges.length} edges for ${path}; exceeds per-note cap of 800 (D1 100-stmt batch budget). Operator: investigate note for runaway link expansion.`
      );
    }

    stmts.push(env.DB.prepare(`
      DELETE FROM vault_edges
      WHERE origin = 'extract' AND source = ?1 AND edge_type != 'spoke_in'
    `).bind(path));
    resultKinds.push("remove");

    stmts.push(env.DB.prepare(`
      DELETE FROM vault_edges
      WHERE origin = 'extract' AND target = ?1 AND edge_type = 'spoke_in'
    `).bind(path));
    resultKinds.push("remove");

    // K_EDGES=15: our INSERT binds origin as a parameter (6 params/row with
    // ingest_run_id) rather than a SQL literal, so 15×6=90 binds stays under
    // D1's 100-bind cap. Plan's K_EDGES=18 assumed literal origin (5 params);
    // our param-bound approach trades 3 rows/batch for caller origin
    // flexibility.
    for (const edgesChunk of chunk(desiredEdges, 15)) {
      stmts.push(
        buildVaultEdgesInsertStmt(
          env,
          edgesChunk.map((e) => ({ ...e, origin: e.origin ?? "extract" })),
          hasEdgeIngestRunId,
        )
      );
      resultKinds.push("add");
    }

    stmts.push(nodeStmt);
    resultKinds.push("upsert_node");
  }

  // Build the ops-log sequence. For delete_node ops in the materialize path,
  // cascaded remove_edge ops are interleaved BEFORE the delete_node op so
  // vault_ops.id ordering reflects emission order. Each cascaded remove_edge
  // carries the ORIGINAL edge's origin — not the delete_node caller's origin —
  // so replay-path DELETE statements (origin-scoped) match the correct rows.
  // (PR2 r2 fix: was op.origin, missing cross-origin edges during replay.)
  const opsForLog: Op[] = [];
  for (const op of ops) {
    if (op.op_type === "delete_node" && deleteNodeCascades.size > 0) {
      const cascades = deleteNodeCascades.get((op as DeleteNodeOp).payload.path) ?? [];
      for (const edge of cascades) {
        opsForLog.push({
          op_type: "remove_edge",
          origin: edge.origin as Op["origin"],
          payload: { source: edge.source, target: edge.target, edge_type: edge.edge_type },
        });
      }
    }
    opsForLog.push(op);
  }

  if (!options.reconcileExtract && materialize) {
    // Walk opsForLog in strict emission order (matches vault_ops.id order for
    // replay semantics). Contiguous add_edge runs are bulk-inserted via
    // buildVaultEdgesInsertStmt; other op types emit one stmt each.
    // K_EDGES rationale: see reconcileExtract branch comment above.
    const K_EDGES = 15;

    let idx = 0;
    while (idx < opsForLog.length) {
      const op = opsForLog[idx];
      if (op.op_type === "add_edge") {
        let end = idx;
        while (end < opsForLog.length && opsForLog[end].op_type === "add_edge") end++;
        const run = opsForLog.slice(idx, end) as AddEdgeOp[];
        for (const runChunk of chunk(run, K_EDGES)) {
          stmts.push(
            buildVaultEdgesInsertStmt(
              env,
              runChunk.map((aop) => ({
                source: aop.payload.source,
                target: aop.payload.target,
                edge_type: aop.payload.edge_type,
                weight: aop.payload.weight,
                ingest_run_id: aop.payload.ingest_run_id ?? null,
                origin: aop.origin,
              })),
              hasEdgeIngestRunId,
            )
          );
          resultKinds.push("add");
        }
        idx = end;
      } else if (op.op_type === "remove_edge") {
        stmts.push(
          env.DB.prepare(
            "DELETE FROM vault_edges WHERE origin = ? AND source = ? AND target = ? AND edge_type = ?"
          ).bind(op.origin, op.payload.source, op.payload.target, op.payload.edge_type)
        );
        resultKinds.push("remove");
        idx++;
      } else if (op.op_type === "delete_node") {
        // PR2: apply-time delete_node ONLY deletes vault_nodes — no edge cascade.
        // Cascaded remove_edge ops were already interleaved into opsForLog
        // BEFORE this delete_node op at emission time, so the preceding iterations
        // of this loop have already emitted the right DELETE stmts for each edge.
        // Edges that land AFTER a delete_node (out-of-order add_edge for same node)
        // remain as phantoms; toolFindRelated phantom-filters them at read time.
        stmts.push(env.DB.prepare("DELETE FROM vault_nodes WHERE path = ?").bind(op.payload.path));
        resultKinds.push("delete_node");
        idx++;
      } else if (op.op_type === "upsert_node") {
        stmts.push(
          env.DB.prepare(`
            INSERT INTO vault_nodes (path, title, note_type, folder, tags, aliases, size, modified_at, indexed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(path) DO UPDATE SET
              title = excluded.title,
              note_type = excluded.note_type,
              folder = excluded.folder,
              tags = excluded.tags,
              aliases = excluded.aliases,
              size = excluded.size,
              modified_at = excluded.modified_at,
              indexed_at = excluded.indexed_at
          `).bind(
            op.payload.path,
            op.payload.title ?? getTitleFromPath(op.payload.path),
            op.payload.note_type ?? null,
            op.payload.folder ?? getFolderFromPath(op.payload.path),
            op.payload.tags ?? "[]",
            JSON.stringify(op.payload.aliases ?? []),
            op.payload.size ?? 0,
            op.payload.modified_at ?? "",
          )
        );
        resultKinds.push("upsert_node");
        idx++;
      } else {
        idx++;
      }
    }
  }

  for (const opsChunk of chunk(opsForLog, 20)) {
    // Phase 3: include ULID for cross-peer identity. Chunk reduced from 30→20
    // because each row now has 4 bindings + 1 SQL function (was 3+1), keeping
    // well under D1's 100-bind limit per statement (20×4=80).
    const placeholders = opsChunk.map(() => "(?, ?, ?, ?, datetime('now'))").join(", ");
    const bindings = opsChunk.flatMap((op) => [ulid(), op.op_type, JSON.stringify(op.payload), op.origin]);
    opStmts.push(
      env.DB.prepare(
        `INSERT INTO vault_ops (ulid, op_type, payload_json, origin, ts) VALUES ${placeholders}`
      ).bind(...bindings)
    );
    opKinds.push("ops");
  }

  // Tier A PR3 (post-0013): the legacy dirty-paths queue is retired. The
  // post-batch drainDegrees() helper now derives dirty paths from vault_ops
  // directly via the __last_degree_drain__ watermark, so writers no longer
  // track them explicitly. Callers no longer pass dirtyPaths.

  const allStmts = [...opStmts, ...stmts];
  const allKinds = [...opKinds, ...resultKinds];

  if (allStmts.length === 0) {
    return { insertedOps: 0, insertedEdges: 0, removedEdges: 0, upsertedNodes: 0, deletedNodes: 0 };
  }

  const results = await env.DB.batch(allStmts);
  let insertedOps = 0;
  let insertedEdges = 0;
  let removedEdges = 0;
  let upsertedNodes = 0;
  let deletedNodes = 0;

  for (let i = 0; i < results.length; i++) {
    const changes = results[i].meta?.changes ?? 0;
    switch (allKinds[i]) {
      case "ops":
        insertedOps += changes;
        break;
      case "add":
        insertedEdges += changes;
        break;
      case "remove":
        removedEdges += changes;
        break;
      case "upsert_node":
        upsertedNodes += changes;
        break;
      case "delete_node":
        deletedNodes += changes;
        break;
      default:
        break;
    }
  }

  return { insertedOps, insertedEdges, removedEdges, upsertedNodes, deletedNodes };
}

// ---------------------------------------------------------------------------
// Tool implementations (existing)
// ---------------------------------------------------------------------------

async function toolListNotes(env: Env, folder?: string): Promise<string> {
  const notes: Array<{ path: string; size: number; modified: string }> = [];
  let cursor: string | undefined;
  const prefix = folder ? folder.replace(/^\/+|\/+$/g, "") + "/" : undefined;

  do {
    const listed = await env.VAULT.list({ prefix, cursor, limit: 1000 });

    for (const obj of listed.objects) {
      if (!obj.key.endsWith(".md")) continue;
      if (obj.key.startsWith(".")) continue;
      notes.push({
        path: obj.key.replace(/\.md$/, ""),
        size: obj.size,
        modified: obj.uploaded.toISOString(),
      });
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return JSON.stringify(notes, null, 2);
}

async function toolReadNote(env: Env, path: string): Promise<string> {
  const key = normalizePath(path);
  const obj = await env.VAULT.get(key);
  if (!obj) return `Note not found: ${path}`;

  // Record access for analytics (feeds fast-score access-centrality divergence detector)
  try {
    await env.DB.prepare(
      `INSERT INTO note_access (path, access_count, last_accessed)
       VALUES (?, 1, datetime('now'))
       ON CONFLICT(path) DO UPDATE SET
         access_count = access_count + 1,
         last_accessed = datetime('now')`
    ).bind(stripExtension(key)).run();
  } catch {
    // Table may not exist yet — silently skip until migration runs
  }

  return await obj.text();
}

function validateFrontmatter(content: string, path: string): string | null {
  const fm = parseFrontmatterExtended(content);
  if (!fm) {
    return "REJECTED: Note must have YAML frontmatter (--- delimiters). Required fields: type, tags, created. See vault documentation for required frontmatter format.";
  }

  const missing: string[] = [];
  if (!fm.type) missing.push("type");
  if (!fm.tags || (Array.isArray(fm.tags) && fm.tags.length === 0)) missing.push("tags");
  if (!fm.created) missing.push("created");

  if (missing.length > 0) {
    return `REJECTED: Frontmatter missing required fields: ${missing.join(", ")}. See vault documentation for required frontmatter format. Example:\n---\ntype: research\ntags: [ai, transcript]\ncreated: 2026-03-17\n---`;
  }

  return null; // valid
}

function validateBacklinks(content: string): string | null {
  // Strip frontmatter to check body only
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const hasWikilink = /\[\[[^\]]+\]\]/.test(body);
  if (!hasWikilink) {
    return "REJECTED: Note must contain at least one [[wikilink]] in the body to connect to the vault graph. Orphan notes are not allowed.";
  }
  return null;
}

function stampModified(content: string): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) return content;

  let fmBody = fmMatch[2];
  // Update or add modified field
  if (/^modified\s*:/m.test(fmBody)) {
    fmBody = fmBody.replace(/^modified\s*:.*$/m, `modified: ${now}`);
  } else {
    fmBody += `\nmodified: ${now}`;
  }
  return `${fmMatch[1]}${fmBody}${fmMatch[3]}${content.slice(fmMatch[0].length)}`;
}

// ---------------------------------------------------------------------------
// Write-time graph enrichment (plan 2026-04-28-001)
// indexNoteInGraph: instant indexing via existing reconcileExtract machinery.
// getNeighborhoodSuggestions: 1-hop neighborhood echo for caller agents.
// ---------------------------------------------------------------------------

async function indexNoteInGraph(
  env: Env,
  path: string,    // sans-extension path (e.g. "projects/roadmap")
  content: string, // full note markdown
  size: number,    // byte length
): Promise<{ edges_indexed: number; edges: VaultEdge[] }> {
  const key = normalizePath(path); // adds .md
  const modified = new Date().toISOString();

  // 1. Extract node + edges (pure function, no side effects)
  const { node, edges: rawEdges, aliases } = extractEdgesFromNote(key, content, modified, size);

  // 2. Resolve short-name wikilinks via vault_nodes (not R2 listing).
  //    COLD-START: on a fresh vault with empty vault_nodes, ALL short-name
  //    targets become phantoms. By design — same as buildGraph first run.
  //    Self-heals on first syncGraph which populates vault_nodes from R2.
  //    Divergence from syncGraph: syncGraph seeds from R2 keys (source of
  //    truth); write-time uses vault_nodes only. Self-heals on next sync.
  const unresolvedTargets = rawEdges
    .filter(e => !e.target.includes("/") && !e.target.startsWith("tag:"))
    .map(e => e.target);
  const shortNameToPath = new Map<string, string>();
  if (unresolvedTargets.length > 0) {
    // Cap at 90 to stay under D1's 100-bind-parameter limit per statement.
    // Notes with 90+ bare wikilinks are rare; overflow targets stay as phantoms
    // and self-heal on next syncGraph (which resolves from R2 listing).
    const uniqueTargets = [...new Set(unresolvedTargets)].slice(0, 90);
    const rows = await env.DB.prepare(
      "SELECT path, title FROM vault_nodes WHERE title IN (" +
      uniqueTargets.map(() => "?").join(",") + ")"
    ).bind(...uniqueTargets).all<{ path: string; title: string }>();
    for (const r of rows.results) {
      if (!shortNameToPath.has(r.title)) {
        shortNameToPath.set(r.title, r.path);
      }
    }
  }
  const edges = rawEdges.map(edge => ({
    ...edge,
    target: !edge.target.includes("/") && !edge.target.startsWith("tag:") && shortNameToPath.has(edge.target)
      ? shortNameToPath.get(edge.target)!
      : edge.target,
  }));

  // 3. Compute content_hash, word_count, frontmatter (mirrors syncGraph)
  const bodyText = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const bodyBytes = new TextEncoder().encode(content);
  const hashBuf = await crypto.subtle.digest("SHA-256", bodyBytes);
  const contentHash = Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;
  const parsedFm = parseFrontmatterExtended(content);
  const frontmatterRaw = parsedFm ? JSON.stringify(parsedFm) : null;

  // 4. Schema probes + nodeStmt (mirrors syncGraph nodeStmt construction)
  //    Probes are positively cached at module level after first call — no D1
  //    cost on subsequent writes within the same isolate.
  const has005 = await hasPlan005VaultNodeColumns(env);

  const nodeStmt: D1PreparedStatement = has005
    ? env.DB.prepare(
        "INSERT INTO vault_nodes (path, title, note_type, folder, tags, aliases, size, modified_at, indexed_at, body, word_count, content_hash, frontmatter, ingest_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET title = excluded.title, note_type = excluded.note_type, folder = excluded.folder, tags = excluded.tags, aliases = excluded.aliases, size = excluded.size, modified_at = excluded.modified_at, indexed_at = excluded.indexed_at, body = excluded.body, word_count = excluded.word_count, content_hash = excluded.content_hash, frontmatter = excluded.frontmatter, ingest_run_id = excluded.ingest_run_id"
      ).bind(node.path, node.title, node.note_type, node.folder, node.tags,
        JSON.stringify(aliases), node.size, node.modified_at,
        content, wordCount, contentHash, frontmatterRaw, null)
    : env.DB.prepare(
        "INSERT INTO vault_nodes (path, title, note_type, folder, tags, aliases, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(path) DO UPDATE SET title = excluded.title, note_type = excluded.note_type, folder = excluded.folder, tags = excluded.tags, aliases = excluded.aliases, size = excluded.size, modified_at = excluded.modified_at, indexed_at = excluded.indexed_at"
      ).bind(node.path, node.title, node.note_type, node.folder, node.tags,
        JSON.stringify(aliases), node.size, node.modified_at);

  // 5. Desired edges with origin='extract' (same as syncGraph)
  const desiredEdges: VaultEdge[] = edges.map(edge => ({
    source: edge.source,
    target: edge.target,
    edge_type: edge.edge_type,
    weight: edge.weight,
    ingest_run_id: null,
    origin: "extract",
  }));

  // 6. Snapshot current extract edges for diff (ops audit log)
  const currentExtractEdgesRes = await env.DB.prepare(`
    SELECT source, target, edge_type, weight
    FROM vault_edges
    WHERE origin = 'extract' AND (
      (source = ?1 AND edge_type != 'spoke_in')
      OR (target = ?1 AND edge_type = 'spoke_in')
    )
  `).bind(path).all<{ source: string; target: string; edge_type: string; weight: number }>();

  const desiredKeySet = new Set(edges.map(e => opKey(e.source, e.target, e.edge_type)));
  const currentByKey = new Map(
    currentExtractEdgesRes.results.map(e => [opKey(e.source, e.target, e.edge_type), e] as const)
  );
  const addOps: Op[] = edges
    .filter(e => !currentByKey.has(opKey(e.source, e.target, e.edge_type)))
    .map(e => ({ op_type: "add_edge" as const, origin: "extract" as const, payload: {
      source: e.source, target: e.target, edge_type: e.edge_type, weight: e.weight, ingest_run_id: null,
    }}));
  const removeOps: Op[] = currentExtractEdgesRes.results
    .filter(e => !desiredKeySet.has(opKey(e.source, e.target, e.edge_type)))
    .map(e => ({ op_type: "remove_edge" as const, origin: "extract" as const, payload: {
      source: e.source, target: e.target, edge_type: e.edge_type,
    }}));

  // 7. Atomic reconciliation via applyOps + reconcileExtract
  await applyOps(
    env,
    [
      { op_type: "upsert_node", origin: "extract", payload: {
        path: node.path, title: node.title, note_type: node.note_type,
        folder: node.folder, tags: node.tags, aliases,
        size: node.size, modified_at: node.modified_at,
        body: content, word_count: wordCount, content_hash: contentHash,
        frontmatter: frontmatterRaw, ingest_run_id: null,
      }},
      ...addOps,
      ...removeOps,
    ],
    { reconcileExtract: { path, desiredEdges, nodeStmt } },
  );

  // 8. FTS update (non-critical, matches syncGraph pattern)
  await env.DB.prepare("DELETE FROM vault_fts WHERE path = ?").bind(path).run().catch(() => {});
  await env.DB.prepare(
    "INSERT INTO vault_fts (path, title, content, tags) VALUES (?, ?, ?, ?)"
  ).bind(node.path, node.title, bodyText, node.tags || "").run().catch(() => {});

  // 9. Degree drain (required at tail of every write path)
  await drainDegrees(env);

  return { edges_indexed: desiredEdges.length, edges };
}

async function getNeighborhoodSuggestions(
  env: Env,
  path: string,
  linkedTargets: Set<string>,
  maxSuggestions: number = 10,
): Promise<Array<{ path: string; title: string; via: string }>> {
  // Cap at 40 targets (80 bind params in the UNION ALL) to stay under
  // D1's 100-bind-parameter limit per prepared statement.
  const targets = [...linkedTargets].filter(t => t.includes("/") && !t.startsWith("tag:")).slice(0, 40);
  if (targets.length === 0) return [];

  const placeholders = targets.map(() => "?").join(", ");
  const hops = await env.DB.prepare(`
    SELECT source, target, edge_type FROM vault_edges
    WHERE source IN (${placeholders}) AND edge_type IN ('wikilink', 'related', 'discusses', 'mentions')
    UNION ALL
    SELECT target, source, edge_type FROM vault_edges
    WHERE target IN (${placeholders}) AND edge_type IN ('wikilink', 'related', 'discusses', 'mentions')
  `).bind(...targets, ...targets).all<{ source: string; target: string; edge_type: string }>();

  const candidates = new Map<string, { via: string; count: number }>();
  for (const row of hops.results) {
    const neighbor = row.target;
    if (neighbor === path) continue;
    if (linkedTargets.has(neighbor)) continue;
    if (neighbor.startsWith("tag:")) continue;
    if (!neighbor.includes("/")) continue;
    if (neighbor.startsWith("transcripts/")) continue;

    const existing = candidates.get(neighbor);
    if (existing) {
      existing.count++;
    } else {
      candidates.set(neighbor, { via: `${row.source} -[${row.edge_type}]->`, count: 1 });
    }
  }

  const ranked = [...candidates.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, maxSuggestions);

  if (ranked.length === 0) return [];
  const pathList = ranked.map(([p]) => p);
  const titlePlaceholders = pathList.map(() => "?").join(", ");
  const titles = await env.DB.prepare(
    `SELECT path, title FROM vault_nodes WHERE path IN (${titlePlaceholders})`
  ).bind(...pathList).all<{ path: string; title: string }>();
  const titleMap = new Map(titles.results.map(r => [r.path, r.title]));

  return ranked.map(([p, info]) => ({
    path: p,
    title: titleMap.get(p) ?? p.split("/").pop() ?? p,
    via: info.via,
  }));
}

async function toolWriteNote(env: Env, path: string, content: string): Promise<string> {
  const fmRejection = validateFrontmatter(content, path);
  if (fmRejection) return fmRejection;

  const blRejection = validateBacklinks(content);
  if (blRejection) return blRejection;

  const stamped = stampModified(content);
  const key = normalizePath(path);
  await env.VAULT.put(key, stamped, {
    httpMetadata: { contentType: "text/markdown" },
  });
  // Write-time graph enrichment: instant indexing + neighborhood echo.
  // R2 put is the success signal; graph enrichment is swallow-on-failure.
  // Separate try/catches so indexing success is preserved even if neighborhood fails.
  const pathSansExt = stripExtension(key);
  let indexResult: { edges_indexed: number; edges: VaultEdge[] } | null = null;
  try {
    indexResult = await indexNoteInGraph(env, pathSansExt, stamped, new TextEncoder().encode(stamped).length);
  } catch (err) {
    console.error(`[write-time-enrichment] indexNoteInGraph failed for ${path}:`, String(err).slice(0, 200));
  }
  if (!indexResult) return `Written: ${path}`;

  let response = `Written: ${path} (indexed: ${indexResult.edges_indexed} edges)`;
  try {
    const linkedTargets = new Set(
      indexResult.edges.filter(e => e.edge_type !== "tag").map(e => e.target)
    );
    const suggestions = await getNeighborhoodSuggestions(env, pathSansExt, linkedTargets);
    if (suggestions.length > 0) {
      response += "\n\nNearby notes you might want to link to:";
      for (const s of suggestions) {
        response += `\n- [[${s.path}]] "${s.title}" (${s.via})`;
      }
    }
  } catch (err) {
    console.error(`[write-time-enrichment] getNeighborhoodSuggestions failed for ${path}:`, String(err).slice(0, 200));
  }
  return response;
}

async function toolAppendNote(env: Env, path: string, content: string): Promise<string> {
  const key = normalizePath(path);
  const existing = await env.VAULT.get(key);
  const existingText = existing ? await existing.text() : "";

  if (!existing) {
    // New note — must have valid frontmatter and backlinks
    const fmRejection = validateFrontmatter(content, path);
    if (fmRejection) return fmRejection;
    const blRejection = validateBacklinks(content);
    if (blRejection) return blRejection;
  }

  let newContent = existingText + "\n" + content;
  // Stamp modified on existing notes that have frontmatter
  if (existing && /^---\n/.test(newContent)) {
    newContent = stampModified(newContent);
  }
  await env.VAULT.put(key, newContent, {
    httpMetadata: { contentType: "text/markdown" },
  });
  // Write-time graph enrichment from FULL content (existing + appended).
  // R2 put is the success signal; graph enrichment is swallow-on-failure.
  // Separate try/catches so indexing success is preserved even if neighborhood fails.
  const pathSansExt = stripExtension(key);
  let indexResult: { edges_indexed: number; edges: VaultEdge[] } | null = null;
  try {
    indexResult = await indexNoteInGraph(env, pathSansExt, newContent, new TextEncoder().encode(newContent).length);
  } catch (err) {
    console.error(`[write-time-enrichment] indexNoteInGraph failed for ${path}:`, String(err).slice(0, 200));
  }
  if (!indexResult) return `Appended to: ${path}`;

  let response = `Appended to: ${path} (indexed: ${indexResult.edges_indexed} edges)`;
  try {
    const linkedTargets = new Set(
      indexResult.edges.filter(e => e.edge_type !== "tag").map(e => e.target)
    );
    const suggestions = await getNeighborhoodSuggestions(env, pathSansExt, linkedTargets);
    if (suggestions.length > 0) {
      response += "\n\nNearby notes you might want to link to:";
      for (const s of suggestions) {
        response += `\n- [[${s.path}]] "${s.title}" (${s.via})`;
      }
    }
  } catch (err) {
    console.error(`[write-time-enrichment] getNeighborhoodSuggestions failed for ${path}:`, String(err).slice(0, 200));
  }
  return response;
}

// ---------------------------------------------------------------------------
// Wiki cross-reference helpers — epistemic retrieval (plan 2026-05-19-001)
// ---------------------------------------------------------------------------

/** Result type for wiki cross-reference lookups. */
export interface WikiCrossRef {
  wikiPath: string;
  title: string;
  compiledAt: string | null;
  freshnessStatus: "fresh" | "stale" | "thin" | "unknown";
  sourceCount: number;
  synthesisSrcCount: number;
}

/**
 * Convert a topic title to a URL-safe wiki slug.
 * Parity test in wiki-lookup.test.ts asserts identical output.
 */
function wikiSlugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Canonical top-level folders that map to wiki subfolders. */
const WIKI_CANONICAL_FOLDERS: ReadonlySet<string> = new Set(["People", "Concepts", "Entities"]);

/**
 * Construct a candidate wiki path from a vault note path.
 * Returns null if the path isn't in a canonical folder (fallback to edge lookup).
 *
 * Maps canonical folder paths to wiki subpaths:
 * - Canonical folders (People/Concepts/Entities): slug from title only
 * - Everything else: no direct mapping (returns null)
 */
function candidateWikiPath(notePath: string): string | null {
  const clean = notePath.replace(/\.md$/, "");
  const parts = clean.split("/");
  const topFolder = parts[0] ?? "";
  if (!WIKI_CANONICAL_FOLDERS.has(topFolder)) return null;

  // Title is the last path segment (e.g., "People/Alice" → "Alice")
  const title = parts[parts.length - 1] ?? "";
  if (!title) return null;

  return `Wiki/${topFolder}/${wikiSlugify(title)}`;
}

/**
 * Find wiki pages that cover the given note paths.
 *
 * Strategy:
 * 1. Primary: construct candidate wiki slugs for canonical-folder paths,
 *    batch check vault_nodes for existence (PK lookup, fast).
 * 2. Fallback: for unresolved paths, query vault_edges for wikilinks FROM
 *    Wiki/ pages TO those paths (catches non-canonical and alias matches).
 * 3. For each discovered wiki page, parse frontmatter for sources/freshness.
 *
 * Returns at most `maxResults` WikiCrossRef objects (default 3).
 */
export async function findWikiPagesForPaths(
  env: { DB: D1Database },
  paths: string[],
  maxResults: number = 3,
): Promise<WikiCrossRef[]> {
  if (paths.length === 0) return [];

  // Normalize: strip .md suffix, deduplicate
  const normalizedPaths = [...new Set(paths.map(p => p.replace(/\.md$/, "")))];

  // ---- Step 1: slug-based primary lookup ----
  const slugCandidates = new Map<string, string>(); // wikiPath → original notePath
  const unresolvedPaths: string[] = [];

  for (const p of normalizedPaths) {
    const candidate = candidateWikiPath(p);
    if (candidate) {
      slugCandidates.set(candidate, p);
    } else {
      unresolvedPaths.push(p);
    }
  }

  const foundWikiPaths = new Map<string, string>(); // wikiPath → one covering notePath

  if (slugCandidates.size > 0) {
    const candidateKeys = [...slugCandidates.keys()];
    // Batch IN query — cap at 50 to stay within D1 budget
    const chunk = candidateKeys.slice(0, 50);
    const placeholders = chunk.map(() => "?").join(", ");
    try {
      const rows = await env.DB.prepare(
        `SELECT path FROM vault_nodes WHERE path IN (${placeholders})`
      ).bind(...chunk).all<{ path: string }>();

      for (const row of rows.results) {
        foundWikiPaths.set(row.path, slugCandidates.get(row.path) ?? "");
        // Remove from unresolved if this slug matched
      }
    } catch (err) {
      console.error("[wiki-lookup] slug lookup failed:", String(err).slice(0, 200));
    }

    // Paths whose slug candidate didn't match need fallback
    for (const [candidate, notePath] of slugCandidates) {
      if (!foundWikiPaths.has(candidate)) {
        unresolvedPaths.push(notePath);
      }
    }
  }

  // ---- Step 2: edge-based fallback for unresolved paths ----
  if (unresolvedPaths.length > 0 && foundWikiPaths.size < maxResults) {
    const chunk = unresolvedPaths.slice(0, 50);
    const placeholders = chunk.map(() => "?").join(", ");
    try {
      const rows = await env.DB.prepare(
        `SELECT source, target FROM vault_edges
         WHERE edge_type = 'wikilink' AND target IN (${placeholders})
         AND source LIKE 'Wiki/%'
         LIMIT ?`
      ).bind(...chunk, maxResults * 3).all<{ source: string; target: string }>();

      for (const row of rows.results) {
        if (foundWikiPaths.size >= maxResults) break;
        if (!foundWikiPaths.has(row.source)) {
          foundWikiPaths.set(row.source, row.target);
        }
      }
    } catch (err) {
      console.error("[wiki-lookup] edge fallback failed:", String(err).slice(0, 200));
    }
  }

  if (foundWikiPaths.size === 0) return [];

  // ---- Step 3: fetch metadata for discovered wiki pages ----
  const wikiPaths = [...foundWikiPaths.keys()].slice(0, maxResults);
  const metaPlaceholders = wikiPaths.map(() => "?").join(", ");

  try {
    const wikiRows = await env.DB.prepare(
      `SELECT path, title, frontmatter, content_hash, modified_at
       FROM vault_nodes WHERE path IN (${metaPlaceholders})`
    ).bind(...wikiPaths).all<{
      path: string;
      title: string;
      frontmatter: string | null;
      content_hash: string | null;
      modified_at: string | null;
    }>();

    const results: WikiCrossRef[] = [];

    for (const wiki of wikiRows.results) {
      // Parse frontmatter for sources and freshness data
      let sources: string[] = [];
      let synthesisSources: string[] = [];
      let compiledAt: string | null = null;
      let sourceHash: string | null = null;

      if (wiki.frontmatter) {
        try {
          const fm = JSON.parse(wiki.frontmatter);
          sources = Array.isArray(fm.sources) ? fm.sources : [];
          synthesisSources = Array.isArray(fm.synthesis_sources) ? fm.synthesis_sources : sources;
          compiledAt = fm.compiled_at ?? null;
          sourceHash = fm.source_hash ?? null;
        } catch {
          // JSON parse failed — frontmatter column is null or malformed.
          // Freshness defaults to "unknown" (no source metadata available).
        }
      }

      const synthesisSrcCount = synthesisSources.length;
      const sourceCount = sources.length;

      // Freshness check: verify synthesis sources still exist in vault_nodes.
      // Does NOT compare content_hash values (no stored baseline to compare against).
      // "stale" = some synthesis sources are missing from vault_nodes.
      // "thin" = only 1 synthesis source (weak coverage).
      // "fresh" = all synthesis sources present (compilation data intact).
      // "unknown" = no synthesis source metadata available.
      let freshnessStatus: WikiCrossRef["freshnessStatus"] = "unknown";

      if (synthesisSrcCount === 0) {
        freshnessStatus = "unknown";
      } else if (synthesisSrcCount === 1) {
        freshnessStatus = "thin";
      } else if (sourceHash && synthesisSources.length > 0) {
        // Check that all synthesis sources still exist in vault_nodes
        const srcChunk = synthesisSources.slice(0, 50);
        const srcPlaceholders = srcChunk.map(() => "?").join(", ");
        try {
          const srcRows = await env.DB.prepare(
            `SELECT path, content_hash FROM vault_nodes WHERE path IN (${srcPlaceholders})`
          ).bind(...srcChunk).all<{ path: string; content_hash: string | null }>();

          // Count sources with content_hash (indexed sources). If fewer than
          // expected, some sources were deleted or not yet indexed → stale.
          const foundSrcCount = srcRows.results.filter(r => r.content_hash).length;
          if (foundSrcCount < synthesisSrcCount) {
            // Some sources missing — might have been deleted or not indexed
            freshnessStatus = "stale";
          } else {
            freshnessStatus = "fresh";
          }
        } catch {
          freshnessStatus = "unknown";
        }
      } else {
        freshnessStatus = compiledAt ? "fresh" : "unknown";
      }

      results.push({
        wikiPath: wiki.path,
        title: wiki.title ?? wiki.path.split("/").pop() ?? wiki.path,
        compiledAt,
        freshnessStatus,
        sourceCount,
        synthesisSrcCount,
      });
    }

    return results;
  } catch (err) {
    console.error("[wiki-lookup] metadata fetch failed:", String(err).slice(0, 200));
    return [];
  }
}

/** FTS5 column names from the vault_fts schema (line ~1012). Case-insensitive match. */
const FTS_COLUMNS: ReadonlySet<string> = new Set(["path", "title", "content", "tags"]);

export async function toolSearchNotes(
  env: Env,
  query: string,
  folder?: string,
  max_results: number = 20,
  format: "envelope" | "array" = "envelope",
): Promise<string> {
  // Check if FTS index exists and is populated
  const count = await env.DB.prepare("SELECT count(*) as n FROM vault_fts").first<{ n: number }>().catch(() => null);
  if (!count || count.n === 0) {
    return JSON.stringify({ error: "FTS index is empty. Run build_graph to populate the search index." });
  }

  // Sanitize the query to handle hyphens, colons, and plus signs that FTS5
  // would otherwise interpret as grammar operators (column qualifiers, negation,
  // phrase concat). Env-var seam: set VAULT_FTS_RAW=1 to bypass sanitizer.
  const ftsQuery = env.VAULT_FTS_RAW === "1"
    ? query.replace(/"/g, '""')
    : sanitizeFtsQuery(query, FTS_COLUMNS);
  const folderClause = folder ? ` AND path LIKE '${folder.replace(/'/g, "''")}%'` : "";

  const results = await env.DB.prepare(`
    SELECT path,
           snippet(vault_fts, 2, '>>>', '<<<', '...', 20) as snippet,
           rank
    FROM vault_fts
    WHERE vault_fts MATCH ?${folderClause}
    ORDER BY rank
    LIMIT ?
  `).bind(ftsQuery, max_results).all<{ path: string; snippet: string; rank: number }>();

  const mappedResults = results.results.map((r) => ({
    path: r.path + ".md",
    snippet: r.snippet.replace(/>>>/g, "**").replace(/<<</g, "**"),
  }));

  if (!mappedResults.length) {
    if (format === "array") return JSON.stringify([]);
    return JSON.stringify({ results: [], wiki_context: { wiki_pages: [], wiki_gap: true } }, null, 2);
  }

  // Legacy format: bare array (backward compat)
  if (format === "array") {
    return JSON.stringify(mappedResults, null, 2);
  }

  // Envelope format (default): include wiki cross-reference
  const resultPaths = mappedResults.map(r => r.path);
  let wikiPages: WikiCrossRef[] = [];
  try {
    wikiPages = await findWikiPagesForPaths(env, resultPaths, 3);
  } catch (err) {
    console.error("[search_notes] wiki cross-reference failed:", String(err).slice(0, 200));
  }

  return JSON.stringify(
    {
      results: mappedResults,
      wiki_context: {
        wiki_pages: wikiPages,
        wiki_gap: wikiPages.length === 0,
      },
    },
    null,
    2,
  );
}

async function toolDeleteNote(env: Env, path: string): Promise<string> {
  const key = normalizePath(path);
  const existing = await env.VAULT.head(key);
  if (!existing) return `Note not found: ${path}`;
  await env.VAULT.delete(key);
  return `Deleted: ${path}`;
}

async function toolListFolders(
  env: Env,
  offset: number = 0,
  limit: number = 200,
): Promise<string> {
  // Compute the full sorted folder set (R2 pagination is internal)
  const folders = new Set<string>();
  let r2Cursor: string | undefined;

  do {
    const listed = await env.VAULT.list({ cursor: r2Cursor, limit: 1000 });
    for (const obj of listed.objects) {
      const parts = obj.key.split("/");
      for (let i = 1; i < parts.length; i++) {
        folders.add(parts.slice(0, i).join("/"));
      }
    }
    r2Cursor = listed.truncated ? listed.cursor : undefined;
  } while (r2Cursor);

  const sorted = [...folders].sort();
  const total = sorted.length;

  // Clamp offset/limit
  const safeOffset = Math.max(0, Math.min(offset, total));
  const safeLimit = Math.max(1, Math.min(limit, 5000));
  const page = sorted.slice(safeOffset, safeOffset + safeLimit);

  return JSON.stringify({
    folders: page,
    has_more: safeOffset + safeLimit < total,
    total,
    offset: safeOffset,
  }, null, 2);
}

async function toolGetFrontmatter(env: Env, path: string): Promise<string> {
  const key = normalizePath(path);
  const obj = await env.VAULT.get(key);
  if (!obj) return `Note not found: ${path}`;
  const content = await obj.text();
  const fm = parseFrontmatter(content);
  return fm ? JSON.stringify(fm, null, 2) : "No frontmatter found";
}

// ---------------------------------------------------------------------------
// Graph extraction
// ---------------------------------------------------------------------------

// extractEdgesFromNote moved to ./extract.ts so local build-graph tooling
// can share extraction logic without pulling the full Worker import graph.

// hasPlan005VaultNodeColumns / hasVaultEdgesIngestRunId moved to
// ./schema-probes.ts for reuse by src/cron/backfill-body.ts (plan-E2).
// Same positive-cache semantics; see that file for the rationale.

// Phase 2 non-destructive refactor: stale-row cleanup after buildGraph
// extract completes. Removes vault_nodes rows not stamped with the current
// build's ingest_run_id (notes deleted from R2 since last build).
//
// Writers: this function (runs once per build, at done=true).
// Readers: all vault_nodes SELECT paths. Cleanup removes rows for notes
// no longer in R2. A timeout before cleanup completes leaves stale rows
// (benign — readers see a superset of truth).
//
// Concurrent-writer safety (P1 fix): STALE_WHERE includes an
// `indexed_at < ?` guard bound to the build start time. Any row
// written or updated by a concurrent writer (syncGraph, write_note,
// indexNoteInGraph, ingestTriples) AFTER the build started has a
// newer indexed_at and is exempt from cleanup. This prevents the
// race where a concurrent writer stamps a different ingest_run_id
// and the stale cleanup deletes a valid row.
//
// Writers that touch vault_nodes during a buildGraph window:
//   syncGraph  — origin='extract', stamps ingest_run_id=sync-*
//   write_note / indexNoteInGraph — ingest_run_id=null
//   ingestTriples (MCP + /api) — ingest_run_id=sync-*
// All set indexed_at = datetime('now') on every upsert, so rows
// written after buildStartTime are excluded by the guard.
//
// Pre-005 databases: ingest_run_id column does not exist; cleanup
// is skipped entirely (hasPlan005VaultNodeColumns guard).
const STALE_CLEANUP_THRESHOLD = 0.05; // 5% — plan §Success Criteria
// ?1 = buildRunId, ?2 = buildStartTime (ISO string from datetime('now'))
const STALE_WHERE = `(ingest_run_id IS NULL OR ingest_run_id != ?1) AND path NOT GLOB '__*' AND indexed_at < ?2`;

async function cleanupStaleNodes(
  env: Env,
  buildRunId: string | null,
  buildStartTime: string,
): Promise<number> {
  if (!buildRunId) return 0;
  if (!(await hasPlan005VaultNodeColumns(env))) return 0;

  // Single query: total count + stale count in one D1 round-trip.
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as total, SUM(CASE WHEN ${STALE_WHERE} THEN 1 ELSE 0 END) as stale FROM vault_nodes WHERE path NOT GLOB '__*'`
  ).bind(buildRunId, buildStartTime).first<{ total: number; stale: number }>().catch(() => null);
  const totalCount = row?.total ?? 0;
  const staleCount = row?.stale ?? 0;

  if (staleCount === 0 || totalCount === 0) return 0;

  if (staleCount > totalCount * STALE_CLEANUP_THRESHOLD) {
    console.warn(
      `buildGraph Phase 2: stale cleanup skipped — ${staleCount}/${totalCount} rows ` +
      `(${((staleCount / totalCount) * 100).toFixed(1)}%) exceed ${STALE_CLEANUP_THRESHOLD * 100}% threshold. ` +
      `Expected on first non-destructive build after upgrade; next build will succeed.`
    );
    return 0;
  }

  // Delete stale FTS entries, vault_edges (origin='extract' only — other
  // origins are managed by their own writers), and vault_nodes — all
  // batched into one D1 round-trip. FTS and edges reference vault_nodes
  // rows that the final DELETE will remove.
  const results = await env.DB.batch([
    env.DB.prepare(`DELETE FROM vault_fts WHERE path IN (SELECT path FROM vault_nodes WHERE ${STALE_WHERE})`).bind(buildRunId, buildStartTime),
    env.DB.prepare(`DELETE FROM vault_edges WHERE origin = 'extract' AND source IN (SELECT path FROM vault_nodes WHERE ${STALE_WHERE})`).bind(buildRunId, buildStartTime),
    env.DB.prepare(`DELETE FROM vault_edges WHERE origin = 'extract' AND target IN (SELECT path FROM vault_nodes WHERE ${STALE_WHERE}) AND edge_type = 'spoke_in'`).bind(buildRunId, buildStartTime),
    env.DB.prepare(`DELETE FROM vault_nodes WHERE ${STALE_WHERE}`).bind(buildRunId, buildStartTime),
  ]);
  return results[3]?.meta?.changes ?? 0;
}

export async function buildGraph(env: Env, phase?: string, force?: boolean): Promise<string> {
  const startTime = Date.now();
  if (await checkMaintenanceMode(env)) {
    return JSON.stringify({ error: "maintenance_mode", message: "tier-a maintenance mode is active; retry after reset completes" });
  }

  // Phase 1: "extract" (default) — process one R2 list page (200 keys) per call
  // Phase 2: "finalize" — add folder/temporal edges + compute degrees
  const currentPhase = phase ?? "extract";

  if (currentPhase === "extract") {
    // Check if this is a fresh start or continuation
    const progress = await env.DB.prepare(
      "SELECT size as processed FROM vault_nodes WHERE path = '__build_progress__'"
    ).first<{ processed: number }>();
    const totalProcessed = progress?.processed ?? 0;

    // Guard: reject if last build completed recently (unless force=true or resuming)
    if (totalProcessed === 0 && !force) {
      const lastBuild = await env.DB.prepare(
        "SELECT indexed_at FROM vault_nodes WHERE path = '__last_build_completed__'"
      ).first<{ indexed_at: string }>();
      if (lastBuild) {
        const hoursAgo = (Date.now() - new Date(lastBuild.indexed_at).getTime()) / 3600000;
        if (hoursAgo < 24) {
          return JSON.stringify({
            error: `build_graph completed ${hoursAgo.toFixed(1)}h ago. Pass force=true to override.`,
            last_build: lastBuild.indexed_at,
          });
        }
      }
    }

    // On first call, recreate tables with expanded edge type schema.
    // Advance meta.last_ingest_run_id AND write an ingest_runs 'running'
    // row so the enrichment orchestrator can detect an in-flight rebuild
    // via its ingest_runs.status='running' probes. Without the row, the
    // orchestrator's round-15 mid-run guard would never fire for rebuilds.
    // (Codex P1 round-7 + round-16 findings.)
    if (totalProcessed === 0) {
      const buildRunId = `build-${ulid()}`;
      await env.DB.prepare(
        "INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('last_ingest_run_id', ?, unixepoch())"
      ).bind(buildRunId).run().catch((err) => { console.warn("buildGraph meta.last_ingest_run_id write failed:", String(err).slice(0, 160)); });
      // INSERT must succeed or we abort the build — no .catch() swallow.
      await env.DB.prepare(
        "INSERT INTO ingest_runs (id, started_at, status) VALUES (?, unixepoch(), 'running')"
      ).bind(buildRunId).run();
      // Phase 2 non-destructive refactor (plan §Phase 2): no DELETE FROM
      // vault_nodes, no DROP TABLE vault_fts. Extract upserts each note via
      // INSERT...ON CONFLICT DO UPDATE and stamps ingest_run_id =
      // currentBuildRunId on every processed row. After all extract calls
      // finish (done=true), stale rows (ingest_run_id != currentBuildRunId
      // AND path NOT GLOB '__*') are cleaned up. FTS is updated per-path
      // (DELETE + INSERT), matching the syncGraph pattern at line ~848.
      //
      // Writers: buildGraph extract (this code). Readers: toolVaultSearch
      // (FTS queries), toolFindRelated, /api/digest, runFastScore, all
      // vault_nodes SELECT paths. Stale cleanup never fires mid-extract
      // (only at done=true), so readers see a superset of truth during the
      // build — stale rows are benign until cleanup.
      //
      // Ensures vault_fts table exists (no-op if already present).
      // Failure is non-fatal: .catch() logs and continues.
      await env.DB.prepare(
        `CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(path, title, content, tags, tokenize='unicode61 remove_diacritics 2')`
      ).run().catch((err) => { console.warn("vault_fts CREATE failed:", String(err).slice(0, 160)); });
      await env.DB.prepare(
        "INSERT OR REPLACE INTO vault_nodes (path, title, note_type, folder, tags, size, modified_at, indexed_at) VALUES ('__build_run_id__', ?, null, '', '[]', 0, '', datetime('now'))"
      ).bind(buildRunId).run().catch(() => {});
    }

    // Get stored R2 cursor from KV-style storage in D1
    const cursorRow = await env.DB.prepare(
      "SELECT title as r2_cursor FROM vault_nodes WHERE path = '__build_cursor__'"
    ).first<{ r2_cursor: string }>();
    const savedCursor = cursorRow?.r2_cursor || undefined;
    const buildRunRow = await env.DB.prepare(
      "SELECT title FROM vault_nodes WHERE path = '__build_run_id__'"
    ).first<{ title: string }>();
    const currentBuildRunId = buildRunRow?.title ?? null;

    // Wrap extract work in try/catch so thrown exceptions mark the ingest_runs
    // row terminal (plan 2026-04-27-001 Phase 3). On success, finalize writes
    // the terminal status — we only act on error here.
    try {

    // List one page of R2 objects (200 at a time, processed in sub-batches of 5)
    const listed = await env.VAULT.list({
      cursor: savedCursor,
      limit: 200,
    });

    const mdObjects = listed.objects.filter(
      (obj) => obj.key.endsWith(".md") && !obj.key.startsWith(".")
    );

    let nodesProcessed = 0;
    let edgesProcessed = 0;

    // Process in sub-batches of 5 (Workers have ~6 concurrent connection limit)
    const BATCH_SIZE = 5;
    for (let i = 0; i < mdObjects.length; i += BATCH_SIZE) {
      const batch = mdObjects.slice(i, i + BATCH_SIZE);
      const fetches = batch.map((item) => env.VAULT.get(item.key));
      const objects = await Promise.all(fetches);

      const stmts: D1PreparedStatement[] = [];

      for (let j = 0; j < objects.length; j++) {
        const obj = objects[j];
        if (!obj) continue;

        const content = await obj.text();
        const { node, edges, aliases: noteAliases } = extractEdgesFromNote(
          batch[j].key,
          content,
          batch[j].uploaded.toISOString(),
          batch[j].size
        );
        const buildBodyBytes = new TextEncoder().encode(content);
        const buildHashBuf = await crypto.subtle.digest("SHA-256", buildBodyBytes);
        const buildContentHash = Array.from(new Uint8Array(buildHashBuf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

        // Populate the new plan005 fields on buildGraph so /api/frontmatter/*
        // and the D1-first /api/note path work after a full rebuild, not only
        // after syncGraph reprocesses each note. Falls back to legacy INSERT
        // on pre-migration-0004 databases to keep buildGraph working before
        // the migration runs. (Codex P1 round-10 + round-11 findings.)
        const has005Cols = await hasPlan005VaultNodeColumns(env);
        const ftsBody = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
        const buildWordCount = ftsBody.split(/\s+/).filter(Boolean).length;
        const buildParsedFm = parseFrontmatterExtended(content);
        const buildFrontmatter = buildParsedFm ? JSON.stringify(buildParsedFm) : null;
        if (has005Cols) {
          // Phase 2: ingest_run_id stamped for stale-row detection.
          stmts.push(
            env.DB.prepare(
              "INSERT INTO vault_nodes (path, title, note_type, folder, tags, aliases, size, modified_at, indexed_at, body, word_count, content_hash, frontmatter, ingest_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET title = excluded.title, note_type = excluded.note_type, folder = excluded.folder, tags = excluded.tags, aliases = excluded.aliases, size = excluded.size, modified_at = excluded.modified_at, indexed_at = excluded.indexed_at, body = excluded.body, word_count = excluded.word_count, content_hash = excluded.content_hash, frontmatter = excluded.frontmatter, ingest_run_id = excluded.ingest_run_id"
            ).bind(
              node.path, node.title, node.note_type, node.folder, node.tags,
              JSON.stringify(noteAliases), node.size, node.modified_at,
              content, buildWordCount, buildContentHash, buildFrontmatter,
              currentBuildRunId,
            )
          );
        } else {
          stmts.push(
            env.DB.prepare(
              "INSERT INTO vault_nodes (path, title, note_type, folder, tags, aliases, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(path) DO UPDATE SET title = excluded.title, note_type = excluded.note_type, folder = excluded.folder, tags = excluded.tags, aliases = excluded.aliases, size = excluded.size, modified_at = excluded.modified_at, indexed_at = excluded.indexed_at"
            ).bind(node.path, node.title, node.note_type, node.folder, node.tags, JSON.stringify(noteAliases), node.size, node.modified_at)
          );
        }
        // Phase 2: per-path FTS update (DELETE + INSERT). Same SQL as
        // syncGraph (line ~848) but batched with vault_nodes stmts for
        // atomicity — FTS failure fails the chunk, unlike syncGraph's
        // individual .run().catch() which swallows FTS errors.
        stmts.push(
          env.DB.prepare("DELETE FROM vault_fts WHERE path = ?").bind(node.path)
        );
        stmts.push(
          env.DB.prepare(
            "INSERT INTO vault_fts (path, title, content, tags) VALUES (?, ?, ?, ?)"
          ).bind(node.path, node.title, ftsBody, node.tags || "")
        );
        nodesProcessed++;

        edgesProcessed += edges.length;

        // PR2: route vault_edges through applyOps (materialize: true) so vault_ops
        // and vault_edges land in the SAME D1.batch(). The simplified upsert_node
        // path in applyOps writes vault_nodes first; the complex INSERT in stmts
        // (below) then overwrites via ON CONFLICT DO UPDATE, so all fields are
        // correct in the final state. Legacy INSERT OR IGNORE removed.
        await applyOps(
          env,
          [
            {
              op_type: "upsert_node",
              origin: "extract",
              payload: {
                path: node.path,
                title: node.title,
                note_type: node.note_type,
                folder: node.folder,
                tags: node.tags,
                aliases: noteAliases,
                size: node.size,
                modified_at: node.modified_at,
                body: content,
                word_count: buildWordCount,
                content_hash: buildContentHash,
                frontmatter: buildFrontmatter,
                ingest_run_id: currentBuildRunId,
              },
            },
            ...edges.map((edge): Op => ({
              op_type: "add_edge",
              origin: "extract",
              payload: {
                source: edge.source,
                target: edge.target,
                edge_type: edge.edge_type,
                weight: edge.weight,
                ingest_run_id: currentBuildRunId,
              },
            })),
          ],
          { materialize: true },
        );

        // Flush in chunks of 80 to stay under D1 batch limit
        if (stmts.length >= 80) {
          await env.DB.batch(stmts.splice(0, 80));
        }
      }

      if (stmts.length > 0) {
        await env.DB.batch(stmts);
      }
    }

    const newTotal = totalProcessed + mdObjects.length;
    const done = !listed.truncated;

    // Save progress + cursor
    const progressStmts: D1PreparedStatement[] = [
      env.DB.prepare(
        "INSERT OR REPLACE INTO vault_nodes (path, title, note_type, folder, tags, size, modified_at, indexed_at) VALUES ('__build_progress__', 'progress', null, '', '[]', ?, '', datetime('now'))"
      ).bind(newTotal),
    ];

    if (listed.truncated) {
      progressStmts.push(
        env.DB.prepare(
          "INSERT OR REPLACE INTO vault_nodes (path, title, note_type, folder, tags, size, modified_at, indexed_at) VALUES ('__build_cursor__', ?, null, '', '[]', 0, '', datetime('now'))"
        ).bind(listed.cursor)
      );
    }
    await env.DB.batch(progressStmts);

    let staleCleanedUp = 0;
    if (done && currentBuildRunId) {
      // Read build start time from the __build_run_id__ sentinel's indexed_at
      // (written at the start of the first extract call via datetime('now')).
      // This timestamp gates the stale cleanup: rows indexed after the build
      // started are exempt (concurrent writers — syncGraph, write_note, etc.).
      const sentinelRow = await env.DB.prepare(
        "SELECT indexed_at FROM vault_nodes WHERE path = '__build_run_id__'"
      ).first<{ indexed_at: string }>().catch(() => null);
      const buildStartTime = sentinelRow?.indexed_at ?? new Date().toISOString();
      staleCleanedUp = await cleanupStaleNodes(env, currentBuildRunId, buildStartTime);
    }
    if (done) {
      // Clean up markers
      await env.DB.batch([
        env.DB.prepare("DELETE FROM vault_nodes WHERE path = '__build_progress__'"),
        env.DB.prepare("DELETE FROM vault_nodes WHERE path = '__build_cursor__'"),
      ]);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    return JSON.stringify({
      phase: "extract",
      processed_this_call: mdObjects.length,
      total_processed: newTotal,
      nodes_this_chunk: nodesProcessed,
      edges_this_chunk: edgesProcessed,
      done,
      ...(done ? { stale_cleaned_up: staleCleanedUp } : {}),
      next: done ? "Call build_graph with phase='finalize'" : "Call build_graph again to continue",
      elapsed_seconds: parseFloat(elapsed),
    }, null, 2);
    } catch (err) {
      // Mark the ingest_runs row as error. Prefer currentBuildRunId (from sentinel
      // or in-memory). If null (sentinel write silently failed via .catch()), fall
      // back to orphan-recovery query — same pattern as finalize.
      let errRunId = currentBuildRunId;
      if (!errRunId) {
        const orphanRow = await env.DB.prepare(
          "SELECT id FROM ingest_runs WHERE id LIKE 'build-%' AND status = 'running' ORDER BY started_at DESC LIMIT 1"
        ).first<{ id: string }>().catch(() => null);
        errRunId = orphanRow?.id ?? null;
      }
      if (errRunId) {
        await env.DB.prepare(
          `UPDATE ingest_runs
           SET status = 'error',
               completed_at = COALESCE(completed_at, unixepoch()),
               error = COALESCE(error, ?)
           WHERE id = ? AND completed_at IS NULL`
        ).bind(String(err).slice(0, 160), errRunId)
         .run()
         .catch((catchErr) => {
           console.error("buildGraph extract: ingest_runs error-mark failed:", String(catchErr).slice(0, 160));
         });
      }
      throw err;
    }
  }

  if (currentPhase === "finalize") {
    // --- Alias resolution: merge split identities ---
    // Many wikilinks use display names like [[Durable Objects]] which create edges
    // to "Durable Objects" instead of the actual file "Concepts/Durable Objects".
    // Build alias→canonical map from frontmatter aliases + titles, then redirect edges.

    const nodesWithAliases = await env.DB.prepare(
      "SELECT path, title, tags, aliases FROM vault_nodes"
    ).all<{ path: string; title: string; tags: string; aliases: string }>();

    // Build alias → canonical path map (multiple strategies)
    const aliasMap = new Map<string, string>(); // exact match
    const aliasMapLower = new Map<string, string>(); // case-insensitive
    const realPaths = new Set<string>();

    for (const row of nodesWithAliases.results) {
      realPaths.add(row.path);

      // Strategy 1: Title → path (e.g., "Durable Objects" → "Concepts/Durable Objects")
      if (row.title && row.title !== row.path) {
        const priority = row.path.startsWith("Concepts/") || row.path.startsWith("Agents/");
        if (!aliasMap.has(row.title) || priority) {
          aliasMap.set(row.title, row.path);
        }
        const lower = row.title.toLowerCase();
        if (!aliasMapLower.has(lower) || priority) {
          aliasMapLower.set(lower, row.path);
        }
      }

      // Strategy 2: Frontmatter aliases → path
      try {
        const aliases: string[] = JSON.parse(row.aliases || "[]");
        for (const alias of aliases) {
          if (!alias) continue;
          const priority = row.path.startsWith("Concepts/") || row.path.startsWith("Agents/");
          if (!aliasMap.has(alias) || priority) {
            aliasMap.set(alias, row.path);
          }
          const lower = alias.toLowerCase();
          if (!aliasMapLower.has(lower) || priority) {
            aliasMapLower.set(lower, row.path);
          }
        }
      } catch {}
    }

    // Find phantom targets (edge targets that don't exist as nodes)
    const phantomTargets = await env.DB.prepare(`
      SELECT DISTINCT target FROM vault_edges
      WHERE target NOT IN (SELECT path FROM vault_nodes)
      AND target NOT LIKE 'tag:%'
    `).all<{ target: string }>();

    let aliasesResolved = 0;
    let phantomsRemaining = 0;

    function resolvePhantom(name: string): string | null {
      // Strategy 1: Exact match on title or frontmatter alias
      const exact = aliasMap.get(name);
      if (exact && realPaths.has(exact)) return exact;

      // Strategy 2: Case-insensitive match
      const lower = aliasMapLower.get(name.toLowerCase());
      if (lower && realPaths.has(lower)) return lower;

      // Strategy 3: Try common prefixes (Concepts/, Agents/, Projects/)
      for (const prefix of ["Concepts/", "Agents/", "Projects/", "Knowledge/"]) {
        if (realPaths.has(prefix + name)) return prefix + name;
      }

      // Strategy 4: Case-insensitive prefix match
      const nameLower = name.toLowerCase();
      for (const prefix of ["Concepts/", "Agents/", "Projects/"]) {
        const candidate = prefix + name;
        const candidateLower = candidate.toLowerCase();
        for (const rp of realPaths) {
          if (rp.toLowerCase() === candidateLower) return rp;
        }
      }

      return null;
    }

    // Resolve phantom targets
    const stmts: D1PreparedStatement[] = [];
    for (const { target } of phantomTargets.results) {
      const canonical = resolvePhantom(target);
      if (canonical) {
        const affected = await env.DB.prepare(
          "SELECT source, target, edge_type, weight FROM vault_edges WHERE target = ?"
        ).bind(target).all<{ source: string; target: string; edge_type: string; weight: number }>();
        stmts.push(
          env.DB.prepare("UPDATE OR IGNORE vault_edges SET target = ? WHERE target = ?")
            .bind(canonical, target)
        );
        stmts.push(
          env.DB.prepare("DELETE FROM vault_edges WHERE target = ?").bind(target)
        );
        await applyOps(
          env,
          affected.results.flatMap((edge): Op[] => [
            {
              op_type: "remove_edge",
              origin: "phantom_rewrite",
              payload: {
                source: edge.source,
                target: edge.target,
                edge_type: edge.edge_type,
              },
            },
            {
              op_type: "add_edge",
              origin: "phantom_rewrite",
              payload: {
                source: edge.source,
                target: canonical,
                edge_type: edge.edge_type,
                weight: edge.weight ?? 1,
              },
            },
          ]),
          { materialize: false },
        );
        aliasesResolved++;
      } else {
        phantomsRemaining++;
      }

      if (stmts.length >= 80) {
        await env.DB.batch(stmts.splice(0, 80));
      }
    }
    if (stmts.length > 0) {
      await env.DB.batch(stmts);
    }

    // Resolve phantom sources
    const phantomSources = await env.DB.prepare(`
      SELECT DISTINCT source FROM vault_edges
      WHERE source NOT IN (SELECT path FROM vault_nodes)
      AND source NOT LIKE 'tag:%'
    `).all<{ source: string }>();

    const srcStmts: D1PreparedStatement[] = [];
    for (const { source } of phantomSources.results) {
      const canonical = resolvePhantom(source);
      if (canonical) {
        const affected = await env.DB.prepare(
          "SELECT source, target, edge_type, weight FROM vault_edges WHERE source = ?"
        ).bind(source).all<{ source: string; target: string; edge_type: string; weight: number }>();
        srcStmts.push(
          env.DB.prepare("UPDATE OR IGNORE vault_edges SET source = ? WHERE source = ?")
            .bind(canonical, source)
        );
        srcStmts.push(
          env.DB.prepare("DELETE FROM vault_edges WHERE source = ?").bind(source)
        );
        await applyOps(
          env,
          affected.results.flatMap((edge): Op[] => [
            {
              op_type: "remove_edge",
              origin: "phantom_rewrite",
              payload: {
                source: edge.source,
                target: edge.target,
                edge_type: edge.edge_type,
              },
            },
            {
              op_type: "add_edge",
              origin: "phantom_rewrite",
              payload: {
                source: canonical,
                target: edge.target,
                edge_type: edge.edge_type,
                weight: edge.weight ?? 1,
              },
            },
          ]),
          { materialize: false },
        );
        aliasesResolved++;
      }
      if (srcStmts.length >= 80) {
        await env.DB.batch(srcStmts.splice(0, 80));
      }
    }
    if (srcStmts.length > 0) {
      await env.DB.batch(srcStmts);
    }

    // --- Load folder membership from vault_nodes ---
    const allNodes = await env.DB.prepare(
      "SELECT path, folder, modified_at FROM vault_nodes WHERE folder != ''"
    ).all<{ path: string; folder: string; modified_at: string }>();

    const folderNotes: Record<string, Array<{ path: string; modified: string }>> = {};
    for (const row of allNodes.results) {
      if (!folderNotes[row.folder]) folderNotes[row.folder] = [];
      folderNotes[row.folder].push({ path: row.path, modified: row.modified_at });
    }

    // Add folder co-membership edges (skip folders with >50 notes)
    // PR2: legacy INSERT OR IGNORE removed — applyOps(materialize: true) handles
    // both vault_ops logging and vault_edges materialization in one D1.batch().
    let folderEdgesAdded = 0;
    for (const [, notes] of Object.entries(folderNotes)) {
      if (notes.length > 50 || notes.length < 2) continue;

      const folderOps: Op[] = [];
      for (let a = 0; a < notes.length; a++) {
        for (let b = a + 1; b < notes.length; b++) {
          folderOps.push({
            op_type: "add_edge",
            origin: "finalize",
            payload: {
              source: notes[a].path,
              target: notes[b].path,
              edge_type: "folder",
              weight: 0.5,
            },
          });
          folderEdgesAdded++;

          if (folderOps.length >= 90) {
            await applyOps(env, folderOps.splice(0, 90), { materialize: true });
          }
        }
      }
      if (folderOps.length > 0) {
        await applyOps(env, folderOps, { materialize: true });
      }
    }

    // Add temporal adjacency edges (same folder, within 1 day)
    let temporalEdgesAdded = 0;
    for (const [, notes] of Object.entries(folderNotes)) {
      if (notes.length > 50 || notes.length < 2) continue;

      const sorted = notes
        .filter((n) => n.modified)
        .sort((a, b) => new Date(a.modified).getTime() - new Date(b.modified).getTime());

      const temporalOps: Op[] = [];
      for (let a = 0; a < sorted.length; a++) {
        const aTime = new Date(sorted[a].modified).getTime();
        for (let b = a + 1; b < sorted.length; b++) {
          const bTime = new Date(sorted[b].modified).getTime();
          if (bTime - aTime > 86400000) break;
          temporalOps.push({
            op_type: "add_edge",
            origin: "finalize",
            payload: {
              source: sorted[a].path,
              target: sorted[b].path,
              edge_type: "temporal",
              weight: 0.3,
            },
          });
          temporalEdgesAdded++;

          if (temporalOps.length >= 90) {
            await applyOps(env, temporalOps.splice(0, 90), { materialize: true });
          }
        }
      }
      if (temporalOps.length > 0) {
        await applyOps(env, temporalOps, { materialize: true });
      }
    }

    // --- Tag co-occurrence edges ---
    // Notes sharing 2+ conceptual tags get a direct edge.
    // Format/source/agent tags already excluded during extraction (EXCLUDED_TAGS).
    // Only use tags appearing on 3-100 notes (rare enough to be meaningful).
    // Require 2+ shared tags to reduce noise.
    let tagCooccurrenceAdded = 0;

    const tagEdges = await env.DB.prepare(`
      SELECT e1.source AS path1, e2.source AS path2, COUNT(*) AS shared_tags
      FROM vault_edges e1
      JOIN vault_edges e2 ON e1.target = e2.target AND e1.source < e2.source
      WHERE e1.edge_type = 'tag' AND e2.edge_type = 'tag'
      AND e1.target IN (
        SELECT target FROM vault_edges WHERE edge_type = 'tag'
        GROUP BY target HAVING COUNT(*) BETWEEN 3 AND 100
      )
      -- Exclude pairs where both notes are in high-volume session/archive folders
      -- These are session logs, not semantically related content
      AND NOT (e1.source LIKE 'Archive/%' AND e2.source LIKE 'Archive/%')
      AND NOT (e1.source LIKE 'channels/%' AND e2.source LIKE 'channels/%')
      AND NOT (e1.source LIKE 'transcripts/%' AND e2.source LIKE 'transcripts/%')
      GROUP BY e1.source, e2.source
      HAVING shared_tags >= 2
      LIMIT 10000
    `).all<{ path1: string; path2: string; shared_tags: number }>();

    const tagOps: Op[] = [];
    for (const { path1, path2, shared_tags } of tagEdges.results) {
      const weight = 0.2 + (shared_tags * 0.3); // 1 shared = 0.5, 2 = 0.8, 3+ = 1.1+
      tagOps.push({
        op_type: "add_edge",
        origin: "finalize",
        payload: {
          source: path1,
          target: path2,
          edge_type: "tag_cooccurrence",
          weight: Math.min(weight, 1.5),
        },
      });
      tagCooccurrenceAdded++;
      if (tagOps.length >= 90) {
        await applyOps(env, tagOps.splice(0, 90), { materialize: true });
      }
    }
    if (tagOps.length > 0) {
      await applyOps(env, tagOps, { materialize: true });
    }

    // Compute degrees — finalize phase touches many paths, so a full-table
    // recompute is cheaper than per-path UPDATEs.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE vault_nodes SET out_degree = (SELECT COUNT(*) FROM vault_edges WHERE source = vault_nodes.path)"
      ),
      env.DB.prepare(
        "UPDATE vault_nodes SET in_degree = (SELECT COUNT(*) FROM vault_edges WHERE target = vault_nodes.path)"
      ),
    ]);

    // PR3: advance the __last_degree_drain__ watermark to the current
    // MAX(vault_ops.id). The full-table UPDATE above already recomputed
    // every node's degrees, so drainDegrees only needs to stamp the new
    // watermark — subsequent syncGraph calls will scope their scan to ops
    // appended after this finalize.
    await drainDegrees(env);

    // L2 snapshot fix (#70): 2 separate COUNT(*) → single UNION ALL statement
    // batched with byType GROUP BY (can't merge into UNION: multi-row).
    // One statement = smaller race window than sequential awaits.
    // See: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
    //
    // Writers: buildGraph (this function, Cron-serialized + ingest_runs lease),
    // syncGraph (origin-scoped, fenced by ingest_runs lease_expires).
    // Readers: this finalize block.
    // Falsifying interleaving: between old separate COUNT(*) calls, a concurrent
    // syncGraph INSERT could make nodeCount stale relative to edgeCount. The
    // single UNION ALL statement eliminates that gap.
    const [countsResult, byTypeResult] = await env.DB.batch([
      env.DB.prepare(`
        SELECT 'node_count' as kind, CAST(COUNT(*) as TEXT) as val FROM vault_nodes
        UNION ALL
        SELECT 'edge_count', CAST(COUNT(*) as TEXT) FROM vault_edges
      `),
      env.DB.prepare(EDGES_BY_TYPE_SQL),
    ]);
    const countsMap = scalarMap(countsResult.results as { kind: string; val: string }[]);
    const finalNodeCount = parseInt(countsMap.get("node_count") ?? "0", 10);
    const finalEdgeCount = parseInt(countsMap.get("edge_count") ?? "0", 10);
    const byType = byTypeResult as D1Result<{ edge_type: string; count: number }>;

    // Record build completion timestamp.
    await env.DB.prepare(
      "INSERT OR REPLACE INTO vault_nodes (path, title, note_type, folder, tags, size, modified_at, indexed_at) VALUES ('__last_build_completed__', 'build_graph', null, '', '[]', ?, '', datetime('now'))"
    ).bind(finalNodeCount).run();

    // Mark the ingest_runs row for this build as completed so the enrichment
    // orchestrator's in-flight probe stops seeing 'running'. The run id was
    // stashed on the __build_run_id__ sentinel during the extract phase.
    // (Codex P1 round-16 finding.)
    const buildRunRow = await env.DB.prepare(
      "SELECT title FROM vault_nodes WHERE path = '__build_run_id__'"
    ).first<{ title: string }>().catch(() => null);
    if (buildRunRow?.title) {
      await env.DB.prepare(
        "UPDATE ingest_runs SET status = 'completed', completed_at = unixepoch(), node_count = ? WHERE id = ? AND completed_at IS NULL"
      ).bind(finalNodeCount, buildRunRow.title).run().catch((err) => { console.warn("buildGraph ingest_runs completion failed:", String(err).slice(0, 160)); });
      await env.DB.prepare("DELETE FROM vault_nodes WHERE path = '__build_run_id__'").run().catch(() => {});
    } else {
      // Sentinel missing — finalize cannot determine which ingest_runs row to
      // mark completed. Attempt orphan recovery: find the most recent running
      // build row and mark it as error.
      console.error("buildGraph finalize: __build_run_id__ sentinel missing; cannot mark ingest_runs terminal via sentinel");
      const orphanRow = await env.DB.prepare(
        "SELECT id FROM ingest_runs WHERE id LIKE 'build-%' AND status = 'running' ORDER BY started_at DESC LIMIT 1"
      ).first<{ id: string }>().catch(() => null);
      if (orphanRow?.id) {
        await env.DB.prepare(
          "UPDATE ingest_runs SET status = 'error', completed_at = COALESCE(completed_at, unixepoch()), error = 'sentinel __build_run_id__ missing at finalize' WHERE id = ? AND completed_at IS NULL"
        ).bind(orphanRow.id).run().catch((e) => {
          console.error("buildGraph finalize: orphan recovery UPDATE failed:", String(e).slice(0, 160));
        });
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    return JSON.stringify({
      phase: "finalize",
      done: true,
      total_nodes: finalNodeCount,
      total_edges: finalEdgeCount,
      edges_by_type: Object.fromEntries(byType.results.map((r) => [r.edge_type, r.count])),
      aliases_resolved: aliasesResolved,
      phantom_targets_found: phantomTargets.results.length,
      phantoms_remaining: phantomsRemaining,
      tag_cooccurrence_edges: tagCooccurrenceAdded,
      folder_edges_added: folderEdgesAdded,
      temporal_edges_added: temporalEdgesAdded,
      elapsed_seconds: parseFloat(elapsed),
    }, null, 2);
  }

  return JSON.stringify({ error: `Unknown phase: ${currentPhase}. Use 'extract' or 'finalize'.` });
}

// ---------------------------------------------------------------------------
// drainDegrees — Tier A PR3 ops-derived degree recompute
// ---------------------------------------------------------------------------
//
// Replaces both the legacy dirty-paths queue and sync_writer_lease (PR3 step 1+2).
//
// Pre-PR3 the lease serialized vault_edges writers and a separate dirty-paths
// queue tracked which paths needed degree recompute. PR2
// already retired the lease on the main writer paths in favor of origin-scoped
// reconciliation; PR3 retires the dirty-degrees queue too. Dirty paths now
// derive directly from vault_ops via the __last_degree_drain__ watermark —
// snapshot the current MAX(id), recompute degrees for paths touched between
// the previous watermark and the snapshot, then advance the watermark in the
// SAME batch. Concurrent writers after the snapshot capture get higher ids
// and are picked up by the next drain. No race.

export type SyncResult = { body: string; status: number; headers?: Record<string, string> };

const SYNC_LIMIT = 20; // Max notes per syncGraph call — keeps within Worker time limits
const SYNC_BATCH_SIZE = 5; // R2 reads per batch — stays under 6-connection limit

/** Ops-derived degree recompute. Reads __last_degree_drain__ watermark from
 *  vault_nodes.size, captures snapshot_max_id from vault_ops within the same
 *  range, queries dirty paths via the 3-way UNION over add_edge/remove_edge
 *  (source + target) and upsert_node/delete_node (path), updates degrees per
 *  dirty path, and stamps the new watermark — all in one env.DB.batch() so
 *  the recompute and watermark advance commit atomically. */
async function drainDegrees(env: Env): Promise<void> {
  // Failures THROW. The watermark stays put on error so the next caller
  // re-reads the same range, but masking via console.warn would hide a
  // real schema/D1 regression — operators must see drain failures as
  // non-2xx responses, not green logs with stale degree state.
  const prev = await env.DB.prepare(
    "SELECT size as since_id FROM vault_nodes WHERE path = '__last_degree_drain__'"
  ).first<{ since_id: number }>();
  const sinceId = prev?.since_id ?? 0;

  const snap = await env.DB.prepare(
    "SELECT MAX(id) as max_id FROM vault_ops WHERE id > ?"
  ).bind(sinceId).first<{ max_id: number | null }>();
  const snapshotMaxId = snap?.max_id;
  if (snapshotMaxId === null || snapshotMaxId === undefined) return; // nothing to drain

  const dirtyRes = await env.DB.prepare(`
    SELECT DISTINCT json_extract(payload_json, '$.source') AS path FROM vault_ops
      WHERE id > ?1 AND id <= ?2 AND op_type IN ('add_edge', 'remove_edge')
    UNION
    SELECT DISTINCT json_extract(payload_json, '$.target') AS path FROM vault_ops
      WHERE id > ?1 AND id <= ?2 AND op_type IN ('add_edge', 'remove_edge')
    UNION
    SELECT DISTINCT json_extract(payload_json, '$.path') AS path FROM vault_ops
      WHERE id > ?1 AND id <= ?2 AND op_type IN ('upsert_node', 'delete_node')
  `).bind(sinceId, snapshotMaxId).all<{ path: string | null }>();

  const stmts: D1PreparedStatement[] = [];
  for (const row of dirtyRes.results) {
    if (!row.path) continue;
    stmts.push(env.DB.prepare(
      "UPDATE vault_nodes SET out_degree = (SELECT COUNT(*) FROM vault_edges WHERE source = ?), in_degree = (SELECT COUNT(*) FROM vault_edges WHERE target = ?) WHERE path = ?"
    ).bind(row.path, row.path, row.path));
  }
  stmts.push(env.DB.prepare(
    "INSERT OR REPLACE INTO vault_nodes (path, title, note_type, folder, tags, size, modified_at, indexed_at) VALUES ('__last_degree_drain__', 'degree_drain', null, '', '[]', ?, '', datetime('now'))"
  ).bind(snapshotMaxId));
  await env.DB.batch(stmts);
}

async function syncGraph(
  env: Env,
  force: boolean = false,
  forceReason?: string
): Promise<SyncResult> {
  if (forceReason) console.log(`syncGraph force_reason=${forceReason}`);
  if (await checkMaintenanceMode(env)) return badMaintenanceResult();

  // PR3: sync_writer_lease retired. Origin-scoping IS the fencing mechanism:
  // syncGraph's DELETE only touches origin='extract' edges (split-DELETE),
  // so ingest_triples writes to origin='ingest_triples' are never clobbered.
  // reconcileExtract wraps DELETE+INSERT+upsert in one D1.batch() call for
  // atomic last-writer-wins within the extract origin.
  return await syncGraphInner(env, force);
}

async function syncGraphInner(
  env: Env,
  force: boolean
): Promise<SyncResult> {
  const startTime = Date.now();
  const json = (obj: unknown, status = 200): SyncResult => ({
    body: JSON.stringify(obj),
    status,
    headers: { "Content-Type": "application/json" },
  });

  // Drain guard: BEFORE the cooldown check + BEFORE the modified.length===0
  // early-return. This picks up degree work produced by other writers
  // (/api/ingest-triples, MCP ingest_triples tool) that ran since the last
  // syncGraph call, even when this call would otherwise no-op.
  await drainDegrees(env);

  // Guard: skip if last sync was < 1h ago. Bypassed by force=true so that
  // callers can publish fresh Wiki/ edges immediately without
  // waiting out the cron cooldown. Concurrent-syncGraph safety still holds
  // because every call inserts a fresh ingest_runs row; if another sync is
  // mid-batch, its 'partial' row will be reclaimed by the next caller, not
  // by a racing force=true call.
  if (!force) {
    const lastSync = await env.DB.prepare(
      "SELECT indexed_at FROM vault_nodes WHERE path = '__last_sync__'"
    ).first<{ indexed_at: string }>();
    if (lastSync) {
      const minsAgo = (Date.now() - new Date(lastSync.indexed_at).getTime()) / 60000;
      if (minsAgo < 60) {
        return json({ skipped: true, last_sync: lastSync.indexed_at, message: `sync_graph ran ${minsAgo.toFixed(0)}m ago` });
      }
    }
  }

  // Partial-ingest lifecycle cleanup: any existing 'partial' ingest_runs
  // row is by definition an orphan from a previous syncGraph call that
  // abandoned its batch. Concurrent syncGraph runs are prevented by the
  // 60-minute cooldown guard above (line ~1017), so reaching this point
  // Record ingest run start. DO NOT advance meta.last_ingest_run_id yet —
  // wait until we know whether any notes actually changed. Advancing the
  // race-guard marker for every syncGraph call (including no-ops) would
  // make the weekly enrichment cron discard healthy runs whenever a cron
  // sync happens to land mid-enrichment on an unchanged vault.
  // (Codex P1 round-4 finding + P2 round-12 refinement.)
  //
  // INSERT MUST happen BEFORE the partial-reclaim below, otherwise there
  // is a window where the old 'partial' row has been marked completed but
  // the new 'running' row has not yet been inserted. An overlapping
  // enrichment cron landing in that window would see no in-flight ingest
  // and publish scores against a partially refreshed graph — exactly the
  // scenario the round-40 gate exists to block.
  // (Codex round-48 P2 finding — reorder fixes round-44's reclaim race.)
  // Phase 3: ULID-based run ID for cross-peer dedup safety.
  //
  // Concurrency walk:
  //   Writers: CF Worker isolates (cron + HTTP) and future local peer.
  //   Readers: drainDegrees (vault_edges.ingest_run_id), ingest_runs tracker.
  //   SQL statement: INSERT INTO ingest_runs (id, ...) VALUES (ingestRunId, ...)
  //                  + INSERT INTO vault_edges (..., ingest_run_id) VALUES (..., ingestRunId)
  //   Falsifying interleaving: two writers generate the same ingestRunId in
  //     the same ms, causing PK collision on ingest_runs INSERT or making
  //     their vault_edges rows indistinguishable by ingest_run_id.
  //   Blocking primitive: ULID's 80-bit random suffix (crypto.getRandomValues
  //     in src/ulid.ts). Collision probability per pair: 2^-80 (~8e-25).
  const ingestRunId = `sync-${ulid()}`;
  // INSERT must succeed or we abort the run — no .catch() swallow.
  // Cron retries on next tick; far better than silent unobservable runs.
  await env.DB.prepare(
    "INSERT INTO ingest_runs (id, started_at, status) VALUES (?, unixepoch(), 'running')"
  ).bind(ingestRunId).run();

  // Lifecycle tracking for try/finally terminal UPDATE (plan 2026-04-27-001).
  // Default to 'error' so any unhandled exit leaves a terminal row, not an orphan.
  let finalStatus: 'noop' | 'partial' | 'completed' | 'error' = 'error';
  let finalNodeCount: number | null = null;
  let finalError: string | null = 'aborted before finally set status';

  try {

  // Partial-ingest lifecycle cleanup: any existing 'partial' ingest_runs
  // row is by definition an orphan from a previous syncGraph call that
  // abandoned its batch. Concurrent syncGraph runs are prevented by the
  // 60-minute cooldown guard above, so reaching this point means no other
  // caller is mid-batch — every partial visible here is stale breadcrumbs.
  // Clear them all AFTER the new 'running' row is in place, so the
  // enrichment gate (`status IN ('running','partial')`) always sees at
  // least one in-flight ingest during the transition.
  // (Codex round-44 P1 — gate leak; round-48 P2 — ordering race.)
  // EXISTS-gated partial reclaim — skip the UPDATE when there are no partial
  // rows to reclaim. Saves a write per call in steady state.
  const hasPartial = await env.DB.prepare(
    "SELECT EXISTS(SELECT 1 FROM ingest_runs WHERE status = 'partial') AS has_partial"
  ).first<{ has_partial: number }>();
  if (hasPartial?.has_partial) {
    await env.DB.prepare(
      `UPDATE ingest_runs
       SET status = 'completed', completed_at = unixepoch()
       WHERE status = 'partial'`
    ).run().catch((err) => { console.warn("partial reclaim failed:", String(err).slice(0, 160)); });
  }

  // Get all indexed timestamps
  const indexed = await env.DB.prepare("SELECT path, indexed_at FROM vault_nodes").all<{
    path: string;
    indexed_at: string;
  }>();
  const indexedMap = new Map<string, string>();
  for (const row of indexed.results) {
    indexedMap.set(row.path, row.indexed_at);
  }

  // List all R2 objects
  const allKeys: Array<{ key: string; size: number; uploaded: string }> = [];
  let cursor: string | undefined;
  do {
    const listed = await env.VAULT.list({ cursor, limit: 1000 });
    for (const obj of listed.objects) {
      if (obj.key.endsWith(".md") && !obj.key.startsWith(".")) {
        allKeys.push({ key: obj.key, size: obj.size, uploaded: obj.uploaded.toISOString() });
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  // Build short-name → full-path resolution map for Obsidian-style wikilinks.
  // [[B]] in Notes/A.md resolves to Notes/B when that path exists in the vault.
  // Seeds from vault_nodes (existing indexed paths) first, then R2 keys
  // (source of truth, overwrites on conflict) so newly-added notes are covered.
  // Short-form wikilinks (no '/') are resolved; already-qualified paths unchanged.
  const shortNameToPath = new Map<string, string>();
  for (const row of indexed.results) {
    const shortName = row.path.split("/").pop();
    if (shortName && !shortNameToPath.has(shortName)) {
      shortNameToPath.set(shortName, row.path);
    }
  }
  for (const { key } of allKeys) {
    const fullPath = stripExtension(key);
    const shortName = fullPath.split("/").pop();
    if (shortName) {
      shortNameToPath.set(shortName, fullPath); // R2 wins over stale vault_nodes
    }
  }

  // Find modified notes
  const modified: typeof allKeys = [];
  for (const item of allKeys) {
    const path = stripExtension(item.key);
    const lastIndexed = indexedMap.get(path);
    if (!lastIndexed || new Date(item.uploaded) > new Date(lastIndexed)) {
      modified.push(item);
    }
  }

  if (modified.length === 0) {
    // No-op sync. Mark ingest_runs 'noop' and DO NOT advance
    // meta.last_ingest_run_id — the graph is unchanged so the race guard
    // must not fire against the overlapping enrichment cron.
    // (Codex P2 round-12 finding.)
    //
    // __last_sync__ write deferred — only stamp when the current row is
    // missing OR > 6h old. Saves a write per no-op call.
    const lastSyncRow = await env.DB.prepare(
      "SELECT indexed_at FROM vault_nodes WHERE path = '__last_sync__'"
    ).first<{ indexed_at: string }>();
    const lastSyncAgeMs = lastSyncRow ? Date.now() - new Date(lastSyncRow.indexed_at).getTime() : Infinity;
    if (lastSyncAgeMs > 6 * 60 * 60 * 1000) {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO vault_nodes (path, title, note_type, folder, tags, size, modified_at, indexed_at) VALUES ('__last_sync__', 'sync_graph', null, '', '[]', 0, '', datetime('now'))"
      ).run();
    }
    finalStatus = 'noop';
    finalNodeCount = 0;
    finalError = null;
    return json({ synced: 0, total_modified: 0, done: true, message: "No modified notes found" });
  }

  // modified.length > 0 — advance meta.last_ingest_run_id NOW so the
  // orchestrator's race guard fires if enrichment is running concurrently.
  // This is safe: we're about to write new node rows and edges.
  await env.DB.prepare(
    "INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('last_ingest_run_id', ?, unixepoch())"
  ).bind(ingestRunId).run().catch((err) => { console.warn("meta.last_ingest_run_id advance failed:", String(err).slice(0, 160)); });

  // Process up to SYNC_LIMIT notes per call
  const toProcess = modified.slice(0, SYNC_LIMIT);
  let synced = 0;

  for (let i = 0; i < toProcess.length; i += SYNC_BATCH_SIZE) {
    const batch = toProcess.slice(i, i + SYNC_BATCH_SIZE);
    const fetches = batch.map((item) => env.VAULT.get(item.key));
    const objects = await Promise.all(fetches);

    for (let j = 0; j < objects.length; j++) {
      const obj = objects[j];
      if (!obj) continue;

      const content = await obj.text();
      const path = stripExtension(batch[j].key);

      // Capture OLD edge targets BEFORE mutations so we can mark them as
      // dirty — their in_degree changes when the source's edges are replaced.
      const oldTargetsRes = await env.DB.prepare(
        "SELECT target FROM vault_edges WHERE source = ?"
      ).bind(path).all<{ target: string }>();
      const oldTargets = oldTargetsRes.results.map((r) => r.target);

      // Snapshot current extract edges to compute the add/remove diff for
      // vault_ops (audit log). reconcileExtract handles the actual materialization
      // atomically via DELETE+INSERT in one D1.batch() call.
      const currentExtractEdgesRes = await env.DB.prepare(`
        SELECT source, target, edge_type, weight
        FROM vault_edges
        WHERE origin = 'extract' AND (
          (source = ?1 AND edge_type != 'spoke_in')
          OR (target = ?1 AND edge_type = 'spoke_in')
        )
      `).bind(path).all<{ source: string; target: string; edge_type: string; weight: number }>();

      const { node, edges: rawEdges, aliases: syncAliases } = extractEdgesFromNote(
        batch[j].key,
        content,
        batch[j].uploaded,
        batch[j].size
      );
      // Resolve short-form wikilink targets (e.g. [[B]] → Notes/B) using the
      // R2 manifest built above. Targets that already contain '/' are full paths
      // and are left unchanged. Targets with no match remain as phantom targets.
      const edges = rawEdges.map(edge => ({
        ...edge,
        target: !edge.target.includes("/") && shortNameToPath.has(edge.target)
          ? shortNameToPath.get(edge.target)!
          : edge.target,
      }));

      const ftsSyncBody = content.replace(/^---\n[\s\S]*?\n---\n?/, "");

      // Compute SHA-256 content_hash of the raw body (E1)
      const bodyBytes = new TextEncoder().encode(content);
      const hashBuf = await crypto.subtle.digest("SHA-256", bodyBytes);
      const contentHash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
      const wordCount = ftsSyncBody.split(/\s+/).filter(Boolean).length;

      // Parse frontmatter to JSON for storage. Hono /api/frontmatter/schema
      // and /api/frontmatter/filter both JSON.parse(vault_nodes.frontmatter),
      // so we must store the parsed form, not the raw YAML block.
      // On pre-migration-0004 databases the new columns don't exist, so fall
      // back to the legacy INSERT. (Codex P1 round-11 finding.)
      const parsedFm = parseFrontmatterExtended(content);
      const frontmatterRaw = parsedFm ? JSON.stringify(parsedFm) : null;
      const syncHas005 = await hasPlan005VaultNodeColumns(env);

      // Compute add/remove diff for vault_ops audit log. reconcileExtract
      // materializes the FULL desired set atomically; these ops are only for
      // the ops-log so replay knows what changed.
      const desiredKeySet = new Set(edges.map((edge) => opKey(edge.source, edge.target, edge.edge_type)));
      const currentByKey = new Map(
        currentExtractEdgesRes.results.map((edge) => [opKey(edge.source, edge.target, edge.edge_type), edge] as const)
      );
      const addOps: Op[] = edges
        .filter((edge) => !currentByKey.has(opKey(edge.source, edge.target, edge.edge_type)))
        .map((edge) => ({
          op_type: "add_edge",
          origin: "extract",
          payload: {
            source: edge.source,
            target: edge.target,
            edge_type: edge.edge_type,
            weight: edge.weight,
            ingest_run_id: ingestRunId,
          },
        }));
      const removeOps: Op[] = currentExtractEdgesRes.results
        .filter((edge) => !desiredKeySet.has(opKey(edge.source, edge.target, edge.edge_type)))
        .map((edge) => ({
          op_type: "remove_edge",
          origin: "extract",
          payload: {
            source: edge.source,
            target: edge.target,
            edge_type: edge.edge_type,
          },
        }));

      // Build nodeStmt for reconcileExtract. Conditional on schema probes so
      // pre-migration DBs don't fail on missing columns. (Codex P1 round-11.)
      const nodeStmt: D1PreparedStatement = syncHas005
        ? env.DB.prepare(
            "INSERT INTO vault_nodes (path, title, note_type, folder, tags, aliases, size, modified_at, indexed_at, body, word_count, content_hash, frontmatter, ingest_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET title = excluded.title, note_type = excluded.note_type, folder = excluded.folder, tags = excluded.tags, aliases = excluded.aliases, size = excluded.size, modified_at = excluded.modified_at, indexed_at = excluded.indexed_at, body = excluded.body, word_count = excluded.word_count, content_hash = excluded.content_hash, frontmatter = excluded.frontmatter, ingest_run_id = excluded.ingest_run_id"
          ).bind(node.path, node.title, node.note_type, node.folder, node.tags, JSON.stringify(syncAliases), node.size, node.modified_at, content, wordCount, contentHash, frontmatterRaw, ingestRunId)
        : env.DB.prepare(
            "INSERT INTO vault_nodes (path, title, note_type, folder, tags, aliases, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(path) DO UPDATE SET title = excluded.title, note_type = excluded.note_type, folder = excluded.folder, tags = excluded.tags, aliases = excluded.aliases, size = excluded.size, modified_at = excluded.modified_at, indexed_at = excluded.indexed_at"
          ).bind(node.path, node.title, node.note_type, node.folder, node.tags, JSON.stringify(syncAliases), node.size, node.modified_at);

      // PR2: desiredEdges is the FULL new set for this path (origin='extract').
      // reconcileExtract atomically deletes old extract edges and inserts these
      // in ONE D1.batch() call — last-writer-wins for concurrent syncGraph calls.
      // ingest_run_id is passed; applyOps gates its inclusion on the schema probe.
      const desiredEdges: VaultEdge[] = edges.map((edge) => ({
        source: edge.source,
        target: edge.target,
        edge_type: edge.edge_type,
        weight: edge.weight,
        ingest_run_id: ingestRunId,
        origin: "extract",
      }));

      // Single atomic batch: DELETE extract edges, INSERT desired, upsert node,
      // log ops. FTS is handled separately below. Dirty-path tracking is now
      // ops-derived via drainDegrees() at the tail of syncGraph (PR3).
      await applyOps(
        env,
        [
          {
            op_type: "upsert_node",
            origin: "extract",
            payload: {
              path: node.path,
              title: node.title,
              note_type: node.note_type,
              folder: node.folder,
              tags: node.tags,
              aliases: syncAliases,
              size: node.size,
              modified_at: node.modified_at,
              body: content,
              word_count: wordCount,
              content_hash: contentHash,
              frontmatter: frontmatterRaw,
              ingest_run_id: ingestRunId,
            },
          },
          ...addOps,
          ...removeOps,
        ],
        {
          reconcileExtract: { path, desiredEdges, nodeStmt },
        },
      );

      // FTS is non-critical and not origin-scoped — handle separately so it
      // does not block the atomic edge/node batch from landing.
      await env.DB.prepare("DELETE FROM vault_fts WHERE path = ?").bind(path).run().catch(() => {});
      await env.DB.prepare(
        "INSERT INTO vault_fts (path, title, content, tags) VALUES (?, ?, ?, ?)"
      ).bind(node.path, node.title, ftsSyncBody, node.tags || "").run().catch(() => {});

      synced++;
    }
  }

  // PR3: ops-derived degree recompute. drainDegrees reads vault_ops since the
  // __last_degree_drain__ watermark, recomputes degrees for paths touched in
  // that range, and stamps the new watermark — all in one batch. Replaces the
  // legacy dirty-paths rowid-snapshot drain.
  await drainDegrees(env);

  const remaining = modified.length - toProcess.length;
  const done = remaining === 0;

  // Mark the ingest_runs row completed on EVERY return path, not only `done`.
  // Partial syncs (SYNC_LIMIT hit) previously left a permanent 'running' row
  // until the follow-up call finished hours later.
  // (Codex P2 round-3 finding.)
  if (!done) {
    finalStatus = 'partial';
    finalNodeCount = synced;
    finalError = null;
  }

  // Record sync completion only when fully caught up
  if (done) {
    finalStatus = 'completed';
    finalNodeCount = synced;
    finalError = null;
    await env.DB.prepare(
      "INSERT OR REPLACE INTO vault_nodes (path, title, note_type, folder, tags, size, modified_at, indexed_at) VALUES ('__last_sync__', 'sync_graph', null, '', '[]', ?, '', datetime('now'))"
    ).bind(synced).run();
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  return json({ synced, total_modified: modified.length, remaining, done, elapsed_seconds: parseFloat(elapsed) });
  } catch (err) {
    // Override any happy-path status set before the throw — a thrown exception
    // means the run failed, even if finalStatus was already 'completed'.
    // (Codex review: avoids contradictory completed+error row.)
    finalStatus = 'error';
    finalError = String(err).slice(0, 160);
    throw err;
  } finally {
    // Single terminal UPDATE — idempotent via WHERE completed_at IS NULL.
    // .catch() here is correct: re-throwing inside finally would mask the
    // original exception (if any). Phase 5 verification catches residual orphans.
    await env.DB.prepare(
      `UPDATE ingest_runs
       SET status = ?,
           completed_at = COALESCE(completed_at, unixepoch()),
           node_count = COALESCE(node_count, ?),
           error = COALESCE(error, ?)
       WHERE id = ? AND completed_at IS NULL`
    ).bind(finalStatus, finalNodeCount, finalError, ingestRunId)
     .run()
     .catch((err) => {
       console.error("ingest_runs terminal UPDATE failed in finally:", String(err).slice(0, 160));
     });
  }
}

// ---------------------------------------------------------------------------
// Graph query tools
// ---------------------------------------------------------------------------

export async function toolFindRelated(
  env: Env,
  path: string,
  depth: number = 2,
  edgeTypes: string[] = ["wikilink", "related", "tag"]
): Promise<string> {
  // Load hub degrees for dampening — nodes with >50 connections get discounted
  // so they don't dominate results (e.g., high-degree concept nodes connecting all learnings equally)
  const HUB_THRESHOLD = 50;
  const hubDegrees = new Map<string, number>();
  const hubs = await env.DB.prepare(
    "SELECT path, in_degree + out_degree AS total_degree FROM vault_nodes WHERE in_degree + out_degree > ?"
  ).bind(HUB_THRESHOLD).all<{ path: string; total_degree: number }>();
  for (const h of hubs.results) {
    hubDegrees.set(h.path, h.total_degree);
  }

  // BFS with depth tracking
  const visited = new Map<string, { score: number; via: string[]; depth: number }>();
  visited.set(path, { score: 0, via: [], depth: 0 });

  let frontier = [path];

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const nextFrontier: string[] = [];
    const neighborsByNode = new Map<
      string,
      Array<{ neighbor: string; edge_type: string; weight: number }>
    >();
    const maxFrontierChunkSize = Math.max(1, 100 - edgeTypes.length);

    for (let i = 0; i < frontier.length; i += maxFrontierChunkSize) {
      const frontierChunk = frontier.slice(i, i + maxFrontierChunkSize);
      const frontierPlaceholders = frontierChunk.map(() => "?").join(", ");
      const typePlaceholders = edgeTypes.map(() => "?").join(", ");

      const outgoing = await env.DB.prepare(
        `SELECT source, target, edge_type, weight FROM vault_edges WHERE source IN (${frontierPlaceholders}) AND edge_type IN (${typePlaceholders})`
      )
        .bind(...frontierChunk, ...edgeTypes)
        .all<{ source: string; target: string; edge_type: string; weight: number }>();

      const incoming = await env.DB.prepare(
        `SELECT target AS source_node, source AS neighbor, edge_type, weight FROM vault_edges WHERE target IN (${frontierPlaceholders}) AND edge_type IN (${typePlaceholders})`
      )
        .bind(...frontierChunk, ...edgeTypes)
        .all<{ source_node: string; neighbor: string; edge_type: string; weight: number }>();

      for (const { source, target, edge_type, weight } of outgoing.results) {
        const neighbors = neighborsByNode.get(source) ?? [];
        neighbors.push({ neighbor: target, edge_type, weight });
        neighborsByNode.set(source, neighbors);
      }

      for (const { source_node, neighbor, edge_type, weight } of incoming.results) {
        const neighbors = neighborsByNode.get(source_node) ?? [];
        neighbors.push({ neighbor, edge_type, weight });
        neighborsByNode.set(source_node, neighbors);
      }
    }

    for (const current of frontier) {
      const currentInfo = visited.get(current)!;
      const neighbors = neighborsByNode.get(current) ?? [];

      for (const { neighbor, edge_type, weight } of neighbors) {
        if (neighbor === path) continue; // Don't include seed

        // Hub dampening: if current node is a supernode, discount the edge
        // dampen factor = HUB_THRESHOLD / degree (e.g., 50/200 = 0.25x for a 200-degree hub)
        const currentDegree = hubDegrees.get(current);
        const hubDampen = currentDegree ? HUB_THRESHOLD / currentDegree : 1.0;

        // Dampen dormant/on-ice project folders — still reachable but won't dominate results.
        // Add folder prefixes here to de-prioritize inactive projects in graph traversal.
        const DAMPENED_FOLDERS: string[] = [];
        const dormantDampen = DAMPENED_FOLDERS.some(f => neighbor.startsWith(f)) ? 0.1 : 1.0;

        const edgeScore = weight * Math.pow(0.7, d + 1) * hubDampen * dormantDampen;
        const via = [...currentInfo.via, `${current} -[${edge_type}]-> ${neighbor}`];

        if (visited.has(neighbor)) {
          const existing = visited.get(neighbor)!;
          // Keep best single-edge score only — no path accumulation
          if (edgeScore > existing.score) {
            visited.set(neighbor, {
              score: edgeScore,
              via,
              depth: Math.min(existing.depth, d + 1),
            });
          }
        } else {
          visited.set(neighbor, { score: edgeScore, via, depth: d + 1 });
          nextFrontier.push(neighbor);
        }
      }
    }

    frontier = nextFrontier;
  }

  // Remove seed, tags, and rank with cluster diversity
  visited.delete(path);
  const seedFolder = getFolderFromPath(path);

  // Build sorted results, filter phantoms
  const allItems: Array<{ path: string; score: number; depth: number; via: string[] }> = [];
  for (const [notePath, info] of visited.entries()) {
    if (notePath.startsWith("tag:") || !notePath.includes("/")) continue;
    // Exclude raw session transcripts — these are logs, not knowledge content
    if (notePath.startsWith("transcripts/")) continue;
    allItems.push({
      path: notePath,
      score: parseFloat(info.score.toFixed(3)),
      depth: info.depth,
      via: info.via,
    });
  }
  allItems.sort((a, b) => b.score - a.score);

  // Fetch cluster_id for all candidates from vault_enrichment.
  // Single IN (...) query — allItems bounded at ~500 paths, well within D1's 1MB limit.
  const candidatePaths = allItems.map((r) => r.path);
  const clusterMap = new Map<string, number>();

  try {
    if (candidatePaths.length > 0) {
      const placeholders = candidatePaths.map(() => "?").join(", ");
      const rows = await env.DB.prepare(
        `SELECT path, cluster_id FROM vault_enrichment WHERE path IN (${placeholders})`
      ).bind(...candidatePaths).all<{ path: string; cluster_id: number }>();
      for (const r of rows.results) clusterMap.set(r.path, r.cluster_id);
    }
  } catch {
    // vault_enrichment may not exist (pre-migration). Fall through to folder-prefix fallback.
  }

  // Fallback: notes without cluster_id use folder-prefix (pre-enrichment or sentinel nodes)
  const getFallbackCluster = (p: string) => {
    const s = p.split("/");
    return s.length >= 2 ? `${s[0]}/${s[1]}` : s[0];
  };

  // Diversity key: string-typed throughout. "c:<cluster_id>" for enriched notes,
  // "f:<folder/subfolder>" for unenriched notes. Set<string> — no type coercion.
  const clusterKeyFor = (p: string): string => {
    const c = clusterMap.get(p);
    return c !== undefined ? `c:${c}` : `f:${getFallbackCluster(p)}`;
  };

  // Diversity: top 15 by score, then fill from unseen clusters
  const results = allItems.slice(0, 15);
  const seen = new Set(results.map((r) => r.path));
  const seenClusters = new Set<string>(results.map((r) => clusterKeyFor(r.path)));

  for (const item of allItems) {
    if (results.length >= 30) break;
    if (seen.has(item.path)) continue;
    const key = clusterKeyFor(item.path);
    if (!seenClusters.has(key)) {
      results.push(item);
      seen.add(item.path);
      seenClusters.add(key);
    }
  }

  // Wiki cross-reference: check seed + top 10 results for wiki coverage
  let wikiContext: { wiki_pages: WikiCrossRef[]; wiki_gap: boolean } = { wiki_pages: [], wiki_gap: true };
  try {
    const lookupPaths = [path, ...results.slice(0, 10).map(r => r.path)];
    const wikiPages = await findWikiPagesForPaths(env, lookupPaths, 3);
    wikiContext = { wiki_pages: wikiPages, wiki_gap: wikiPages.length === 0 };
  } catch (err) {
    console.error("[find_related] wiki cross-reference failed:", String(err).slice(0, 200));
  }

  return JSON.stringify(
    { seed: path, results, count: results.length, total_found: visited.size, wiki_context: wikiContext },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// topic_dossier — wiki-first structured retrieval (plan 2026-05-19-001 U4)
// ---------------------------------------------------------------------------

/** Parse contradiction annotations from wiki body: (compare: [[A]] vs [[B]]) */
export function parseContradictionAnnotations(body: string): Array<{ sourceA: string; sourceB: string }> {
  const pattern = /\(compare:\s*\[\[([^\]]+)\]\]\s*vs\.?\s*\[\[([^\]]+)\]\]\s*\)/gi;
  const results: Array<{ sourceA: string; sourceB: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    results.push({ sourceA: match[1].trim(), sourceB: match[2].trim() });
  }
  return results;
}

export async function toolTopicDossier(
  env: Env,
  topic: string,
  includeBody: boolean = true,
  maxSources: number = 15,
): Promise<string> {
  // ---- Step 1: find wiki page for topic ----
  // Strategy (ordered): direct slug → FTS on Wiki/ → edge-based
  type WikiRow = {
    path: string;
    title: string;
    body: string | null;
    frontmatter: string | null;
    content_hash: string | null;
  };
  let wikiRow: WikiRow | null = null;

  // 1a. Direct slug construction for each Wiki kind
  for (const folder of ["People", "Concepts", "Entities"]) {
    const candidatePath = `Wiki/${folder}/${wikiSlugify(topic)}`;
    const row = await env.DB.prepare(
      `SELECT path, title, body, frontmatter, content_hash FROM vault_nodes WHERE path = ?`
    ).bind(candidatePath).first<WikiRow>();
    if (row) {
      wikiRow = row;
      break;
    }
  }

  // 1b. FTS search filtered to Wiki/ paths
  if (!wikiRow) {
    try {
      const ftsQuery = sanitizeFtsQuery(topic, FTS_COLUMNS);
      const ftsRow = await env.DB.prepare(
        `SELECT path, title, body, frontmatter, content_hash FROM vault_nodes
         WHERE path IN (
           SELECT path FROM vault_fts WHERE vault_fts MATCH ? AND path LIKE 'Wiki/%'
           ORDER BY rank LIMIT 1
         )`
      ).bind(ftsQuery).first<WikiRow>();
      if (ftsRow) wikiRow = ftsRow;
    } catch {
      // FTS table may not exist — continue to fallback
    }
  }

  // 1c. Edge-based: search for topic in vault_nodes, then find wiki pages via wikilinks
  if (!wikiRow) {
    try {
      const ftsQuery = sanitizeFtsQuery(topic, FTS_COLUMNS);
      const topicNode = await env.DB.prepare(
        `SELECT path FROM vault_fts WHERE vault_fts MATCH ? ORDER BY rank LIMIT 1`
      ).bind(ftsQuery).first<{ path: string }>();
      if (topicNode) {
        const wikiEdge = await env.DB.prepare(
          `SELECT source FROM vault_edges WHERE edge_type = 'wikilink' AND target = ? AND source LIKE 'Wiki/%' LIMIT 1`
        ).bind(topicNode.path).first<{ source: string }>();
        if (wikiEdge) {
          wikiRow = await env.DB.prepare(
            `SELECT path, title, body, frontmatter, content_hash FROM vault_nodes WHERE path = ?`
          ).bind(wikiEdge.source).first<WikiRow>();
        }
      }
    } catch {
      // Edge lookup may fail — continue without wiki
    }
  }

  // ---- Step 2: no wiki page → return gap signal with FTS matches ----
  if (!wikiRow) {
    let additionalMatches: Array<{ path: string; snippet: string }> = [];
    try {
      const ftsQuery = sanitizeFtsQuery(topic, FTS_COLUMNS);
      const ftsResults = await env.DB.prepare(
        `SELECT path, snippet(vault_fts, 2, '>>>', '<<<', '...', 20) as snippet
         FROM vault_fts WHERE vault_fts MATCH ? ORDER BY rank LIMIT ?`
      ).bind(ftsQuery, maxSources).all<{ path: string; snippet: string }>();
      additionalMatches = ftsResults.results.map(r => ({
        path: r.path + ".md",
        snippet: r.snippet.replace(/>>>/g, "**").replace(/<<</g, "**"),
      }));
    } catch {
      // FTS may not be populated
    }

    return JSON.stringify({
      wiki_synthesis: null,
      synthesis_sources: [],
      additional_matches: additionalMatches,
      coverage: {
        freshness_status: null,
        synthesis_source_count: 0,
        total_source_count: 0,
        wiki_gap: true,
      },
    }, null, 2);
  }

  // ---- Step 3: wiki page found → build structured bundle ----
  let sources: string[] = [];
  let synthesisSources: string[] = [];
  let compiledAt: string | null = null;
  let sourceHash: string | null = null;

  if (wikiRow.frontmatter) {
    try {
      const fm = JSON.parse(wikiRow.frontmatter);
      sources = Array.isArray(fm.sources) ? fm.sources : [];
      synthesisSources = Array.isArray(fm.synthesis_sources) ? fm.synthesis_sources : sources;
      compiledAt = fm.compiled_at ?? null;
      sourceHash = fm.source_hash ?? null;
    } catch {
      // Malformed frontmatter
    }
  }

  // Body excerpt: from vault_nodes.body (D1, zero latency), R2 fallback
  let bodyExcerpt: string | null = null;
  let contradictionAnnotations: Array<{ sourceA: string; sourceB: string }> = [];

  if (includeBody) {
    let fullBody = wikiRow.body;

    if (!fullBody) {
      // R2 fallback
      try {
        const r2Obj = await (env as any).VAULT?.get(wikiRow.path + ".md");
        if (r2Obj) fullBody = await r2Obj.text();
      } catch (err) {
        console.error("[topic_dossier] R2 read failed:", String(err).slice(0, 200));
      }
    }

    if (fullBody) {
      bodyExcerpt = fullBody.slice(0, 3000);
      contradictionAnnotations = parseContradictionAnnotations(fullBody);
    }
  }

  // Freshness check — verify synthesis sources still exist in vault_nodes.
  // Does NOT compare content_hash values (no stored baseline to compare against).
  // "stale" = some synthesis sources missing from vault_nodes.
  // "thin" = only 1 synthesis source. "fresh" = all present. "unknown" = no metadata.
  let freshnessStatus: "fresh" | "stale" | "thin" | "unknown" = "unknown";
  if (synthesisSources.length === 0) {
    freshnessStatus = "unknown";
  } else if (synthesisSources.length === 1) {
    freshnessStatus = "thin";
  } else if (sourceHash && synthesisSources.length > 0) {
    const srcChunk = synthesisSources.slice(0, 50);
    const srcPlaceholders = srcChunk.map(() => "?").join(", ");
    try {
      const srcRows = await env.DB.prepare(
        `SELECT path, content_hash FROM vault_nodes WHERE path IN (${srcPlaceholders})`
      ).bind(...srcChunk).all<{ path: string; content_hash: string | null }>();
      const foundSrcCount = srcRows.results.filter(r => r.content_hash).length;
      freshnessStatus = foundSrcCount < synthesisSources.length ? "stale" : "fresh";
    } catch {
      freshnessStatus = "unknown";
    }
  } else {
    freshnessStatus = compiledAt ? "fresh" : "unknown";
  }

  // Fetch synthesis source titles
  const srcList: Array<{ path: string; title: string }> = [];
  if (synthesisSources.length > 0) {
    const chunk = synthesisSources.slice(0, maxSources);
    const placeholders = chunk.map(() => "?").join(", ");
    try {
      const srcRows = await env.DB.prepare(
        `SELECT path, title FROM vault_nodes WHERE path IN (${placeholders})`
      ).bind(...chunk).all<{ path: string; title: string }>();
      for (const r of srcRows.results) {
        srcList.push({ path: r.path, title: r.title ?? r.path.split("/").pop() ?? r.path });
      }
    } catch {
      // D1 failure — return what we have
    }
  }

  // Additional FTS matches NOT in synthesis sources
  let additionalMatches: Array<{ path: string; snippet: string }> = [];
  try {
    const synthSet = new Set(synthesisSources);
    const ftsQuery = sanitizeFtsQuery(topic, FTS_COLUMNS);
    const ftsResults = await env.DB.prepare(
      `SELECT path, snippet(vault_fts, 2, '>>>', '<<<', '...', 20) as snippet
       FROM vault_fts WHERE vault_fts MATCH ? ORDER BY rank LIMIT ?`
    ).bind(ftsQuery, maxSources + synthSet.size).all<{ path: string; snippet: string }>();
    additionalMatches = ftsResults.results
      .filter(r => !synthSet.has(r.path) && r.path !== wikiRow!.path.replace(/\.md$/, ""))
      .slice(0, maxSources)
      .map(r => ({
        path: r.path + ".md",
        snippet: r.snippet.replace(/>>>/g, "**").replace(/<<</g, "**"),
      }));
  } catch {
    // FTS failure — return without additional matches
  }

  return JSON.stringify({
    wiki_synthesis: {
      path: wikiRow.path,
      title: wikiRow.title ?? wikiRow.path.split("/").pop() ?? wikiRow.path,
      body_excerpt: bodyExcerpt,
      compiled_at: compiledAt,
      freshness_status: freshnessStatus,
      source_count: sources.length,
      contradiction_annotations: contradictionAnnotations,
    },
    synthesis_sources: srcList,
    additional_matches: additionalMatches,
    coverage: {
      freshness_status: freshnessStatus,
      synthesis_source_count: synthesisSources.length,
      total_source_count: sources.length,
      wiki_gap: false,
    },
  }, null, 2);
}

async function toolVaultHealth(env: Env, reportType: string): Promise<string> {
  switch (reportType) {
    case "hubs": {
      const result = await env.DB.prepare(
        "SELECT path, title, in_degree, out_degree, note_type, folder FROM vault_nodes ORDER BY in_degree DESC LIMIT 20"
      ).all();
      return JSON.stringify({ report: "hubs", results: result.results }, null, 2);
    }

    case "orphans": {
      const result = await env.DB.prepare(
        "SELECT path, title, folder, note_type FROM vault_nodes WHERE in_degree = 0 AND out_degree = 0 ORDER BY path LIMIT 100"
      ).all();
      return JSON.stringify({
        report: "orphans",
        count: result.results.length,
        results: result.results,
      }, null, 2);
    }

    case "clusters": {
      const result = await env.DB.prepare(`
        SELECT
          n.folder,
          COUNT(DISTINCT n.path) as note_count,
          COUNT(DISTINCT e.id) as edge_count,
          ROUND(CAST(COUNT(DISTINCT e.id) AS REAL) / MAX(COUNT(DISTINCT n.path), 1), 2) as edges_per_note
        FROM vault_nodes n
        LEFT JOIN vault_edges e ON e.source = n.path AND e.source LIKE n.folder || '%'
        WHERE n.folder != ''
        GROUP BY n.folder
        ORDER BY edges_per_note DESC
        LIMIT 30
      `).all();
      return JSON.stringify({ report: "clusters", results: result.results }, null, 2);
    }

    case "stats": {
      // L2 snapshot fix (#68): 5 scalar reads -> single UNION ALL statement.
      // byType GROUP BY is a separate statement in env.DB.batch() (multi-row,
      // can't merge into the scalar UNION).
      //
      // One UNION ALL = one DB operation vs 5 separate awaits. batch() runs
      // statements sequentially but does not guarantee cross-statement
      // consistency -- the byType query could theoretically see a different edge
      // distribution than the scalar totals.
      //
      // Writers: buildGraph (Cron-serialized), syncGraph (origin-scoped fencing
      // via ingest_runs lease). Readers: this stats handler, read-only.
      // Falsifying interleaving: old code's 5 separate awaits could observe a
      // syncGraph INSERT between node_count and edge_count reads, yielding
      // inconsistent density. The single UNION ALL statement eliminates that gap.
      // prevents this.
      const [scalarResult, byTypeResult] = await env.DB.batch([
        env.DB.prepare(`
          SELECT 'node_count' as kind, CAST(COUNT(*) as TEXT) as val FROM vault_nodes
          UNION ALL
          SELECT 'edge_count', CAST(COUNT(*) as TEXT) FROM vault_edges
          UNION ALL
          SELECT 'avg_degree', CAST(ROUND(AVG(in_degree + out_degree), 2) as TEXT) FROM vault_nodes
          UNION ALL
          SELECT 'drain_watermark', CAST(COALESCE(
            (SELECT size FROM vault_nodes WHERE path = '__last_degree_drain__'), 0
          ) as TEXT)
        `),
        env.DB.prepare(EDGES_BY_TYPE_SQL),
      ]);
      const countsMap = scalarMap(scalarResult.results as { kind: string; val: string }[]);
      const nodeCount = parseInt(countsMap.get("node_count") ?? "0", 10);
      const edgeCount = parseInt(countsMap.get("edge_count") ?? "0", 10);
      const density = nodeCount > 1 ? (edgeCount / (nodeCount * (nodeCount - 1))).toFixed(6) : "0";

      return JSON.stringify(
        {
          report: "stats",
          total_nodes: nodeCount,
          total_edges: edgeCount,
          edges_by_type: Object.fromEntries(
            (byTypeResult.results as { edge_type: string; count: number }[]).map((r) => [r.edge_type, r.count])
          ),
          avg_degree: parseFloat(countsMap.get("avg_degree") ?? "0"),
          density: parseFloat(density),
          last_degree_drain_op_id: parseInt(countsMap.get("drain_watermark") ?? "0", 10),
        },
        null,
        2
      );
    }

    case "topics": {
      // L2 snapshot fix (#68): 2 sequential queries → single UNION ALL statement.
      // 'src_'/'wiki_' prefix discriminates source-topic from compiled rows.
      //
      // Writers: buildGraph (upserts vault_nodes during extract), external wiki
      // compilers (upsert Wiki/* vault_nodes). Readers: this handler, read-only.
      // Coordinating primitive: UNION ALL = single SQL statement (same as stats).
      // Falsifying interleaving: old code queried source counts first, then
      // wiki counts. An INSERT between the two reads could show 0 wiki pages
      // alongside non-zero source counts. The single UNION ALL prevents this.
      const topicRows = await env.DB.prepare(`
        SELECT 'src_' || CASE
            WHEN path LIKE 'People/%' THEN 'People'
            WHEN path LIKE 'Concepts/%' THEN 'Concepts'
            WHEN path LIKE 'Entities/%' THEN 'Entities'
          END AS kind, COUNT(*) AS count
        FROM vault_nodes
        WHERE path LIKE 'People/%' OR path LIKE 'Concepts/%' OR path LIKE 'Entities/%'
        GROUP BY kind
        UNION ALL
        SELECT 'wiki_' || CASE
            WHEN path LIKE 'Wiki/People/%' THEN 'People'
            WHEN path LIKE 'Wiki/Concepts/%' THEN 'Concepts'
            WHEN path LIKE 'Wiki/Entities/%' THEN 'Entities'
          END AS kind, COUNT(*) AS count
        FROM vault_nodes
        WHERE path LIKE 'Wiki/%'
        GROUP BY kind
      `).all<{ kind: string; count: number }>();
      const sourceTopics: Record<string, number> = {};
      const compiledPages: Record<string, number> = {};
      for (const r of topicRows.results) {
        if (!r.kind) continue;
        if (r.kind.startsWith("src_")) sourceTopics[r.kind.slice(4)] = r.count;
        else if (r.kind.startsWith("wiki_")) compiledPages[r.kind.slice(5)] = r.count;
      }
      return JSON.stringify(
        {
          report: "topics",
          source_topics: sourceTopics,
          compiled_wiki_pages: compiledPages,
        },
        null,
        2
      );
    }

    case "phantoms": {
      // L2 snapshot fix (#68): single CTE for phantom detection.
      // The CTE + outer query is one SQL statement.
      // Both the top-50 detail rows and the SUM(edge_count) total derive
      // from the same CTE definition within that single statement.
      //
      // Writers: buildGraph (INSERT vault_nodes during extract, INSERT
      // vault_edges during extract/finalize), syncGraph (same via
      // reconcileExtract). Readers: this handler, read-only.
      // Coordinating primitive: single SQL statement (CTE + outer query).
      // Falsifying interleaving: old code ran the NOT IN anti-join twice
      // (top-50 query + separate COUNT query). A buildGraph inserting
      // vault_nodes between the two queries could change which targets
      // qualified as phantoms, making the COUNT inconsistent with the
      // top-50 list. The CTE runs the anti-join once in one statement.
      const result = await env.DB.prepare(`
        WITH phantom_edges AS (
          SELECT target, COUNT(*) as edge_count
          FROM vault_edges
          WHERE target NOT IN (SELECT path FROM vault_nodes)
            AND target NOT LIKE 'tag:%'
          GROUP BY target
        )
        SELECT target, edge_count,
               (SELECT SUM(edge_count) FROM phantom_edges) as total_phantom_edges
        FROM phantom_edges
        ORDER BY edge_count DESC
        LIMIT 50
      `).all<{ target: string; edge_count: number; total_phantom_edges: number }>();
      const totalPhantomEdges = result.results.length > 0 ? result.results[0].total_phantom_edges : 0;
      return JSON.stringify({
        report: "phantoms",
        description: "Wikilink targets that don't resolve to any vault note",
        total_phantom_edges: totalPhantomEdges,
        top_phantoms: result.results.map((r) => ({ target: r.target, edge_count: r.edge_count })),
      }, null, 2);
    }

    default:
      return JSON.stringify({ error: `Unknown report type: ${reportType}. Use: hubs, orphans, clusters, stats, phantoms, topics` });
  }
}

async function toolExpandSubgraph(
  env: Env,
  seed: string,
  k: number = 3,
  constraints?: { edge_types?: string[]; exclude_folders?: string[]; max_nodes?: number }
): Promise<string> {
  const edgeTypes = constraints?.edge_types ?? ["wikilink", "related", "tag", "folder", "temporal"];
  const excludeFolders = new Set(constraints?.exclude_folders ?? []);
  const maxNodes = constraints?.max_nodes ?? 200;
  const typePlaceholders = edgeTypes.map(() => "?").join(", ");

  const visitedNodes = new Set<string>([seed]);
  const subgraphEdges: Array<{
    source: string;
    target: string;
    type: string;
    weight: number;
    depth: number;
  }> = [];

  let frontier = [seed];
  let maxDepthReached = 0;

  for (let d = 0; d < k && frontier.length > 0 && visitedNodes.size < maxNodes; d++) {
    const nextFrontier: string[] = [];

    for (const current of frontier) {
      if (visitedNodes.size >= maxNodes) break;

      const outgoing = await env.DB.prepare(
        `SELECT target AS neighbor, edge_type, weight FROM vault_edges WHERE source = ? AND edge_type IN (${typePlaceholders})`
      )
        .bind(current, ...edgeTypes)
        .all<{ neighbor: string; edge_type: string; weight: number }>();

      const incoming = await env.DB.prepare(
        `SELECT source AS neighbor, edge_type, weight FROM vault_edges WHERE target = ? AND edge_type IN (${typePlaceholders})`
      )
        .bind(current, ...edgeTypes)
        .all<{ neighbor: string; edge_type: string; weight: number }>();

      const neighbors = [...outgoing.results, ...incoming.results];

      for (const { neighbor, edge_type, weight } of neighbors) {
        if (visitedNodes.size >= maxNodes) break;

        // Check folder exclusion
        const neighborFolder = getFolderFromPath(neighbor);
        if (excludeFolders.has(neighborFolder)) continue;

        subgraphEdges.push({
          source: current,
          target: neighbor,
          type: edge_type,
          weight,
          depth: d + 1,
        });

        if (!visitedNodes.has(neighbor)) {
          visitedNodes.add(neighbor);
          nextFrontier.push(neighbor);
          maxDepthReached = Math.max(maxDepthReached, d + 1);
        }
      }
    }

    frontier = nextFrontier;
  }

  return JSON.stringify(
    {
      seed,
      nodes: [...visitedNodes],
      edges: subgraphEdges,
      stats: {
        node_count: visitedNodes.size,
        edge_count: subgraphEdges.length,
        max_depth_reached: maxDepthReached,
      },
    },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// L2 PR1 — cache-coherence verifier
// ---------------------------------------------------------------------------

/**
 * Synthetic node-path markers that live in vault_nodes for cursor/state
 * purposes but have no corresponding vault_ops entry. The verifier excludes
 * these from drift reporting.
 *
 * Pattern-based check (^__.*__$) instead of an explicit allow-list because
 * the convention is consistent across all known synthetic markers and the
 * explicit-list approach silently regresses every time a new marker is
 * added (false-positive drift on day 0 of soak — caught in the wild on
 * PR #64's first smoke for `__last_build_completed__`).
 *
 * Known markers as of 2026-04-26 (NOT load-bearing — the regex is the
 * source of truth; this list is documentation only):
 *   - __last_degree_drain__   (drainDegrees watermark, L1/PR3)
 *   - __last_sync__           (syncGraph cooldown marker)
 *   - __last_build_completed__ (buildGraph finalize timestamp)
 *   - __build_progress__      (transient mid-build counter)
 *   - __build_cursor__        (transient mid-build R2 cursor)
 *   - __build_run_id__        (transient mid-build run id)
 *
 * Real note paths cannot start AND end with double-underscores (vault notes
 * are folder/file.md). The regex is safe.
 */
const VERIFIER_SYNTHETIC_PATH_RE = /^__[a-z0-9_]+__$/;
function isVerifierSyntheticPath(path: string): boolean {
  return VERIFIER_SYNTHETIC_PATH_RE.test(path);
}

export type DriftEdge = { source: string; target: string; edge_type: string; origin: string };

export type DriftReport =
  | { ok: true; window: { since_id: number; max_id: number }; checked_edges: number; checked_nodes: number }
  | {
      ok: false;
      window: { since_id: number; max_id: number };
      drift: {
        missing_in_cache: DriftEdge[];
        extra_in_cache: DriftEdge[];
        missing_nodes: Array<{ path: string }>;
        extra_nodes: Array<{ path: string }>;
      };
    };

/**
 * verifyCacheCoherence — replays vault_ops and diffs the result against the
 * live vault_edges + vault_nodes tables. Returns a DriftReport.
 *
 * Read-only. No mutations. Synthetic marker rows in vault_nodes are excluded
 * from the diff (they have no op-log representation by design).
 *
 * Window: (0, MAX(vault_ops.id)]. PR2 will extend this to allow snapshot-based
 * partial replay; PR1 ships full replay only.
 */
export async function verifyCacheCoherence(db: D1Database): Promise<DriftReport> {
  const snap = await db
    .prepare("SELECT MAX(id) as max_id FROM vault_ops")
    .first<{ max_id: number | null }>();
  const maxId = snap?.max_id ?? 0;
  const window = { since_id: 0, max_id: maxId };

  // Replay all ops in id order. Edges keyed by (origin|source|target|edge_type)
  // matching the UNIQUE constraint on vault_edges.
  const opsRes = await db
    .prepare("SELECT id, op_type, payload_json, origin FROM vault_ops ORDER BY id ASC")
    .all<{ id: number; op_type: string; payload_json: string; origin: string }>();

  const replayedEdges = new Map<string, DriftEdge>();
  const replayedNodes = new Set<string>();
  for (const row of opsRes.results ?? []) {
    let payload: any;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      // Skip malformed rows — they cannot represent reproducible state.
      continue;
    }
    if (row.op_type === "add_edge" || row.op_type === "remove_edge") {
      const source = payload.source as string | undefined;
      const target = payload.target as string | undefined;
      const edge_type = payload.edge_type as string | undefined;
      const origin = (payload.origin as string | undefined) ?? row.origin;
      if (!source || !target || !edge_type || !origin) continue;
      const key = `${origin}|${source}|${target}|${edge_type}`;
      if (row.op_type === "add_edge") {
        replayedEdges.set(key, { source, target, edge_type, origin });
      } else {
        replayedEdges.delete(key);
      }
    } else if (row.op_type === "upsert_node") {
      const path = payload.path as string | undefined;
      if (path) replayedNodes.add(path);
    } else if (row.op_type === "delete_node") {
      const path = payload.path as string | undefined;
      if (path) replayedNodes.delete(path);
    }
  }

  // Live cache state.
  const liveEdgesRes = await db
    .prepare("SELECT source, target, edge_type, origin FROM vault_edges")
    .all<DriftEdge>();
  const liveEdges = new Map<string, DriftEdge>();
  for (const e of liveEdgesRes.results ?? []) {
    liveEdges.set(`${e.origin}|${e.source}|${e.target}|${e.edge_type}`, e);
  }

  const liveNodesRes = await db
    .prepare("SELECT path FROM vault_nodes")
    .all<{ path: string }>();
  const liveNodes = new Set<string>();
  for (const n of liveNodesRes.results ?? []) {
    if (!isVerifierSyntheticPath(n.path)) liveNodes.add(n.path);
  }

  // Diff edges.
  const missingInCache: DriftEdge[] = [];
  const extraInCache: DriftEdge[] = [];
  for (const [key, edge] of replayedEdges) {
    if (!liveEdges.has(key)) missingInCache.push(edge);
  }
  for (const [key, edge] of liveEdges) {
    if (!replayedEdges.has(key)) extraInCache.push(edge);
  }

  // Diff nodes.
  const missingNodes: Array<{ path: string }> = [];
  const extraNodes: Array<{ path: string }> = [];
  for (const path of replayedNodes) {
    if (!liveNodes.has(path)) missingNodes.push({ path });
  }
  for (const path of liveNodes) {
    if (!replayedNodes.has(path)) extraNodes.push({ path });
  }

  if (
    missingInCache.length === 0 &&
    extraInCache.length === 0 &&
    missingNodes.length === 0 &&
    extraNodes.length === 0
  ) {
    return {
      ok: true,
      window,
      checked_edges: replayedEdges.size,
      checked_nodes: replayedNodes.size,
    };
  }

  return {
    ok: false,
    window,
    drift: {
      missing_in_cache: missingInCache,
      extra_in_cache: extraInCache,
      missing_nodes: missingNodes,
      extra_nodes: extraNodes,
    },
  };
}

// ---------------------------------------------------------------------------
// L2 PR1.5 — isolate-local debounce wrapper for runVerifierTwoPhase
// ---------------------------------------------------------------------------

/**
 * Module-level in-flight cache. Two concurrent route invocations on the SAME
 * Worker isolate will share the same verifier execution (so we don't run 4
 * concurrent SELECTs against D1 for two simultaneous external requests).
 *
 * SCOPE: ISOLATE-LOCAL ONLY. Cloudflare Workers route concurrent requests to
 * potentially-different isolates, so two external calls landing on different
 * isolates can each see `inFlight === null` and run two verifiers. This is
 * acceptable load-shedding (worst case 2x verifier executions across N isolates
 * instead of N), not strict deduplication. True cross-isolate dedup would
 * require a Durable Object or KV-backed lock — explicitly deferred.
 */
let _verifierInFlight: Promise<VerifierResponse> | null = null;

async function runVerifierTwoPhaseDebounced(env: Env): Promise<VerifierResponse> {
  if (_verifierInFlight) {
    // Another request on this isolate is mid-flight; await its result.
    return await _verifierInFlight;
  }
  _verifierInFlight = (async () => {
    try {
      return await runVerifierTwoPhase({ DB: env.DB }, verifyCacheCoherence);
    } finally {
      _verifierInFlight = null;
    }
  })();
  return await _verifierInFlight;
}

// Test-only escape hatch — reset the in-flight cache between tests.
export function __resetVerifierInFlight(): void {
  _verifierInFlight = null;
}

// ---------------------------------------------------------------------------
// VaultMcpDO — McpAgent Durable Object
// ---------------------------------------------------------------------------

export class VaultMcpDO extends McpAgent<Env & Cloudflare.Env, McpState> {
  server = new McpServer({ name: "Vault", version: "2.0.0" });

  async init(): Promise<void> {
    // Ensure access tracking table exists
    try {
      await this.env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS note_access (
          path TEXT PRIMARY KEY,
          access_count INTEGER DEFAULT 0,
          last_accessed TEXT
        )`
      ).run();
    } catch {
      // Best-effort — D1 may not support DDL in all contexts
    }

    // --- list_notes ---
    this.server.registerTool(
      "list_notes",
      {
        description:
          "List all notes in the vault, optionally filtered by folder. Returns path, size (bytes), and last modified date for each note. READ-ONLY. Does NOT return note content — use read_note for that. Does NOT search content — use search_notes for text search or find_related for graph traversal. Can be slow on large vaults (8000+ notes) — prefer folder filtering.",
        inputSchema: {
          folder: z
            .string()
            .optional()
            .describe("Filter to notes in this folder (e.g. 'daily' or 'projects/alpha'). Leave empty for all notes."),
        },
      },
      async ({ folder }) => {
        const text = await toolListNotes(this.env, folder);
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // --- read_note ---
    this.server.registerTool(
      "read_note",
      {
        description: "Read a note's content. Without range params: returns raw markdown (including frontmatter) for notes < 50KB, or a truncation envelope {path, head, tail, total_lines, total_chars, hint} for notes >= 50KB. With lines + position params: returns that many lines from the specified end — does NOT guarantee frontmatter inclusion (use get_frontmatter for metadata). SIDE EFFECT: records access count + timestamp in D1 (note_access table) for analytics. Path should NOT include .md extension. Returns 'Note not found' if path doesn't exist — does NOT create the note. Does NOT do content search — use search_notes.",
        inputSchema: {
          path: z
            .string()
            .describe("Note path relative to vault root (e.g. 'daily/2026-03-14' or 'projects/roadmap')"),
          lines: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Number of lines to return (positive integer). Use with position to slice large notes."),
          position: z
            .enum(["head", "tail"])
            .default("head")
            .describe("Which end to read from: 'head' (first N lines) or 'tail' (last N lines). Default: head."),
        },
      },
      async ({ path, lines, position }) => {
        const text = await toolReadNote(this.env, path);

        // Error / not-found passthrough
        if (text.startsWith("Note not found:")) {
          return { content: [{ type: "text" as const, text }] };
        }

        const allLines = text.split("\n");

        // Range mode: caller requested a specific slice
        if (lines !== undefined) {
          const n = Math.max(1, Math.floor(lines)); // defense-in-depth: positive int
          const pos = position ?? "head";
          const slice = pos === "tail"
            ? allLines.slice(-n)
            : allLines.slice(0, n);
          return { content: [{ type: "text" as const, text: slice.join("\n") }] };
        }

        // Auto-truncation for notes >= 50KB without explicit range params
        if (text.length >= 50_000) {
          const envelope = JSON.stringify({
            path,
            head: allLines.slice(0, 80).join("\n"),
            tail: allLines.slice(-80).join("\n"),
            total_lines: allLines.length,
            total_chars: text.length,
            hint: "Use lines + position params to read a specific range. Use get_frontmatter for metadata only.",
          });
          return { content: [{ type: "text" as const, text: envelope }] };
        }

        // Default: full body (notes < 50KB)
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // --- write_note ---
    this.server.registerTool(
      "write_note",
      {
        description:
          "Create or OVERWRITE a note. DESTRUCTIVE if note exists — replaces all content. ENFORCES: YAML frontmatter with type/tags/created fields (rejects without them), at least one [[wikilink]] in body (rejects orphan notes). Auto-stamps 'modified' timestamp in frontmatter. Attempts to index the note in the knowledge graph (edges, FTS, degrees) and return neighborhood suggestions — on D1 failure, the write still succeeds but indexing is skipped (catches up on next sync_graph). For bulk imports, use build_graph instead. Does NOT create ingest_runs rows. Use append_note to add to existing notes without overwriting.",
        inputSchema: {
          path: z.string().describe("Note path relative to vault root (e.g. 'projects/roadmap')"),
          content: z.string().describe("Full markdown content to write"),
        },
      },
      async ({ path, content }) => {
        const text = await toolWriteNote(this.env, path, content);
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // --- append_note ---
    this.server.registerTool(
      "append_note",
      {
        description:
          "Append content to an existing note (adds a newline then your content). NON-DESTRUCTIVE — preserves existing content. If the note does NOT exist, creates it with the same enforcement as write_note (frontmatter + wikilinks required). Auto-stamps 'modified' on existing notes that have frontmatter. Attempts to re-index the note in the knowledge graph from the full content (existing + appended) and return neighborhood suggestions — on D1 failure, the append still succeeds but indexing is skipped (catches up on next sync_graph). Does NOT create ingest_runs rows.",
        inputSchema: {
          path: z.string().describe("Note path relative to vault root"),
          content: z.string().describe("Content to append (will be prefixed with a newline)"),
        },
      },
      async ({ path, content }) => {
        const text = await toolAppendNote(this.env, path, content);
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // --- search_notes ---
    this.server.registerTool(
      "search_notes",
      {
        description:
          "Full-text search across all vault notes using D1 FTS5 index. Auto-sanitizes hyphens, colons, and plus signs in bare queries (wraps in quotes so FTS5 tokenizer handles them). Supports phrases (\"exact match\"), prefix (word*), boolean (word1 AND word2), and column qualifiers (path:folder). Advanced FTS5 syntax (^, NEAR(), {col set}:, space-padded +) is passed through unsanitized — manually quote hyphens/colons in those queries. READ-ONLY. Returns BM25-ranked results with context snippets. Default 'envelope' format includes wiki cross-references when Wiki/ pages cover any result (wiki_context.wiki_pages + freshness status). Use format='array' for legacy bare array output. Does NOT do semantic/fuzzy matching — use find_related for that. Does NOT return full wiki page content — use topic_dossier for structured wiki-first bundles. Index is populated during build_graph and sync_graph.",
        inputSchema: {
          query: z.string().describe("Search query — supports phrases, prefix (word*), boolean (AND/OR/NOT)"),
          folder: z.string().optional().describe("Limit search to notes in this folder. Optional."),
          max_results: z.number().default(20).describe("Maximum results to return. Default: 20."),
          format: z.enum(["envelope", "array"]).default("envelope").describe("Response format. 'envelope' (default): { results, wiki_context }. 'array': legacy bare array, no wiki context."),
        },
      },
      async ({ query, folder, max_results, format }) => {
        const text = await toolSearchNotes(this.env, query, folder, max_results, format);
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // --- delete_note ---
    this.server.registerTool(
      "delete_note",
      {
        description: "PERMANENTLY delete a note from the vault. DESTRUCTIVE and IRREVERSIBLE — no trash, no undo. Does NOT remove the note from the graph index (stale edges will remain until next build_graph). Does NOT check for incoming wikilinks — other notes may break. Verify the path carefully before calling.",
        inputSchema: {
          path: z.string().describe("Note path relative to vault root"),
        },
      },
      async ({ path }) => {
        const text = await toolDeleteNote(this.env, path);
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // --- list_folders ---
    this.server.registerTool(
      "list_folders",
      {
        description:
          "List vault folders with offset-based pagination. Returns {folders: string[], has_more: boolean, total: number, offset: number}. Default limit=200 (~4-6KB). Paginate with offset to retrieve more. READ-ONLY. Does NOT return note counts per folder — just paths. Does NOT return notes — use list_notes for that. For large vaults, iterate with offset until has_more is false. Pagination is best-effort: vault mutations between calls can cause offset drift.",
        inputSchema: {
          offset: z.number().default(0).describe("Start position in the sorted folder list. Default: 0."),
          limit: z.number().default(200).describe("Max folders to return per page. Default: 200, max: 5000."),
        },
      },
      async ({ offset, limit }) => {
        const text = await toolListFolders(this.env, offset, limit);
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // --- get_frontmatter ---
    this.server.registerTool(
      "get_frontmatter",
      {
        description:
          "Parse and return YAML frontmatter from a note as JSON key-value pairs. Much cheaper than read_note for metadata-only lookups — does NOT return the note body. READ-ONLY. Does NOT record an access mark (unlike read_note). Returns 'No frontmatter found' if the note lacks --- delimiters.",
        inputSchema: {
          path: z.string().describe("Note path relative to vault root"),
        },
      },
      async ({ path }) => {
        const text = await toolGetFrontmatter(this.env, path);
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // =====================================================================
    // Graph tools
    // =====================================================================

    // --- build_graph ---
    this.server.registerTool(
      "build_graph",
      {
        description:
          "ADMIN: Full graph rebuild. NON-DESTRUCTIVE: vault_nodes uses INSERT...ON CONFLICT DO UPDATE (upsert) per note — no DELETE FROM vault_nodes, no DROP TABLE vault_fts. Each processed note is stamped with ingest_run_id; after extract completes (done=true), stale rows (not touched by this build) are cleaned up if they are <=5% of total. vault_edges routes through applyOps({materialize:true}) for per-note atomic batches — rows from other origins (e.g. ingest_triples) are preserved across rebuilds. FTS updated per-path (DELETE+INSERT). Processes ~200 notes per call from R2. Call repeatedly until done=true, then call with phase='finalize' to add folder/temporal/tag_cooccurrence edges and compute degree counts. Takes 40+ calls for a full vault (~10,000 notes). GUARDED: rejects if last build completed <24h ago unless force=true. SIDE EFFECTS: writes vault_nodes, vault_edges, vault_ops, vault_fts, ingest_runs. ALTERNATIVES: use sync_graph for incremental updates; the only times build_graph is necessary are bulk R2 imports, folder renames, and schema migrations.",
        inputSchema: {
          phase: z
            .enum(["extract", "finalize"])
            .default("extract")
            .describe("'extract' (default) processes note chunks. 'finalize' adds folder/temporal edges and computes degrees. Run extract until done, then finalize."),
          force: z
            .boolean()
            .default(false)
            .describe("Override the 24h build guard. Only use if the graph is genuinely degraded."),
        },
      },
      async ({ phase, force }) => {
        const text = await buildGraph(this.env, phase, force);
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // --- sync_graph ---
    this.server.registerTool(
      "sync_graph",
      {
        description:
          "Incremental graph update — re-indexes only notes modified since last sync. Faster than build_graph but capped at SYNC_LIMIT=20 notes per call. SIDE EFFECTS: writes vault_nodes, vault_edges, vault_ops, vault_fts, ingest_runs; advances the __last_degree_drain__ ops watermark via drainDegrees. CONCURRENCY: origin-scoping (origin='extract') keeps ingest_triples writes safe from syncGraph's split-DELETE. PREREQUISITE: build_graph must have run at least once. GUARDED: non-force calls skip silently if last sync was <1h ago. Force=true bypasses the cooldown (useful for cron catchup). Does NOT recompute folder/temporal/tag_cooccurrence edges — those live in build_graph's finalize phase. ALTERNATIVES: use build_graph for full rebuild after vault-level changes; use ingest_triples for direct subject-relation-object writes.",
        inputSchema: {
          force: z.boolean().default(false).describe("Bypass the 1h cooldown guard. Set true for post-compile or operator-initiated catchup."),
          force_reason: z.string().optional().describe("Audit string when force=true (e.g. 'enrichment_post_compile', 'cron_catchup', 'manual'). Logged but not enforced."),
        },
      },
      async ({ force, force_reason }) => {
        const result = await syncGraph(this.env, force, force_reason);
        return { content: [{ type: "text" as const, text: result.body }] };
      }
    );

    // --- find_related ---
    this.server.registerTool(
      "find_related",
      {
        description:
          "Find notes structurally connected to a given note via graph traversal. Uses BFS over typed edges with hub dampening and cluster-diverse ranking. Returns up to 30 results with scores plus wiki_context (cross-references to Wiki/ pages covering the seed or results, with freshness status). READ-ONLY. PREREQUISITE: build_graph must have run at least once. Does NOT do semantic search — follows structural edges only. Does NOT return full wiki page content — use topic_dossier for structured wiki-first bundles. SIDE EFFECTS: none. ALTERNATIVES: topic_dossier for wiki-first topic retrieval; for semantic similarity, use an external embedding search. Results exclude raw session transcripts and phantom targets. Cross-cluster results are boosted to surface connections outside the seed's home folder.",
        inputSchema: {
          path: z.string().describe("Note path to find connections for (e.g. 'Concepts/Durable Objects')"),
          depth: z.number().default(2).describe("Max hops to traverse. Default: 2."),
          edge_types: z
            .array(z.string())
            .default(["wikilink", "related", "tag", "tag_cooccurrence"])
            .describe(`Edge types to follow. Default: wikilink, related, tag, tag_cooccurrence (author-intent signals). Available types organized by category — Structural: wikilink, related, tag, folder, temporal, tag_cooccurrence, belongs_to, part_of, has_part. Semantic: spoke_in, discusses, predicts, claims, references, instance_of, broader, narrower, scoped_by. Epistemic: supports, contradicts, overrides, rejected, replaces, replaced_by. Provenance: derived_from, version_of, evolved_into, inspired_by, learned_from, depends_on, requires, required_by. For epistemic traversal, pass edge_types: ['contradicts', 'supports', 'replaces'] to follow epistemic edges.`),
        },
      },
      async ({ path, depth, edge_types }) => {
        const text = await toolFindRelated(this.env, path, depth, edge_types);
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // --- topic_dossier ---
    this.server.registerTool(
      "topic_dossier",
      {
        description:
          "Wiki-first structured retrieval for topic-level queries. Returns a structured bundle: wiki synthesis (body excerpt, contradiction annotations, freshness status), synthesis sources, and additional FTS matches NOT in the synthesis set. Primary anti-cherry-pick mechanism — agents receive curated context, not just raw matches. READ-ONLY. PREREQUISITE: build_graph must have indexed Wiki/ pages. Does NOT create or modify wiki pages. Does NOT follow graph edges — use find_related for structural traversal. Does NOT do semantic search — uses slug construction + FTS to locate wiki pages. SIDE EFFECTS: records no state. ALTERNATIVES: search_notes for flat text search with wiki cross-reference; find_related for graph-based traversal with wiki cross-reference; read_note on Wiki/<Kind>/<slug> for raw wiki page content.",
        inputSchema: {
          topic: z.string().describe("Topic to look up (e.g. 'Alice', 'Durable Objects', 'MCP')"),
          include_body: z.boolean().default(true).describe("Include wiki body excerpt (first 3000 chars). Default: true."),
          max_sources: z.number().default(15).describe("Max synthesis sources to return. Default: 15."),
        },
      },
      async ({ topic, include_body, max_sources }) => {
        const text = await toolTopicDossier(this.env, topic, include_body, max_sources);
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // --- vault_health ---
    this.server.registerTool(
      "vault_health",
      {
        description:
          "Graph diagnostics. report_type options: 'hubs' (top 20 most-linked notes), 'orphans' (notes with zero edges, max 100), 'clusters' (folder-level edge density), 'stats' (node/edge totals + last_degree_drain_op_id watermark from the ops-derived drain), 'phantoms' (wikilink targets without real notes), 'topics' (counts of source topics in People/Concepts/Entities and how many have wiki pages in Wiki/). READ-ONLY. SIDE EFFECTS: none. PREREQUISITE: build_graph. ALTERNATIVES: 'phantoms' surfaces missing notes to create; 'orphans' surfaces unlinked notes; 'topics' shows folder-based topic counts.",
        inputSchema: {
          report_type: z
            .enum(["hubs", "orphans", "clusters", "stats", "phantoms", "topics"])
            .describe("Type of health report to generate"),
        },
      },
      async ({ report_type }) => {
        const text = await toolVaultHealth(this.env, report_type);
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // --- expand_subgraph ---
    this.server.registerTool(
      "expand_subgraph",
      {
        description:
          "BFS expansion from a seed note to depth k. Returns the full subgraph as JSON: all nodes visited, all edges traversed, and stats (node count, max depth reached). Heavier than find_related — returns the raw graph structure, not ranked results. Use this for visualization, subgraph analysis, or when you need the full neighborhood topology. Does NOT rank or score results — use find_related for relevance-ranked output. READ-ONLY. SIDE EFFECTS: none. REQUIRES build_graph. ALTERNATIVES: find_related for scored/ranked results; expand_subgraph for raw topology.",
        inputSchema: {
          seed: z.string().describe("Starting note path (e.g. 'Concepts/MCP')"),
          k: z.number().default(3).describe("Max BFS depth. Default: 3."),
          edge_types: z
            .array(z.string())
            .optional()
            .describe(`Edge types to follow. Default: wikilink, related, tag, folder, temporal. Available types organized by category — Structural: wikilink, related, tag, folder, temporal, tag_cooccurrence, belongs_to, part_of, has_part. Semantic: spoke_in, discusses, predicts, claims, references, instance_of, broader, narrower, scoped_by. Epistemic: supports, contradicts, overrides, rejected, replaces, replaced_by. Provenance: derived_from, version_of, evolved_into, inspired_by, learned_from, depends_on, requires, required_by. For epistemic traversal, pass edge_types: ['contradicts', 'supports', 'replaces'].`),
          exclude_folders: z
            .array(z.string())
            .optional()
            .describe("Folder paths to exclude from traversal (e.g. ['Archive', 'transcripts'])"),
          max_nodes: z
            .number()
            .optional()
            .describe("Max nodes in subgraph. Default: 200."),
        },
      },
      async ({ seed, k, edge_types, exclude_folders, max_nodes }) => {
        const text = await toolExpandSubgraph(this.env, seed, k, {
          edge_types,
          exclude_folders,
          max_nodes,
        });
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // --- graph_qa ---
    this.server.registerTool(
      "graph_qa",
      {
        description:
          "Graph quality evaluation tool. Tests whether a keyword-free question can be answered by graph traversal alone. Runs find_related from each seed path, reads the top discovered notes, and returns: traversal trace (seeds, hops, scores), note excerpts (first 2000 chars of each discovered note), and evaluation guidance. Use this AFTER build_graph to validate graph connectivity. Does NOT answer the question itself — it shows whether the graph can REACH the answer. Heavy operation (multiple find_related + R2 reads) — don't run in loops.",
        inputSchema: {
          question: z
            .string()
            .describe(
              "A keyword-free question — describe the concept without using vault-specific note titles or paths"
            ),
          seeds: z
            .array(z.string())
            .describe(
              "1-5 seed node paths to start graph traversal from (e.g. People/Elon Musk, Concepts/AI Safety)"
            ),
          depth: z.number().default(2).describe("Traversal depth. Default: 2"),
        },
      },
      async ({ question, seeds, depth }) => {
        const text = await graphQA(this.env, question, seeds, depth);
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // =====================================================================
    // Wiki layer
    // =====================================================================

    // (Wiki compiler tools removed — wiki pages are still indexed by build_graph/sync_graph)
    // Wiki pages under Wiki/ are still indexed by build_graph/sync_graph
    // and surfaced via topic_dossier and find_related.


    // --- ingest_triples ---
    this.server.registerTool(
      "ingest_triples",
      {
        description:
          "Insert (subject, relation, object) edges directly into vault_edges. Wraps the /api/ingest-triples HTTP endpoint with a single in-process call instead of HTTP. Max 2000 triples per call (NOT 1MB — the cap is statement count). SIDE EFFECTS: writes vault_edges + vault_ops; tail call to drainDegrees advances the ops watermark and recomputes degrees for affected paths. CONCURRENCY: origin-scoping (origin='ingest_triples') protects these rows from syncGraph's split-DELETE. Per-chunk atomicity (33 triples/chunk); on partial failure returns committed_chunks. Does NOT update vault_centrality (next algorithm-enrichment cron will catch up). Does NOT validate that subjects/objects exist as vault_nodes (orphan-target edges are allowed, surface as phantoms in vault_health). ALTERNATIVES: write_note + sync_graph if the triples are derivable from note content (preserves provenance via wikilinks).",
        inputSchema: {
          triples: z
            .array(
              z.object({
                subject: z.string().describe("Source path or entity"),
                relation: z.string().describe("Edge type — must be in VAULT_MCP_EDGE_TYPES (e.g. wikilink, related, mentions, authored). Unknown types fall back to 'related'."),
                object: z.string().describe("Target path or entity"),
                weight: z.number().optional().describe("Edge weight. Default 1.0 for 'related', 1.5 otherwise."),
                source_note: z.string().optional().describe("Provenance note path (advisory; not stored)"),
              })
            )
            .describe("Up to 2000 triples"),
        },
      },
      async ({ triples }) => {
        const MAX = 2000;
        if (triples.length > MAX) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "too_many_triples", message: `Max ${MAX} per call (got ${triples.length})` }) }] };
        }
        if (await checkMaintenanceMode(this.env)) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: "maintenance_mode", message: "tier-a maintenance mode is active; retry after reset completes" }),
            }],
          };
        }
        // PR3: writer leases and dirty-degrees tracking are retired.
        // Origin-scoping (origin='ingest_triples') prevents syncGraph's
        // split-DELETE from clobbering these rows; drainDegrees() at the
        // tail picks up affected paths via vault_ops since-watermark.
        const VALID_RELATIONS = new Set<string>(VAULT_MCP_EDGE_TYPES);
        let ingested = 0;
        let skipped = 0;
        let committedChunks = 0;
        const TRIPLES_PER_CHUNK = 33;
        const totalChunks = Math.ceil(triples.length / TRIPLES_PER_CHUNK);
        for (let c = 0; c < totalChunks; c++) {
          const chunk = triples.slice(c * TRIPLES_PER_CHUNK, (c + 1) * TRIPLES_PER_CHUNK);
          const ops: Op[] = [];
          for (const t of chunk) {
            const rel = VALID_RELATIONS.has(t.relation) ? t.relation : "related";
            const w = t.weight ?? (rel === "related" ? 1.0 : 1.5);
            ops.push({
              op_type: "add_edge",
              origin: "ingest_triples",
              payload: {
                source: t.subject,
                target: t.object,
                edge_type: rel,
                weight: w,
              },
            });
          }
          const result = await applyOps(this.env, ops, {});
          ingested += result.insertedEdges;
          skipped += chunk.length - result.insertedEdges;
          committedChunks++;
        }
        await drainDegrees(this.env);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ingested, skipped, total: triples.length, committed_chunks: committedChunks, total_chunks: totalChunks }, null, 2),
            },
          ],
        };
      }
    );

  }
}

// ---------------------------------------------------------------------------
// Enrichment table probe — dual-path: vault_enrichment (preferred) or
// vault_centrality (legacy fallback during B9 migration window).
// ---------------------------------------------------------------------------

/** Returns the enrichment table name that actually exists in D1, or null.
 *  Deterministically prefers `vault_enrichment` when both exist during the
 *  plan-B9 transition window — LIMIT 1 without ORDER BY is nondeterministic
 *  in SQLite and could have picked the legacy table. (Codex P2 round-4.) */
async function resolveEnrichmentTable(env: Env): Promise<"vault_enrichment" | "vault_centrality" | null> {
  const row = await env.DB.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name IN ('vault_enrichment', 'vault_centrality')
     ORDER BY CASE WHEN name = 'vault_enrichment' THEN 0 ELSE 1 END
     LIMIT 1`
  ).first<{ name: string }>().catch(() => null);
  const name = row?.name ?? null;
  if (name === "vault_enrichment" || name === "vault_centrality") return name;
  return null;
}

// ---------------------------------------------------------------------------
// Fast loop detectors
// ---------------------------------------------------------------------------

export interface FastLoopCandidate {
  type: string;
  path: string;
  signal: string;
  strength: number;
  detail?: string;
}

async function detectAccessDivergence(env: Env): Promise<FastLoopCandidate[]> {
  const candidates: FastLoopCandidate[] = [];

  const enrichTable = await resolveEnrichmentTable(env);
  if (!enrichTable) return candidates; // no enrichment table yet — degrade gracefully

  // High centrality, low/no access (overlooked hubs)
  const overlooked = await env.DB.prepare(`
    SELECT c.path, c.pagerank, COALESCE(a.access_count, 0) as accesses,
           COALESCE(a.last_accessed, 'never') as last_read
    FROM ${enrichTable} c
    LEFT JOIN note_access a ON a.path = c.path
    WHERE c.pagerank > (SELECT AVG(pagerank) * 2 FROM ${enrichTable})
    AND (a.access_count IS NULL OR a.access_count < 3)
    AND c.path LIKE '%/%'
    ORDER BY c.pagerank DESC
    LIMIT 10
  `).all<{ path: string; pagerank: number; accesses: number; last_read: string }>();

  for (const row of overlooked.results) {
    candidates.push({
      type: "overlooked_hub",
      path: row.path,
      signal: `PageRank ${row.pagerank.toFixed(4)} but only ${row.accesses} reads (last: ${row.last_read})`,
      strength: Math.min(row.pagerank * 500, 1.0),
    });
  }

  // Low centrality, high access (emerging importance)
  const emerging = await env.DB.prepare(`
    SELECT c.path, c.pagerank, a.access_count, a.last_accessed
    FROM ${enrichTable} c
    JOIN note_access a ON a.path = c.path
    WHERE c.pagerank < (SELECT AVG(pagerank) FROM ${enrichTable})
    AND a.access_count > 10
    AND c.path LIKE '%/%'
    ORDER BY a.access_count DESC
    LIMIT 10
  `).all<{ path: string; pagerank: number; access_count: number; last_accessed: string }>();

  for (const row of emerging.results) {
    candidates.push({
      type: "emerging_importance",
      path: row.path,
      signal: `Only ${row.pagerank.toFixed(4)} centrality but ${row.access_count} reads`,
      strength: Math.min(row.access_count / 50, 1.0),
    });
  }

  return candidates;
}

async function detectCentralityShifts(env: Env): Promise<FastLoopCandidate[]> {
  const candidates: FastLoopCandidate[] = [];

  const enrichTable = await resolveEnrichmentTable(env);
  if (!enrichTable) return candidates; // no enrichment table yet — degrade gracefully

  const shifts = await env.DB.prepare(`
    SELECT path, pagerank, prev_pagerank,
           ABS(pagerank - prev_pagerank) as delta,
           CASE WHEN prev_pagerank > 0
                THEN (pagerank - prev_pagerank) / prev_pagerank
                ELSE 999 END as pct_change
    FROM ${enrichTable}
    WHERE prev_pagerank > 0
    AND ABS(pagerank - prev_pagerank) > 0.0001
    ORDER BY delta DESC
    LIMIT 10
  `).all<{ path: string; pagerank: number; prev_pagerank: number; delta: number; pct_change: number }>();

  for (const row of shifts.results) {
    if (Math.abs(row.pct_change) < 0.1) continue; // <10% shift, skip
    const direction = row.pct_change > 0 ? "increased" : "decreased";
    candidates.push({
      type: "centrality_shift",
      path: row.path,
      signal: `Centrality ${direction} ${(Math.abs(row.pct_change) * 100).toFixed(0)}% (${row.prev_pagerank.toFixed(4)} → ${row.pagerank.toFixed(4)})`,
      strength: Math.min(Math.abs(row.pct_change), 1.0),
    });
  }

  return candidates;
}

async function detectConceptMentions(env: Env): Promise<FastLoopCandidate[]> {
  const candidates: FastLoopCandidate[] = [];

  // Get all concept titles + aliases
  const concepts = await env.DB.prepare(`
    SELECT path, title, aliases FROM vault_nodes
    WHERE path LIKE 'Concepts/%' AND size > 100
  `).all<{ path: string; title: string; aliases: string }>();

  // Build search terms from titles and aliases
  const conceptTerms: Array<{ path: string; terms: string[] }> = [];
  for (const c of concepts.results) {
    const terms = [c.title.toLowerCase()];
    try {
      const parsed = JSON.parse(c.aliases || "[]");
      if (Array.isArray(parsed)) {
        for (const a of parsed) {
          if (typeof a === "string" && a.length > 2) terms.push(a.toLowerCase());
        }
      }
    } catch { /* ignore */ }
    conceptTerms.push({ path: c.path, terms });
  }

  // Check recently modified notes for concept mentions without wikilinks
  const recentNotes = await env.DB.prepare(`
    SELECT path FROM vault_nodes
    WHERE indexed_at > datetime('now', '-1 hour')
    AND path NOT LIKE 'Concepts/%'
    AND size > 500
    LIMIT 50
  `).all<{ path: string }>();

  for (const note of recentNotes.results) {
    const obj = await env.VAULT.get(normalizePath(note.path));
    if (!obj) continue;
    const content = (await obj.text()).toLowerCase();

    // Check existing edges from this note
    const existing = await env.DB.prepare(
      "SELECT target FROM vault_edges WHERE source = ? AND edge_type IN ('wikilink', 'related', 'discusses', 'references')"
    ).bind(note.path).all<{ target: string }>();
    const linkedConcepts = new Set(existing.results.map((r) => r.target));

    for (const concept of conceptTerms) {
      if (linkedConcepts.has(concept.path)) continue;
      // Check if any term appears in content
      const found = concept.terms.find((t) => content.includes(t));
      if (found) {
        candidates.push({
          type: "concept_mention",
          path: note.path,
          signal: `Mentions "${found}" but doesn't link to [[${concept.path}]]`,
          strength: 0.7,
          detail: concept.path,
        });
      }
    }
  }

  return candidates;
}

export async function detectBridges(env: Env): Promise<FastLoopCandidate[]> {
  const candidates: FastLoopCandidate[] = [];

  // Find notes indexed in the last 15 minutes
  const recentNotes = await env.DB.prepare(`
    SELECT path FROM vault_nodes
    WHERE indexed_at > datetime('now', '-15 minutes')
    AND size > 200
    LIMIT 30
  `).all<{ path: string }>();

  if (recentNotes.results.length === 0) return candidates;

  for (const note of recentNotes.results) {
    // Get this note's wikilink/related targets
    const targets = await env.DB.prepare(`
      SELECT target FROM vault_edges
      WHERE source = ? AND edge_type IN ('wikilink', 'related', 'discusses', 'references')
    `).bind(note.path).all<{ target: string }>();

    const targetPaths = targets.results.map((t) => t.target).filter((t) => t.includes("/"));
    if (targetPaths.length < 2) continue;

    // Batch-fetch cluster_ids for this note's targets
    const targetClusters = new Map<string, number>();
    try {
      if (targetPaths.length > 0) {
        const ph = targetPaths.map(() => "?").join(", ");
        const rows = await env.DB.prepare(
          `SELECT path, cluster_id FROM vault_enrichment WHERE path IN (${ph})`
        ).bind(...targetPaths).all<{ path: string; cluster_id: number }>();
        for (const r of rows.results) targetClusters.set(r.path, r.cluster_id);
      }
    } catch {
      // vault_enrichment missing — all bridges get default strength 0.9
    }

    // Batch-fetch all direct edges between any pair of targets (replaces N² per-pair queries).
    // Uses the same placeholder pattern as the cluster_id batch-fetch above.
    const cappedTargets = targetPaths.slice(0, 10);
    const directConnected = new Set<string>();
    {
      const ph = cappedTargets.map(() => "?").join(", ");
      const directRows = await env.DB.prepare(
        `SELECT source, target FROM vault_edges
         WHERE source IN (${ph}) AND target IN (${ph})
         AND edge_type IN ('wikilink', 'related', 'discusses', 'references', 'spoke_in')`
      ).bind(...cappedTargets, ...cappedTargets).all<{ source: string; target: string }>();
      for (const r of directRows.results) {
        // Normalize pair key for bidirectional lookup (alphabetical order)
        const key = r.source < r.target ? `${r.source}\0${r.target}` : `${r.target}\0${r.source}`;
        directConnected.add(key);
      }
    }

    // Batch-fetch all 1-hop connected pairs via intermediaries (replaces N² per-pair queries).
    // Uses narrower edge type filter than direct check: only wikilink/related (matching
    // pre-refactor per-pair 1-hop query). Excludes the bridge note itself as intermediary.
    const oneHopConnected = new Set<string>();
    {
      const ph = cappedTargets.map(() => "?").join(", ");
      // Find pairs of targets that share a common intermediary via wikilink/related edges.
      // e1: target → intermediary, e2: intermediary → other target (either direction).
      // Intermediary must not be the bridge note or any of the targets themselves.
      const notePathParam = note.path;
      const oneHopRows = await env.DB.prepare(
        `SELECT DISTINCT e1.source AS a, e2.target AS b FROM vault_edges e1
         JOIN vault_edges e2 ON e1.target = e2.source
         WHERE e1.source IN (${ph}) AND e2.target IN (${ph})
         AND e1.edge_type IN ('wikilink', 'related') AND e2.edge_type IN ('wikilink', 'related')
         AND e1.target != ? AND e1.target != e1.source AND e1.source != e2.target
         UNION
         SELECT DISTINCT e1.source AS a, e2.source AS b FROM vault_edges e1
         JOIN vault_edges e2 ON e1.target = e2.target
         WHERE e1.source IN (${ph}) AND e2.source IN (${ph})
         AND e1.edge_type IN ('wikilink', 'related') AND e2.edge_type IN ('wikilink', 'related')
         AND e1.target != ? AND e1.target != e1.source AND e1.source != e2.source`
      ).bind(
        ...cappedTargets, ...cappedTargets, notePathParam,
        ...cappedTargets, ...cappedTargets, notePathParam
      ).all<{ a: string; b: string }>();
      for (const r of oneHopRows.results) {
        const key = r.a < r.b ? `${r.a}\0${r.b}` : `${r.b}\0${r.a}`;
        oneHopConnected.add(key);
      }
    }

    // Check each pair using in-memory Sets instead of per-pair D1 queries
    for (let i = 0; i < cappedTargets.length; i++) {
      for (let j = i + 1; j < cappedTargets.length; j++) {
        const a = cappedTargets[i];
        const b = cappedTargets[j];
        const pairKey = a < b ? `${a}\0${b}` : `${b}\0${a}`;

        if (!directConnected.has(pairKey) && !oneHopConnected.has(pairKey)) {
          // Graduated bridge strength using cluster boundaries:
          // Cross-cluster bridges: 1.0 (most surprising — structurally distant)
          // Missing enrichment data: 0.9 (preserve existing behavior)
          // Same-cluster bridges: 0.7 (less surprising — already structurally close)
          const clusterA = targetClusters.get(a);
          const clusterB = targetClusters.get(b);
          const crossCluster = (clusterA !== undefined && clusterB !== undefined && clusterA !== clusterB);
          const strength = crossCluster ? 1.0 : (clusterA === undefined || clusterB === undefined) ? 0.9 : 0.7;

          candidates.push({
            type: "bridge",
            path: note.path,
            signal: `Bridges [[${a.split("/").pop()}]] to [[${b.split("/").pop()}]] (no prior 2-hop path)`,
            strength,
            detail: `${a} ↔ ${b}`,
          });
        }
      }
    }
  }

  // Deduplicate — keep highest strength per bridge pair
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = c.detail || c.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function detectTagAnomalies(env: Env): Promise<FastLoopCandidate[]> {
  const candidates: FastLoopCandidate[] = [];

  // Get recently indexed notes with their tags
  const recentNotes = await env.DB.prepare(`
    SELECT path, tags FROM vault_nodes
    WHERE indexed_at > datetime('now', '-15 minutes')
    AND tags != '[]' AND tags IS NOT NULL
    LIMIT 30
  `).all<{ path: string; tags: string }>();

  for (const note of recentNotes.results) {
    let tags: string[];
    try {
      tags = JSON.parse(note.tags);
    } catch {
      continue;
    }
    if (tags.length < 2) continue;

    // For each pair of tags, check if this combination is novel
    for (let i = 0; i < Math.min(tags.length, 8); i++) {
      for (let j = i + 1; j < Math.min(tags.length, 8); j++) {
        const tagA = `tag:${tags[i].toLowerCase()}`;
        const tagB = `tag:${tags[j].toLowerCase()}`;

        const cooccurrence = await env.DB.prepare(`
          SELECT COUNT(DISTINCT e1.source) as cnt
          FROM vault_edges e1
          JOIN vault_edges e2 ON e1.source = e2.source
          WHERE e1.edge_type = 'tag' AND e2.edge_type = 'tag'
          AND e1.target = ? AND e2.target = ?
          AND e1.source != ?
        `).bind(tagA, tagB, note.path).first<{ cnt: number }>();

        if (cooccurrence && cooccurrence.cnt < 2) {
          candidates.push({
            type: "tag_anomaly",
            path: note.path,
            signal: `Novel tag pair: [${tags[i]}, ${tags[j]}] (${cooccurrence.cnt} prior co-occurrences)`,
            strength: cooccurrence.cnt === 0 ? 1.0 : 0.6,
            detail: `${tags[i]} + ${tags[j]}`,
          });
        }
      }
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c.detail || "")) return false;
    seen.add(c.detail || "");
    return true;
  }).slice(0, 20); // Cap at 20 tag anomalies per run
}

async function runFastScore(env: Env): Promise<string> {
  const startTime = Date.now();

  // L2 snapshot fix (#71): pre/post watermark on vault_ops MAX(id).
  //
  // SELECT MAX(id) is one statement = one DB operation, giving a consistent
  // point-in-time read of the autoincrement high-water mark.
  //
  // Writers: syncGraph (INSERT INTO vault_ops via applyOps — origin-scoped),
  // buildGraph extract (INSERT via reconcileExtract), ingestTriples (INSERT
  // via applyOps). All append to vault_ops with monotonically increasing id.
  // Readers: the 4 detectors between pre/post watermark reads (bridges,
  // access divergence, centrality shifts, tag anomalies).
  // Falsifying interleaving: a syncGraph call INSERTs vault_ops rows after
  // preWatermark but before detectBridges completes → detectBridges reads
  // stale edge data. The watermark detects this: postWatermark.max_id >
  // preWatermark.max_id → snapshotStale=true. This is advisory, not a
  // blocking primitive — detectors can't be combined into a single statement.
  const preWatermark = await env.DB.prepare(
    "SELECT MAX(id) as max_id FROM vault_ops"
  ).first<{ max_id: number | null }>().catch(() => null);

  // 1. Read current PageRank node count from enrichment table (populated by orchestrator).
  //    fast-score no longer computes PageRank — it reads what the orchestrator wrote.
  //    BEFORE reading, prune stale rows for notes that no longer exist —
  //    preserves the cleanup the legacy computeCentrality() path did on every
  //    daily run. Without this, detectCentralityShifts + detectAccessDivergence
  //    can keep surfacing deleted paths until the next weekly enrichment.
  //    (Codex P2 round-12 finding.)
  const enrichTable = await resolveEnrichmentTable(env);
  if (enrichTable) {
    await env.DB.prepare(
      `DELETE FROM ${enrichTable}
       WHERE path NOT IN (SELECT path FROM vault_nodes WHERE path NOT GLOB '__*')`
    ).run().catch((err) => { console.warn("fast-score stale prune failed:", String(err).slice(0, 160)); });
  }
  const enrichNodeCount = enrichTable
    ? ((await env.DB.prepare(`SELECT COUNT(*) as c FROM ${enrichTable}`).first<{ c: number }>())?.c ?? 0)
    : 0;
  const centrality = { nodes: enrichNodeCount, source: enrichTable ?? "none" };

  // 2. Run structural detectors (text-based detection moves to external NLP pipeline)
  const bridgeCandidates = await detectBridges(env);
  const accessCandidates = await detectAccessDivergence(env);
  const shiftCandidates = await detectCentralityShifts(env);
  const tagCandidates = await detectTagAnomalies(env);

  // L2 snapshot fix (#71): post-detector watermark check.
  // Default to stale=true when either read fails — unknown state is not fresh.
  const postWatermark = await env.DB.prepare(
    "SELECT MAX(id) as max_id FROM vault_ops"
  ).first<{ max_id: number | null }>().catch(() => null);
  const snapshotStale = preWatermark === null || postWatermark === null
    ? true
    : (preWatermark.max_id ?? 0) !== (postWatermark.max_id ?? 0);
  if (snapshotStale) {
    console.warn(`fast-score snapshot stale: pre=${preWatermark?.max_id ?? "null"} post=${postWatermark?.max_id ?? "null"}`);
  }

  // Exclude dormant/on-ice projects from fast-score results.
  // Add folder prefixes here to filter out inactive projects.
  const FAST_SCORE_DAMPENED: string[] = [];
  const allCandidates = [
    ...bridgeCandidates,    // Bridges first — highest signal
    ...accessCandidates,
    ...shiftCandidates,
    ...tagCandidates,
  ].filter(c => !FAST_SCORE_DAMPENED.some(f => c.path.startsWith(f)))
   .sort((a, b) => b.strength - a.strength);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // 3. Write staging note if we have candidates
  if (allCandidates.length > 0) {
    const now = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
    const stagingContent = [
      "---",
      "type: fast-loop-candidates",
      `created: ${new Date().toISOString()}`,
      `candidates: ${allCandidates.length}`,
      `run_duration_ms: ${Date.now() - startTime}`,
      `centrality_nodes: ${centrality.nodes}`,
      "---",
      "",
      `# Fast Loop Candidates — ${new Date().toISOString().slice(0, 16)}`,
      "",
    ];

    for (const c of allCandidates) {
      stagingContent.push(`### ${c.type}: ${c.path}`);
      stagingContent.push(`- **Signal:** ${c.signal}`);
      stagingContent.push(`- **Strength:** ${c.strength.toFixed(2)}`);
      if (c.detail) stagingContent.push(`- **Detail:** ${c.detail}`);
      stagingContent.push("");
    }

    const stagingPath = `memory/high-signal/staging/${now}.md`;
    await env.VAULT.put(stagingPath + (stagingPath.endsWith(".md") ? "" : ".md"), stagingContent.join("\n"), {
      httpMetadata: { contentType: "text/markdown" },
    });
  }

  return JSON.stringify({
    elapsed_seconds: parseFloat(elapsed),
    centrality: centrality,
    candidates: allCandidates.length,
    // L2 (#71): advisory staleness flag. True when vault_ops.MAX(id) advanced
    // between pre/post watermark reads, or when either read failed.
    snapshot_stale: snapshotStale,
    snapshot_watermark: { pre: preWatermark?.max_id ?? 0, post: postWatermark?.max_id ?? 0 },
    by_type: {
      bridge: bridgeCandidates.length,
      tag_anomaly: tagCandidates.length,
      overlooked_hub: accessCandidates.filter((c) => c.type === "overlooked_hub").length,
      emerging_importance: accessCandidates.filter((c) => c.type === "emerging_importance").length,
      centrality_shift: shiftCandidates.length,
    },
    top_candidates: allCandidates.slice(0, 10),
  }, null, 2);
}

// ---------------------------------------------------------------------------
// Graph QA evaluation
// ---------------------------------------------------------------------------

interface QATraversal {
  seed: string;
  related_found: number;
  top_results: Array<{ path: string; score: number; depth: number }>;
}

async function graphQA(
  env: Env,
  question: string,
  seedPaths: string[],
  depth: number = 2
): Promise<string> {
  const traversals: QATraversal[] = [];
  const discoveredPaths = new Set<string>();
  const noteExcerpts: Array<{ path: string; excerpt: string }> = [];

  // Phase 1: Traverse from each seed
  for (const seed of seedPaths.slice(0, 5)) {
    const rawResult = await toolFindRelated(env, seed, depth, [
      "wikilink",
      "related",
      "tag",
      "tag_cooccurrence",
    ]);
    let parsed: any;
    try {
      parsed = JSON.parse(rawResult);
    } catch {
      traversals.push({ seed, related_found: 0, top_results: [] });
      continue;
    }

    const results = parsed.results || [];
    for (const r of results) {
      discoveredPaths.add(r.path);
    }
    traversals.push({
      seed,
      related_found: parsed.total_found || results.length,
      top_results: results.map((r: any) => ({
        path: r.path,
        score: r.score,
        depth: r.depth,
      })),
    });
  }

  // Phase 2: Read top discovered notes (max 8)
  const toRead = [...discoveredPaths].slice(0, 8);
  for (const path of toRead) {
    const obj = await env.VAULT.get(normalizePath(path));
    if (!obj) continue;
    const content = await obj.text();
    // Take first 2000 chars as excerpt (frontmatter + summary)
    noteExcerpts.push({ path, excerpt: content.slice(0, 2000) });
  }

  // Phase 3: Assemble report
  return JSON.stringify(
    {
      question,
      seeds_used: seedPaths,
      traversal_depth: depth,
      traversals,
      unique_notes_discovered: discoveredPaths.size,
      notes_read: toRead.length,
      excerpts: noteExcerpts,
      evaluation_guide:
        "Review the excerpts to determine: (1) Does any discovered note answer the question? (2) Was graph traversal necessary to find it? (3) Rate confidence: HIGH/MEDIUM/LOW/NONE.",
    },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

// Hoisted so the headless-host branch in legacyDispatch can route directly
// to VaultMcpDO without going through OAuthProvider. Same handler is
// referenced by both the headless-host branch and OAuthProvider.
const mcpServeHandler = VaultMcpDO.serve("/mcp", { binding: "VAULT_MCP" });

const oauthHandler = new OAuthProvider({
  apiHandler: mcpServeHandler,
  apiRoute: "/mcp",
  defaultHandler: { fetch: handleAccessRequest },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  accessTokenTTL: 30 * 24 * 60 * 60,    // 30 days
  refreshTokenTTL: 3 * 365 * 24 * 60 * 60,  // 3 years
});

// ---------------------------------------------------------------------------
// Precompute structural neighbors
// ---------------------------------------------------------------------------

async function precomputeStructuralNeighbors(env: Env): Promise<void> {
  // Scan vault_nodes for top-degree nodes and precompute their graph neighbors.
  // Results are written to R2 as a JSON file for external integrations.
  const allNodes = await env.DB.prepare(
    `SELECT path, title FROM vault_nodes
     WHERE path NOT LIKE 'transcripts/%'
       AND path NOT GLOB '__*'
       AND path NOT LIKE 'channels/%'
     ORDER BY in_degree + out_degree DESC
     LIMIT 500`
  ).all();

  if (allNodes.results.length === 0) return;

  const neighbors: Record<string, any[]> = {};
  for (const node of allNodes.results) {
    const path = (node as any).path;
    try {
      const related = await toolFindRelated(env, path, 2,
        ["wikilink", "related", "discusses", "spoke_in", "tag"]);
      const parsed = JSON.parse(related);
      if (parsed.results && parsed.results.length > 0) {
        neighbors[path] = parsed.results.slice(0, 15);
      }
    } catch {
      // Skip nodes that fail BFS
    }
  }

  await env.VAULT.put("__structural_neighbors__.json",
    JSON.stringify({
      computed_at: new Date().toISOString(),
      node_count: Object.keys(neighbors).length,
      neighbors,
    }),
    { httpMetadata: { contentType: "application/json" } }
  );
}

// ---------------------------------------------------------------------------
// Legacy bespoke dispatcher — kept intact, called via Hono fallthrough (F3)
// ---------------------------------------------------------------------------

async function legacyDispatch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const hostHeader = request.headers.get("host") ?? url.hostname;
    const host = hostHeader.split(":")[0].toLowerCase();

    const uiHosts = new Set(
      (env.UI_HOSTNAME?.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean) ?? [])
    );

    if (uiHosts.has(host)) {
      const assetResponse = handleUiAssetRequest(url);
      if (assetResponse) return assetResponse;

      const uiResponse = await handleUiRequest(request, url, env);
      if (uiResponse) return uiResponse;
    }

    // All /api/* endpoints — centralized auth
    if (url.pathname.startsWith("/api/")) {
      if (!(await verifyBearer(request, env.SHARED_SECRET))) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // L2 PR1.5 — cache-coherence verifier with two-phase confirmation.
    // AUTH: via the CENTRALIZED gate above (search "centralized auth" — the
    // named-comment anchor is asserted by tests/l2/verifier_endpoint_centralized_auth.test.ts).
    // Per CLAUDE.md "Bearer Token Auth" rule, individual endpoints MUST NOT re-check auth.
    //
    // Two-phase logic (per docs/plans/2026-04-26-003-fix-l2-verifier-snapshot-reads-eliminate-race):
    // if first call reports drift, immediately re-call and partition results via
    // classifyDrift. confirmed_drift = A ∩ B → 409. transient_drift = A △ B → 200.
    // First-call exception → 500 (second call NOT attempted; "both throw" unreachable).
    // Second-call exception with first-call drift → 200 + second_call_error diagnostic.
    //
    // DEBOUNCE: ISOLATE-LOCAL only. Two concurrent requests on the SAME isolate share
    // one verifier execution; concurrent requests across DIFFERENT isolates do not.
    // True cross-isolate dedup would require a Durable Object or KV-backed lock.
    if (request.method === "GET" && url.pathname === "/api/verify-cache-coherence") {
      try {
        const result = await runVerifierTwoPhaseDebounced(env);
        return new Response(JSON.stringify(result.body, null, 2), {
          status: result.status,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error("/api/verify-cache-coherence error:", err);
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Triple ingestion — receives (subject, relation, object) triples from automation pipeline
    if (url.pathname.startsWith("/api/ingest-triples")) {
      try {
        if (await checkMaintenanceMode(env)) {
          const blocked = badMaintenanceResult();
          return new Response(blocked.body, { status: blocked.status, headers: blocked.headers });
        }
        const body = await request.json<{
          triples: Array<{ subject: string; relation: string; object: string; weight?: number; source_note?: string }>;
        }>();

        // Cap input size to bound CPU — 2000 triples × 3 stmts/triple = 6000
        // statements, batched into ≤33-triple chunks (99 stmts each), so
        // ~61 chunks per max request. Keeps within D1 batch limits while
        // preserving per-chunk atomicity.
        const MAX_TRIPLES = 2000;
        if (body.triples.length > MAX_TRIPLES) {
          return new Response(JSON.stringify({
            error: "too_many_triples",
            message: `Max ${MAX_TRIPLES} triples per request (received ${body.triples.length}). Split into multiple requests.`,
          }), { status: 413, headers: { "Content-Type": "application/json" } });
        }

        // PR3: writer leases and dirty-degrees tracking are retired.
        // Origin-scoping (origin='ingest_triples') prevents syncGraph's
        // split-DELETE from clobbering these rows; drainDegrees() at the
        // tail picks up affected paths via vault_ops since-watermark.

        // Valid relation types — canonical list from shared contract
        const VALID_RELATIONS = new Set<string>(VAULT_MCP_EDGE_TYPES);

        let ingested = 0;
        let skipped = 0;
        let committedChunks = 0;
        let failedChunkIndex: number | null = null;
        let failureMessage: string | null = null;

        // Triple-aligned chunking: each triple = 1 edge insert. 33 triples per
        // chunk keeps the batch comfortably under D1's 100-statement limit
        // even with the per-chunk vault_ops INSERT statements. Per-chunk
        // atomicity: D1.batch() either applies all statements in a chunk or
        // none.
        const TRIPLES_PER_CHUNK = 33;
        const totalChunks = Math.ceil(body.triples.length / TRIPLES_PER_CHUNK);

        for (let c = 0; c < totalChunks; c++) {
          const chunkTriples = body.triples.slice(c * TRIPLES_PER_CHUNK, (c + 1) * TRIPLES_PER_CHUNK);
          const ops: Op[] = [];

          for (const triple of chunkTriples) {
            const relation = VALID_RELATIONS.has(triple.relation) ? triple.relation : "related";
            const weight = triple.weight ?? (relation === "related" ? 1.0 : 1.5);
            ops.push({
              op_type: "add_edge",
              origin: "ingest_triples",
              payload: {
                source: triple.subject,
                target: triple.object,
                edge_type: relation,
                weight,
              },
            });
          }

          try {
            const result = await applyOps(env, ops, {});
            ingested += result.insertedEdges;
            skipped += chunkTriples.length - result.insertedEdges;
            committedChunks++;
          } catch (chunkErr: any) {
            failedChunkIndex = c;
            failureMessage = String(chunkErr?.message ?? chunkErr).slice(0, 240);
            break;
          }
        }

        // Drain degrees once after all chunks land. Failures throw —
        // a failed drain returns non-2xx to the caller, and the
        // unchanged __last_degree_drain__ watermark means the next
        // syncGraph or ingest_triples call retries the same range.
        await drainDegrees(env);

        const responseBody: Record<string, unknown> = {
          ingested,
          skipped,
          total: body.triples.length,
          committed_chunks: committedChunks,
          total_chunks: totalChunks,
        };
        if (failedChunkIndex !== null) {
          responseBody.failed_chunk_index = failedChunkIndex;
          responseBody.error = "chunk_failed";
          responseBody.message = failureMessage;
          return new Response(JSON.stringify(responseBody), {
            status: 207, headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(responseBody), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Entity lookup — returns entity-to-path mapping for GLiNER2 resolution
    if (url.pathname.startsWith("/api/entity-lookup")) {
      // auth already verified above
      try {
        const nodes = await env.DB.prepare(`
          SELECT path, title, aliases FROM vault_nodes
          WHERE (path LIKE 'Concepts/%' OR path LIKE 'People/%' OR path LIKE 'Projects/%' OR path LIKE 'Agents/%')
          AND size > 50
        `).all<{ path: string; title: string; aliases: string }>();

        const lookup: Record<string, string> = {};
        for (const node of nodes.results) {
          // Map title → path
          lookup[node.title.toLowerCase()] = node.path;
          // Map aliases → path
          try {
            const aliases = JSON.parse(node.aliases || "[]");
            if (Array.isArray(aliases)) {
              for (const alias of aliases) {
                if (typeof alias === "string" && alias.length > 1) {
                  lookup[alias.toLowerCase()] = node.path;
                }
              }
            }
          } catch { /* ignore */ }
        }

        return new Response(JSON.stringify({ entries: Object.keys(lookup).length, lookup }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Precompute structural neighbors (writes to R2 for external integrations)
    if (url.pathname.startsWith("/api/precompute")) {
      try {
        await precomputeStructuralNeighbors(env);
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    // Fast loop scorer
    if (url.pathname.startsWith("/api/fast-score")) {
      // auth already verified above
      try {
        const result = await runFastScore(env);
        return new Response(result, { headers: { "Content-Type": "application/json" } });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Graph APIs — bypass MCP/OAuth, protected by shared secret
    if (url.pathname.startsWith("/api/graph-qa")) {
      // auth already verified above
      try {
        const body = await request.json<{ question: string; seeds: string[]; depth?: number }>();
        // Clamp depth to 1..5 to bound BFS fanout. graphQA already caps
        // seeds to 5 internally. (Self-review round-34.)
        const depth = Math.min(Math.max(body.depth ?? 2, 1), 5);
        const result = await graphQA(env, body.question, body.seeds ?? [], depth);
        return new Response(result, { headers: { "Content-Type": "application/json" } });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Algorithm enrichment status — READ-ONLY
    if (request.method === "GET" && url.pathname === "/api/enrich/status") {
      try {
        // L2 snapshot fix (#69): 4 sequential reads → single UNION ALL statement.
        //
        // UNION ALL makes all 5 SELECTs (phase, lease_expires from enrich_cursor;
        // 3 keys from meta) one DB statement instead of 4 separate operations.
        //
        // Writers: runAlgorithmEnrichment (updates enrich_cursor.phase +
        // meta keys within a batch); sweeper-cron (updates lease_expires).
        // Readers: this handler, read-only.
        // Falsifying interleaving: old code read enrich_cursor first, then
        // Promise.all'd 3 meta reads. An enrichment phase transition between
        // the cursor read and meta reads could show phase="idle" but
        // last_enrichment_at from the *previous* run. UNION ALL prevents this.
        //
        // If either table is missing, the entire UNION ALL fails and the outer
        // .catch() returns empty results -- all fields null. This is stricter
        // than the old per-query .catch() which preserved partial data when
        // only one table was missing.
        const rows = await env.DB.prepare(`
          SELECT 'phase' as key, phase as value FROM enrich_cursor WHERE id = 1
          UNION ALL
          SELECT 'lease_expires', CAST(lease_expires as TEXT) FROM enrich_cursor WHERE id = 1
          UNION ALL
          SELECT 'last_enrichment_at', value FROM meta WHERE key = 'last_enrichment_at'
          UNION ALL
          SELECT 'enrichment_version', value FROM meta WHERE key = 'enrichment_version'
          UNION ALL
          SELECT 'enrichment_community_count', value FROM meta WHERE key = 'enrichment_community_count'
        `).all<{ key: string; value: string | null }>().catch(() => ({ results: [] as { key: string; value: string | null }[] }));
        const m = new Map(rows.results.map((r) => [r.key, r.value]));
        return new Response(JSON.stringify({
          phase: m.get("phase") ?? null,
          leaseExpires: m.has("lease_expires") ? parseInt(m.get("lease_expires")!, 10) || null : null,
          lastRunAt: m.get("last_enrichment_at") ?? null,
          enrichmentVersion: m.get("enrichment_version") ?? null,
          communityCount: m.get("enrichment_community_count") ?? null,
        }), { headers: { "Content-Type": "application/json" } });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Algorithm enrichment trigger — POST /api/enrich[?force=true]
    if (request.method === "POST" && url.pathname === "/api/enrich") {
      try {
        const force = url.searchParams.get("force") === "true";

        if (force) {
          // Pre-0004 guard: force-enrich reads/writes `meta` and `enrich_cursor`.
          // On a pre-migration database these tables don't exist, and without
          // the guard the endpoint 500s instead of degrading cleanly like the
          // normal path. Wrap the force-only ops in try/catch and fall through
          // to runAlgorithmEnrichment() which has its own pre-migration skip.
          // (Codex round-41 P2 finding.)
          // Rate-limit: max 10 force-triggers per hour. Track via meta bucket.
          const hourBucket = Math.floor(Date.now() / 3_600_000).toString();
          let counterRow: { value: string } | null = null;
          try {
            counterRow = await env.DB.prepare(
              "SELECT value FROM meta WHERE key = 'enrich_force_bucket'"
            ).first<{ value: string }>();
          } catch {
            // meta table missing — pre-0004. Skip rate-limit, let runAlgorithmEnrichment
            // handle the no-op via its own guards.
            const result = await runAlgorithmEnrichment(env);
            return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
          }
          let counter = 0;
          let currentBucket = hourBucket;
          if (counterRow?.value) {
            try {
              const parsed = JSON.parse(counterRow.value) as { bucket: string; count: number };
              if (parsed.bucket === hourBucket) {
                counter = parsed.count;
                currentBucket = parsed.bucket;
              }
            } catch { /* stale — reset */ }
          }
          if (counter >= 10) {
            return new Response(JSON.stringify({ error: "rate_limit", message: "Max 10 forced enrichments per hour" }), {
              status: 429, headers: { "Content-Type": "application/json" },
            });
          }
          // Increment counter
          await env.DB.prepare(
            "INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('enrich_force_bucket', ?, unixepoch())"
          ).bind(JSON.stringify({ bucket: currentBucket, count: counter + 1 })).run().catch(() => {});

          // Bypass cooldown: reset phase to 'algorithm' ONLY if an enrichment
          // is not currently in progress. Clobbering 'running_algorithms' would
          // break the single-run guarantee and let two runs write metadata +
          // snapshots concurrently. (Codex P1 round-6 finding.)
          // Catch-all covers pre-0004 when enrich_cursor doesn't exist yet.
          await env.DB.prepare(
            "UPDATE enrich_cursor SET phase = 'algorithm' WHERE id = 1 AND phase != 'running_algorithms'"
          ).run().catch(() => {});
          // (Dropped dead `last_enrich_forced_at` write — self-review round-20.
          // The actual force-mode rate limit uses `enrich_force_bucket` above.)
        }

        const result = await runAlgorithmEnrichment(env);
        return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Backfill endpoint — POST /api/backfill?kind=body[&force=true]
    //
    // Plan-E2: replaces the pre-deploy 501 stub with a resumable lease-aware
    // body/content_hash backfill. The operator polls this endpoint until
    // `status === "completed"`. HTTP status codes are mapped per spec-flow F4:
    //   in_progress / completed                 → 200
    //   skipped / running_algorithms-lease-held → 409
    //   rate_limit                              → 429
    //   not_implemented                         → 501
    // Any other `kind` value returns 501 — future plans may add embedding.
    if (request.method === "POST" && url.pathname === "/api/backfill") {
      try {
        const kind = url.searchParams.get("kind") ?? "body";
        if (kind !== "body") {
          return new Response(JSON.stringify({
            status: "not_implemented",
            kind,
            message: `backfill kind='${kind}' is not implemented; only 'body' is supported`,
          }), { status: 501, headers: { "Content-Type": "application/json" } });
        }

        const force = url.searchParams.get("force") === "true";
        const result = await runBodyBackfillSlice(env, force);

        // Exhaustive map over runBodyBackfillSlice's status enum. Adding a
        // new variant to the enum without updating this map = tsc error.
        const STATUS_HTTP: Record<typeof result.status, number> = {
          in_progress: 200,
          completed: 200,
          skipped: 409,
          lease_held: 409,
          rate_limit: 429,
          not_implemented: 501,
        };
        const httpStatus = STATUS_HTTP[result.status] ?? 500;

        return new Response(JSON.stringify({ ...result, kind: "body" }), {
          status: httpStatus,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // PR3: /api/replay-graph-dry-run and /api/tier-a-reset retired. They were
    // PR1/PR2 verification endpoints; their migration purpose is complete.
    // backfillTierAOps remains exported for the standalone idempotency test
    // harness (tests/writers/backfill_idempotent.test.ts) and any future
    // operator-driven reconciliation tooling.

    // -----------------------------------------------------------------------
    // Phase 3: /api/sync-ops — bidirectional vault_ops exchange for CRDT sync
    // -----------------------------------------------------------------------
    //
    // Does: returns vault_ops rows since a ULID watermark, accepts incoming ops
    //       from the local peer (for C2+ when local becomes a writer).
    // Does NOT: sync vault_nodes or vault_edges directly — those are materialized
    //           state derived from vault_ops by each peer independently.
    // Side effects: backfills ULIDs on first call if any rows lack them.
    //               Applies received ops via applyOps() (C2+; empty in C1).
    // Prerequisites: migration 0014 (ulid column added to vault_ops).
    //
    // Request:  POST { ops: Op[], watermark: string | null, limit?: number }
    // Response: { ops: [...], watermark: string, has_more: boolean, stats: {...} }
    if (request.method === "POST" && url.pathname === "/api/sync-ops") {
      try {
        const body = await request.json<{
          ops?: Array<{ op_type: string; payload: unknown; origin: string; ulid?: string }>;
          watermark?: string | null;
          limit?: number;
        }>();

        const pageLimit = Math.min(Math.max(body.limit ?? 500, 1), 2000);

        // Step 1: Backfill any pre-Phase-3 rows that lack ULIDs.
        // Fast guard: skip the full backfill loop if no NULL rows exist.
        const needsBackfill = await env.DB.prepare(
          "SELECT EXISTS(SELECT 1 FROM vault_ops WHERE ulid IS NULL) AS e"
        ).first<{ e: number }>();
        const backfillResult = needsBackfill?.e
          ? await backfillVaultOpsUlids(env)
          : { backfilled: 0 };

        // Step 2: Apply incoming ops from remote peer (empty in C1 read-only phase).
        // Cap inbound array to prevent unbounded memory use from oversized POST bodies.
        let appliedOps = 0;
        const incomingOps = (body.ops ?? []).slice(0, 2000);
        if (incomingOps.length > 0) {
          // Validate and apply remote ops. Client-supplied op.ulid is discarded —
          // applyOps() generates fresh server-side ULIDs for each inserted row.
          // Replay protection relies on op-level dedup in applyOps() (same
          // op_type+payload+origin content), not on ULID uniqueness.
          const validOps = incomingOps
            .filter((op) =>
              VAULT_MCP_OP_TYPES.includes(op.op_type as VaultMcpOpType) &&
              VAULT_MCP_OP_ORIGINS.includes(op.origin as VaultMcpOpOrigin)
            )
            .map((op) => ({
              op_type: op.op_type as VaultMcpOpType,
              origin: op.origin as VaultMcpOpOrigin,
              payload: op.payload as Record<string, unknown> & { path?: string; source?: string; target?: string; edge_type?: string; weight?: number },
            })) as Op[];

          if (validOps.length > 0) {
            const result = await applyOps(env, validOps);
            appliedOps = result.insertedOps;
          }
        }

        // Step 3: Fetch local ops since watermark for the remote peer.
        const watermark = body.watermark ?? null;
        let rows: Array<{
          id: number; ulid: string; op_type: string;
          payload_json: string; origin: string; ts: string;
        }>;

        if (watermark) {
          rows = (await env.DB.prepare(
            `SELECT id, ulid, op_type, payload_json, origin, ts
               FROM vault_ops
              WHERE ulid > ?
              ORDER BY ulid
              LIMIT ?`
          ).bind(watermark, pageLimit + 1).all()).results as typeof rows;
        } else {
          // No watermark — return everything from the beginning
          rows = (await env.DB.prepare(
            `SELECT id, ulid, op_type, payload_json, origin, ts
               FROM vault_ops
              WHERE ulid IS NOT NULL
              ORDER BY ulid
              LIMIT ?`
          ).bind(pageLimit + 1).all()).results as typeof rows;
        }

        const hasMore = rows.length > pageLimit;
        if (hasMore) rows = rows.slice(0, pageLimit);

        const latestUlid = rows.length > 0 ? rows[rows.length - 1].ulid : (watermark ?? null);

        // Count total ops for progress reporting. The partial index
        // idx_vault_ops_ulid covers this COUNT — O(index size), not a full scan.
        const totalResult = await env.DB.prepare(
          "SELECT COUNT(*) AS c FROM vault_ops WHERE ulid IS NOT NULL"
        ).first<{ c: number }>();
        const totalOps = totalResult?.c ?? 0;

        return new Response(JSON.stringify({
          ops: rows.map((r) => ({
            ulid: r.ulid,
            op_type: r.op_type,
            payload: JSON.parse(r.payload_json),
            origin: r.origin,
            ts: r.ts,
          })),
          watermark: latestUlid,
          has_more: hasMore,
          stats: {
            returned: rows.length,
            applied: appliedOps,
            backfilled: backfillResult.backfilled,
            total_ops: totalOps,
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: any) {
        console.error("/api/sync-ops error:", err);
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Phase 3: /api/export — bulk dump of materialized state for initial
    // local SQLite population (Phase C1 read-only replica).
    //
    // Does: returns vault_nodes + vault_edges as JSON arrays (paginated).
    // Does NOT: return vault_ops (use /api/sync-ops for that).
    // Side effects: none (read-only).
    //
    // Request:  GET /api/export?table=vault_nodes&offset=0&limit=1000
    // Response: { rows: [...], has_more: boolean, total: number }
    if (request.method === "GET" && url.pathname === "/api/export") {
      try {
        const table = url.searchParams.get("table");
        if (!table || !["vault_nodes", "vault_edges"].includes(table)) {
          return new Response(JSON.stringify({
            error: "table parameter required (vault_nodes or vault_edges)",
          }), { status: 400, headers: { "Content-Type": "application/json" } });
        }

        const rawOffset = parseInt(url.searchParams.get("offset") ?? "0");
        const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);
        const rawLimit = parseInt(url.searchParams.get("limit") ?? "1000");
        const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 1000, 1), 5000);

        // Sentinel rows (path GLOB '__*') are excluded from vault_nodes export —
        // they are intra-peer bookkeeping (__last_sync__, __last_degree_drain__,
        // __maintenance_mode__, __build_run_id__) and must not cross to replicas.
        const whereClause = table === "vault_nodes" ? "WHERE path NOT GLOB '__*'" : "";
        const countResult = await env.DB.prepare(
          `SELECT COUNT(*) AS c FROM ${table} ${whereClause}`
        ).first<{ c: number }>();
        const total = countResult?.c ?? 0;

        const rows = await env.DB.prepare(
          `SELECT * FROM ${table} ${whereClause} LIMIT ? OFFSET ?`
        ).bind(limit, offset).all();

        return new Response(JSON.stringify({
          table,
          rows: rows.results,
          has_more: offset + limit < total,
          total,
          offset,
          limit,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: any) {
        console.error("/api/export error:", err);
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (url.pathname.startsWith("/api/build-graph") || url.pathname.startsWith("/api/sync-graph")) {
      // auth already verified above
      try {
        if (url.pathname.startsWith("/api/sync-graph")) {
          const force = url.searchParams.get("force") === "true";
          const forceReason = url.searchParams.get("force_reason") ?? undefined;
          const result = await syncGraph(env, force, forceReason);
          return new Response(result.body, {
            status: result.status,
            headers: result.headers ?? { "Content-Type": "application/json" },
          });
        }
        const phase = url.searchParams.get("phase") ?? "extract";
        const force = url.searchParams.get("force") === "true";
        if (await checkMaintenanceMode(env)) {
          const blocked = badMaintenanceResult();
          return new Response(blocked.body, { status: blocked.status, headers: blocked.headers });
        }
        const result = await buildGraph(env, phase, force);
        return new Response(result, { headers: { "Content-Type": "application/json" } });
      } catch (err: any) {
        console.error("/api/build-graph or /api/sync-graph error:", err);
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // List notes — returns paths, sizes, modified dates for a folder
    if (url.pathname.startsWith("/api/list-notes")) {
      try {
        const folder = url.searchParams.get("folder") ?? undefined;
        const text = await toolListNotes(env, folder);
        return new Response(text, { headers: { "Content-Type": "application/json" } });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Read note — returns raw markdown content
    if (url.pathname.startsWith("/api/read-note")) {
      try {
        const path = url.searchParams.get("path");
        if (!path) {
          return new Response(JSON.stringify({ error: "path parameter required" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }
        const text = await toolReadNote(env, path);
        return new Response(text, { headers: { "Content-Type": "text/markdown" } });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Daily digest — returns vault activity for a given date
    if (url.pathname.startsWith("/api/digest")) {
      // auth already verified above
      try {
        const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
        const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100"), 500);
        const offset = parseInt(url.searchParams.get("offset") ?? "0");
        const dateStart = `${date} 00:00:00`;
        const dateEnd = `${date} 23:59:59`;

        // Semantic edge types worth showing in digest (excludes structural noise)
        const SEMANTIC_TYPES = [
          "wikilink", "related", "spoke_in", "discusses", "claims", "predicts",
          "supports", "contradicts", "references", "instance_of", "broader", "narrower",
          "part_of", "has_part", "derived_from", "version_of",
          "replaces", "replaced_by", "requires", "required_by",
          "evolved_into", "inspired_by", "depends_on", "overrides", "learned_from",
          "scoped_by", "rejected", "belongs_to",
        ];
        const typePlaceholders = SEMANTIC_TYPES.map(() => "?").join(",");

        // modified_at is the R2 object's actual modification time (ISO 8601: 2026-03-18T14:27:15.444Z)
        // indexed_at is when build_graph processed it — NOT useful for "what happened on this date"
        const datePrefix = date; // YYYY-MM-DD

        // L2 snapshot fix (#67): Promise.all (4 concurrent queries) → env.DB.batch()
        // (2 queries, sequential). Separate COUNT(*) queries eliminated — total
        // derived from .results.length, so the count is structurally consistent
        // with the data returned.
        //
        // batch() executes statements sequentially, so the notes and edges
        // queries could theoretically see different DB states. Accepted
        // tradeoff: the consistency that matters (count matching returned rows)
        // is structural (derived from the same result set), not transactional.
        // See: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
        //
        // Writers: buildGraph (writes vault_nodes.modified_at, vault_edges.
        // created_at), syncGraph (same). Readers: this handler, read-only.
        // Falsifying interleaving: old code's separate COUNT queries could count
        // N notes but N+K edges if a buildGraph finalize inserted edges between
        // the two COUNTs. Eliminated by deriving counts from fetched rows.
        const [notesResult, edgesResult] = await env.DB.batch([
          env.DB.prepare(
            `SELECT path, title, note_type, folder, tags, modified_at, indexed_at
             FROM vault_nodes
             WHERE modified_at LIKE ? || '%'
             ORDER BY modified_at DESC`
          ).bind(datePrefix),
          env.DB.prepare(
            `SELECT source, target, edge_type, weight, created_at
             FROM vault_edges
             WHERE created_at >= ? AND created_at <= ?
               AND edge_type IN (${typePlaceholders})
             ORDER BY created_at DESC`
          ).bind(dateStart, dateEnd, ...SEMANTIC_TYPES),
        ]) as [
          D1Result<{ path: string; title: string; note_type: string | null; folder: string; tags: string; modified_at: string; indexed_at: string }>,
          D1Result<{ source: string; target: string; edge_type: string; weight: number; created_at: string }>,
        ];

        const items: Array<{
          timestamp: string; source: string; type: string;
          summary: string; id: string; metadata: Record<string, any>;
        }> = [];

        // Filter out build progress markers and bulk-sync noise.
        // R2 modified_at reflects upload time, not authoring time. A vault sync
        // stamps thousands of files with the same minute. Detect bulk clusters
        // (>20 notes in the same minute) and exclude them — those are sync artifacts.
        const minuteBuckets: Record<string, number> = {};
        for (const n of notesResult.results) {
          const min = (n.modified_at || "").slice(0, 16); // YYYY-MM-DDTHH:MM
          minuteBuckets[min] = (minuteBuckets[min] || 0) + 1;
        }
        const bulkMinutes = new Set(Object.entries(minuteBuckets).filter(([, c]) => c > 20).map(([m]) => m));

        for (const n of notesResult.results) {
          if (n.path.startsWith("__")) continue;
          const ts = n.modified_at || n.indexed_at;
          const min = (n.modified_at || "").slice(0, 16);
          // Wiki exemption: Wiki/<Kind>/<slug>.md pages may land in bursts
          // (e.g., bulk wiki compilation), but they are authoring events,
          // not sync artifacts. Wiki-
          // prefixed notes bypass the bulk-minute filter unconditionally;
          // non-Wiki bulk noise still gets filtered. Per-note, not per-
          // cluster — see docs/plans/2026-04-15-002-feat-wiki-v2-vault-
          // native-plan.md §"Risks" R1.
          if (bulkMinutes.has(min) && !n.path.startsWith("Wiki/")) continue;
          let tags: string[] = [];
          try { tags = JSON.parse(n.tags || "[]"); } catch {}
          items.push({
            timestamp: ts, source: "vault", type: "note",
            summary: `${n.folder ? n.folder + "/" : ""}${n.title}${n.note_type ? ` (${n.note_type})` : ""}`,
            id: n.path,
            metadata: { noteType: n.note_type, folder: n.folder, tags, modifiedAt: n.modified_at, indexedAt: n.indexed_at },
          });
        }

        for (const e of edgesResult.results) {
          items.push({
            timestamp: e.created_at, source: "vault", type: "vault_edge",
            summary: `${e.source.replace(/\.md$/, "")} —[${e.edge_type}]→ ${e.target.replace(/\.md$/, "")}`,
            id: `${e.source}|${e.edge_type}|${e.target}`,
            metadata: { edgeType: e.edge_type, weight: e.weight, sourcePath: e.source, targetPath: e.target },
          });
        }

        items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        // total = raw DB row count (notes + edges), used for pagination.
        // items may be smaller after filtering (__-prefixed sentinels, bulk-minute
        // sync artifacts), so total >= items.length. This matches the old COUNT(*)
        // behavior which also counted unfiltered rows.
        const total = notesResult.results.length + edgesResult.results.length;
        const paged = items.slice(offset, offset + limit);

        return new Response(JSON.stringify({ date, items: paged, total }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // /mcp on the dedicated headless hostname — service-token auth path.
    // CF Access at the edge gates the SVC_HOSTNAME/mcp* via self-hosted Access app
    // and forwards Cf-Access-Jwt-Assertion. We re-verify
    // the JWT against the team JWKS, confirm common_name is allowlisted, then
    // route straight to VaultMcpDO with synthesized props. The request never
    // reaches OAuthProvider because the credential is not an OAuth bearer.
    // Service-token headless-host MCP path.
    if (
      env.SVC_HOSTNAME &&
      host === env.SVC_HOSTNAME.toLowerCase() &&
      url.pathname === "/mcp" &&
      env.CF_ACCESS_TEAM_DOMAIN &&
      env.CF_ACCESS_SVC_AUD_TAG
    ) {
      const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
      if (!jwt) {
        return new Response(JSON.stringify({ error: "missing_cf_access_jwt" }), {
          status: 401, headers: { "Content-Type": "application/json" },
        });
      }
      let claims: AccessClaims;
      try {
        // Strip scheme prefix if env has it; verifyCfAccessJwt expects bare team host.
        const teamDomain = env.CF_ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//i, "").replace(/\/$/, "");
        claims = await verifyCfAccessJwt(jwt, {
          teamDomain,
          aud: env.CF_ACCESS_SVC_AUD_TAG,
        });
      } catch (err) {
        const kind = err instanceof CfAccessError ? err.kind : "unknown";
        return new Response(JSON.stringify({ error: "cf_access_jwt_invalid", kind }), {
          status: 401, headers: { "Content-Type": "application/json" },
        });
      }
      const cn = typeof claims.common_name === "string" ? claims.common_name : "";
      const allow = (env.SERVICE_TOKEN_ALLOWLIST ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      if (!cn || !allow.includes(cn)) {
        return new Response(JSON.stringify({ error: "service_token_not_allowlisted", cn }), {
          status: 403, headers: { "Content-Type": "application/json" },
        });
      }
      const proxiedCtx = {
        props: {
          accessToken: `svc:${cn}`,
          email: `${cn}@service.local`,
          login: `service:${cn}`,
          name: cn,
        },
        waitUntil: ctx.waitUntil.bind(ctx),
        passThroughOnException: ctx.passThroughOnException.bind(ctx),
      } as unknown as ExecutionContext;
      return mcpServeHandler.fetch(
        request,
        env as unknown as Parameters<typeof mcpServeHandler.fetch>[1],
        proxiedCtx,
      );
    }

    // OAUTH_PROVIDER is injected into env by OAuthProvider's fetch wrapper at runtime
    type RuntimeOauthEnv = Env & Cloudflare.Env & { OAUTH_PROVIDER: OAuthHelpers };
    return oauthHandler.fetch(request, env as unknown as RuntimeOauthEnv, ctx);
}

// ---------------------------------------------------------------------------
// F3 — Hono mount with fallthrough to legacy dispatcher
// ---------------------------------------------------------------------------

// F3 — Wire the legacy bespoke dispatcher as the Hono catch-all fallthrough.
// Any request not matched by Hono routes falls through to legacyDispatch.
withFallthrough(legacyDispatch);

export default {
  fetch: honoApp.fetch.bind(honoApp),

  // Cron Trigger — orphan sweep + fast-score + precompute structural neighbors
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Hourly orphan sweep: catch platform-kill orphans that bypass try/finally.
    // Marks stale running/pending rows (>1h) as error. Idempotent — safe to
    // run on every cron trigger, but dedicated to "0 * * * *" for clarity.
    if (event.cron.startsWith("0 *")) {
      ctx.waitUntil(
        env.DB.prepare(
          `UPDATE ingest_runs
           SET status = 'error',
               completed_at = unixepoch(),
               error = 'orphan sweep: no terminal status after 1 hour'
           WHERE status IN ('running', 'pending')
             AND completed_at IS NULL
             AND started_at < unixepoch() - 3600`
        ).run().then((result) => {
          const swept = result.meta?.rows_written ?? 0;
          if (swept > 0) console.log(`Sweeper-cron: marked ${swept} orphan ingest_runs rows as error`);
        }).catch((err) => {
          console.error("Sweeper-cron failed:", err.message);
        })
      );
      return;
    }

    // Weekly vault snapshot. wrangler.toml registers this as "0 6 * * SUN"
    // but CF's deploy API normalizes cron strings and may emit '0', 'SUN',
    // or '7' for Sunday depending on version. Match on the hour+minute
    // prefix since those are unique across this worker's cron set.
    // (Self-review round-22.)
    if (event.cron.startsWith("0 6 ")) {
      ctx.waitUntil(
        writeVaultSnapshot(env).catch((err) => {
          console.error("Vault snapshot cron failed:", err.message);
        })
      );
      return;
    }

    // Weekly algorithm enrichment (Sunday 07:00 UTC). Same hour+minute
    // prefix match as the snapshot branch — immune to CF day-of-week
    // normalization (0 vs SUN vs 7). (Self-review round-22.)
    if (event.cron.startsWith("0 7 ")) {
      ctx.waitUntil(
        runAlgorithmEnrichment(env)
          .then((result) => {
            console.log("Algorithm enrichment cron result:", JSON.stringify(result));
          })
          .catch((err) => {
            console.error("Algorithm enrichment cron failed:", err.message);
          })
      );
      return;
    }

    ctx.waitUntil(
      (async () => {
        // Catch-up: if __last_sync__ is >12h stale, loop syncGraph until
        // done before scoring. Skip fast-score if catchup can't complete —
        // scoring against a partial graph is worse than skipping a tick.
        const catchup = await runSyncCatchupIfStale(env);
        if (catchup === "skipped_partial") {
          console.warn("Fast-score skipped: sync catchup did not reach done=true within budget");
          return;
        }

        await runFastScore(env).catch((err) => {
          console.error("Fast-score cron failed:", err.message);
        });

        await precomputeStructuralNeighbors(env).catch((err) => {
          console.error("Structural neighbor precompute failed:", err.message);
        });
      })()
    );
  },
};

/** Cron-time catch-up. If __last_sync__ is >12h stale, loops syncGraph
 *  until done=true within a wall-clock budget. Returns:
 *    "fresh"            — no catchup needed
 *    "completed"        — caught up to done=true
 *    "skipped_partial"  — wall-clock budget exhausted before done; caller
 *                         should skip downstream work that needs a complete
 *                         graph (e.g. fast-score). */
async function runSyncCatchupIfStale(env: Env): Promise<"fresh" | "completed" | "skipped_partial"> {
  const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000;
  const WALL_CLOCK_BUDGET_MS = 25 * 60 * 1000; // 25 min, fits within 30-min Cron Trigger limit
  const MAX_ITERATIONS = 50;

  const lastSync = await env.DB.prepare(
    "SELECT indexed_at FROM vault_nodes WHERE path = '__last_sync__'"
  ).first<{ indexed_at: string }>();
  if (lastSync) {
    const ageMs = Date.now() - new Date(lastSync.indexed_at).getTime();
    if (ageMs < STALE_THRESHOLD_MS) return "fresh";
  }

  const startMs = Date.now();
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (Date.now() - startMs > WALL_CLOCK_BUDGET_MS) return "skipped_partial";
    const result = await syncGraph(env, true, "cron_catchup");
    if (result.status === 503) {
      const retryAfterRaw = result.headers?.["Retry-After"];
      const retryAfter = retryAfterRaw ? Number.parseInt(retryAfterRaw, 10) : 5;
      const sleepMs = Math.min(Math.max(retryAfter, 1), 30) * 1000;
      if (Date.now() - startMs + sleepMs > WALL_CLOCK_BUDGET_MS) return "skipped_partial";
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
      continue;
    }
    try {
      const parsed = JSON.parse(result.body) as { done?: boolean };
      if (parsed.done) return "completed";
    } catch {
      return "skipped_partial";
    }
  }
  return "skipped_partial";
}
