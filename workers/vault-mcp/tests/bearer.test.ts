import { describe, expect, test } from "bun:test";
import { verifyBearer } from "../src/auth/bearer";

function mkReq(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers["Authorization"] = authHeader;
  return new Request("http://localhost/api/test", { headers });
}

describe("verifyBearer", () => {
  const secret = "my-test-secret";

  test("missing Authorization header → false", async () => {
    expect(await verifyBearer(mkReq(), secret)).toBe(false);
  });

  test("wrong prefix (no 'Bearer ') → false", async () => {
    expect(await verifyBearer(mkReq("Token my-test-secret"), secret)).toBe(false);
  });

  test("0-byte token (empty after 'Bearer ') → false (no throw)", async () => {
    expect(await verifyBearer(mkReq("Bearer "), secret)).toBe(false);
  });

  test("100KB token → false (no throw)", async () => {
    const bigToken = "x".repeat(100 * 1024);
    expect(await verifyBearer(mkReq(`Bearer ${bigToken}`), secret)).toBe(false);
  });

  test("correct token → true", async () => {
    expect(await verifyBearer(mkReq(`Bearer ${secret}`), secret)).toBe(true);
  });

  test("wrong token same length → false", async () => {
    const wrongSameLen = "x".repeat(secret.length);
    expect(await verifyBearer(mkReq(`Bearer ${wrongSameLen}`), secret)).toBe(false);
  });

  // Regression: round-21 empty-secret bypass. Pre-fix, verifyBearer hashed
  // both sides unconditionally. If SHARED_SECRET was deployed as "", an
  // attacker sending `Authorization: Bearer ` (empty candidate) hashed the
  // same "" value → timingSafeEqual returned true → auth bypass.
  test("empty secret + empty candidate → false (round-21 regression)", async () => {
    expect(await verifyBearer(mkReq("Bearer "), "")).toBe(false);
  });

  test("empty secret + any candidate → false", async () => {
    expect(await verifyBearer(mkReq("Bearer anything"), "")).toBe(false);
  });

  test("undefined secret → false (graceful, not thrown)", async () => {
    expect(await verifyBearer(mkReq("Bearer anything"), undefined)).toBe(false);
  });

  test("null secret → false", async () => {
    expect(await verifyBearer(mkReq("Bearer anything"), null)).toBe(false);
  });
});
