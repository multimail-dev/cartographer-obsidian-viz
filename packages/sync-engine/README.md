# `vault-graph-sync-engine`

Bidirectional R2-to-vault sync engine extracted from the Obsidian and daemon consumers. It handles listing, download/upload decisions, ignore-prefix filtering, rename handling, and sync-state tracking.

Source build SHA: `__SOURCE_COMMIT_SHA__` (replaced at publish time by `.github/workflows/publish-sync-engine.yml`)

## Install

```bash
bun add vault-graph-sync-engine@0.1.0
```

## Quick Start

```ts
import { SyncEngine, type SyncState, type VaultAdapterLike } from "vault-graph-sync-engine";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

const adapter: VaultAdapterLike = {
  async readBinary(path) {
    const buf = await fs.readFile(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  },
  async writeBinary(path, data) {
    await fs.mkdir(dirname(path), { recursive: true });
    const buf = data instanceof ArrayBuffer ? Buffer.from(data) : data;
    await fs.writeFile(path, buf);
  },
  async stat(path) {
    try {
      const s = await fs.stat(path);
      return { mtime: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
  },
  async mkdir(path) {
    await fs.mkdir(path, { recursive: true });
  },
};

const state: SyncState = { files: {} };

const engine = new SyncEngine(
  { adapter, getFiles: () => [{ path: "notes/example.md" }] },
  {
    endpoint: "https://<account>.r2.cloudflarestorage.com",
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    bucket: "obsidian-vault",
    syncIntervalSeconds: 300,
    ignorePatterns: ".obsidian/\n.trash/",
  },
  state
);

const result = await engine.fullSync();
console.log(result.downloaded, result.uploaded, result.errors);
```

## Adapter Contract

`VaultAdapterLike` must provide:

```ts
type VaultAdapterLike = {
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer | Buffer): Promise<void>;
  stat(path: string): Promise<{ mtime: number; size: number } | null>;
  mkdir(path: string): Promise<void>;
  getBasePath?: () => string;
  getFullPath?: (path: string) => string;
};
```

If `getBasePath` or `getFullPath` is present, the engine uses Node streams for lower-memory transfers. If neither is present, it stays on the adapter `readBinary` / `writeBinary` path.

## Configuration

```ts
interface R2SyncSettings {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  syncIntervalSeconds: number;
  ignorePatterns: string;
}
```

`ignorePatterns` is newline-separated path prefixes. Matching is prefix-based, not glob-based.

## Provenance

- Merge contract: [PROVENANCE.md](./PROVENANCE.md)
