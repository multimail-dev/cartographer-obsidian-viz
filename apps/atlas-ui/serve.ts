#!/usr/bin/env bun
/**
 * Local-first dev server for Cartographer.
 *
 * Does:  reads an Obsidian vault from disk, builds a knowledge graph in memory
 *        (edges, PageRank, Louvain communities, connected components, clustering
 *        coefficients), and serves the Atlas UI + JSON API on localhost.
 *
 * Usage:
 *   bun apps/atlas-ui/serve.ts                          # default ~/vault
 *   bun apps/atlas-ui/serve.ts ~/my-obsidian-vault       # custom vault path
 *   VAULT_PATH=~/my-vault bun apps/atlas-ui/serve.ts    # env var
 *   PORT=3000 bun apps/atlas-ui/serve.ts                # custom port
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { parseVault } from "./src/core/parser";
import { buildEdges } from "./src/core/graph-builder";
import { keywordSearch } from "./src/core/search";
import { pagerank } from "./src/core/pagerank";
import { louvain } from "./src/core/louvain";
import { connectedComponents } from "./src/core/components";
import { clusteringCoefficient } from "./src/core/clustering";
import type { VaultNote, GraphEdge } from "./src/core/types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VAULT_PATH = process.argv[2] ?? process.env.VAULT_PATH ?? join(process.env.HOME!, "vault");
const PORT = parseInt(process.env.PORT ?? "4321", 10);

// Static asset roots.
const PUBLIC_ROOT = join(import.meta.dir, "public");
const FRONTEND_ROOT = join(import.meta.dir, "src", "frontend");

// ---------------------------------------------------------------------------
// Graph state (built once on startup, held in memory)
// ---------------------------------------------------------------------------

interface EnrichedNode {
  id: string;
  title: string;
  folder: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  wordCount: number;
  created: number;
  modified: number;
  x: number;
  y: number;
  clusterId: number | null;
  componentId: number | null;
  pagerank: number | null;
  clusteringCoeff: number | null;
}

let nodes: EnrichedNode[] = [];
let edges: GraphEdge[] = [];
let noteIndex: Map<string, VaultNote> = new Map();
let meta = {
  nodeCount: 0,
  edgeCount: 0,
  edgeTypes: [] as string[],
  topTags: [] as Array<{ tag: string; count: number }>,
  topFolders: [] as Array<{ folder: string; count: number }>,
  lastReload: 0,
  enrichmentVersion: 1,
  lastEnrichmentAt: 0,
  enrichmentCommunityCount: 0,
};

// ---------------------------------------------------------------------------
// Build graph with enrichment
// ---------------------------------------------------------------------------

async function buildFullGraph(): Promise<void> {
  const startMs = Date.now();
  console.log(`Parsing vault: ${VAULT_PATH}`);
  const vaultNotes = await parseVault(VAULT_PATH);
  console.log(`  ${vaultNotes.length} notes parsed in ${Date.now() - startMs}ms`);

  // Index notes for search + note retrieval
  noteIndex = new Map(vaultNotes.map((n) => [n.id, n]));

  // Build edges
  const rawEdges = buildEdges(vaultNotes);
  console.log(`  ${rawEdges.length} edges built`);

  // Build index maps for enrichment algorithms
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < vaultNotes.length; i++) idToIdx.set(vaultNotes[i].id, i);

  const numericEdges = rawEdges
    .map((e) => ({
      source: idToIdx.get(e.source)!,
      target: idToIdx.get(e.target)!,
      weight: e.weight,
    }))
    .filter((e) => e.source !== undefined && e.target !== undefined);

  // PageRank
  console.log("  Computing PageRank...");
  const pr = pagerank(vaultNotes.length, numericEdges);

  // Louvain communities
  console.log("  Computing Louvain communities...");
  const lv = louvain(vaultNotes.length, numericEdges);
  console.log(`  ${lv.communityCount} communities (modularity ${lv.modularity.toFixed(3)})`);

  // Connected components
  console.log("  Computing connected components...");
  const cc = connectedComponents(vaultNotes.length, numericEdges);

  // Clustering coefficients
  console.log("  Computing clustering coefficients...");
  const cl = clusteringCoefficient(vaultNotes.length, numericEdges);

  // Random initial positions (the frontend runs ForceAtlas3 in a web worker)
  const rng = () => Math.random() * 200 - 100;

  // Assemble enriched nodes
  nodes = vaultNotes.map((note, i) => ({
    id: note.id,
    title: note.title,
    folder: note.folder,
    tags: Array.isArray(note.frontmatter.tags) ? note.frontmatter.tags.map(String) : [],
    frontmatter: note.frontmatter,
    wordCount: note.wordCount,
    created: note.created,
    modified: note.modified,
    x: rng(),
    y: rng(),
    clusterId: lv.communities[i] ?? null,
    componentId: cc.components[i] ?? null,
    pagerank: pr[i] ?? null,
    clusteringCoeff: cl.coefficients[i] ?? null,
  }));

  edges = rawEdges;

  // Compute meta
  const tagCounts = new Map<string, number>();
  const folderCounts = new Map<string, number>();
  const edgeTypesSet = new Set<string>();
  for (const e of edges) edgeTypesSet.add(e.type);
  for (const n of nodes) {
    for (const t of n.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    if (n.folder) folderCounts.set(n.folder, (folderCounts.get(n.folder) ?? 0) + 1);
  }

  meta = {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    edgeTypes: [...edgeTypesSet],
    topTags: [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag, count]) => ({ tag, count })),
    topFolders: [...folderCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([folder, count]) => ({ folder, count })),
    lastReload: Date.now(),
    enrichmentVersion: 1,
    lastEnrichmentAt: Date.now(),
    enrichmentCommunityCount: lv.communityCount,
  };

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`  Graph ready: ${nodes.length} nodes, ${edges.length} edges in ${elapsed}s`);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

let cachedIndexHtml = "";

async function loadIndexHtml(): Promise<void> {
  cachedIndexHtml = await Bun.file(join(FRONTEND_ROOT, "index.html")).text();
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

async function startServer(): Promise<void> {
  await buildFullGraph();
  await loadIndexHtml();

  Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);

      // --- API routes ---

      if (url.pathname === "/api/graph") {
        return Response.json({
          nodes: nodes.map((n) => ({
            id: n.id,
            title: n.title,
            folder: n.folder,
            type: null,
            nodeType: null,
            tags: n.tags,
            wordCount: n.wordCount,
            created: n.created,
            modified: n.modified,
            x: n.x,
            y: n.y,
            frontmatter: n.frontmatter,
            clusterId: n.clusterId,
            componentId: n.componentId,
            pagerank: n.pagerank,
            clusteringCoeff: n.clusteringCoeff,
          })),
          edges: edges.map((e) => ({
            source: e.source,
            target: e.target,
            type: e.type,
            weight: e.weight,
          })),
        });
      }

      if (url.pathname === "/api/meta") {
        return Response.json(meta);
      }

      if (url.pathname === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        if (!q) return Response.json({ results: [], totalCount: 0 });
        const results = keywordSearch([...noteIndex.values()], q);
        return Response.json({ results, totalCount: results.length });
      }

      if (url.pathname === "/api/note") {
        const path = url.searchParams.get("path") ?? "";
        if (!path) return new Response("missing ?path", { status: 400 });
        const note = noteIndex.get(path);
        if (!note) return new Response("not found", { status: 404 });
        try {
          const content = await readFile(join(VAULT_PATH, note.path), "utf-8");
          return new Response(content, {
            headers: { "Content-Type": "text/markdown; charset=utf-8" },
          });
        } catch {
          return new Response("file read error", { status: 500 });
        }
      }

      if (url.pathname === "/api/enrichments") {
        return Response.json({
          version: meta.enrichmentVersion,
          communityCount: meta.enrichmentCommunityCount,
          lastRunAt: meta.lastEnrichmentAt,
        });
      }

      if (url.pathname === "/api/events") {
        // SSE stub — keeps the connection open so the frontend doesn't error
        return new Response(": connected\n\n", {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      // --- Static assets ---

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(cachedIndexHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/style.css") {
        const file = Bun.file(join(FRONTEND_ROOT, "style.css"));
        return new Response(file, {
          headers: { "Content-Type": "text/css; charset=utf-8" },
        });
      }

      if (url.pathname === "/dist/app.js") {
        const file = Bun.file(join(PUBLIC_ROOT, "dist", "app.js"));
        return new Response(file, {
          headers: { "Content-Type": "application/javascript; charset=utf-8" },
        });
      }

      if (url.pathname === "/dist/fa3-worker.js") {
        const file = Bun.file(join(PUBLIC_ROOT, "dist", "fa3-worker.js"));
        return new Response(file, {
          headers: { "Content-Type": "application/javascript; charset=utf-8" },
        });
      }

      // Source map requests — 204 no-content
      if (url.pathname.endsWith(".js.map")) {
        return new Response(null, { status: 204 });
      }

      return new Response("not found", { status: 404 });
    },
  });

  console.log(`\nCartographer local server running at http://localhost:${PORT}`);
  console.log(`Vault: ${VAULT_PATH} (${nodes.length} notes, ${edges.length} edges)`);
}

startServer().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
