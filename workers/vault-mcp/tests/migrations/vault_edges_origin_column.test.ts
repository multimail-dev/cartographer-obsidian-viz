import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// cwd-independent path to the migration (matches pattern at tests/digest-wiki-exemption.test.ts:27)
const MIGRATION_0012 = join(__dirname, "..", "..", "migrations", "0012_tier_a_op_log.sql");

function setupDb(): Database {
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
      edge_type TEXT NOT NULL CHECK (edge_type IN ('wikilink', 'related', 'folder', 'temporal', 'tag_cooccurrence')),
      weight REAL DEFAULT 1.0,
      created_at TEXT DEFAULT (datetime('now')),
      ingest_run_id TEXT,
      UNIQUE(source, target, edge_type)
    );

    INSERT INTO vault_nodes (path, title, note_type, folder, tags, size, modified_at, content_hash) VALUES
      ('Notes/A', 'A', 'note', 'Notes', '[]', 1, '2026-04-23T00:00:00.000Z', 'hash-a');

    INSERT INTO vault_edges (source, target, edge_type, weight, ingest_run_id) VALUES
      ('Notes/A', 'Notes/B', 'wikilink', 1.0, 'sync-1'),
      ('Notes/A', 'Entity/C', 'related', 1.5, NULL),
      ('Notes/A', 'Notes/D', 'folder', 0.5, NULL);
  `);
  return db;
}

function applyMigration(db: Database) {
  const sql = readFileSync(MIGRATION_0012, "utf8");
  db.exec(sql);
}

describe("0012 vault_edges origin rebuild", () => {
  test("adds origin, widens uniqueness, and backfills origins", () => {
    const db = setupDb();
    applyMigration(db);

    const columns = db.query("PRAGMA table_info(vault_edges)").all() as Array<{ name: string }>;
    expect(columns.some((col) => col.name === "origin")).toBe(true);

    const rows = db.query(
      "SELECT source, target, edge_type, origin FROM vault_edges ORDER BY id",
    ).all() as Array<{ source: string; target: string; edge_type: string; origin: string }>;
    expect(rows).toEqual([
      { source: "Notes/A", target: "Notes/B", edge_type: "wikilink", origin: "extract" },
      { source: "Notes/A", target: "Entity/C", edge_type: "related", origin: "ingest_triples" },
      { source: "Notes/A", target: "Notes/D", edge_type: "folder", origin: "finalize" },
    ]);

    db.query(
      "INSERT INTO vault_edges (source, target, edge_type, weight, ingest_run_id, origin) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("Notes/A", "Notes/B", "wikilink", 1, null, "ingest_triples");
    const count = db.query(
      "SELECT COUNT(*) AS c FROM vault_edges WHERE source = 'Notes/A' AND target = 'Notes/B' AND edge_type = 'wikilink'",
    ).get() as { c: number };
    expect(count.c).toBe(2);
  });
});
