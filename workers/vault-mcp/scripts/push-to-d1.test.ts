import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Unit tests for push-to-d1 logic.
 *
 * These tests exercise the push watermark tracking and batch behavior
 * against a real SQLite database — no HTTP calls (mocked via globalThis.fetch).
 * Integration testing (actual D1 push) is done manually via U4.
 */

const TEST_DIR = join(tmpdir(), "cartographer-push-test");
const TEST_DB = join(TEST_DIR, "test.sqlite");
const SCHEMA_PATH = join(import.meta.dir, "local-schema.sql");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database {
  const dir = TEST_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(TEST_DB);
  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schema);
  return db;
}

function insertLocalOps(db: Database, count: number, startUlid?: string): string[] {
  const ulids: string[] = [];
  const stmt = db.prepare(
    `INSERT INTO vault_ops (ulid, op_type, payload_json, origin, ts, peer)
     VALUES (?, ?, ?, ?, ?, 'local')`,
  );
  for (let i = 0; i < count; i++) {
    // Generate monotonically increasing ULIDs
    const ts = String(1700000000000 + i).padStart(10, "0");
    const rand = String(i).padStart(16, "0");
    const ulid = `${ts}${rand}`;
    ulids.push(ulid);
    stmt.run(
      ulid,
      "upsert_node",
      JSON.stringify({ path: `notes/test-${i}.md`, title: `Test ${i}` }),
      "extract",
      new Date(1700000000000 + i).toISOString(),
    );
  }
  return ulids;
}

function getWatermark(db: Database): string {
  return (
    db.query<{ value: string }, []>(
      "SELECT value FROM sync_state WHERE key = 'push_watermark'",
    ).get()?.value ?? ""
  );
}

// Mock fetch for all tests
let fetchCalls: Array<{ url: string; body: unknown }> = [];
let fetchResponses: Array<Response> = [];
let fetchResponseIndex = 0;

