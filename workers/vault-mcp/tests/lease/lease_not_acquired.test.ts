/**
 * lease_not_acquired.test.ts
 *
 * Tier A PR3 — sync_writer_lease retired from writer paths.
 *
 * Plan: docs/plans/2026-04-23-001-cartographer-op-log-tier-a-plan.md (r8) §PR3.
 *
 * Acceptance: writer paths complete WITHOUT acquiring sync_writer_lease.
 * The meta key remains readable for operator debugging — writers neither
 * read nor write it.
 *
 * Pre-write per chief-of-staff TDD-strict discipline. Implementing
 * agent makes this pass without modifying this file.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const INDEX_TS = resolve(import.meta.dir, "../../src/index.ts");

function read(): string {
  if (!existsSync(INDEX_TS)) throw new Error(`missing: ${INDEX_TS}`);
  return readFileSync(INDEX_TS, "utf8");
}

describe("Tier A PR3 — lease retirement (writer-paths-do-not-acquire-lease)", () => {
  test("acquireSyncWriterLease function is removed from production code", () => {
    const body = read();
    expect(body).not.toMatch(/^async\s+function\s+acquireSyncWriterLease\b/m);
  });

  test("no writer path calls acquireSyncWriterLease()", () => {
    const body = read();
    expect(body).not.toMatch(/await\s+acquireSyncWriterLease\s*\(/);
    expect(body).not.toMatch(/=\s*acquireSyncWriterLease\s*\(/);
  });

  test("no INSERT or UPDATE on meta where key='sync_writer_lease'", () => {
    const body = read();
    // The lease was written via INSERT INTO meta ... key='sync_writer_lease'
    // OR UPDATE meta SET ... WHERE key='sync_writer_lease'. Both forms must
    // disappear from production code.
    expect(body).not.toMatch(/INSERT\s+INTO\s+meta[^;]*sync_writer_lease/i);
    expect(body).not.toMatch(/UPDATE\s+meta[^;]*sync_writer_lease/i);
    expect(body).not.toMatch(/REPLACE\s+INTO\s+meta[^;]*sync_writer_lease/i);
  });

  test("syncGraph entry no longer rejects with HTTP 503 lease_held", () => {
    const body = read();
    expect(body).not.toMatch(/leaseHeldResponse\s*\(/);
    // Scope to error-payload usage so the cron-lease status enum
    // (`status: "lease_held"` in runBodyBackfillSlice — unrelated
    // feature, plan-E2) does not collide.
    expect(body).not.toMatch(/error:\s*"lease_held"/);
  });

  test("ingest_triples handler no longer checks lease state", () => {
    const body = read();
    // The two writer paths (syncGraph + ingest_triples) historically each
    // acquired the lease. Post-PR3 neither does.
    const ingestStart = body.indexOf("/api/ingest-triples");
    if (ingestStart < 0) {
      // endpoint may have moved — just assert lease checks gone globally
      return;
    }
    const ingestSlice = body.slice(ingestStart, ingestStart + 5000);
    expect(ingestSlice).not.toMatch(/acquireSyncWriterLease/);
    expect(ingestSlice).not.toMatch(/lease_held/);
  });
});
