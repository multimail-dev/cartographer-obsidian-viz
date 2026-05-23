/**
 * verifier_endpoint_centralized_auth.test.ts
 *
 * L2 PR1 — verification artifact for Sharp Directive 3 ("Before you commit
 * any comment claiming a code behavior, read the code body and verify the
 * claim word for word").
 *
 * The verifier route handler in src/index.ts contains an `AUTH:` comment
 * claiming the new GET /api/verify-cache-coherence endpoint inherits
 * bearer-auth from the CENTRALIZED `verifyBearer()` gate at the top of the
 * /api/* path. This test verifies that claim against the actual code body:
 *
 *   1. The centralized auth comment appears in the file.
 *   2. The verifier route comes AFTER the centralized auth (so the gate
 *      runs first).
 *   3. The verifier route does NOT call verifyBearer() itself (so it's not
 *      double-checking — and not bypassing).
 *
 * If any of these break (someone moves the gate, removes the centralized
 * check, or adds a per-handler bearer call), this test fails — closing the
 * "comments rot" failure mode at commit time.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const INDEX_TS = resolve(import.meta.dir, "../../src/index.ts");

function read(p: string): string {
  if (!existsSync(p)) throw new Error(`missing: ${p}`);
  return readFileSync(p, "utf8");
}

describe("L2 PR1 — verifier endpoint inherits centralized bearer-auth", () => {
  test("centralized auth comment exists exactly once in src/index.ts", () => {
    const body = read(INDEX_TS);
    const matches = body.match(/All \/api\/\* endpoints — centralized auth/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test("verifier route appears AFTER the centralized auth comment", () => {
    const body = read(INDEX_TS);
    const authIdx = body.indexOf("All /api/* endpoints — centralized auth");
    const routeIdx = body.indexOf('url.pathname === "/api/verify-cache-coherence"');
    expect(authIdx).toBeGreaterThan(-1);
    expect(routeIdx).toBeGreaterThan(-1);
    expect(routeIdx).toBeGreaterThan(authIdx);
  });

  test("verifier route handler does NOT re-call verifyBearer()", () => {
    const body = read(INDEX_TS);
    const routeIdx = body.indexOf('url.pathname === "/api/verify-cache-coherence"');
    expect(routeIdx).toBeGreaterThan(-1);
    // Slice from the route signature to the end of its handler block.
    // The handler is small (~12 lines); slicing 600 chars covers it with margin.
    const handlerSlice = body.slice(routeIdx, routeIdx + 1200);
    expect(handlerSlice).not.toMatch(/verifyBearer\s*\(/);
  });

  test("centralized gate uses verifyBearer + 401 response (not stale comment)", () => {
    const body = read(INDEX_TS);
    const authIdx = body.indexOf("All /api/* endpoints — centralized auth");
    expect(authIdx).toBeGreaterThan(-1);
    // Slice forward enough to capture the auth block (~10 lines).
    const gateSlice = body.slice(authIdx, authIdx + 800);
    expect(gateSlice).toMatch(/verifyBearer\s*\(\s*request\s*,\s*env\.SHARED_SECRET\s*\)/);
    expect(gateSlice).toMatch(/status:\s*401/);
  });
});
