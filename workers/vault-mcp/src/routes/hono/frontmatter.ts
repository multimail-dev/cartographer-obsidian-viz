/**
 * GET /api/frontmatter/schema
 *   Returns a map of frontmatter fields → distinct values + counts,
 *   aggregated across vault_nodes. Used by the frontend's dynamic filter
 *   builder.
 *
 * GET /api/frontmatter/filter?field=<field>&value=<value>
 *   Returns the list of node paths whose frontmatter[field] includes the
 *   given value. Array fields match if the value is an element; scalar
 *   fields match on equality.
 *
 * DOES NOT:
 *   - Index frontmatter fields in D1 (all scanning happens in-memory per
 *     request — fine at 10-20K nodes; v0.3 could add a generated column)
 *   - Support nested paths (top-level only)
 *   - Support comparison operators — equality / array-membership only
 *
 * Ported from vault-mcp-power frontmatter.ts — adapted to vault-mcp schema:
 *   nodes.id        → vault_nodes.path
 *   nodes.frontmatter → vault_nodes.frontmatter (added in migration 0004)
 * READ-ONLY. No side effects.
 */
import { Hono } from "hono";
import type { Env } from "../../env";

export const frontmatterRoutes = new Hono<{ Bindings: Env }>();

// Pre-0004 guard: vault_nodes.frontmatter is added in migration 0004. During
// the dual-path rollout window the code is live before the migration runs.
// Probe once per request; if the column is missing, return an empty schema/
// filter response rather than 500ing. (Codex round-39 P1 finding.)
async function vaultNodesHasFrontmatter(env: Env): Promise<boolean> {
  try {
    const cols = await env.DB.prepare(
      `PRAGMA table_info('vault_nodes')`
    ).all<{ name: string }>();
    return (cols.results ?? []).some((r) => r.name === "frontmatter");
  } catch {
    return false;
  }
}

const MAX_SCAN = 20000;
const MAX_VALUES_PER_FIELD = 50;

const RESERVED_FIELDS = new Set(["type", "tags", "title", "created", "modified", "date"]);

interface FrontmatterScanRow {
  path: string;
  frontmatter: string | null;
}

interface FieldSchema {
  field: string;
  values: Array<{ value: string; count: number }>;
  total: number;
  kind: "scalar" | "array";
}

frontmatterRoutes.get("/api/frontmatter/schema", async (c) => {
  if (!(await vaultNodesHasFrontmatter(c.env))) {
    return c.json({ fields: [], scanned: 0, truncated: false });
  }
  const res = await c.env.DB.prepare(
    `SELECT path, frontmatter FROM vault_nodes
     WHERE frontmatter IS NOT NULL AND path NOT GLOB '__*'
     LIMIT ?`,
  ).bind(MAX_SCAN).all<FrontmatterScanRow>();

  const rows = res.results ?? [];
  const counts = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  const arrayHits = new Map<string, number>();

  for (const row of rows) {
    if (!row.frontmatter) continue;
    let fm: Record<string, unknown>;
    try {
      fm = JSON.parse(row.frontmatter) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!fm || typeof fm !== "object") continue;

    for (const [field, rawValue] of Object.entries(fm)) {
      if (RESERVED_FIELDS.has(field)) continue;
      if (rawValue === null || rawValue === undefined) continue;

      totals.set(field, (totals.get(field) ?? 0) + 1);
      let valueMap = counts.get(field);
      if (!valueMap) {
        valueMap = new Map();
        counts.set(field, valueMap);
      }

      if (Array.isArray(rawValue)) {
        arrayHits.set(field, (arrayHits.get(field) ?? 0) + 1);
        for (const item of rawValue) {
          if (typeof item === "string" || typeof item === "number") {
            const key = String(item);
            valueMap.set(key, (valueMap.get(key) ?? 0) + 1);
          }
        }
      } else if (
        typeof rawValue === "string" ||
        typeof rawValue === "number" ||
        typeof rawValue === "boolean"
      ) {
        const key = String(rawValue);
        valueMap.set(key, (valueMap.get(key) ?? 0) + 1);
      }
    }
  }

  const schema: FieldSchema[] = [];
  for (const [field, valueMap] of counts) {
    const total = totals.get(field) ?? 0;
    const arrayCount = arrayHits.get(field) ?? 0;
    const kind: "scalar" | "array" = arrayCount * 2 > total ? "array" : "scalar";
    const values = [...valueMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_VALUES_PER_FIELD)
      .map(([value, count]) => ({ value, count }));
    schema.push({ field, values, total, kind });
  }
  schema.sort((a, b) => b.total - a.total);

  return c.json({ fields: schema, scanned: rows.length, truncated: rows.length === MAX_SCAN });
});

frontmatterRoutes.get("/api/frontmatter/filter", async (c) => {
  const field = c.req.query("field");
  const value = c.req.query("value");
  if (!field || value === undefined) {
    return c.json({ error: "field and value are required" }, 400);
  }
  if (field.length > 64) return c.json({ error: "field name too long" }, 413);
  if (value.length > 1024) return c.json({ error: "value too long" }, 413);

  if (!(await vaultNodesHasFrontmatter(c.env))) {
    return c.json({ field, value, matches: [], count: 0, scanned: 0 });
  }

  const res = await c.env.DB.prepare(
    `SELECT path, frontmatter FROM vault_nodes
     WHERE frontmatter IS NOT NULL AND path NOT GLOB '__*'
     LIMIT ?`,
  ).bind(MAX_SCAN).all<FrontmatterScanRow>();

  const matching: string[] = [];
  for (const row of res.results ?? []) {
    if (!row.frontmatter) continue;
    let fm: Record<string, unknown>;
    try {
      fm = JSON.parse(row.frontmatter) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!fm || typeof fm !== "object") continue;

    const rawValue = fm[field];
    if (rawValue === null || rawValue === undefined) continue;

    if (Array.isArray(rawValue)) {
      if (rawValue.some((item) => String(item) === value)) matching.push(row.path);
    } else if (String(rawValue) === value) {
      matching.push(row.path);
    }
  }

  return c.json({
    field,
    value,
    matches: matching,
    count: matching.length,
    scanned: res.results?.length ?? 0,
  });
});
