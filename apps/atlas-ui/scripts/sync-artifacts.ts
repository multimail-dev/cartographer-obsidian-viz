#!/usr/bin/env bun
// Post-build step for apps/atlas-ui:
//   1. copy src/frontend/{index.html,style.css} into workers/vault-mcp/public/
//   2. copy built {app.js,fa3-worker.js} → {*.txt} sibling files (worker
//      imports these as text modules; see workers/vault-mcp/src/ui-handler.ts)
//   3. delete stale *.map files (sourcemaps are intentionally not served;
//      see docs/plans/2026-04-20-001-consolidate-atlas-ui-into-cartographer-plan.md §Unit 4)
//
// Run manually via `bun run scripts/sync-artifacts.ts` from apps/atlas-ui,
// or indirectly via `bun run build` / `bun run --filter @vault-graph/atlas-ui build`.

import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const repoRoot = resolve(appRoot, "..", "..");
const distDir = resolve(repoRoot, "workers/vault-mcp/public/dist");
const publicDir = resolve(repoRoot, "workers/vault-mcp/public");
const frontendDir = resolve(appRoot, "src/frontend");

async function ensureDir(path: string): Promise<void> {
  if (!existsSync(path)) {
    await mkdir(path, { recursive: true });
  }
}

async function copyAcross(from: string, to: string): Promise<void> {
  if (!existsSync(from)) {
    throw new Error(`sync-artifacts: missing source ${from}`);
  }
  await ensureDir(dirname(to));
  await copyFile(from, to);
}

async function copyAsText(from: string, toTxt: string): Promise<void> {
  if (!existsSync(from)) {
    throw new Error(`sync-artifacts: missing built bundle ${from}`);
  }
  const contents = await readFile(from);
  await writeFile(toTxt, contents);
}

async function pruneMaps(): Promise<void> {
  if (!existsSync(distDir)) return;
  for (const entry of await readdir(distDir)) {
    if (entry.endsWith(".map")) {
      await unlink(join(distDir, entry));
    }
  }
}

async function main(): Promise<void> {
  await ensureDir(distDir);
  await copyAcross(join(frontendDir, "index.html"), join(publicDir, "index.html"));
  await copyAcross(join(frontendDir, "style.css"), join(publicDir, "style.css"));
  await copyAsText(join(distDir, "app.js"), join(distDir, "app.js.txt"));
  await copyAsText(join(distDir, "fa3-worker.js"), join(distDir, "fa3-worker.js.txt"));
  await pruneMaps();
  console.log("sync-artifacts: ok");
}

await main();
