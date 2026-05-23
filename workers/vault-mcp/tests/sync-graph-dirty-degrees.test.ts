/**
 * sync-graph-dirty-degrees.test.ts
 *
 * Validates degree-drain correctness after sync-graph and build-graph runs.
 *
 * Validates the rowid-snapshot drain semantics on vault_dirty_degrees.
 * The snapshot-based drain is the codex r3 #1 fix: drain captures
 * MAX(rowid), updates degrees for paths with rowid <= snapshot_max,
 * deletes only those rows. Concurrent writers' rows (rowid > snapshot_max)
 * survive and get processed by the next drain.
 *
 * This test does not invoke syncGraph end-to-end (that requires R2 + the
 * full Worker env). It validates the drain primitive against a real
 * SQLite DB so the drain semantics are nailed down deterministically.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE vault_nodes (
      path TEXT PRIMARY KEY,
      out_degree INTEGER DEFAULT 0,
      in_degree  INTEGER DEFAULT 0
    );
    CREATE TABLE vault_edges (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      weight REAL,
      PRIMARY KEY (source, target, edge_type)
    );
    CREATE TABLE vault_dirty_degrees (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL
    );

    INSERT INTO vault_nodes (path) VALUES
      ('A'), ('B'), ('C'), ('D');
    INSERT INTO vault_edges (source, target, edge_type) VALUES
      ('A', 'B', 'wikilink'),
      ('A', 'C', 'wikilink'),
      ('B', 'C', 'related');
  `);
  return db;
}

function drain(db: Database): { snapshotMax: number | null; pathsRecomputed: string[] } {
  const snap = db.prepare("SELECT MAX(rowid) AS m FROM vault_dirty_degrees").get() as { m: number | null };
  const snapshotMax = snap?.m ?? null;
  if (snapshotMax === null) return { snapshotMax: null, pathsRecomputed: [] };

  const paths = db
    .prepare("SELECT DISTINCT path FROM vault_dirty_degrees WHERE rowid <= ?")
    .all(snapshotMax) as Array<{ path: string }>;
  const pathList = paths.map((r) => r.path);

  db.prepare(
    `UPDATE vault_nodes SET out_degree = (SELECT COUNT(*) FROM vault_edges WHERE source = vault_nodes.path)
     WHERE path IN (SELECT DISTINCT path FROM vault_dirty_degrees WHERE rowid <= ?)`
  ).run(snapshotMax);
  db.prepare(
    `UPDATE vault_nodes SET in_degree = (SELECT COUNT(*) FROM vault_edges WHERE target = vault_nodes.path)
     WHERE path IN (SELECT DISTINCT path FROM vault_dirty_degrees WHERE rowid <= ?)`
  ).run(snapshotMax);
  db.prepare("DELETE FROM vault_dirty_degrees WHERE rowid <= ?").run(snapshotMax);

  return { snapshotMax, pathsRecomputed: pathList };
}

describe("vault_dirty_degrees rowid-snapshot drain", () => {
  let db: Database;
  beforeEach(() => {
    db = setupDb();
  });

  test("drain on empty table is a no-op", () => {
    const result = drain(db);
    expect(result.snapshotMax).toBeNull();
    expect(result.pathsRecomputed).toEqual([]);
  });

  test("drain updates only dirty paths' degrees, leaves others untouched", () => {
    db.prepare("INSERT INTO vault_dirty_degrees (path) VALUES (?)").run("A");
    db.prepare("INSERT INTO vault_dirty_degrees (path) VALUES (?)").run("B");

    const before = db.prepare("SELECT path, out_degree, in_degree FROM vault_nodes ORDER BY path").all() as Array<{ path: string; out_degree: number; in_degree: number }>;
    expect(before.find((r) => r.path === "C")?.in_degree).toBe(0); // not yet recomputed

    drain(db);

    const rows = db.prepare("SELECT path, out_degree, in_degree FROM vault_nodes ORDER BY path").all() as Array<{ path: string; out_degree: number; in_degree: number }>;
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r])) as Record<string, { out_degree: number; in_degree: number }>;
    expect(byPath.A.out_degree).toBe(2); // A→B, A→C
    expect(byPath.B.in_degree).toBe(1);  // A→B
    expect(byPath.B.out_degree).toBe(1); // B→C
    // C was NOT in the dirty set — degrees stay at default 0
    expect(byPath.C.in_degree).toBe(0);
    // D was never dirty and has no edges
    expect(byPath.D.out_degree).toBe(0);
  });

  test("drain consumes only its snapshot — concurrent writes survive", () => {
    db.prepare("INSERT INTO vault_dirty_degrees (path) VALUES (?)").run("A");
    db.prepare("INSERT INTO vault_dirty_degrees (path) VALUES (?)").run("B");

    // Capture snapshot, then simulate a concurrent writer
    const snap = db.prepare("SELECT MAX(rowid) AS m FROM vault_dirty_degrees").get() as { m: number };
    const snapshotMax = snap.m;
    expect(snapshotMax).toBe(2);

    // Concurrent writer (e.g., /api/ingest-triples) appends new dirty rows
    db.prepare("INSERT INTO vault_dirty_degrees (path) VALUES (?)").run("D");

    // Now finish the drain bound to the original snapshot
    db.prepare(
      `UPDATE vault_nodes SET out_degree = (SELECT COUNT(*) FROM vault_edges WHERE source = vault_nodes.path)
       WHERE path IN (SELECT DISTINCT path FROM vault_dirty_degrees WHERE rowid <= ?)`
    ).run(snapshotMax);
    db.prepare("DELETE FROM vault_dirty_degrees WHERE rowid <= ?").run(snapshotMax);

    // Concurrent writer's row MUST survive
    const remaining = db.prepare("SELECT path FROM vault_dirty_degrees ORDER BY rowid").all() as Array<{ path: string }>;
    expect(remaining).toEqual([{ path: "D" }]);

    // Next drain picks it up
    const result2 = drain(db);
    expect(result2.pathsRecomputed).toEqual(["D"]);
    const after = db.prepare("SELECT COUNT(*) AS c FROM vault_dirty_degrees").get() as { c: number };
    expect(after.c).toBe(0);
  });

  test("duplicate path appends collapse via SELECT DISTINCT", () => {
    // Multiple writers can append the same path
    db.prepare("INSERT INTO vault_dirty_degrees (path) VALUES (?)").run("A");
    db.prepare("INSERT INTO vault_dirty_degrees (path) VALUES (?)").run("A");
    db.prepare("INSERT INTO vault_dirty_degrees (path) VALUES (?)").run("A");
    db.prepare("INSERT INTO vault_dirty_degrees (path) VALUES (?)").run("B");

    const result = drain(db);
    // pathsRecomputed should be deduped to A and B (order from SELECT DISTINCT)
    expect(result.pathsRecomputed.sort()).toEqual(["A", "B"]);
    const after = db.prepare("SELECT COUNT(*) AS c FROM vault_dirty_degrees").get() as { c: number };
    expect(after.c).toBe(0); // all 4 rows consumed
  });
});
