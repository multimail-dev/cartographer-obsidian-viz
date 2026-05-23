/**
 * Lightweight frontmatter parser shared between src/index.ts (build/sync
 * graph) and src/cron/backfill-body.ts (plan-E2). Kept in its own module
 * so backfill-body does not pull the full index.ts import graph (which
 * brings in @cloudflare/workers-oauth-provider and breaks test isolation).
 *
 * Non-goals: this is a line-scanner, not a real YAML parser. It handles the
 * subset Obsidian emits — scalar values and single-line [a, b, c] arrays.
 * Multi-line block sequences, nested maps, and anchors are out of scope.
 */
export function parseFrontmatterExtended(
  content: string,
): Record<string, string | string[]> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm: Record<string, string | string[]> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
    if (!m) continue;
    const [, key, raw] = m;
    const val = raw.trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      fm[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      fm[key] = val;
    }
  }
  return fm;
}
