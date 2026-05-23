/**
 * fts-sanitize.test.ts — Tests for the FTS5 query sanitizer.
 *
 * Covers:
 *   - Historical failures (hyphens, colons, dates)
 *   - Boolean operators (AND/OR/NOT — case-sensitive)
 *   - Column qualifiers (case-insensitive, with negation)
 *   - Prefix star preservation
 *   - Advanced-syntax bypass (^, space-padded +, NEAR(), {brace sets})
 *   - Tokens containing + (C++, A+B — quoted, not bypassed)
 *   - Edge cases (empty, whitespace, unbalanced quotes)
 *   - Env-var seam bypass expectation
 */

import { describe, expect, test } from "bun:test";
import { sanitizeFtsQuery } from "../src/fts-sanitize";

const COLUMNS = new Set(["path", "title", "content", "tags"]);

describe("sanitizeFtsQuery", () => {
  // ───── Historical failures ─────
  describe("historical failures", () => {
    test("fine-tune adapter LoRA distill", () => {
      expect(sanitizeFtsQuery("fine-tune adapter LoRA distill", COLUMNS))
        .toBe('"fine-tune" adapter LoRA distill');
    });

    test("2026-04-25 (date)", () => {
      expect(sanitizeFtsQuery("2026-04-25", COLUMNS))
        .toBe('"2026-04-25"');
    });

    test("created:2026-04-2* (fake column + date + prefix)", () => {
      expect(sanitizeFtsQuery("created:2026-04-2*", COLUMNS))
        .toBe('"created:2026-04-2"*');
    });

    test("off-policy reinforcement", () => {
      expect(sanitizeFtsQuery("off-policy reinforcement", COLUMNS))
        .toBe('"off-policy" reinforcement');
    });

    test("fine-tune AND off-policy", () => {
      expect(sanitizeFtsQuery("fine-tune AND off-policy", COLUMNS))
        .toBe('"fine-tune" AND "off-policy"');
    });
  });

  // ───── Already-quoted passthrough ─────
  describe("quoted phrases", () => {
    test("already-quoted phrase passes through", () => {
      expect(sanitizeFtsQuery('"exact phrase"', COLUMNS))
        .toBe('"exact phrase"');
    });

    test("quoted phrase with trailing star", () => {
      expect(sanitizeFtsQuery('"fine-tune"*', COLUMNS))
        .toBe('"fine-tune"*');
    });

    test("mixed quoted and bare", () => {
      expect(sanitizeFtsQuery('"exact phrase" AND bare', COLUMNS))
        .toBe('"exact phrase" AND bare');
    });

    test("unbalanced quote closes at end", () => {
      expect(sanitizeFtsQuery('"unclosed phrase', COLUMNS))
        .toBe('"unclosed phrase"');
    });
  });

  // ───── Boolean operators ─────
  describe("boolean operators", () => {
    test("a AND b", () => {
      expect(sanitizeFtsQuery("a AND b", COLUMNS)).toBe("a AND b");
    });

    test("a OR b", () => {
      expect(sanitizeFtsQuery("a OR b", COLUMNS)).toBe("a OR b");
    });

    test("a NOT b", () => {
      expect(sanitizeFtsQuery("a NOT b", COLUMNS)).toBe("a NOT b");
    });

    test("lowercase and/or/not are regular words", () => {
      expect(sanitizeFtsQuery("and or not", COLUMNS)).toBe("and or not");
    });
  });

  // ───── Column qualifiers ─────
  describe("column qualifiers", () => {
    test("path:Research (valid column)", () => {
      expect(sanitizeFtsQuery("path:Research", COLUMNS)).toBe("path:Research");
    });

    test("PATH:Research (case-insensitive)", () => {
      expect(sanitizeFtsQuery("PATH:Research", COLUMNS)).toBe("PATH:Research");
    });

    test("path:fine-tune* (column + hyphenated RHS + prefix)", () => {
      expect(sanitizeFtsQuery("path:fine-tune*", COLUMNS))
        .toBe('path:"fine-tune"*');
    });

    test("PATH:fine-tune* (case-insensitive col + hyphenated RHS)", () => {
      expect(sanitizeFtsQuery("PATH:fine-tune*", COLUMNS))
        .toBe('PATH:"fine-tune"*');
    });

    test('path:"fine-tune" (column + already-quoted RHS)', () => {
      expect(sanitizeFtsQuery('path:"fine-tune"', COLUMNS))
        .toBe('path:"fine-tune"');
    });

    test("-path:foo (negated column filter)", () => {
      expect(sanitizeFtsQuery("-path:foo", COLUMNS)).toBe("-path:foo");
    });
  });

  // ───── Prefix star ─────
  describe("prefix star", () => {
    test("word* passes through", () => {
      expect(sanitizeFtsQuery("word*", COLUMNS)).toBe("word*");
    });

    test("fine-tune* (hyphen + prefix)", () => {
      expect(sanitizeFtsQuery("fine-tune*", COLUMNS)).toBe('"fine-tune"*');
    });
  });

  // ───── Parentheses ─────
  describe("parentheses", () => {
    test("(a OR b) AND c", () => {
      expect(sanitizeFtsQuery("(a OR b) AND c", COLUMNS))
        .toBe("(a OR b) AND c");
    });

    test("parens with hyphens", () => {
      expect(sanitizeFtsQuery("(fine-tune OR off-policy)", COLUMNS))
        .toBe('("fine-tune" OR "off-policy")');
    });
  });

  // ───── Advanced-syntax bypass ─────
  describe("advanced syntax bypass", () => {
    test("NEAR(term1 term2, 5)", () => {
      expect(sanitizeFtsQuery("NEAR(term1 term2, 5)", COLUMNS))
        .toBe("NEAR(term1 term2, 5)");
    });

    test("^word (initial token)", () => {
      expect(sanitizeFtsQuery("^word", COLUMNS)).toBe("^word");
    });

    test("a + b (space-padded phrase concat)", () => {
      expect(sanitizeFtsQuery("a + b", COLUMNS)).toBe("a + b");
    });

    test("{path title}:word (brace column set)", () => {
      expect(sanitizeFtsQuery("{path title}:word", COLUMNS))
        .toBe("{path title}:word");
    });

    test('^"fine-tune" (advanced with quotes)', () => {
      expect(sanitizeFtsQuery('^"fine-tune"', COLUMNS))
        .toBe('^"fine-tune"');
    });
  });

  // ───── Tokens containing + (NOT advanced bypass) ─────
  describe("plus in tokens (not bypass)", () => {
    test("C++ memory model (plus inside token)", () => {
      expect(sanitizeFtsQuery("C++ memory model", COLUMNS))
        .toBe('"C++" memory model');
    });

    test("A+B hyphen-test", () => {
      expect(sanitizeFtsQuery("A+B hyphen-test", COLUMNS))
        .toBe('"A+B" "hyphen-test"');
    });
  });

  // ───── Edge cases ─────
  describe("edge cases", () => {
    test("empty string preserved", () => {
      expect(sanitizeFtsQuery("", COLUMNS)).toBe("");
    });

    test("whitespace-only preserved", () => {
      expect(sanitizeFtsQuery("   ", COLUMNS)).toBe("   ");
    });

    test("single word passes through", () => {
      expect(sanitizeFtsQuery("hello", COLUMNS)).toBe("hello");
    });

    test("multiple plain words pass through", () => {
      expect(sanitizeFtsQuery("hello world foo", COLUMNS))
        .toBe("hello world foo");
    });
  });
});
