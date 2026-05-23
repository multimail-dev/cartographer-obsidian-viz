import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Path relative to this test file so it works from any cwd (repo root,
// workers/vault-mcp/, etc.). Matches existing tests at tests/*.ts using __dirname.
const MIGRATION_0012 = join(__dirname, "..", "..", "migrations", "0012_tier_a_op_log.sql");

function setupPre0012Db(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE vault_nodes (
      path TEXT PRIMARY KEY,
      title TEXT,
      note_type TEXT,
      folder TEXT,
      tags TEXT,
      aliases TEXT DEFAULT '[]',
      size INTEGER DEFAULT 0,
      modified_at TEXT,
      indexed_at TEXT DEFAULT (datetime('now')),
      content_hash TEXT
    );

    CREATE TABLE vault_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      edge_type TEXT NOT NULL CHECK (edge_type IN ('wikilink', 'related', 'folder')),
      weight REAL DEFAULT 1.0,
      created_at TEXT DEFAULT (datetime('now')),
      ingest_run_id TEXT,
      UNIQUE(source, target, edge_type)
    );

    INSERT INTO vault_nodes (path, title, note_type, folder, tags, aliases, size, modified_at, content_hash) VALUES
      ('Notes/A', 'A', 'note', 'Notes', '[]', '[]', 123, '2026-04-23T00:00:00.000Z', 'hash-a');

    INSERT INTO vault_edges (source, target, edge_type, weight, ingest_run_id) VALUES
      ('Notes/A', 'Notes/B', 'wikilink', 1.0, 'sync-1'),
      ('Notes/A', 'Entity/C', 'related', 1.5, NULL),
      ('Notes/A', 'Notes/D', 'folder', 0.5, NULL);
  `);
  return db;
}

function apply0012(db: Database) {
  const sql = readFileSync(MIGRATION_0012, "utf8");
  db.exec(sql);
}

describe("0012_tier_a_op_log schema", () => {
  test("creates vault_ops with indexes and backfilled rows", () => {
    const db = setupPre0012Db();
    apply0012(db);

    const tableSql = db.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vault_ops'",
    ).get() as { sql: string };
    expect(tableSql.sql).toContain("CHECK (op_type IN ('add_edge', 'remove_edge', 'upsert_node', 'delete_node'))");
    expect(tableSql.sql).toContain("CHECK (origin IN ('extract', 'ingest_triples', 'finalize', 'phantom_rewrite', 'migration'))");

    const indexes = db.query(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'vault_ops' ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual([
      "idx_vault_ops_origin_ts",
      "idx_vault_ops_ts",
    ]);

    const opCounts = db.query(
      "SELECT op_type, COUNT(*) AS c FROM vault_ops GROUP BY op_type ORDER BY op_type",
    ).all() as Array<{ op_type: string; c: number }>;
    expect(opCounts).toEqual([
      { op_type: "add_edge", c: 3 },
      { op_type: "upsert_node", c: 1 },
    ]);
  });
});
