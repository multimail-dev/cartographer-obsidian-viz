import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import * as https from "https";
import {
  createReadStream,
  createWriteStream,
  promises as fsPromises,
} from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type {
  FileSyncRecord,
  R2SyncSettings,
  SyncState,
  VaultAdapterLike,
} from "./types";

export type {
  VaultAdapterLike,
  R2SyncSettings,
  SyncState,
  FileSyncRecord,
} from "./types";

const MAX_SYNC_FILE_SIZE = 50 * 1024 * 1024;
const MAX_CONCURRENT_TRANSFERS = 5;

async function runBatched<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;
  async function next(): Promise<void> {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]!();
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => next()
  );
  await Promise.all(workers);
  return results;
}

type RemoteObjectInfo = {
  key: string;
  etag: string;
  lastModified: number;
  size: number;
};

export class SyncEngine {
  private client: S3Client | null = null;
  private settings: R2SyncSettings;
  private state: SyncState;
  private ignorePrefixes: string[];

  constructor(
    private vault: {
      adapter: VaultAdapterLike;
      getFiles(): Array<{ path: string }>;
    },
    settings: R2SyncSettings,
    state: SyncState
  ) {
    this.vault = vault;
    this.settings = settings;
    this.state = state;
    this.ignorePrefixes = this.parseIgnorePatterns(settings.ignorePatterns);
    this.initClient();
  }

  updateSettings(settings: R2SyncSettings): void {
    const shouldReinitializeClient =
      settings.endpoint !== this.settings.endpoint ||
      settings.accessKeyId !== this.settings.accessKeyId ||
      settings.secretAccessKey !== this.settings.secretAccessKey;

    this.settings = settings;
    this.ignorePrefixes = this.parseIgnorePatterns(settings.ignorePatterns);
    if (shouldReinitializeClient) {
      this.initClient();
    }
  }

  updateState(state: SyncState): void {
    this.state = state;
  }

  getState(): SyncState {
    return this.state;
  }

  private parseIgnorePatterns(raw: string): string[] {
    return raw
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }

  private isIgnored(path: string): boolean {
    return this.ignorePrefixes.some((prefix) => path.startsWith(prefix));
  }

  private initClient(): void {
    if (
      !this.settings.endpoint ||
      !this.settings.accessKeyId ||
      !this.settings.secretAccessKey
    ) {
      this.client = null;
      return;
    }
    this.client = new S3Client({
      region: "auto",
      endpoint: this.settings.endpoint,
      credentials: {
        accessKeyId: this.settings.accessKeyId,
        secretAccessKey: this.settings.secretAccessKey,
      },
      forcePathStyle: true,
      // maxSockets was previously 5 (commit f8c25a9, 2026-04-05) to
      // suppress @smithy/node-http-handler warnings. That treated the
      // symptom, not the cause: for a 5000+ file vault, the sync queue
      // regularly outpaces a 5-socket drain rate and thousands of
      // requests back up behind it (observed 9920 enqueued on
      // 2026-04-13). Cloudflare R2's per-bucket rate limits are in the
      // thousands/sec, so 50 concurrent is comfortably safe.
      requestHandler: new NodeHttpHandler({
        httpsAgent: new https.Agent({ maxSockets: 50 }),
        socketAcquisitionWarningTimeout: 30000,
      }),
    });
  }

  isConfigured(): boolean {
    return this.client !== null && this.settings.bucket.length > 0;
  }

  private async *iterateRemoteObjects(): AsyncGenerator<RemoteObjectInfo> {
    if (!this.client) {
      return;
    }
    let continuationToken: string | undefined;
    do {
      const cmd = new ListObjectsV2Command({
        Bucket: this.settings.bucket,
        ContinuationToken: continuationToken,
      });
      const resp = await this.client.send(cmd);
      if (resp.Contents) {
        for (const obj of resp.Contents) {
          if (obj.Key && obj.ETag && obj.LastModified) {
            yield {
              key: obj.Key,
              etag: obj.ETag,
              lastModified: obj.LastModified.getTime(),
              size: obj.Size ?? 0,
            };
          }
        }
      }
      continuationToken = resp.NextContinuationToken;
    } while (continuationToken);
  }

