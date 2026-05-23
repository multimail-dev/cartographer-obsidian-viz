/**
 * no_dirty_table.test.ts
 *
 * Tier A PR3 — vault_dirty_degrees retired in favor of ops-derived
 * dirty-path query (drainDegrees() reading vault_ops since-watermark).
 *
 * Plan: docs/plans/2026-04-23-001-cartographer-op-log-tier-a-plan.md (r8) §PR3.
 *
 * Acceptance:
 *   1. Production code no longer references vault_dirty_degrees.
 *   2. drainDegrees() function exists in index.ts and uses vault_ops
 *      with __last_degree_drain__ watermark.
 *   3. The watermark-bounded SQL pattern produces the right dirty paths.
 *   4. Migration 0013 drops vault_dirty_degrees + bootstraps the watermark.
 *
 * Pre-write per chief-of-staff TDD-strict discipline. Implementing
 * agent makes this pass without modifying this file.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";

const SRC_DIR = resolve(import.meta.dir, "../../src");
const MIGRATIONS_DIR = resolve(import.meta.dir, "../../migrations");
const INDEX_TS = resolve(SRC_DIR, "index.ts");

function read(p: string): string {
  if (!existsSync(p)) throw new Error(`missing: ${p}`);
  return readFileSync(p, "utf8");
}

function find0013(): string | null {
  if (!existsSync(MIGRATIONS_DIR)) return null;
  for (const e of readdirSync(MIGRATIONS_DIR)) {
    if (e.startsWith("0013_") && e.endsWith(".sql")) return resolve(MIGRATIONS_DIR, e);
  }
  return null;
}

describe("Tier A PR3 — drainDegrees replaces vault_dirty_degrees", () => {
  test("drainDegrees() function defined in index.ts", () => {
    const body = read(INDEX_TS);
    expect(body).toMatch(/^async\s+function\s+drainDegrees\b/m);
  });

  test("drainDirtyDegrees() function removed from index.ts", () => {
    const body = read(INDEX_TS);
    expect(body).not.toMatch(/^async\s+function\s+drainDirtyDegrees\b/m);
  });

  test("zero references to vault_dirty_degrees in workers/vault-mcp/src/**/*.ts", () => {
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
    walk(SRC_DIR);
    expect(total).toBe(0);
  });

  test("drainDegrees uses __last_degree_drain__ watermark and vault_ops", () => {
    const body = read(INDEX_TS);
    const start = body.indexOf("async function drainDegrees");
    expect(start).toBeGreaterThan(-1);
    const slice = body.slice(start, start + 4000);
    expect(slice).toMatch(/__last_degree_drain__/);
    expect(slice).toMatch(/vault_ops/);
    expect(slice).toMatch(/MAX\s*\(\s*id\s*\)/i);
  });
});

describe("Tier A PR3 — Migration 0013 retires the table", () => {
  test("Migration 0013_*.sql exists", () => {
    expect(find0013()).not.toBeNull();
  });

  test("Migration 0013 contains DROP TABLE for vault_dirty_degrees", () => {
    const path = find0013();
    if (!path) return;
    const body = readFileSync(path, "utf8");
    expect(body).toMatch(/DROP\s+TABLE\s+(IF\s+EXISTS\s+)?vault_dirty_degrees\b/i);
  });

  test("Migration 0013 stamps __last_degree_drain__ from MAX(vault_ops.id)", () => {
    const path = find0013();
    if (!path) return;
    const body = readFileSync(path, "utf8");
    expect(body).toMatch(/__last_degree_drain__/);
    expect(body).toMatch(/MAX\s*\(\s*id\s*\)\s+FROM\s+vault_ops/i);
  });
});

