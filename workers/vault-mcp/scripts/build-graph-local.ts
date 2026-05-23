#!/usr/bin/env bun
/**
 * Phase 3A: Local buildGraph — extract + finalize against local vault files.
 *
 * Does: reads .md files from local vault (~/vault by default), calls the
 *       same extractEdgesFromNote logic as the CF Worker, writes vault_nodes +
 *       vault_edges + vault_ops to local SQLite (~/.cartographer/local-graph.sqlite).
 * Does NOT: connect to D1 or R2. Does NOT sync with remote.
 * Use instead of: /api/build-graph when operating on local vault files.
 *
 * Usage:
 *   bun scripts/build-graph-local.ts                    # full build (extract + finalize)
 *   bun scripts/build-graph-local.ts --phase extract    # extract only
 *   bun scripts/build-graph-local.ts --phase finalize   # finalize only
 *   bun scripts/build-graph-local.ts --push             # full build + push to D1
 *
 * Env:
 *   VAULT_PATH    — vault directory (default: ~/vault)
 *   LOCAL_DB_PATH — SQLite path (default: ~/.cartographer/local-graph.sqlite)
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { Glob } from "bun";

import { extractEdgesFromNote, type VaultEdge } from "../src/extract";
import { parseFrontmatterExtended } from "../src/parse";
import { ulid } from "../src/ulid";
import { DEFAULT_DB_PATH, DEFAULT_VAULT_PATH, SCHEMA_PATH } from "./lib/config";

// ---------------------------------------------------------------------------
// Config + args
// ---------------------------------------------------------------------------

const VAULT_PATH = process.env.VAULT_PATH ?? DEFAULT_VAULT_PATH;
const DB_PATH = process.env.LOCAL_DB_PATH ?? DEFAULT_DB_PATH;
const LOCK_PATH = DB_PATH + ".build.lock";

const phaseIdx = process.argv.indexOf("--phase");
const phaseArg = phaseIdx !== -1 ? process.argv[phaseIdx + 1] : "all";
if (!["extract", "finalize", "all"].includes(phaseArg)) {
  console.error("Usage: bun scripts/build-graph-local.ts [--phase extract|finalize|all] [--push]");
  process.exit(1);
}
const shouldPush = process.argv.includes("--push");

// ---------------------------------------------------------------------------
// Lockfile (PID-based — prevents concurrent build-graph-local instances)
// ---------------------------------------------------------------------------

function acquireLock(): void {
  if (existsSync(LOCK_PATH)) {
    const pidStr = readFileSync(LOCK_PATH, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0); // signal 0 = check existence
        console.error(`Another build-graph-local is running (pid ${pid}). Remove ${LOCK_PATH} if stale.`);
        process.exit(1);
      } catch {
        // ESRCH: process not found — stale lock
        console.warn(`Removing stale lock file (pid ${pidStr})`);
      }
    }
  }
  const dir = dirname(LOCK_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(LOCK_PATH, String(process.pid));
}

function releaseLock(): void {
  try { unlinkSync(LOCK_PATH); } catch {}
}

// ---------------------------------------------------------------------------
// Database
// PRAGMAs (WAL, busy_timeout=5000, etc.) are set in local-schema.sql lines
// 10-13 and applied by db.exec(schema) below.
// ---------------------------------------------------------------------------

function initDb(): Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schema);
  return db;
}

// ---------------------------------------------------------------------------
// Vault walk — find all .md files in the vault directory
// ---------------------------------------------------------------------------

async function walkVault(): Promise<Array<{ relPath: string; absPath: string; size: number; modified: string }>> {
  if (!existsSync(VAULT_PATH)) {
    throw new Error(`Vault path does not exist: ${VAULT_PATH}`);
  }

  const files: Array<{ relPath: string; absPath: string; size: number; modified: string }> = [];
  const glob = new Glob("**/*.md");

  for await (const relPath of glob.scan({ cwd: VAULT_PATH, dot: false })) {
    // Skip hidden directories and .obsidian
    if (relPath.startsWith(".") || relPath.includes("/.")) continue;

    const absPath = join(VAULT_PATH, relPath);
    const stat = statSync(absPath);
    files.push({
      relPath,
      absPath,
      size: stat.size,
      modified: stat.mtime.toISOString(),
    });
  }

  return files;
}

