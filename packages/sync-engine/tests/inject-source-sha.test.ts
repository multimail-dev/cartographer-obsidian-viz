/**
 * Env-precedence test for scripts/inject-source-sha.sh.
 *
 * Closes Sharp Directive #2: "Pre-existing exports collide silently; new
 * env-var contracts must specify precedence (override vs respect) and prove
 * it with a test that runs with the var pre-set."
 *
 * The contract being proved here:
 *   1. The script REQUIRES SOURCE_SHA, REPO, and TARGET to be set
 *      explicitly by the caller (no inheritance fallback / no defaults).
 *   2. When the caller sets a value via execSync's `env` option, that
 *      value WINS over any pre-existing inherited value — guaranteed by
 *      the script's `: "${VAR:?...}"` parameter expansion contract.
 *   3. Missing values fail loud, not silently.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, "..", "scripts", "inject-source-sha.sh");

function makeReadme(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sync-engine-sse-"));
  const path = join(dir, "README.md");
  writeFileSync(
    path,
    "# pkg\n\nSource build SHA: __SOURCE_COMMIT_SHA__ (replaced at publish time)\n\nMore content.\n"
  );
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("inject-source-sha env-precedence", () => {
  test("explicit SOURCE_SHA wins over a pre-existing inherited value", () => {
    const { path, cleanup } = makeReadme();
    try {
      // Pre-set SOURCE_SHA in this test process to a "stale" value that
      // would be wrong if the script silently inherited it.
      process.env.SOURCE_SHA = "STALE_INHERITED_VALUE_DO_NOT_USE";

      // Now invoke the script with an EXPLICIT SOURCE_SHA via the env
      // option. The execFileSync env option REPLACES the child's env,
      // mirroring how GitHub Actions' step-level `env:` block delivers
      // `${{ github.sha }}` to the shell.
      execFileSync("bash", [SCRIPT], {
        env: {
          PATH: process.env.PATH ?? "",
          SOURCE_SHA: "explicit-abc123",
          REPO: "owner/repo",
          TARGET: path,
        },
        stdio: "pipe",
      });

      const out = readFileSync(path, "utf8");
      expect(out).toContain("explicit-abc123");
      expect(out).toContain("https://github.com/owner/repo/commit/explicit-abc123");
      expect(out).not.toContain("STALE_INHERITED_VALUE_DO_NOT_USE");
      expect(out).not.toContain("__SOURCE_COMMIT_SHA__");
    } finally {
      delete process.env.SOURCE_SHA;
      cleanup();
    }
  });

  test("missing SOURCE_SHA fails loud (no default, no silent fallback)", () => {
    const { path, cleanup } = makeReadme();
    try {
      let threw = false;
      let stderr = "";
      try {
        execFileSync("bash", [SCRIPT], {
          env: {
            PATH: process.env.PATH ?? "",
            REPO: "owner/repo",
            TARGET: path,
            // SOURCE_SHA intentionally absent
          },
          stdio: "pipe",
        });
      } catch (e) {
        threw = true;
        stderr = (e as { stderr?: Buffer }).stderr?.toString("utf8") ?? "";
      }
      expect(threw).toBe(true);
      expect(stderr).toContain("SOURCE_SHA must be set explicitly");
      // README must NOT have been modified.
      const out = readFileSync(path, "utf8");
      expect(out).toContain("__SOURCE_COMMIT_SHA__");
    } finally {
      cleanup();
    }
  });

  test("missing TARGET fails loud", () => {
    let threw = false;
    let stderr = "";
    try {
      execFileSync("bash", [SCRIPT], {
        env: {
          PATH: process.env.PATH ?? "",
          SOURCE_SHA: "abc",
          REPO: "owner/repo",
        },
        stdio: "pipe",
      });
    } catch (e) {
      threw = true;
      stderr = (e as { stderr?: Buffer }).stderr?.toString("utf8") ?? "";
    }
    expect(threw).toBe(true);
    expect(stderr).toContain("TARGET must be set");
  });

  test("placeholder absent in target → fails loud (catches a malformed README)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-engine-sse-"));
    const path = join(dir, "README.md");
    writeFileSync(path, "# README without the placeholder\n");
    try {
      let threw = false;
      let stderr = "";
      try {
        execFileSync("bash", [SCRIPT], {
          env: {
            PATH: process.env.PATH ?? "",
            SOURCE_SHA: "abc123",
            REPO: "owner/repo",
            TARGET: path,
          },
          stdio: "pipe",
        });
      } catch (e) {
        threw = true;
        stderr = (e as { stderr?: Buffer }).stderr?.toString("utf8") ?? "";
      }
      expect(threw).toBe(true);
      expect(stderr).toContain("does not contain abc123");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
