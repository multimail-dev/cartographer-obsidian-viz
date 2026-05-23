import { describe, it, expect } from "bun:test";
import { ulid } from "../src/ulid";

describe("ULID generation", () => {
  it("produces 26-character string", () => {
    const id = ulid();
    expect(id).toHaveLength(26);
  });

  it("uses only Crockford base32 characters", () => {
    const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/;
    for (let i = 0; i < 100; i++) {
      expect(ulid()).toMatch(CROCKFORD);
    }
  });

  it("is unique across calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(ulid());
    }
    expect(ids.size).toBe(1000);
  });

  it("preserves chronological order via timestamp prefix", () => {
    const earlier = ulid(1000000);
    const later = ulid(2000000);
    // ULID encodes timestamp in first 10 chars — earlier timestamp sorts lower
    expect(earlier.slice(0, 10) < later.slice(0, 10)).toBe(true);
  });

  it("seedTime overrides Date.now()", () => {
    const fixedTime = 1700000000000; // known epoch
    const id1 = ulid(fixedTime);
    const id2 = ulid(fixedTime);
    // Same timestamp prefix, different random suffix
    expect(id1.slice(0, 10)).toBe(id2.slice(0, 10));
    expect(id1.slice(10)).not.toBe(id2.slice(10));
  });

  it("encodes epoch 0 correctly (all zeros in timestamp)", () => {
    const id = ulid(0);
    expect(id.slice(0, 10)).toBe("0000000000");
  });
});