// ---------------------------------------------------------------------------
// Ops logging helper
// ---------------------------------------------------------------------------

function logOps(
  db: Database,
  ops: Array<{ op_type: string; origin: string; payload: Record<string, unknown> }>,
): void {
  if (ops.length === 0) return;
  const stmt = db.prepare(
    "INSERT INTO vault_ops (ulid, op_type, payload_json, origin, ts, peer) VALUES (?, ?, ?, ?, datetime('now'), 'local')",
  );
  for (const op of ops) {
    stmt.run(ulid(), op.op_type, JSON.stringify(op.payload), op.origin);
  }
}

// ---------------------------------------------------------------------------
// Content hashing (Bun-native, sync)
// ---------------------------------------------------------------------------

function contentHash(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

// ---------------------------------------------------------------------------
// Extract phase
// ---------------------------------------------------------------------------

async function extractPhase(db: Database): Promise<{
  nodesProcessed: number;
  edgesProcessed: number;
  runId: string;
}> {
  const startTime = Date.now();
  const runId = `build-local-${ulid()}`;

  // Create ingest_runs row
  db.run(
    "INSERT INTO ingest_runs (id, started_at, status) VALUES (?, unixepoch(), 'running')",
    [runId],
  );

  // Stash run id in meta for finalize phase to find
  db.run(
    "INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('build_run_id', ?, unixepoch())",
    [runId],
  );

  console.log("  Scanning vault...");
  const files = await walkVault();
  console.log(`  Found ${files.length} .md files in ${VAULT_PATH}`);

  let nodesProcessed = 0;
  let edgesProcessed = 0;
  const BATCH_SIZE = 200;

  // Prepared statements (reused across batches)
  const deleteEdgesOutbound = db.prepare(
    "DELETE FROM vault_edges WHERE origin = 'extract' AND source = ?1 AND edge_type != 'spoke_in'",
  );
  const deleteEdgesInbound = db.prepare(
    "DELETE FROM vault_edges WHERE origin = 'extract' AND target = ?1 AND edge_type = 'spoke_in'",
  );
  const insertEdge = db.prepare(
    `INSERT OR IGNORE INTO vault_edges (source, target, edge_type, weight, ingest_run_id, origin)
     VALUES (?, ?, ?, ?, ?, 'extract')`,
  );
  const upsertNode = db.prepare(
    `INSERT INTO vault_nodes (path, title, note_type, folder, tags, aliases, size, modified_at,
       indexed_at, body, word_count, content_hash, frontmatter, ingest_run_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'), ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT(path) DO UPDATE SET
       title = excluded.title, note_type = excluded.note_type, folder = excluded.folder,
       tags = excluded.tags, aliases = excluded.aliases, size = excluded.size,
       modified_at = excluded.modified_at, indexed_at = excluded.indexed_at,
       body = excluded.body, word_count = excluded.word_count,
       content_hash = excluded.content_hash, frontmatter = excluded.frontmatter,
       ingest_run_id = excluded.ingest_run_id`,
  );
  const deleteFts = db.prepare("DELETE FROM vault_fts WHERE path = ?");
  const insertFts = db.prepare(
    "INSERT INTO vault_fts (path, title, content, tags) VALUES (?, ?, ?, ?)",
  );

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);

    const tx = db.transaction(() => {
      const batchOps: Array<{ op_type: string; origin: string; payload: Record<string, unknown> }> = [];

      for (const file of batch) {
        const content = readFileSync(file.absPath, "utf-8");
        const { node, edges, aliases } = extractEdgesFromNote(
          file.relPath, // key (with .md extension — extractEdgesFromNote strips it)
          content,
          file.modified,
          file.size,
        );

        // Content hash + word count + frontmatter
        const hash = contentHash(content);
        const ftsBody = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
        const wordCount = ftsBody.split(/\s+/).filter(Boolean).length;
        const fm = parseFrontmatterExtended(content);
        const frontmatter = fm ? JSON.stringify(fm) : null;

        // --- reconcileExtract: DELETE old edges, INSERT new edges ---
        deleteEdgesOutbound.run(node.path);
        deleteEdgesInbound.run(node.path);

        for (const edge of edges) {
          insertEdge.run(
            edge.source, edge.target, edge.edge_type, edge.weight,
            runId,
          );
        }

        // --- UPSERT vault_nodes ---
        upsertNode.run(
          node.path, node.title, node.note_type, node.folder, node.tags,
          JSON.stringify(aliases), node.size, node.modified_at,
          content, wordCount, hash, frontmatter, runId,
        );

        // --- FTS update ---
        deleteFts.run(node.path);
        insertFts.run(node.path, node.title, ftsBody, node.tags || "");

        // --- Collect ops for vault_ops ---
        batchOps.push({
          op_type: "upsert_node",
          origin: "extract",
          payload: {
            path: node.path, title: node.title, note_type: node.note_type,
            folder: node.folder, tags: node.tags, aliases,
            size: node.size, modified_at: node.modified_at,
          },
        });
        for (const edge of edges) {
          batchOps.push({
            op_type: "add_edge",
            origin: "extract",
            payload: {
              source: edge.source, target: edge.target,
              edge_type: edge.edge_type, weight: edge.weight,
              ingest_run_id: runId,
            },
          });
        }

        nodesProcessed++;
        edgesProcessed += edges.length;
      }

      logOps(db, batchOps);
    });

    tx();

    const pct = Math.round(((i + batch.length) / files.length) * 100);
    process.stdout.write(
      `\r  Extract: ${nodesProcessed}/${files.length} notes (${pct}%) — ${edgesProcessed} edges`,
    );
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `\n  Extract complete: ${nodesProcessed} nodes, ${edgesProcessed} edges in ${elapsed}s`,
  );

  return { nodesProcessed, edgesProcessed, runId };
}

