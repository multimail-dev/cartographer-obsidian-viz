# SyncEngine Provenance

Documents the canonical-source decision and every divergence between the two pre-extraction vendored copies.

## Canonical source (decided)

The private upstream Obsidian plugin (vendored 2026-04-13) is canonical for **logic and behavior**. The daemon's vendor copy explicitly cites the source commit — it is itself a copy of the plugin's version. There is no logic drift between the two.

The private upstream sync daemon is canonical for **TypeScript-strictness fixes**. Its copy applied four small type-safety improvements that the plugin copy has not yet picked up.

The published `vault-graph-sync-engine` package adopts:
- All logic from `obsidian-r2-sync`.
- All four TS-strictness fixes from `r2-sync-daemon`.
- Drops the vendor header (the package itself is now canonical — there is no upstream to point at).
- Drops the relative `./settings` / `./settings.js` import — the package owns its own type module (`src/types.ts`).

## Diff enumeration

`diff -u plugin/src/sync-engine.ts daemon/src/vendor/sync-engine.ts` produced 6 hunks. All accounted for below.

| # | Lines | Plugin (canonical) | Daemon (vendor) | Category | Pick | Rationale |
|---|---|---|---|---|---|---|
| 1 | +16 | (no header) | 16-line vendor header citing source repo + commit | (d) stylistic — daemon-only | **Drop** | The package IS canonical; there is no upstream commit to cite. The header was a daemon-side hygiene aid for vendored code, not engine code. |
| 2 | 1 | `import … from "./settings"` | `import … from "./settings.js"` | (a)/(b) split — both are right for their host's module resolution (Obsidian bundler vs daemon NodeNext) | **Resolve by owning** | Package re-exports types from `./types` (or `./types.ts` under `allowImportingTsExtensions`). Neither consumer's import suffix problem applies anymore. |
| 3 | 1 | `results[i] = await tasks[i]();` | `results[i] = await tasks[i]!();` | (c) genuine bug fix — daemon caught the `noUncheckedIndexedAccess` issue | **Pick daemon** | Under strict TS, `tasks[i]` is `(() => Promise<T>) \| undefined`. The non-null assertion is correct here because the loop guard `while (idx < tasks.length)` proves presence. Plugin probably has looser tsconfig and didn't surface the error. |
| 4 | 1 | `type VaultAdapterLike = {` | `export type VaultAdapterLike = {` | (a)/(b) split — daemon needs to export it (used by host wrapper code), plugin keeps it internal | **Pick daemon** | The package's whole point is being consumed externally. `VaultAdapterLike` MUST be exported. |
| 5 | 1 | `await this.vault.adapter.writeBinary(key, data);` | `await this.vault.adapter.writeBinary(key, data as ArrayBuffer);` | (a) host-side TS-strictness | **Pick daemon** | `data` typecheck issue: `bytes.buffer` is `ArrayBufferLike`, not `ArrayBuffer`. The narrowing is provably correct because `bytes` is a `Uint8Array` whose backing buffer is always `ArrayBuffer` (not `SharedArrayBuffer`) in this code path. |
| 6 | 2 | `Body: body,` | `// eslint-disable-next-line ...` + `Body: body as any,` | (d) stylistic — both work; daemon's silences a stricter @aws-sdk type narrowing | **Pick daemon** | Package targets strict TS. The `as any` is acceptable here because `@aws-sdk/client-s3`'s `Body` type signature is genuinely tortured for the union of `Uint8Array | NodeJS.ReadableStream`. The eslint-disable is local and documented. |

## Public API surface (frozen for consumers)

The merged package exports exactly these symbols. Adding to this list is a minor version bump; removing anything is a major version bump.

```ts
// Class
export class SyncEngine {
  constructor(
    vault: { adapter: VaultAdapterLike; getFiles(): Array<{ path: string }> },
    settings: R2SyncSettings,
    state: SyncState
  );
  updateSettings(settings: R2SyncSettings): void;
  updateState(state: SyncState): void;
  getState(): SyncState;
  isConfigured(): boolean;
  uploadFile(path: string): Promise<FileSyncRecord | null>;
  deleteRemote(path: string): Promise<void>;
  handleRename(oldPath: string, newPath: string): Promise<void>;
  fullSync(): Promise<{ downloaded: number; uploaded: number; errors: string[] }>;
}

// Types
export type VaultAdapterLike = {
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer | Buffer): Promise<void>;
  stat(path: string): Promise<{ mtime: number; size: number } | null>;
  mkdir(path: string): Promise<void>;
  getBasePath?: () => string;
  getFullPath?: (path: string) => string;
};

export interface R2SyncSettings {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  syncIntervalSeconds: number;     // unused by SyncEngine itself; kept for consumer compat
  ignorePatterns: string;
}

export interface SyncState {
  files: Record<string, FileSyncRecord>;
}

export interface FileSyncRecord {
  localMtime: number;
  remoteEtag: string;
  remoteLastModified: number;
  lastSynced: number;
}
```

## What is intentionally NOT in the package

| Excluded | Reason |
|---|---|
| `R2SyncSettingTab` (Obsidian `PluginSettingTab` UI class from plugin's `settings.ts`) | UI concern bound to Obsidian's `App` + `PluginSettingTab`. Belongs in the plugin, not the engine. |
| `DEFAULT_SETTINGS` (default settings object from plugin's `settings.ts`) | Consumer-policy concern. Each consumer picks its own defaults (the daemon may want different `syncIntervalSeconds`). |
| Sync loop / interval timer | This is the daemon's `chokidar` + interval orchestration; the engine is a stateless transport. |

## Source-commit linkage

This extraction's source is a private upstream (logic) merged with four TS-strictness fixes documented above.
