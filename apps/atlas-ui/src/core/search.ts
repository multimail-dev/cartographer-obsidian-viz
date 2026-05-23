import type { VaultNote } from "./types";

export function keywordSearch(notes: VaultNote[], query: string): string[] {
  const q = query.toLowerCase();
  const results: Array<{ id: string; score: number }> = [];

  for (const note of notes) {
    let score = 0;

    // Title match (highest weight)
    if (note.title.toLowerCase().includes(q)) score += 10;

    // ID/path match
    if (note.id.toLowerCase().includes(q)) score += 5;

    // Tag match
    const tags = note.frontmatter.tags;
    if (Array.isArray(tags) && tags.some(t => String(t).toLowerCase().includes(q))) {
      score += 8;
    }

    // Type match
    if (typeof note.frontmatter.type === "string" && note.frontmatter.type.toLowerCase().includes(q)) {
      score += 3;
    }

    if (score > 0) {
      results.push({ id: note.id, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.map(r => r.id);
}
