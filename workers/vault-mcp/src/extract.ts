/**
 * Pure extraction helpers extracted from src/index.ts.
 *
 * Contains extractEdgesFromNote() and the path/tag helpers it depends on.
 * Shared between the Cloudflare Worker (src/index.ts) and local build-graph
 * tooling so that the local scale gate uses the identical extraction logic
 * without pulling the full Worker import graph.
 *
 * Does NOT contain D1-coupled helpers (chunk, opKey, buildVaultEdgesInsertStmt),
 * normalizePath, or parseFrontmatter — those stay in index.ts.
 * Does NOT re-export parseFrontmatterExtended — import from "./parse" directly.
 */

import type { VaultMcpOpOrigin } from "@vault-graph/contract";
import { parseFrontmatterExtended } from "./parse";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VaultNode {
  path: string;
  title: string;
  note_type: string | null;
  folder: string;
  tags: string;
  size: number;
  modified_at: string;
}

export interface VaultEdge {
  source: string;
  target: string;
  edge_type: string;
  weight: number;
  ingest_run_id?: string | null;
  origin?: VaultMcpOpOrigin;
}

export interface ExtractedNote {
  node: VaultNode;
  edges: VaultEdge[];
  aliases: string[];
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function stripExtension(key: string): string {
  return key.replace(/\.md$/, "");
}

export function getFolderFromPath(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.substring(0, idx);
}

export function getTitleFromPath(path: string): string {
  const stripped = stripExtension(path);
  const idx = stripped.lastIndexOf("/");
  return idx === -1 ? stripped : stripped.substring(idx + 1);
}

// ---------------------------------------------------------------------------
// Tag exclusion set
// ---------------------------------------------------------------------------

export const EXCLUDED_TAGS = new Set([
  // Format/type tags — describe what the note IS, not what it's ABOUT
  "transcript", "podcast", "stub", "concept", "navigation", "project",
  "changelog", "assessment", "person", "project-state", "briefing", "memory",
  "channel-export", "notion-import", "auto-captured", "personal-reference",
  // Process tags — how the note was created, not what it's about
  "subagent", "claude-code", "claude-desktop", "enriched",
  // Too broad to be useful as graph edges
  "ai", "archive", "research", "notion",
  // Add your own source/agent tags here to exclude them from graph edges.
  // Example: "my-podcast", "my-newsletter", "agent-name"
]);

// ---------------------------------------------------------------------------
// Core extraction
// ---------------------------------------------------------------------------

export function extractEdgesFromNote(
  key: string,
  content: string,
  modified: string,
  size: number
): ExtractedNote {
  const path = stripExtension(key);
  const folder = getFolderFromPath(path);
  const title = getTitleFromPath(path);

  const fm = parseFrontmatterExtended(content);
  const noteType = fm?.type ? (Array.isArray(fm.type) ? fm.type[0] : fm.type) : null;
  const tags: string[] = fm?.tags
    ? Array.isArray(fm.tags)
      ? fm.tags
      : [fm.tags]
    : [];
  const aliases: string[] = fm?.aliases
    ? Array.isArray(fm.aliases)
      ? fm.aliases
      : [fm.aliases]
    : [];

  const node: VaultNode = {
    path,
    title,
    note_type: noteType,
    folder,
    tags: JSON.stringify(tags),
    size,
    modified_at: modified,
  };

  const edges: VaultEdge[] = [];

  // Strip frontmatter to get body
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");

  // Check if we're in a Related section
  const relatedMatch = body.match(/##\s+(?:Related|Context)\s*\n([\s\S]*?)(?=\n##\s|\n$|$)/i);
  const relatedSection = relatedMatch ? relatedMatch[1] : "";

  // Extract all wikilinks from body
  const wikilinkRegex = /\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g;
  let match: RegExpExecArray | null;

  // Track which targets appear in Related section
  const relatedTargets = new Set<string>();
  if (relatedSection) {
    let rm: RegExpExecArray | null;
    const relRegex = /\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g;
    while ((rm = relRegex.exec(relatedSection)) !== null) {
      relatedTargets.add(rm[1].trim());
    }
  }

  // Extract section-specific wikilinks with typed edges
  // Map sections to edge types for semantic graph edges
  const sectionEdgeMap: Record<string, string> = {
    "speakers": "spoke_in",
    "key claims": "claims",
    "predictions": "predicts",
    "podcast discussions": "discusses",
    "podcast episodes": "discusses",
  };

  // Parse sections to build a target→edge_type map
  const typedTargets = new Map<string, string>();
  for (const [sectionName, edgeType] of Object.entries(sectionEdgeMap)) {
    const sectionRegex = new RegExp(
      `##\\s+${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|\\n$|$)`,
      "i"
    );
    const sectionMatch = body.match(sectionRegex);
    if (sectionMatch) {
      const sectionContent = sectionMatch[1];
      const linkRegex = /\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g;
      let lm: RegExpExecArray | null;
      while ((lm = linkRegex.exec(sectionContent)) !== null) {
        typedTargets.set(lm[1].trim(), edgeType);
      }
    }
  }

  // Extract speakers from frontmatter as typed edges
  const speakers: string[] = fm?.speakers
    ? Array.isArray(fm.speakers) ? fm.speakers : [fm.speakers]
    : [];
  for (const speaker of speakers) {
    const speakerPath = `People/${speaker}`;
    edges.push({ source: speakerPath, target: path, edge_type: "spoke_in", weight: 1.5 });
  }

  // Extract concepts from frontmatter as wikilink edges
  const concepts: string[] = fm?.concepts
    ? Array.isArray(fm.concepts) ? fm.concepts : [fm.concepts]
    : [];
  for (const concept of concepts) {
    edges.push({ source: path, target: concept, edge_type: "discusses", weight: 1.5 });
  }

  // All wikilinks from body — use typed edges when available
  const seenTargets = new Set<string>();
  while ((match = wikilinkRegex.exec(body)) !== null) {
    const target = match[1].trim();
    if (seenTargets.has(target)) continue;
    seenTargets.add(target);

    // Priority: typed section edge > related section > generic wikilink
    const typedEdge = typedTargets.get(target);
    if (typedEdge) {
      edges.push({ source: path, target, edge_type: typedEdge, weight: 1.5 });
    } else if (relatedTargets.has(target)) {
      edges.push({ source: path, target, edge_type: "related", weight: 1.5 });
    } else {
      edges.push({ source: path, target, edge_type: "wikilink", weight: 1.0 });
    }
  }

  // Tag edges (normalize to lowercase, exclude format/source/provenance tags)
  for (const tag of tags) {
    const normalized = tag.toLowerCase();
    if (EXCLUDED_TAGS.has(normalized)) continue;
    edges.push({ source: path, target: `tag:${normalized}`, edge_type: "tag", weight: 1.0 });
  }

  // --- Contradiction edges from wiki pages (plan 2026-05-19-001 U5) ---
  // When extracting a Wiki/ page, scan for (compare: [[A]] vs [[B]]) annotations
  // and emit contradicts edges. CRITICAL: source = wiki page path (not referenced note).
  // reconcileExtract deletes WHERE origin='extract' AND source=?1 (the note being extracted).
  // With source=wikiPath, edges survive extraction of referenced notes A and B.
  if (path.startsWith("Wiki/")) {
    const comparePattern = /\(compare:\s*\[\[([^\]]+)\]\]\s*vs\.?\s*\[\[([^\]]+)\]\]\s*\)/gi;
    let compareMatch: RegExpExecArray | null;
    while ((compareMatch = comparePattern.exec(body)) !== null) {
      const targetA = compareMatch[1].trim();
      const targetB = compareMatch[2].trim();
      // Emit two edges per contradiction: wiki→A and wiki→B
      // To reconstruct "A contradicts B", query all contradicts edges from this wiki page
      edges.push({ source: path, target: targetA, edge_type: "contradicts", weight: 1.0 });
      edges.push({ source: path, target: targetB, edge_type: "contradicts", weight: 1.0 });
    }
  }

  return { node, edges, aliases };
}
