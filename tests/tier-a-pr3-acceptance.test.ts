// Tier A PR3 TDD gate (chief-of-staff pre-write, 2026-04-25).
//
// Encodes acceptance criteria from
// docs/plans/2026-04-23-001-cartographer-op-log-tier-a-plan.md (r8) §PR3.
// MUST fail on the branch tip BEFORE delegated implementation.
// Implementing agents make these pass without modifying this file.
//
// Scope per plan §PR3:
//   1. Delete sync_writer_lease logic from writer paths (meta key stays readable)
//   2. Replace vault_dirty_degrees with ops-derived dirty-path query (drainDegrees)
//   3. Remove DROP TABLE IF EXISTS vault_edges destructive block
//   4. Delete /api/replay-graph-dry-run + /api/tier-a-reset
//   5. Update CLAUDE.md: strike build_graph-Destructive, sync_writer_lease,
//      Degree-Recompute-vault_dirty_degrees; add vault_ops-as-Audit-Log rule.
//   6. Migration 0013: drop vault_dirty_degrees + bootstrap __last_degree_drain__

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";

const REPO_ROOT = resolve(import.meta.dir, "..");
const INDEX_TS = resolve(REPO_ROOT, "workers/vault-mcp/src/index.ts");
const SCHEMA_PROBES_TS = resolve(REPO_ROOT, "workers/vault-mcp/src/schema-probes.ts");
const CLAUDE_MD = resolve(REPO_ROOT, "CLAUDE.md");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "workers/vault-mcp/migrations");

function read(p: string): string {
  if (!existsSync(p)) throw new Error(`expected file does not exist: ${p}`);
  return readFileSync(p, "utf8");
}

function find0013(): string | null {
  if (!existsSync(MIGRATIONS_DIR)) return null;
  for (const entry of readdirSync(MIGRATIONS_DIR)) {
    if (entry.startsWith("0013_") && entry.endsWith(".sql")) return resolve(MIGRATIONS_DIR, entry);
  }
  return null;
}