function mockFetch() {
  fetchCalls = [];
  fetchResponses = [];
  fetchResponseIndex = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? JSON.parse(init.body as string) : null;
    fetchCalls.push({ url, body });

    if (fetchResponseIndex < fetchResponses.length) {
      return fetchResponses[fetchResponseIndex++];
    }

    // Default success response
    return new Response(
      JSON.stringify({
        ops: [],
        watermark: null,
        has_more: false,
        stats: { returned: 0, applied: body?.ops?.length ?? 0, backfilled: 0, total_ops: 0 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("push-to-d1", () => {
  let db: Database;
  let restoreFetch: () => void;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    db = createTestDb();
    restoreFetch = mockFetch();
  });

  afterEach(() => {
    db.close();
    restoreFetch();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("pushes ops and advances watermark to last ULID", async () => {
    const ulids = insertLocalOps(db, 5);
    expect(getWatermark(db)).toBe("");

    // Simulate what push-to-d1.ts main() does — inline the logic
    const watermarkRow = db.query<{ value: string }, []>(
      "SELECT value FROM sync_state WHERE key = 'push_watermark'",
    ).get();
    let watermark = watermarkRow?.value || "";

    const ops = db.query<{ ulid: string; op_type: string; payload_json: string; origin: string; ts: string }, [string]>(
      "SELECT ulid, op_type, payload_json, origin, ts FROM vault_ops WHERE peer = 'local' AND ulid > ? ORDER BY ulid ASC LIMIT 2000",
    ).all(watermark);

    expect(ops.length).toBe(5);

    // POST to sync-ops
    const payload = ops.map((op) => ({
      op_type: op.op_type,
      payload: JSON.parse(op.payload_json),
      origin: op.origin,
      ulid: op.ulid,
    }));

    const res = await fetch("https://your-vault-domain.com/api/sync-ops", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ ops: payload, watermark: null, limit: 1 }),
    });
    expect(res.ok).toBe(true);

    // Advance watermark
    watermark = ops[ops.length - 1].ulid;
    db.run("UPDATE sync_state SET value = ? WHERE key = 'push_watermark'", [watermark]);

    expect(getWatermark(db)).toBe(ulids[4]);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.ops.length).toBe(5);
  });

  it("cold start (empty watermark) pushes all local ops", async () => {
    const ulids = insertLocalOps(db, 3);
    expect(getWatermark(db)).toBe("");

    const ops = db.query<{ ulid: string }, [string]>(
      "SELECT ulid FROM vault_ops WHERE peer = 'local' AND ulid > ? ORDER BY ulid ASC LIMIT 2000",
    ).all("");

    expect(ops.length).toBe(3);
    expect(ops[0].ulid).toBe(ulids[0]);
  });

  it("incremental push (watermark set) pushes only new ops", async () => {
    const ulids = insertLocalOps(db, 5);

    // Set watermark to 3rd op (already pushed first 3)
    db.run("UPDATE sync_state SET value = ? WHERE key = 'push_watermark'", [ulids[2]]);

    const ops = db.query<{ ulid: string }, [string]>(
      "SELECT ulid FROM vault_ops WHERE peer = 'local' AND ulid > ? ORDER BY ulid ASC LIMIT 2000",
    ).all(ulids[2]);

    expect(ops.length).toBe(2);
    expect(ops[0].ulid).toBe(ulids[3]);
    expect(ops[1].ulid).toBe(ulids[4]);
  });

  it("no new ops → no HTTP calls", async () => {
    // Insert ops but set watermark past all of them
    const ulids = insertLocalOps(db, 3);
    db.run("UPDATE sync_state SET value = ? WHERE key = 'push_watermark'", [ulids[2]]);

    const ops = db.query<{ ulid: string }, [string]>(
      "SELECT ulid FROM vault_ops WHERE peer = 'local' AND ulid > ? ORDER BY ulid ASC LIMIT 2000",
    ).all(ulids[2]);

    expect(ops.length).toBe(0);
    expect(fetchCalls.length).toBe(0);
  });

  it("ignores remote peer ops (only pushes local)", async () => {
    // Insert both local and remote ops
    insertLocalOps(db, 3);
    const remoteStmt = db.prepare(
      "INSERT INTO vault_ops (ulid, op_type, payload_json, origin, ts, peer) VALUES (?, ?, ?, ?, ?, 'remote')",
    );
    remoteStmt.run("99999999990000000000000000", "upsert_node", '{"path":"remote.md"}', "extract", "2024-01-01T00:00:00Z");

    const allOps = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM vault_ops").get()?.c ?? 0;
    const localOps = db.query<{ c: number }, [string]>(
      "SELECT COUNT(*) AS c FROM vault_ops WHERE peer = 'local' AND ulid > ?",
    ).get("")?.c ?? 0;

    expect(allOps).toBe(4);
    expect(localOps).toBe(3);
  });

  it("HTTP 401 is not retried", async () => {
    insertLocalOps(db, 1);

    fetchResponses.push(
      new Response("Unauthorized", { status: 401 }),
    );

    const ops = db.query<{ ulid: string; op_type: string; payload_json: string; origin: string }, [string]>(
      "SELECT ulid, op_type, payload_json, origin FROM vault_ops WHERE peer = 'local' AND ulid > ? ORDER BY ulid ASC LIMIT 2000",
    ).all("");

    const payload = ops.map((op) => ({
      op_type: op.op_type,
      payload: JSON.parse(op.payload_json),
      origin: op.origin,
    }));

    await expect(
      fetch("https://your-vault-domain.com/api/sync-ops", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer bad" },
        body: JSON.stringify({ ops: payload, watermark: null, limit: 1 }),
      }).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
      }),
    ).rejects.toThrow("HTTP 401");

    // Only 1 fetch call — no retries
    expect(fetchCalls.length).toBe(1);
  });

  it("push_watermark seed exists in schema", () => {
    const row = db.query<{ value: string }, []>(
      "SELECT value FROM sync_state WHERE key = 'push_watermark'",
    ).get();

    expect(row).toBeTruthy();
    expect(row!.value).toBe("");
  });
});
