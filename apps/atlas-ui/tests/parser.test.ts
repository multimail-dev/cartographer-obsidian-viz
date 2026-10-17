import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { parseVault } from "../src/core/parser";

const vaults: string[] = [];
afterEach(async () => {
  await Promise.all(vaults.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function parseNote(text: string) {
  const vault = await mkdtemp(join(tmpdir(), "atlas-parser-"));
  vaults.push(vault);
  await writeFile(join(vault, "note.md"), text);
  const notes = await parseVault(vault);
  expect(notes).toHaveLength(1);
  return notes[0];
}

for (const newline of ["\n", "\r\n"]) {
  test(`YAML metadata and body parse with ${JSON.stringify(newline)}`, async () => {
    const note = await parseNote([
      "---", "title: Example", "tags: [one, two]", "created: 2026-01-02",
      "hidden: '[[Metadata link]]'", "---", "Hello [[Body link]]",
    ].join(newline));
    expect(note.title).toBe("Example");
    expect(note.frontmatter.tags).toEqual(["one", "two"]);
    expect(note.created).toBe(new Date("2026-01-02").getTime());
    expect(note.wikilinks).toEqual(["Body link"]);
    expect(note.wordCount).toBe(3);
  });
}

for (const suffix of ["js", "javascript", " javascript", "json", "yaml", "yml"]) {
  test(`language suffix ${JSON.stringify(suffix)} stays inert body text`, async () => {
    const sentinel = "__atlasParserSentinel";
    const globals = globalThis as unknown as Record<string, unknown>;
    globals[sentinel] = "unchanged";
    try {
      const note = await parseNote(`---${suffix}\n(globalThis.${sentinel} = "executed", { title: "Executed" })\n---\n[[Body link]]`);
      expect(globals[sentinel]).toBe("unchanged");
      expect(note.frontmatter).toEqual({});
      expect(note.title).toBe("note");
      expect(note.wikilinks).toEqual(["Body link"]);
    } finally {
      delete globals[sentinel];
    }
  });
}

for (const text of [
  "---\ntitle: [broken\n---\n[[Fallback]]",
  "---\ntitle: unclosed\n[[Fallback]]",
  "---\n- sequence\n---\n[[Fallback]]",
  "---\nscalar\n---\n[[Fallback]]",
  "Preface\n---javascript\n({title: 'ignored'})\n---\n[[Fallback]]",
]) {
  test(`invalid or absent frontmatter preserves body: ${JSON.stringify(text)}`, async () => {
    const note = await parseNote(text);
    expect(note.frontmatter).toEqual({});
    expect(note.title).toBe("note");
    expect(note.wikilinks).toEqual(["Fallback"]);
    expect(note.wordCount).toBe(text.split(/\s+/).length);
  });
}

test("empty YAML frontmatter is supported", async () => {
  const note = await parseNote("---\n---\n[[Body]]");
  expect(note.frontmatter).toEqual({});
  expect(note.wikilinks).toEqual(["Body"]);
  expect(note.wordCount).toBe(1);
});

test("BOM and closing delimiter at EOF are supported", async () => {
  const note = await parseNote("\uFEFF---\ntitle: Example\n---");
  expect(note.title).toBe("Example");
  expect(note.wikilinks).toEqual([]);
});