// ---------------------------------------------------------------------------
// Finalize phase
// ---------------------------------------------------------------------------

function finalizePhase(db: Database): {
  aliasesResolved: number;
  phantomsRemaining: number;
  folderEdges: number;
  temporalEdges: number;
  tagCooccurrenceEdges: number;
  totalNodes: number;
  totalEdges: number;
} {
  const startTime = Date.now();
  console.log("  Alias resolution...");

  // --- Alias resolution: merge split identities ---
  const nodesWithAliases = db.query<
    { path: string; title: string; tags: string; aliases: string },
    []
  >("SELECT path, title, tags, aliases FROM vault_nodes").all();

  const aliasMap = new Map<string, string>();
  const aliasMapLower = new Map<string, string>();
  const realPaths = new Set<string>();

  for (const row of nodesWithAliases) {
    realPaths.add(row.path);

    // Strategy 1: Title -> path
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

    // Strategy 2: Frontmatter aliases -> path
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

  function resolvePhantom(name: string): string | null {
    const exact = aliasMap.get(name);
    if (exact && realPaths.has(exact)) return exact;

    const lower = aliasMapLower.get(name.toLowerCase());
    if (lower && realPaths.has(lower)) return lower;

    for (const prefix of ["Concepts/", "Agents/", "Projects/", "Knowledge/"]) {
      if (realPaths.has(prefix + name)) return prefix + name;
    }

    const nameLower = name.toLowerCase();
    for (const prefix of ["Concepts/", "Agents/", "Projects/"]) {
      const candidateLower = (prefix + name).toLowerCase();
      for (const rp of realPaths) {
        if (rp.toLowerCase() === candidateLower) return rp;
      }
    }

    return null;
  }

  // Resolve phantom targets
  const phantomTargets = db.query<{ target: string }, []>(`
    SELECT DISTINCT target FROM vault_edges
    WHERE target NOT IN (SELECT path FROM vault_nodes)
    AND target NOT LIKE 'tag:%'
  `).all();

  let aliasesResolved = 0;
  let phantomsRemaining = 0;

  const resolveTargetTx = db.transaction(() => {
    const phantomOps: Array<{ op_type: string; origin: string; payload: Record<string, unknown> }> = [];

    for (const { target } of phantomTargets) {
      const canonical = resolvePhantom(target);
      if (canonical) {
        const affected = db.query<
          { source: string; target: string; edge_type: string; weight: number },
          [string]
        >("SELECT source, target, edge_type, weight FROM vault_edges WHERE target = ?").all(target);

        db.run("UPDATE OR IGNORE vault_edges SET target = ? WHERE target = ?", [canonical, target]);
        db.run("DELETE FROM vault_edges WHERE target = ?", [target]);

        for (const edge of affected) {
          phantomOps.push(
            { op_type: "remove_edge", origin: "phantom_rewrite", payload: { source: edge.source, target: edge.target, edge_type: edge.edge_type } },
            { op_type: "add_edge", origin: "phantom_rewrite", payload: { source: edge.source, target: canonical, edge_type: edge.edge_type, weight: edge.weight ?? 1 } },
          );
        }
        aliasesResolved++;
      } else {
        phantomsRemaining++;
      }
    }

    logOps(db, phantomOps);
  });
  resolveTargetTx();

  // Resolve phantom sources
  const phantomSources = db.query<{ source: string }, []>(`
    SELECT DISTINCT source FROM vault_edges
    WHERE source NOT IN (SELECT path FROM vault_nodes)
    AND source NOT LIKE 'tag:%'
  `).all();

  const resolveSourceTx = db.transaction(() => {
    const phantomOps: Array<{ op_type: string; origin: string; payload: Record<string, unknown> }> = [];

    for (const { source } of phantomSources) {
      const canonical = resolvePhantom(source);
      if (canonical) {
        const affected = db.query<
          { source: string; target: string; edge_type: string; weight: number },
          [string]
        >("SELECT source, target, edge_type, weight FROM vault_edges WHERE source = ?").all(source);

        db.run("UPDATE OR IGNORE vault_edges SET source = ? WHERE source = ?", [canonical, source]);
        db.run("DELETE FROM vault_edges WHERE source = ?", [source]);

        for (const edge of affected) {
          phantomOps.push(
            { op_type: "remove_edge", origin: "phantom_rewrite", payload: { source: edge.source, target: edge.target, edge_type: edge.edge_type } },
            { op_type: "add_edge", origin: "phantom_rewrite", payload: { source: canonical, target: edge.target, edge_type: edge.edge_type, weight: edge.weight ?? 1 } },
          );
        }
        aliasesResolved++;
      }
    }

    logOps(db, phantomOps);
  });
  resolveSourceTx();

  console.log(`  Aliases resolved: ${aliasesResolved}, phantoms remaining: ${phantomsRemaining}`);

  // --- Folder co-membership edges ---
  console.log("  Folder co-membership edges...");

  const allNodes = db.query<
    { path: string; folder: string; modified_at: string },
    []
  >("SELECT path, folder, modified_at FROM vault_nodes WHERE folder != ''").all();

  const folderNotes: Record<string, Array<{ path: string; modified: string }>> = {};
  for (const row of allNodes) {
    if (!folderNotes[row.folder]) folderNotes[row.folder] = [];
    folderNotes[row.folder].push({ path: row.path, modified: row.modified_at });
  }

  let folderEdgesAdded = 0;
  const insertFolderEdge = db.prepare(
    "INSERT OR IGNORE INTO vault_edges (source, target, edge_type, weight, origin) VALUES (?, ?, 'folder', 0.5, 'finalize')",
  );
  const folderTx = db.transaction(() => {
    const folderOps: Array<{ op_type: string; origin: string; payload: Record<string, unknown> }> = [];

    for (const [, notes] of Object.entries(folderNotes)) {
      if (notes.length > 50 || notes.length < 2) continue;
      for (let a = 0; a < notes.length; a++) {
        for (let b = a + 1; b < notes.length; b++) {
          insertFolderEdge.run(notes[a].path, notes[b].path);
          folderOps.push({
            op_type: "add_edge",
            origin: "finalize",
            payload: { source: notes[a].path, target: notes[b].path, edge_type: "folder", weight: 0.5 },
          });
          folderEdgesAdded++;
        }
      }
    }

    logOps(db, folderOps);
  });
  folderTx();
  console.log(`  Folder edges: ${folderEdgesAdded}`);

  // --- Temporal adjacency edges (same folder, within 1 day) ---
  console.log("  Temporal adjacency edges...");

  let temporalEdgesAdded = 0;
  const insertTemporalEdge = db.prepare(
    "INSERT OR IGNORE INTO vault_edges (source, target, edge_type, weight, origin) VALUES (?, ?, 'temporal', 0.3, 'finalize')",
  );
  const temporalTx = db.transaction(() => {
    const temporalOps: Array<{ op_type: string; origin: string; payload: Record<string, unknown> }> = [];

    for (const [, notes] of Object.entries(folderNotes)) {
      if (notes.length > 50 || notes.length < 2) continue;

      const sorted = notes
        .filter((n) => n.modified)
        .sort((a, b) => new Date(a.modified).getTime() - new Date(b.modified).getTime());

      for (let a = 0; a < sorted.length; a++) {
        const aTime = new Date(sorted[a].modified).getTime();
        for (let b = a + 1; b < sorted.length; b++) {
          const bTime = new Date(sorted[b].modified).getTime();
          if (bTime - aTime > 86400000) break;
          insertTemporalEdge.run(sorted[a].path, sorted[b].path);
          temporalOps.push({
            op_type: "add_edge",
            origin: "finalize",
            payload: { source: sorted[a].path, target: sorted[b].path, edge_type: "temporal", weight: 0.3 },
          });
          temporalEdgesAdded++;
        }
      }
    }

    logOps(db, temporalOps);
  });
  temporalTx();
  console.log(`  Temporal edges: ${temporalEdgesAdded}`);

  // --- Tag co-occurrence edges ---
  console.log("  Tag co-occurrence edges...");

  const tagEdges = db.query<
    { path1: string; path2: string; shared_tags: number },
    []
  >(`
    SELECT e1.source AS path1, e2.source AS path2, COUNT(*) AS shared_tags
    FROM vault_edges e1
    JOIN vault_edges e2 ON e1.target = e2.target AND e1.source < e2.source
    WHERE e1.edge_type = 'tag' AND e2.edge_type = 'tag'
    AND e1.target IN (
      SELECT target FROM vault_edges WHERE edge_type = 'tag'
      GROUP BY target HAVING COUNT(*) BETWEEN 3 AND 100
    )
    AND NOT (e1.source LIKE 'Archive/%' AND e2.source LIKE 'Archive/%')
    AND NOT (e1.source LIKE 'channels/%' AND e2.source LIKE 'channels/%')
    AND NOT (e1.source LIKE 'transcripts/%' AND e2.source LIKE 'transcripts/%')
    GROUP BY e1.source, e2.source
    HAVING shared_tags >= 2
    LIMIT 10000
  `).all();

  let tagCooccurrenceAdded = 0;
  const insertTagCoEdge = db.prepare(
    "INSERT OR IGNORE INTO vault_edges (source, target, edge_type, weight, origin) VALUES (?, ?, 'tag_cooccurrence', ?, 'finalize')",
  );
  const tagTx = db.transaction(() => {
    const tagOps: Array<{ op_type: string; origin: string; payload: Record<string, unknown> }> = [];

    for (const { path1, path2, shared_tags } of tagEdges) {
      const weight = Math.min(0.2 + shared_tags * 0.3, 1.5);
      insertTagCoEdge.run(path1, path2, weight);
      tagOps.push({
        op_type: "add_edge",
        origin: "finalize",
        payload: { source: path1, target: path2, edge_type: "tag_cooccurrence", weight },
      });
      tagCooccurrenceAdded++;
    }

    logOps(db, tagOps);
  });
  tagTx();
  console.log(`  Tag co-occurrence edges: ${tagCooccurrenceAdded}`);

  // --- Degree recompute (full-table, cheaper than per-path after finalize) ---
  console.log("  Degree recompute...");
  db.run(
    "UPDATE vault_nodes SET out_degree = (SELECT COUNT(*) FROM vault_edges WHERE source = vault_nodes.path)",
  );
  db.run(
    "UPDATE vault_nodes SET in_degree = (SELECT COUNT(*) FROM vault_edges WHERE target = vault_nodes.path)",
  );

  // --- drainDegrees: advance the watermark so subsequent incremental drains
  //     start from this point (same logic as CF Worker drainDegrees) ---
  const maxOpsRow = db.query<{ max_id: number | null }, []>(
    "SELECT MAX(id) as max_id FROM vault_ops",
  ).get();
  if (maxOpsRow?.max_id != null) {
    db.run(
      `INSERT OR REPLACE INTO vault_nodes (path, title, note_type, folder, tags, size, modified_at, indexed_at)
       VALUES ('__last_degree_drain__', 'degree_drain', null, '', '[]', ?, '', datetime('now'))`,
      [maxOpsRow.max_id],
    );
  }

  // --- Record build completion sentinel ---
  const totalNodes = db.query<{ c: number }, []>(
    "SELECT COUNT(*) AS c FROM vault_nodes WHERE path NOT GLOB '__*'",
  ).get()?.c ?? 0;
  const totalEdges = db.query<{ c: number }, []>(
    "SELECT COUNT(*) AS c FROM vault_edges",
  ).get()?.c ?? 0;

  db.run(
    `INSERT OR REPLACE INTO vault_nodes (path, title, note_type, folder, tags, size, modified_at, indexed_at)
     VALUES ('__last_build_completed__', 'build_graph', null, '', '[]', ?, '', datetime('now'))`,
    [totalNodes],
  );

  // --- Mark ingest_runs completed ---
  const buildRunId = db.query<{ value: string }, []>(
    "SELECT value FROM meta WHERE key = 'build_run_id'",
  ).get()?.value;
  if (buildRunId) {
    db.run(
      "UPDATE ingest_runs SET status = 'completed', completed_at = unixepoch(), node_count = ?, edge_count = ? WHERE id = ? AND completed_at IS NULL",
      [totalNodes, totalEdges, buildRunId],
    );
    db.run("DELETE FROM meta WHERE key = 'build_run_id'");
  }

  // --- Edges by type ---
  const byType = db.query<{ edge_type: string; count: number }, []>(
    "SELECT edge_type, COUNT(*) as count FROM vault_edges GROUP BY edge_type ORDER BY count DESC",
  ).all();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Finalize complete in ${elapsed}s`);
  console.log(`  Total: ${totalNodes} nodes, ${totalEdges} edges`);
  console.log("  Edges by type:");
  for (const { edge_type, count } of byType) {
    console.log(`    ${edge_type}: ${count}`);
  }

  return {
    aliasesResolved,
    phantomsRemaining,
    folderEdges: folderEdgesAdded,
    temporalEdges: temporalEdgesAdded,
    tagCooccurrenceEdges: tagCooccurrenceAdded,
    totalNodes,
    totalEdges,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`build-graph-local: ${VAULT_PATH} → ${DB_PATH}`);
  console.log(`Phase: ${phaseArg}`);

  acquireLock();
  const db = initDb();

  try {
    if (phaseArg === "extract" || phaseArg === "all") {
      console.log("\n=== Extract Phase ===");
      const { nodesProcessed, edgesProcessed, runId } = await extractPhase(db);
      console.log(`  Run ID: ${runId}`);
    }

    if (phaseArg === "finalize" || phaseArg === "all") {
      console.log("\n=== Finalize Phase ===");
      finalizePhase(db);
    }

    // Final state summary
    const nodeCount = db.query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM vault_nodes WHERE path NOT GLOB '__*'",
    ).get()?.c ?? 0;
    const edgeCount = db.query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM vault_edges",
    ).get()?.c ?? 0;
    const opsCount = db.query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM vault_ops",
    ).get()?.c ?? 0;

    console.log("\nLocal graph state:");
    console.log(`  vault_nodes: ${nodeCount}`);
    console.log(`  vault_edges: ${edgeCount}`);
    console.log(`  vault_ops:   ${opsCount}`);

    // --push: spawn push-to-d1 as subprocess after graph build completes
    if (shouldPush) {
      console.log("\n=== Push to D1 ===");
      const pushScript = join(import.meta.dir, "push-to-d1.ts");
      const proc = Bun.spawn(["bun", pushScript], {
        stdout: "inherit",
        stderr: "inherit",
        env: {
          ...process.env,
          LOCAL_DB_PATH: DB_PATH,
          SKIP_BACKUP: "1", // backup already handled by push-to-d1 on standalone runs; skip when chained
        },
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        throw new Error(`push-to-d1 failed with exit code ${exitCode}`);
      }
    }

    console.log("done.");
  } catch (err) {
    // Mark ingest_runs as error if extract phase failed
    const buildRunId = db.query<{ value: string }, []>(
      "SELECT value FROM meta WHERE key = 'build_run_id'",
    ).get()?.value;
    if (buildRunId) {
      db.run(
        "UPDATE ingest_runs SET status = 'error', completed_at = COALESCE(completed_at, unixepoch()), error = ? WHERE id = ? AND completed_at IS NULL",
        [String(err).slice(0, 500), buildRunId],
      );
    }
    throw err;
  } finally {
    db.close();
    releaseLock();
  }
}

main().catch((err) => {
  console.error("build-graph-local failed:", err);
  releaseLock();
  process.exit(1);
});