  private getLocalFilePath(path: string): string | null {
    const adapter = this.vault.adapter;
    if (typeof adapter.getFullPath === "function") {
      return adapter.getFullPath(path);
    }
    if (typeof adapter.getBasePath === "function") {
      return join(adapter.getBasePath(), path);
    }
    return null;
  }

  private isReadableStream(body: unknown): body is NodeJS.ReadableStream {
    return !!body && typeof (body as NodeJS.ReadableStream).pipe === "function";
  }

  private async ensureParentDir(path: string): Promise<void> {
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (!dir) {
      return;
    }
    try {
      await this.vault.adapter.mkdir(dir);
    } catch {
      // Directory may already exist.
    }
  }

  private async writeRemoteBodyToVault(
    key: string,
    body: unknown
  ): Promise<void> {
    const localPath = this.getLocalFilePath(key);
    if (localPath && this.isReadableStream(body)) {
      await fsPromises.mkdir(dirname(localPath), { recursive: true });
      await pipeline(body, createWriteStream(localPath));
      return;
    }

    if (
      !body ||
      typeof (body as { transformToByteArray?: unknown }).transformToByteArray !==
        "function"
    ) {
      throw new Error(`Unsupported response body for ${key}`);
    }

    const bytes = await (
      body as { transformToByteArray(): Promise<Uint8Array> }
    ).transformToByteArray();
    await this.ensureParentDir(key);
    const data =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.slice().buffer;
    await this.vault.adapter.writeBinary(key, data as ArrayBuffer);
  }

  private async downloadFile(
    key: string,
    expectedSize?: number
  ): Promise<FileSyncRecord | null> {
    if (!this.client) return null;
    if ((expectedSize ?? 0) > MAX_SYNC_FILE_SIZE) {
      console.warn(`R2 Sync: skipped download over 50MB: ${key}`);
      return null;
    }

    const cmd = new GetObjectCommand({
      Bucket: this.settings.bucket,
      Key: key,
    });
    const resp = await this.client.send(cmd);
    if (!resp.Body) return null;
    if ((resp.ContentLength ?? 0) > MAX_SYNC_FILE_SIZE) {
      console.warn(`R2 Sync: skipped download over 50MB: ${key}`);
      return null;
    }

    await this.writeRemoteBodyToVault(key, resp.Body);

    const stat = await this.vault.adapter.stat(key);
    const record: FileSyncRecord = {
      localMtime: stat?.mtime ?? Date.now(),
      remoteEtag: resp.ETag ?? "",
      remoteLastModified: resp.LastModified?.getTime() ?? Date.now(),
      lastSynced: Date.now(),
    };
    this.state.files[key] = record;
    return record;
  }

  async uploadFile(path: string): Promise<FileSyncRecord | null> {
    if (!this.client || this.isIgnored(path)) return null;

    const stat = await this.vault.adapter.stat(path);
    if (!stat) {
      return null;
    }
    if (stat.size > MAX_SYNC_FILE_SIZE) {
      console.warn(`R2 Sync: skipped upload over 50MB: ${path}`);
      return null;
    }

    let body: Uint8Array | NodeJS.ReadableStream;
    try {
      const localPath = this.getLocalFilePath(path);
      body = localPath
        ? createReadStream(localPath)
        : new Uint8Array(await this.vault.adapter.readBinary(path));
    } catch {
      return null;
    }

    const cmd = new PutObjectCommand({
      Bucket: this.settings.bucket,
      Key: path,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Body: body as any,
    });
    const resp = await this.client.send(cmd);

    const record: FileSyncRecord = {
      localMtime: stat.mtime ?? Date.now(),
      remoteEtag: resp.ETag ?? "",
      remoteLastModified: Date.now(),
      lastSynced: Date.now(),
    };
    this.state.files[path] = record;
    return record;
  }

