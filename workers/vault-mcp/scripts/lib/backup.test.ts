import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backupLocalDb } from "./backup";

const TEST_DIR = join(tmpdir(), "cartographer-backup-test");

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

function createTestDb(path: string, rowCount: number = 10): void {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE test_data (id INTEGER PRIMARY KEY, value TEXT)");
  const stmt = db.prepare("INSERT INTO test_data (value) VALUES (?)");
  for (let i = 0; i < rowCount; i++) {
    stmt.run(`row-${i}`);
  }
  db.close();
}

describe("backupLocalDb", () => {
  it("creates a valid, queryable backup with same row count", async () => {
    const srcPath = join(TEST_DIR, "source.sqlite");
    createTestDb(srcPath, 25);

    const backupPath = await backupLocalDb(srcPath);

    expect(existsSync(backupPath)).toBe(true);
    expect(backupPath).toBe(`${srcPath}.bak`);

    // Verify the backup is a valid SQLite database with correct data
    const backupDb = new Database(backupPath, { readonly: true });
    const count = backupDb.query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM test_data",
    ).get()?.c;
    backupDb.close();

    expect(count).toBe(25);
  });

  it("overwrites existing .bak file without error", async () => {
    const srcPath = join(TEST_DIR, "source.sqlite");
    createTestDb(srcPath, 5);

    // First backup
    const path1 = await backupLocalDb(srcPath);
    expect(existsSync(path1)).toBe(true);

    // Add more rows to source
    const db = new Database(srcPath);
    db.exec("INSERT INTO test_data (value) VALUES ('extra')");
    db.close();

    // Second backup overwrites
    const path2 = await backupLocalDb(srcPath);
    expect(path2).toBe(path1);

    // Verify updated data
    const backupDb = new Database(path2, { readonly: true });
    const count = backupDb.query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM test_data",
    ).get()?.c;
    backupDb.close();

    expect(count).toBe(6);
  });

  it("accepts custom backup path", async () => {
    const srcPath = join(TEST_DIR, "source.sqlite");
    const customPath = join(TEST_DIR, "custom-backup", "my.bak");
    createTestDb(srcPath, 3);

    const result = await backupLocalDb(srcPath, customPath);

    expect(result).toBe(customPath);
    expect(existsSync(customPath)).toBe(true);

    const backupDb = new Database(customPath, { readonly: true });
    const count = backupDb.query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM test_data",
    ).get()?.c;
    backupDb.close();

    expect(count).toBe(3);
  });

  it("throws descriptive error for nonexistent DB path", async () => {
    const fakePath = join(TEST_DIR, "does-not-exist.sqlite");

    await expect(backupLocalDb(fakePath)).rejects.toThrow(
      /Cannot backup: database does not exist/,
    );
  });
});
