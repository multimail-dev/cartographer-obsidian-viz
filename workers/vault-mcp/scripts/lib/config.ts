/**
 * Shared configuration for local sync scripts.
 *
 * Does: loads bearer token, provides default paths.
 * Does NOT: manage database connections or make HTTP calls.
 *
 * Env-var precedence (override — explicit env var wins over defaults):
 *   VAULT_API_URL   — overrides DEFAULT_API_URL if set
 *   VAULT_BEARER    — overrides .dev.vars SHARED_SECRET if set
 *   LOCAL_DB_PATH   — overrides DEFAULT_DB_PATH if set
 *   VAULT_PATH      — overrides DEFAULT_VAULT_PATH if set
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_API_URL = "https://your-vault-domain.com";
export const DEFAULT_DB_PATH = join(homedir(), ".cartographer", "local-graph.sqlite");
export const DEFAULT_VAULT_PATH = join(homedir(), "vault");
export const SCHEMA_PATH = join(import.meta.dir, "..", "local-schema.sql");

export function loadBearer(): string {
  if (process.env.VAULT_BEARER) return process.env.VAULT_BEARER;
  // Try .dev.vars — check worker directory first, then repo root
  const candidates = [
    join(import.meta.dir, "..", "..", ".dev.vars"),   // workers/vault-mcp/.dev.vars
    join(import.meta.dir, "..", "..", "..", "..", ".dev.vars"), // repo root .dev.vars
  ];
  for (const devVars of candidates) {
    if (existsSync(devVars)) {
      const content = readFileSync(devVars, "utf-8");
      const match = content.match(/^SHARED_SECRET\s*=\s*(.+)$/m);
      if (match) return match[1].trim();
    }
  }
  throw new Error("VAULT_BEARER env var required (or set SHARED_SECRET in .dev.vars)");
}