  async deleteRemote(path: string): Promise<void> {
    if (!this.client || this.isIgnored(path)) return;

    const cmd = new DeleteObjectCommand({
      Bucket: this.settings.bucket,
      Key: path,
    });
    await this.client.send(cmd);
    delete this.state.files[path];
  }

  async handleRename(oldPath: string, newPath: string): Promise<void> {
    await this.deleteRemote(oldPath);
    await this.uploadFile(newPath);
  }

  async fullSync(): Promise<{
    downloaded: number;
    uploaded: number;
    errors: string[];
  }> {
    if (!this.isConfigured()) {
      return { downloaded: 0, uploaded: 0, errors: ["R2 not configured"] };
    }

    const errors: string[] = [];
    let downloaded = 0;
    let uploaded = 0;

    const localFiles = this.vault.getFiles();
    const localPaths = new Set<string>();
    for (const f of localFiles) {
      if (!this.isIgnored(f.path)) {
        localPaths.add(f.path);
      }
    }

    const remotePaths = new Set<string>();
    const remoteChangedPaths = new Set<string>();

    type TransferTask =
      | { type: "download"; key: string; size?: number }
      | { type: "upload"; path: string };
    const transferQueue: TransferTask[] = [];

    try {
      for await (const remote of this.iterateRemoteObjects()) {
        const { key } = remote;
        if (this.isIgnored(key)) continue;

        remotePaths.add(key);
        const known = this.state.files[key];
        if (!known || remote.etag !== known.remoteEtag) {
          remoteChangedPaths.add(key);
        }

        if (!known) {
          if (localPaths.has(key)) {
            const stat = await this.vault.adapter.stat(key);
            const localMtime = stat?.mtime ?? 0;
            if (remote.lastModified > localMtime) {
              transferQueue.push({ type: "download", key, size: remote.size });
            } else {
              transferQueue.push({ type: "upload", path: key });
            }
          } else {
            transferQueue.push({ type: "download", key, size: remote.size });
          }
        } else if (remote.etag !== known.remoteEtag) {
          const stat = await this.vault.adapter.stat(key);
          const localMtime = stat?.mtime ?? 0;
          const localChanged = localMtime > known.lastSynced;
          const remoteChanged = remote.lastModified > known.lastSynced;

          if (remoteChanged && !localChanged) {
            transferQueue.push({ type: "download", key, size: remote.size });
          } else if (remoteChanged && localChanged) {
            if (remote.lastModified > localMtime) {
              transferQueue.push({ type: "download", key, size: remote.size });
            } else {
              transferQueue.push({ type: "upload", path: key });
            }
          }
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { downloaded: 0, uploaded: 0, errors: [`Failed to list R2: ${msg}`] };
    }

    for (const path of localPaths) {
      const known = this.state.files[path];
      if (!known && !remotePaths.has(path)) {
        transferQueue.push({ type: "upload", path });
      } else if (known) {
        const stat = await this.vault.adapter.stat(path);
        const localMtime = stat?.mtime ?? 0;
        if (localMtime > known.lastSynced && !remoteChangedPaths.has(path)) {
          transferQueue.push({ type: "upload", path });
        }
      }
    }

    const tasks = transferQueue.map((t) => async () => {
      try {
        if (t.type === "download") {
          if (await this.downloadFile(t.key, t.size)) downloaded++;
        } else {
          if (await this.uploadFile(t.path)) uploaded++;
        }
      } catch (e: unknown) {
        const label = t.type === "download" ? `Download ${t.key}` : `Upload ${t.path}`;
        errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    await runBatched(tasks, MAX_CONCURRENT_TRANSFERS);

    for (const path of Object.keys(this.state.files)) {
      if (!localPaths.has(path) && !remotePaths.has(path)) {
        delete this.state.files[path];
      }
    }

    return { downloaded, uploaded, errors };
  }
}