describe("Tier A PR3 — drainDegrees SQL pattern correctness on fresh schema (no vault_dirty_degrees)", () => {
  test("ops-derived dirty paths query produces correct degree updates without vault_dirty_degrees", () => {
    const db = new Database(":memory:");
    // Fresh post-PR3 schema: vault_dirty_degrees does NOT exist.
    db.run(`
      CREATE TABLE vault_nodes (
        path TEXT PRIMARY KEY,
        title TEXT,
        note_type TEXT,
        folder TEXT,
        tags TEXT,
        size INTEGER,
        modified_at TEXT,
        indexed_at TEXT,
        out_degree INTEGER DEFAULT 0,
        in_degree INTEGER DEFAULT 0
      );
      CREATE TABLE vault_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        origin TEXT NOT NULL,
        weight REAL,
        ingest_run_id TEXT,
        created_at TEXT
      );
      CREATE TABLE vault_ops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ulid TEXT,
        op_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX idx_vault_ops_ulid ON vault_ops (ulid) WHERE ulid IS NOT NULL;
    `);
    // Seed nodes + edges.
    db.run(`INSERT INTO vault_nodes (path, title, tags, size, modified_at, indexed_at) VALUES
      ('a.md', 'A', '[]', 0, '', ''),
      ('b.md', 'B', '[]', 0, '', ''),
      ('c.md', 'C', '[]', 0, '', ''),
      ('__last_degree_drain__', 'degree_drain', '[]', 0, '', '')
    `);
    db.run(`INSERT INTO vault_edges (source, target, edge_type, origin) VALUES
      ('a.md', 'b.md', 'wikilink', 'extract'),
      ('a.md', 'c.md', 'wikilink', 'extract'),
      ('b.md', 'c.md', 'wikilink', 'extract')
    `);
    // Seed corresponding vault_ops at ids 1-3.
    db.run(`INSERT INTO vault_ops (op_type, payload_json) VALUES
      ('add_edge', '{"source":"a.md","target":"b.md","edge_type":"wikilink","origin":"extract"}'),
      ('add_edge', '{"source":"a.md","target":"c.md","edge_type":"wikilink","origin":"extract"}'),
      ('add_edge', '{"source":"b.md","target":"c.md","edge_type":"wikilink","origin":"extract"}')
    `);

    // Drain from sinceId=0: all paths a, b, c are dirty.
    const sinceId = 0;
    const snap = db
      .query("SELECT MAX(id) AS max_id FROM vault_ops WHERE id > ?")
      .get(sinceId) as { max_id: number | null };
    expect(snap.max_id).toBe(3);

    const dirty = db
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
    const dirtyPaths = new Set(dirty.map((r) => r.path).filter(Boolean));
    expect(dirtyPaths).toEqual(new Set(["a.md", "b.md", "c.md"]));

    // Apply scoped recompute for each dirty path.
    for (const p of dirtyPaths) {
      db.run(
        "UPDATE vault_nodes SET out_degree = (SELECT COUNT(*) FROM vault_edges WHERE source = ?), in_degree = (SELECT COUNT(*) FROM vault_edges WHERE target = ?) WHERE path = ?",
        [p, p, p],
      );
    }
    // Stamp the watermark.
    db.run(
      "INSERT OR REPLACE INTO vault_nodes (path, title, note_type, folder, tags, size, modified_at, indexed_at) VALUES ('__last_degree_drain__', 'degree_drain', null, '', '[]', ?, '', datetime('now'))",
      [snap.max_id],
    );

    // Verify degrees correct.
    const a = db.query("SELECT out_degree, in_degree FROM vault_nodes WHERE path = 'a.md'").get() as {
      out_degree: number;
      in_degree: number;
    };
    expect(a).toEqual({ out_degree: 2, in_degree: 0 });
    const c = db.query("SELECT out_degree, in_degree FROM vault_nodes WHERE path = 'c.md'").get() as {
      out_degree: number;
      in_degree: number;
    };
    expect(c).toEqual({ out_degree: 0, in_degree: 2 });

    // Verify watermark advanced.
    const wm = db
      .query("SELECT size FROM vault_nodes WHERE path = '__last_degree_drain__'")
      .get() as { size: number };
    expect(wm.size).toBe(3);
  });
});
