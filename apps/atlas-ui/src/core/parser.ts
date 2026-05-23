import { readFile, stat } from "fs/promises";
import matter from "gray-matter";
import type { VaultNote } from "./types";

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?\s*(?:\|[^\]]*)?\]\]/g;

export async function parseVault(vaultPath: string): Promise<VaultNote[]> {
  const glob = new Bun.Glob("**/*.md");
  const paths: string[] = [];

  for await (const file of glob.scan({ cwd: vaultPath, absolute: false, onlyFiles: true })) {
    // Skip dotfiles and .obsidian
    if (file.split("/").some(part => part.startsWith("."))) continue;
    paths.push(file);
  }

  const notes: VaultNote[] = [];
  const BATCH = 1000;

  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (relPath) => {
        const fullPath = `${vaultPath}/${relPath}`;
        const [text, fileStat] = await Promise.all([
          readFile(fullPath, "utf-8"),
          stat(fullPath),
        ]);
        return { relPath, text, mtime: fileStat.mtimeMs };
      })
    );

    for (const { relPath, text, mtime } of results) {
      const id = relPath.replace(/\.md$/, "");
      const folder = id.includes("/") ? id.substring(0, id.lastIndexOf("/")) : "";
      const filename = id.includes("/") ? id.substring(id.lastIndexOf("/") + 1) : id;

      let fm: Record<string, unknown> = {};
      let body = text;
      try {
        const parsed = matter(text);
        fm = parsed.data;
        body = parsed.content;
      } catch {
        // Malformed frontmatter — treat entire file as body
      }

      // Extract wikilinks
      const wikilinks: string[] = [];
      const seen = new Set<string>();
      for (const match of body.matchAll(WIKILINK_RE)) {
        const target = match[1].trim();
        if (target && !seen.has(target)) {
          seen.add(target);
          wikilinks.push(target);
        }
      }

      // Timestamps
      const created = fm.created
        ? new Date(fm.created).getTime()
        : fm.date
          ? new Date(fm.date).getTime()
          : mtime;

      notes.push({
        id,
        title: (fm.title as string) || filename,
        path: relPath,
        folder,
        frontmatter: fm,
        wikilinks,
        wordCount: body.split(/\s+/).length,
        created,
        modified: mtime,
      });
    }
  }

  return notes;
}
