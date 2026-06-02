/**
 * Unit tests for search — keyword scoring + server limit behavior.
 *
 * Run with: bun test tests/search.test.ts
 */
import { test, expect } from "bun:test";
import { keywordSearch } from "../src/core/search";
import type { VaultNote } from "../src/core/types";

function makeNote(id: string, title: string, tags: string[] = [], type = "note"): VaultNote {
  return {
    id,
    title,
    folder: id.includes("/") ? id.split("/").slice(0, -1).join("/") : "",
    frontmatter: { tags, type },
    wikilinks: [],
    wordCount: 100,
    created: Date.now(),
    modified: Date.now(),
  };
}

test("keywordSearch returns all matches (no internal cap)", () => {
  // Create 300 notes all matching "test"
  const notes = Array.from({ length: 300 }, (_, i) =>
    makeNote(`test-note-${i}`, `Test Note ${i}`)
  );
  const results = keywordSearch(notes, "test");
  expect(results.length).toBe(300);
});

test("keywordSearch scores title higher than path", () => {
  const notes = [
    makeNote("some/deep/path", "Unrelated Title"),
    makeNote("unrelated/path", "Search Target"),
  ];
  const results = keywordSearch(notes, "search");
  expect(results[0]).toBe("unrelated/path"); // title match (10) > path match (5)
});

test("keywordSearch scores tags higher than type", () => {
  const notes = [
    makeNote("a", "Note A", [], "searchable"),      // type match = 3
    makeNote("b", "Note B", ["search-related"], ""), // tag match = 8
  ];
  const results = keywordSearch(notes, "search");
  expect(results[0]).toBe("b");
});

test("keywordSearch returns empty for no matches", () => {
  const notes = [makeNote("a", "Hello"), makeNote("b", "World")];
  const results = keywordSearch(notes, "zzzznotfound");
  expect(results.length).toBe(0);
});

test("keywordSearch is case-insensitive", () => {
  const notes = [makeNote("a", "Machine Learning")];
  expect(keywordSearch(notes, "machine").length).toBe(1);
  expect(keywordSearch(notes, "MACHINE").length).toBe(1);
  expect(keywordSearch(notes, "Machine").length).toBe(1);
});
