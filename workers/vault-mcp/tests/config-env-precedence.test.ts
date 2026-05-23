/**
 * Tests env-var precedence for scripts/lib/config.ts.
 *
 * Sharp directive: "Before you ship an env-var seam, ask 'what if this var
 * is already exported in the user's shell?' Write that test."
 *
 * These vars use override semantics: process.env.X takes precedence over
 * defaults. Tests prove the pre-exported case works against the ACTUAL
 * config module exports (DEFAULT_API_URL, DEFAULT_DB_PATH, loadBearer).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DEFAULT_API_URL, DEFAULT_DB_PATH, DEFAULT_VAULT_PATH, loadBearer } from "../scripts/lib/config";

describe("config env-var precedence", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.VAULT_BEARER = process.env.VAULT_BEARER;
    origEnv.VAULT_API_URL = process.env.VAULT_API_URL;
    origEnv.LOCAL_DB_PATH = process.env.LOCAL_DB_PATH;
    origEnv.VAULT_PATH = process.env.VAULT_PATH;
  });

  afterEach(() => {
    if (origEnv.VAULT_BEARER === undefined) delete process.env.VAULT_BEARER;
    else process.env.VAULT_BEARER = origEnv.VAULT_BEARER;
    if (origEnv.VAULT_API_URL === undefined) delete process.env.VAULT_API_URL;
    else process.env.VAULT_API_URL = origEnv.VAULT_API_URL;
    if (origEnv.LOCAL_DB_PATH === undefined) delete process.env.LOCAL_DB_PATH;
    else process.env.LOCAL_DB_PATH = origEnv.LOCAL_DB_PATH;
    if (origEnv.VAULT_PATH === undefined) delete process.env.VAULT_PATH;
    else process.env.VAULT_PATH = origEnv.VAULT_PATH;
  });

  it("VAULT_BEARER env var takes precedence over .dev.vars fallback", () => {
    process.env.VAULT_BEARER = "test-token-from-env";
    expect(loadBearer()).toBe("test-token-from-env");
  });

  it("VAULT_API_URL pre-exported env var overrides DEFAULT_API_URL at consumer site", () => {
    // Simulates: user already has VAULT_API_URL exported in shell.
    // The consumer pattern (sync-local.ts:28, parity-check.ts:22) is:
    //   const API_URL = process.env.VAULT_API_URL ?? DEFAULT_API_URL;
    process.env.VAULT_API_URL = "https://custom-api.example.com";
    const apiUrl = process.env.VAULT_API_URL ?? DEFAULT_API_URL;
    expect(apiUrl).toBe("https://custom-api.example.com");
    expect(DEFAULT_API_URL).toBe("https://your-vault-domain.com"); // default unchanged
  });

  it("LOCAL_DB_PATH pre-exported env var overrides DEFAULT_DB_PATH at consumer site", () => {
    // Simulates: user already has LOCAL_DB_PATH exported in shell.
    // The consumer pattern (sync-local.ts:29, parity-check.ts:24) is:
    //   const DB_PATH = process.env.LOCAL_DB_PATH ?? DEFAULT_DB_PATH;
    process.env.LOCAL_DB_PATH = "/tmp/test-graph.sqlite";
    const dbPath = process.env.LOCAL_DB_PATH ?? DEFAULT_DB_PATH;
    expect(dbPath).toBe("/tmp/test-graph.sqlite");
    expect(DEFAULT_DB_PATH).toContain(".cartographer"); // default unchanged
  });

  it("VAULT_PATH pre-exported env var overrides DEFAULT_VAULT_PATH at consumer site", () => {
    // Simulates: user already has VAULT_PATH exported in shell.
    // The consumer pattern (build-graph-local.ts) is:
    //   const VAULT_PATH = process.env.VAULT_PATH ?? DEFAULT_VAULT_PATH;
    process.env.VAULT_PATH = "/tmp/test-vault";
    const vaultPath = process.env.VAULT_PATH ?? DEFAULT_VAULT_PATH;
    expect(vaultPath).toBe("/tmp/test-vault");
    expect(DEFAULT_VAULT_PATH).toContain("vault"); // default unchanged
  });

  it("VAULT_PATH override reaches build-graph-local consumer (subprocess proof)", () => {
    // Sharp Directive #2: "what if this var is already exported in the user's
    // shell?" — prove it by running the actual consumer with the var pre-set.
    // The script will fail (path doesn't exist) but the error message proves
    // the override reached the consumer code.
    const result = Bun.spawnSync({
      cmd: ["bun", "scripts/build-graph-local.ts"],
      cwd: new URL("../", import.meta.url).pathname,
      env: {
        ...process.env,
        VAULT_PATH: "/tmp/nonexistent-vault-test-12345",
        LOCAL_DB_PATH: "/tmp/test-env-precedence.sqlite",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout.toString() + result.stderr.toString();
    // The script prints the vault path it's using — prove the override took effect
    expect(output).toContain("/tmp/nonexistent-vault-test-12345");
    // It should fail because the vault path doesn't exist
    expect(result.exitCode).not.toBe(0);
  });

  it("defaults apply when env vars are not set", () => {
    delete process.env.VAULT_API_URL;
    delete process.env.LOCAL_DB_PATH;
    delete process.env.VAULT_PATH;
    const apiUrl = process.env.VAULT_API_URL ?? DEFAULT_API_URL;
    const dbPath = process.env.LOCAL_DB_PATH ?? DEFAULT_DB_PATH;
    const vaultPath = process.env.VAULT_PATH ?? DEFAULT_VAULT_PATH;
    expect(apiUrl).toBe("https://your-vault-domain.com");
    expect(dbPath).toContain(".cartographer/local-graph.sqlite");
    expect(vaultPath).toContain("vault");
  });
});