describe("PR3 §1 — sync_writer_lease retired from writer paths", () => {
  test("index.ts no longer defines acquireSyncWriterLease()", () => {
    const body = read(INDEX_TS);
    // The acquire function and 503 lease-held response should be gone from
    // production code paths. Historical refs in COMMENTS are fine; the
    // FUNCTION DEFINITIONS must be removed.
    expect(body).not.toMatch(/^async\s+function\s+acquireSyncWriterLease\b/m);
    expect(body).not.toMatch(/^function\s+leaseHeldResponse\b/m);
  });

  test("index.ts writer paths do not call lease acquire", () => {
    const body = read(INDEX_TS);
    // No call to acquireSyncWriterLease( anywhere in active code.
    expect(body).not.toMatch(/acquireSyncWriterLease\s*\(/);
  });

  test("index.ts does not include lease-held 503 response branches in writer paths", () => {
    const body = read(INDEX_TS);
    // The retired sync-writer lease returned a 503 with body
    // `{"error": "lease_held", ...}`. Scope the assertion to the
    // error-payload usage so it does not collide with the unrelated
    // cron-lease status enum (`status: "lease_held"`) in
    // runBodyBackfillSlice. The other lease assertions (no
    // leaseHeldResponse function, no callers, no acquireSyncWriterLease)
    // already cover the function-level retirement.
    expect(body).not.toMatch(/error:\s*"lease_held"/);
  });

  test("vault_health stats payload no longer reports sync_writer_lease_holder/expires_at", () => {
    const body = read(INDEX_TS);
    expect(body).not.toMatch(/sync_writer_lease_holder\s*:/);
    expect(body).not.toMatch(/sync_writer_lease_expires_at\s*:/);
  });
});

describe("PR3 §2 — vault_dirty_degrees retired in favor of drainDegrees() reading vault_ops", () => {
  test("index.ts defines drainDegrees() (replacement for drainDirtyDegrees)", () => {
    const body = read(INDEX_TS);
    expect(body).toMatch(/^async\s+function\s+drainDegrees\b/m);
  });

  test("index.ts no longer defines drainDirtyDegrees()", () => {
    const body = read(INDEX_TS);
    expect(body).not.toMatch(/^async\s+function\s+drainDirtyDegrees\b/m);
  });

  test("index.ts no longer INSERTs into vault_dirty_degrees", () => {
    const body = read(INDEX_TS);
    expect(body).not.toMatch(/INSERT\s+INTO\s+vault_dirty_degrees\b/i);
  });

  test("index.ts no longer SELECTs from vault_dirty_degrees", () => {
    const body = read(INDEX_TS);
    // Active queries must be gone. Historical comments allowed.
    expect(body).not.toMatch(/FROM\s+vault_dirty_degrees\b/i);
    expect(body).not.toMatch(/DELETE\s+FROM\s+vault_dirty_degrees\b/i);
  });

  test("schema-probes.ts no longer probes vault_dirty_degrees existence", () => {
    if (!existsSync(SCHEMA_PROBES_TS)) return; // file may not exist if probes were inlined
    const body = read(SCHEMA_PROBES_TS);
    expect(body).not.toMatch(/['"]vault_dirty_degrees['"]/);
  });

  test("drainDegrees uses vault_ops as the source of dirty paths", () => {
    const body = read(INDEX_TS);
    const drainStart = body.indexOf("async function drainDegrees");
    expect(drainStart).toBeGreaterThan(-1);
    // Look at the next ~3KB for the SQL pattern we expect per plan §PR3.
    const drainSlice = body.slice(drainStart, drainStart + 3500);
    expect(drainSlice).toMatch(/vault_ops/);
    expect(drainSlice).toMatch(/__last_degree_drain__/);
    // Must use a since-id watermark, not a full table scan.
    expect(drainSlice).toMatch(/MAX\s*\(\s*id\s*\)/i);
  });
});

describe("PR3 §3 — buildGraph DROP TABLE block removed (preserves cross-origin rows)", () => {
  test("index.ts no longer contains DROP TABLE IF EXISTS vault_edges in active code", () => {
    const body = read(INDEX_TS);
    // The destructive line must be gone. If a fallback for pre-0012 schemas
    // remains, it must not literally DROP TABLE vault_edges.
    expect(body).not.toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+vault_edges\b/i);
  });
});

describe("PR3 §4 — debugging endpoints retired", () => {
  test("/api/replay-graph-dry-run endpoint removed from index.ts", () => {
    const body = read(INDEX_TS);
    expect(body).not.toMatch(/['"]\/api\/replay-graph-dry-run['"]/);
  });

  test("/api/tier-a-reset endpoint removed from index.ts", () => {
    const body = read(INDEX_TS);
    expect(body).not.toMatch(/['"]\/api\/tier-a-reset['"]/);
  });
});

describe("PR3 §5 — CLAUDE.md rules updated", () => {
  test("CLAUDE.md no longer contains pre-PR3 §'build_graph is Destructive' heading body", () => {
    const body = read(CLAUDE_MD);
    // The original heading was '### build_graph is Destructive' — that
    // heading must be gone (or rewritten without 'is Destructive' framing).
    // The post-PR2 patch already qualified this; PR3 strikes it entirely.
    expect(body).not.toMatch(/^###\s+build_graph\s+is\s+Destructive\b/m);
    expect(body).not.toMatch(/^###\s+build_graph\s+is\s+Destructive\s+\(pre-0012/m);
  });

  test("CLAUDE.md no longer documents sync_writer_lease in active rules", () => {
    const body = read(CLAUDE_MD);
    // Strike 'sync_writer_lease' from active prose. A historical
    // mention is fine if it's clearly post-PR3 retirement context.
    // Absolute rule: no rule heading + body that REQUIRES the lease.
    expect(body).not.toMatch(/All\s+`vault_edges`\s+writers\s+acquire\s+`meta\.sync_writer_lease`/);
  });

  test("CLAUDE.md no longer contains §'Degree Recompute (scoped via vault_dirty_degrees)' heading", () => {
    const body = read(CLAUDE_MD);
    expect(body).not.toMatch(/Degree\s+Recompute\s+\(scoped\s+via\s+vault_dirty_degrees\)/);
  });

  test("CLAUDE.md introduces the new vault_ops-as-Audit-Log rule (per plan §PR3 step 5)", () => {
    const body = read(CLAUDE_MD);
    // Required new rule heading body content.
    expect(body).toMatch(/vault_ops\s+is\s+(the\s+)?Audit\s+Log/i);
    expect(body).toMatch(/vault_edges\s+is\s+(the\s+|a\s+)?Materialized\s+Cache/i);
  });

  test("CLAUDE.md introduces 'Degree Recompute (scoped via vault_ops since-ts)' or equivalent", () => {
    const body = read(CLAUDE_MD);
    expect(body).toMatch(/Degree\s+Recompute.+vault_ops/i);
  });
});

describe("PR3 §6 — Migration 0013", () => {
  test("Migration 0013_*.sql exists in workers/vault-mcp/migrations/", () => {
    expect(find0013()).not.toBeNull();
  });

  test("Migration 0013 drops vault_dirty_degrees", () => {
    const path = find0013();
    if (!path) {
      expect(path).not.toBeNull();
      return;
    }
    const body = readFileSync(path, "utf8");
    expect(body).toMatch(/DROP\s+TABLE\s+(IF\s+EXISTS\s+)?vault_dirty_degrees\b/i);
  });

  test("Migration 0013 bootstraps __last_degree_drain__ watermark from MAX(vault_ops.id)", () => {
    const path = find0013();
    if (!path) return;
    const body = readFileSync(path, "utf8");
    expect(body).toMatch(/__last_degree_drain__/);
    expect(body).toMatch(/MAX\s*\(\s*id\s*\)\s+FROM\s+vault_ops/i);
  });
});

describe("PR3 acceptance §grep-clean — sync_writer_lease and vault_dirty_degrees gone from source", () => {
  test("grep sync_writer_lease in workers/vault-mcp/src returns historical-comment-only refs", () => {
    const body = read(INDEX_TS);
    // Strict: no STRING LITERAL "sync_writer_lease" anywhere except the
    // SYNC_LEASE_KEY constant kept for read-back in vault_health stats
    // (the plan permits this — "meta key stays readable for operator
    // debugging"). Count occurrences of the bare string and require a
    // small, justifiable number.
    const matches = body.match(/sync_writer_lease/g) ?? [];
    // Tolerate at most 3 references (the SYNC_LEASE_KEY constant + at most
    // 2 historical-context comments). Anything more = stale code.
    expect(matches.length).toBeLessThanOrEqual(3);
  });

  test("grep vault_dirty_degrees in workers/vault-mcp/src returns zero refs (table is gone)", () => {
    const srcDir = resolve(REPO_ROOT, "workers/vault-mcp/src");
    let total = 0;
    function walk(d: string): void {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) {
          walk(resolve(d, e.name));
        } else if (e.name.endsWith(".ts")) {
          const body = readFileSync(resolve(d, e.name), "utf8");
          total += (body.match(/vault_dirty_degrees/g) ?? []).length;
        }
      }
    }
    walk(srcDir);
    expect(total).toBe(0);
  });
});

describe("PR3 §drainDegrees correctness (synthetic SQL exercise)", () => {
  // Verifies the plan's SQL pattern for the ops-derived dirty-path query.
  // Build a minimal in-memory schema, seed vault_ops + vault_edges, run
  // the query the plan specifies, assert correct dirty path set.
  test("ops-derived dirty paths query (plan §PR3 step 2 SQL) returns the right set", () => {
    const db = new Database(":memory:");
    db.run(`
      CREATE TABLE vault_ops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    // Seed: ops 1-2 are pre-watermark (sinceId = 2). ops 3-6 are dirty.
    db.run(`INSERT INTO vault_ops (op_type, payload_json) VALUES
      ('add_edge', '{"source":"a.md","target":"b.md","edge_type":"wikilink"}'),
      ('add_edge', '{"source":"c.md","target":"d.md","edge_type":"wikilink"}'),
      ('add_edge', '{"source":"e.md","target":"f.md","edge_type":"wikilink"}'),
      ('remove_edge', '{"source":"a.md","target":"b.md","edge_type":"wikilink"}'),
      ('upsert_node', '{"path":"g.md"}'),
      ('delete_node', '{"path":"h.md"}')
    `);
    const sinceId = 2;
    const snap = db
      .query("SELECT MAX(id) AS max_id FROM vault_ops WHERE id > ?")
      .get(sinceId) as { max_id: number | null };
    expect(snap.max_id).toBe(6);

    const rows = db
      .query(
        `
        SELECT DISTINCT json_extract(payload_json, '$.source') AS path FROM vault_ops
          WHERE id > ?1 AND id <= ?2 AND op_type IN ('add_edge', 'remove_edge')
        UNION
        SELECT DISTINCT json_extract(payload_json, '$.target') AS path FROM vault_ops
          WHERE id > ?1 AND id <= ?2 AND op_type IN ('add_edge', 'remove_edge')
        UNION
        SELECT DISTINCT json_extract(payload_json, '$.path') AS path FROM vault_ops
          WHERE id > ?1 AND id <= ?2 AND op_type IN ('upsert_node', 'delete_node')
        `,
      )
      .all(sinceId, snap.max_id) as Array<{ path: string }>;
    const paths = new Set(rows.map((r) => r.path).filter(Boolean));
    // Expected: e.md, f.md, a.md, b.md, g.md, h.md (post-watermark touches).
    expect(paths).toEqual(new Set(["e.md", "f.md", "a.md", "b.md", "g.md", "h.md"]));
  });
});
