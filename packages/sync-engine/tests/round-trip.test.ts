/**
 * Bidirectional round-trip integration test. Wires SyncEngine against an
 * in-memory mock S3 + an in-memory VaultAdapterLike and asserts that
 * download → modify → upload → delete cycles preserve content byte-identically
 * and converge state.files correctly.
 *
 * This is the load-bearing logic test. If SyncEngine breaks behavior
 * during the merge, this fires.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// In-memory R2 mock — module-level mock so SyncEngine's bare `new S3Client()`
// gets the in-memory implementation transparently.
// ---------------------------------------------------------------------------

type MockObject = { body: Uint8Array; etag: string; lastModified: Date };
const mockBucket = new Map<string, MockObject>();

function bytesToEtag(bytes: Uint8Array): string {
  // Cheap deterministic etag — sha-like prefix from the byte sum + length.
  let h = 0;
  for (const b of bytes) h = (h * 31 + b) >>> 0;
  return `"${h.toString(16).padStart(8, "0")}-${bytes.length}"`;
}

class ListObjectsV2Command {
  constructor(public input: { Bucket: string; ContinuationToken?: string }) {}
}
class GetObjectCommand {
  constructor(public input: { Bucket: string; Key: string }) {}
}
class PutObjectCommand {
  constructor(public input: { Bucket: string; Key: string; Body: Uint8Array }) {}
}
class DeleteObjectCommand {
  constructor(public input: { Bucket: string; Key: string }) {}
}

class S3Client {
  constructor(_config: unknown) {}
  async send(cmd: unknown): Promise<unknown> {
    if (cmd instanceof ListObjectsV2Command) {
      return {
        Contents: Array.from(mockBucket.entries()).map(([key, v]) => ({
          Key: key,
          ETag: v.etag,
          LastModified: v.lastModified,
          Size: v.body.byteLength,
        })),
        NextContinuationToken: undefined,
      };
    }
    if (cmd instanceof GetObjectCommand) {
      const obj = mockBucket.get(cmd.input.Key);
      if (!obj) throw new Error(`mock NoSuchKey: ${cmd.input.Key}`);
      return {
        Body: {
          async transformToByteArray(): Promise<Uint8Array> {
            return obj.body;
          },
        },
        ETag: obj.etag,
        LastModified: obj.lastModified,
        ContentLength: obj.body.byteLength,
      };
    }
    if (cmd instanceof PutObjectCommand) {
      const body = cmd.input.Body;
      const etag = bytesToEtag(body);
      mockBucket.set(cmd.input.Key, { body, etag, lastModified: new Date() });
      return { ETag: etag };
    }
    if (cmd instanceof DeleteObjectCommand) {
      mockBucket.delete(cmd.input.Key);
      return {};
    }
    throw new Error(`Unmocked S3 command: ${(cmd as object)?.constructor?.name}`);
  }
}

mock.module("@aws-sdk/client-s3", () => ({
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
}));

mock.module("@smithy/node-http-handler", () => ({
  NodeHttpHandler: class {
    constructor(_opts: unknown) {}
  },
}));

// ---------------------------------------------------------------------------
// In-memory VaultAdapterLike — pure Map-backed, no filesystem.
// Crucially we do NOT implement getBasePath/getFullPath, so SyncEngine
// stays on the readBinary/writeBinary code path (no node:fs streams).
// ---------------------------------------------------------------------------

import type { SyncState, VaultAdapterLike } from "../src/index.ts";

type LocalEntry = { data: Uint8Array; mtime: number };
const localFiles = new Map<string, LocalEntry>();

const adapter: VaultAdapterLike = {
  async readBinary(path: string): Promise<ArrayBuffer> {
    const entry = localFiles.get(path);
    if (!entry) throw new Error(`local ENOENT: ${path}`);
    const view = entry.data;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  },
  async writeBinary(path: string, data: ArrayBuffer | Buffer): Promise<void> {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    localFiles.set(path, { data: new Uint8Array(bytes), mtime: Date.now() });
  },
  async stat(path: string) {
    const entry = localFiles.get(path);
    return entry ? { mtime: entry.mtime, size: entry.data.byteLength } : null;
  },
  async mkdir() {},
};

const vault = {
  adapter,
  getFiles() {
    return Array.from(localFiles.keys()).map((path) => ({ path }));
  },
};

// ---------------------------------------------------------------------------
// Tests — defer SyncEngine import until after mock.module has registered.
// ---------------------------------------------------------------------------

describe("round-trip", () => {
  beforeEach(() => {
    mockBucket.clear();
    localFiles.clear();
  });
  afterEach(() => {
    mockBucket.clear();
    localFiles.clear();
  });

  test("downloads a remote-only file into the local vault", async () => {
    const { SyncEngine } = await import("../src/index.ts");
    const remoteBytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    mockBucket.set("note.md", {
      body: remoteBytes,
      etag: bytesToEtag(remoteBytes),
      lastModified: new Date(),
    });

    const engine = new SyncEngine(
      vault,
      {
        endpoint: "https://mock",
        accessKeyId: "k",
        secretAccessKey: "s",
        bucket: "test-bucket",
        syncIntervalSeconds: 0,
        ignorePatterns: "",
      },
      { files: {} } as SyncState
    );

    const result = await engine.fullSync();
    expect(result.errors).toEqual([]);
    expect(result.downloaded).toBe(1);
    expect(result.uploaded).toBe(0);

    const local = localFiles.get("note.md");
    expect(local).toBeDefined();
    expect(Array.from(local!.data)).toEqual(Array.from(remoteBytes));
    expect(engine.getState().files["note.md"]).toBeDefined();
  });

  test("uploads a local-only file to remote", async () => {
    const { SyncEngine } = await import("../src/index.ts");
    const localBytes = new Uint8Array([1, 2, 3, 4, 5]);
    localFiles.set("up.md", { data: localBytes, mtime: Date.now() });

    const engine = new SyncEngine(
      vault,
      {
        endpoint: "https://mock",
        accessKeyId: "k",
        secretAccessKey: "s",
        bucket: "test-bucket",
        syncIntervalSeconds: 0,
        ignorePatterns: "",
      },
      { files: {} } as SyncState
    );

    const result = await engine.fullSync();
    expect(result.errors).toEqual([]);
    expect(result.uploaded).toBe(1);
    expect(result.downloaded).toBe(0);

    const remote = mockBucket.get("up.md");
    expect(remote).toBeDefined();
    expect(Array.from(remote!.body)).toEqual(Array.from(localBytes));
  });

  test("deleteRemote drops the bucket entry and the state record", async () => {
    const { SyncEngine } = await import("../src/index.ts");
    const bytes = new Uint8Array([9, 9, 9]);
    mockBucket.set("kill.md", {
      body: bytes,
      etag: bytesToEtag(bytes),
      lastModified: new Date(),
    });

    const state: SyncState = {
      files: {
        "kill.md": {
          localMtime: 0,
          remoteEtag: bytesToEtag(bytes),
          remoteLastModified: Date.now(),
          lastSynced: Date.now(),
        },
      },
    };
    const engine = new SyncEngine(
      vault,
      {
        endpoint: "https://mock",
        accessKeyId: "k",
        secretAccessKey: "s",
        bucket: "test-bucket",
        syncIntervalSeconds: 0,
        ignorePatterns: "",
      },
      state
    );

    await engine.deleteRemote("kill.md");
    expect(mockBucket.has("kill.md")).toBe(false);
    expect(engine.getState().files["kill.md"]).toBeUndefined();
  });

  test("handleRename: deletes old remote key, uploads new key", async () => {
    const { SyncEngine } = await import("../src/index.ts");
    const bytes = new Uint8Array([4, 2]);
    mockBucket.set("old.md", {
      body: bytes,
      etag: bytesToEtag(bytes),
      lastModified: new Date(),
    });
    localFiles.set("new.md", { data: bytes, mtime: Date.now() });

    const engine = new SyncEngine(
      vault,
      {
        endpoint: "https://mock",
        accessKeyId: "k",
        secretAccessKey: "s",
        bucket: "test-bucket",
        syncIntervalSeconds: 0,
        ignorePatterns: "",
      },
      { files: {} } as SyncState
    );

    await engine.handleRename("old.md", "new.md");
    expect(mockBucket.has("old.md")).toBe(false);
    expect(mockBucket.has("new.md")).toBe(true);
  });

  test("byte-identical round-trip: local → remote → fresh local equals original", async () => {
    const { SyncEngine } = await import("../src/index.ts");
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) original[i] = i; // every byte value
    localFiles.set("payload.bin", { data: original, mtime: Date.now() });

    const enginePush = new SyncEngine(
      vault,
      {
        endpoint: "https://mock",
        accessKeyId: "k",
        secretAccessKey: "s",
        bucket: "test-bucket",
        syncIntervalSeconds: 0,
        ignorePatterns: "",
      },
      { files: {} } as SyncState
    );
    await enginePush.fullSync();
    expect(mockBucket.has("payload.bin")).toBe(true);

    // Wipe local and pull back down with a fresh engine + fresh state.
    localFiles.clear();
    const enginePull = new SyncEngine(
      vault,
      {
        endpoint: "https://mock",
        accessKeyId: "k",
        secretAccessKey: "s",
        bucket: "test-bucket",
        syncIntervalSeconds: 0,
        ignorePatterns: "",
      },
      { files: {} } as SyncState
    );
    await enginePull.fullSync();

    const recovered = localFiles.get("payload.bin");
    expect(recovered).toBeDefined();
    expect(Array.from(recovered!.data)).toEqual(Array.from(original));
  });
});
