import type { VaultNote, GraphEdge } from "./types";

const MAX_NOTES_PER_FOLDER = 50;
const MAX_NOTES_PER_TAG = 50;
const TEMPORAL_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

export function buildEdges(notes: VaultNote[]): GraphEdge[] {
  const noteById = new Map<string, VaultNote>();
  const noteByBasename = new Map<string, VaultNote[]>();

  for (const note of notes) {
    noteById.set(note.id, note);
    const basename = note.id.includes("/")
      ? note.id.substring(note.id.lastIndexOf("/") + 1)
      : note.id;
    const existing = noteByBasename.get(basename) || [];
    existing.push(note);
    noteByBasename.set(basename, existing);
  }

  const edges: GraphEdge[] = [];
  let edgeCount = 0;

  // 1. Wikilinks — directed, weight 1.0
  for (const note of notes) {
    for (const target of note.wikilinks) {
      // Resolve: exact path first, basename fallback
      let resolved = noteById.get(target);
      if (!resolved) {
        const candidates = noteByBasename.get(target);
        if (candidates && candidates.length === 1) {
          resolved = candidates[0];
        }
        // Skip ambiguous basename matches
      }
      if (resolved && resolved.id !== note.id) {
        edges.push({
          id: `wl:${edgeCount++}`,
          source: note.id,
          target: resolved.id,
          type: "wikilink",
          weight: 1.0,
        });
      }
    }
  }

  // 2. Tag edges — undirected, IDF-weighted, cap at 50 notes/tag
  const tagNotes = new Map<string, string[]>();
  for (const note of notes) {
    const tags = note.frontmatter.tags;
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      if (typeof tag !== "string") continue;
      const list = tagNotes.get(tag) || [];
      list.push(note.id);
      tagNotes.set(tag, list);
    }
  }

  const totalNotes = notes.length || 1;
  const seen = new Set<string>();
  for (const [tag, members] of tagNotes) {
    if (members.length < 2 || members.length > MAX_NOTES_PER_TAG) continue;
    const weight = Math.max(0.1, Math.min(1.0,
      Math.log(totalNotes / members.length) / Math.log(totalNotes)
    ));
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const pair = members[i] < members[j]
          ? `${members[i]}|${members[j]}`
          : `${members[j]}|${members[i]}`;
        if (!seen.has(pair)) {
          seen.add(pair);
          edges.push({
            id: `tag:${edgeCount++}`,
            source: members[i],
            target: members[j],
            type: "tag",
            weight,
          });
        }
      }
    }
  }

  // 3. Folder edges — undirected, skip large folders
  const folderNotes = new Map<string, string[]>();
  for (const note of notes) {
    if (!note.folder) continue;
    const list = folderNotes.get(note.folder) || [];
    list.push(note.id);
    folderNotes.set(note.folder, list);
  }

  seen.clear();
  for (const [_folder, members] of folderNotes) {
    if (members.length < 2 || members.length > MAX_NOTES_PER_FOLDER) continue;
    const weight = Math.max(0.05, Math.min(0.5, 1.0 / Math.sqrt(members.length)));
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        edges.push({
          id: `folder:${edgeCount++}`,
          source: members[i],
          target: members[j],
          type: "folder",
          weight,
        });
      }
    }
  }

  // 4. Temporal edges — same folder, modified within 24h
  seen.clear();
  for (const [_folder, memberIds] of folderNotes) {
    if (memberIds.length < 2 || memberIds.length > MAX_NOTES_PER_FOLDER) continue;
    const memberNotes = memberIds.map(id => noteById.get(id)!).sort((a, b) => a.modified - b.modified);
    for (let i = 0; i < memberNotes.length; i++) {
      for (let j = i + 1; j < memberNotes.length; j++) {
        const diff = memberNotes[j].modified - memberNotes[i].modified;
        if (diff > TEMPORAL_WINDOW_MS) break;
        const pair = memberNotes[i].id < memberNotes[j].id
          ? `${memberNotes[i].id}|${memberNotes[j].id}`
          : `${memberNotes[j].id}|${memberNotes[i].id}`;
        if (!seen.has(pair)) {
          seen.add(pair);
          const weight = Math.max(0.1, 1.0 - diff / TEMPORAL_WINDOW_MS);
          edges.push({
            id: `temporal:${edgeCount++}`,
            source: memberNotes[i].id,
            target: memberNotes[j].id,
            type: "temporal",
            weight,
          });
        }
      }
    }
  }

  return edges;
}
