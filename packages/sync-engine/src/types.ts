/**
 * Public types for vault-graph-sync-engine.
 *
 * Frozen surface — see PROVENANCE.md "Public API surface" section. Changes
 * here are minor or major version bumps depending on additive vs breaking.
 */

/**
 * Adapter contract that the consumer's "vault" must implement. Both
 * Obsidian's `Vault.adapter` and a node-fs-backed wrapper satisfy this.
 *
 * `getBasePath` / `getFullPath` are optional — if provided, the engine
 * will use a Node `createReadStream` for uploads and `pipeline()` for
 * downloads (faster, lower memory). If absent, it falls back to the
 * adapter's `readBinary` / `writeBinary` (works in any environment).
 */
export type VaultAdapterLike = {
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer | Buffer): Promise<void>;
  stat(path: string): Promise<{ mtime: number; size: number } | null>;
  mkdir(path: string): Promise<void>;
  getBasePath?: () => string;
  getFullPath?: (path: string) => string;
};

/**
 * R2 connection + behavior settings. `syncIntervalSeconds` is unused by
 * SyncEngine itself but kept for consumer-side scheduling code.
 */
export interface R2SyncSettings {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  syncIntervalSeconds: number;
  ignorePatterns: string;
}

/**
 * Per-file sync metadata. Persisted by the consumer between sync runs so
 * that the engine can distinguish "file is new" from "file changed" from
 * "file is up to date".
 */
export interface FileSyncRecord {
  localMtime: number;
  remoteEtag: string;
  remoteLastModified: number;
  lastSynced: number;
}

export interface SyncState {
  files: Record<string, FileSyncRecord>;
}
