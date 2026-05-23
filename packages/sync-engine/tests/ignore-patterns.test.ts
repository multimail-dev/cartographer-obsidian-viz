/**
 * Ignore-pattern behavior test. Both vendored copies treat ignore patterns
 * as path-prefix matches (newline-separated). This guards against regressions
 * where a refactor accidentally switches to glob/regex semantics or skips
 * the prefix check on one of the writer paths (uploadFile, deleteRemote).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Reuse the same mock infrastructure as round-trip — minimal duplication
// because we only care about whether the engine CALLS the mock, not the
// full bidirectional logic.

const seenCommands: Array<{ kind: string; key?: string }> = [];

class ListObjectsV2Command {
  constructor(public input: { Bucket: string }) {}
}
class GetObjectCommand {
  constructor(public input: { Bucket: string; Key: string }) {}
}
class PutObjectCommand {
  constructor(public input: { Bucket: string; Key: string }) {}
}
class DeleteObjectCommand {
  constructor(public input: { Bucket: string; Key: string }) {}
}

class S3Client {
  constructor(_config: unknown) {}
  async send(cmd: unknown): Promise<unknown> {
    if (cmd instanceof ListObjectsV2Command) {
      seenCommands.push({ kind: "list" });
      return { Contents: [], NextContinuationToken: undefined };
    }
    if (cmd instanceof PutObjectCommand) {
      seenCommands.push({ kind: "put", key: cmd.input.Key });
      return { ETag: '"deadbeef"' };
    }
    if (cmd instanceof DeleteObjectCommand) {
      seenCommands.push({ kind: "delete", key: cmd.input.Key });
      return {};
    }
    if (cmd instanceof GetObjectCommand) {
      seenCommands.push({ kind: "get", key: cmd.input.Key });
      throw new Error(`unexpected GET in ignore-patterns test: ${cmd.input.Key}`);
    }
    throw new Error(`Unmocked: ${(cmd as object)?.constructor?.name}`);
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

import type { SyncState, VaultAdapterLike } from "../src/index.ts";

const adapter: VaultAdapterLike = {
  async readBinary() {
    return new Uint8Array([0]).buffer as ArrayBuffer;
  },
  async writeBinary() {},
  async stat() {
    return { mtime: Date.now(), size: 1 };
  },
  async mkdir() {},
};

const baseSettings = {
  endpoint: "https://mock",
  accessKeyId: "k",
  secretAccessKey: "s",
  bucket: "test-bucket",
  syncIntervalSeconds: 0,
  ignorePatterns: ".obsidian/\n.trash/",
};

describe("ignore-patterns", () => {
  beforeEach(() => {
    seenCommands.length = 0;
  });

  test("uploadFile skips paths with an ignored prefix (no PUT issued)", async () => {
    const { SyncEngine } = await import("../src/index.ts");
    const engine = new SyncEngine(
      { adapter, getFiles: () => [] },
      baseSettings,
      { files: {} } as SyncState
    );
    const result = await engine.uploadFile(".obsidian/workspace.json");
    expect(result).toBeNull();
    expect(seenCommands.filter((c) => c.kind === "put")).toEqual([]);
  });

  test("deleteRemote skips paths with an ignored prefix (no DELETE issued)", async () => {
    const { SyncEngine } = await import("../src/index.ts");
    const engine = new SyncEngine(
      { adapter, getFiles: () => [] },
      baseSettings,
      { files: {} } as SyncState
    );
    await engine.deleteRemote(".trash/old-note.md");
    expect(seenCommands.filter((c) => c.kind === "delete")).toEqual([]);
  });

  test("uploadFile DOES upload a non-ignored path", async () => {
    const { SyncEngine } = await import("../src/index.ts");
    const engine = new SyncEngine(
      { adapter, getFiles: () => [] },
      baseSettings,
      { files: {} } as SyncState
    );
    const result = await engine.uploadFile("notes/keeper.md");
    expect(result).not.toBeNull();
    const puts = seenCommands.filter((c) => c.kind === "put");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe("notes/keeper.md");
  });

  test("updateSettings applies new ignorePatterns immediately (no stale prefix list)", async () => {
    const { SyncEngine } = await import("../src/index.ts");
    const engine = new SyncEngine(
      { adapter, getFiles: () => [] },
      baseSettings,
      { files: {} } as SyncState
    );
    // Initially "draft/" is NOT ignored.
    let result = await engine.uploadFile("draft/x.md");
    expect(result).not.toBeNull();
    expect(seenCommands.filter((c) => c.kind === "put").map((c) => c.key)).toContain("draft/x.md");

    seenCommands.length = 0;
    engine.updateSettings({ ...baseSettings, ignorePatterns: "draft/\n" });

    // After updateSettings, "draft/" IS ignored.
    result = await engine.uploadFile("draft/y.md");
    expect(result).toBeNull();
    expect(seenCommands.filter((c) => c.kind === "put")).toEqual([]);
  });
});
