/**
 * Adapter-shape parity test. Inspects ../src/index.ts directly and asserts
 * it exports the frozen public surface documented in PROVENANCE.md "Public
 * API surface" section. Because PROVENANCE.md was authored from the union
 * of both vendored copies' exports (plugin + daemon),
 * any method dropped during the merge fires this test.
 *
 * The test does NOT read the vendored files directly at runtime — it relies
 * on PROVENANCE.md as the merge contract. If a future refactor changes
 * either vendored copy's surface, PROVENANCE.md must be re-derived first
 * and this test updated accordingly.
 */
import { describe, expect, test } from "bun:test";
import * as engineModule from "../src/index.ts";
import type {
  R2SyncSettings,
  SyncState,
  FileSyncRecord,
  VaultAdapterLike,
} from "../src/index.ts";

describe("api-surface", () => {
  test("exports SyncEngine class", () => {
    expect(typeof engineModule.SyncEngine).toBe("function");
  });

  test("SyncEngine prototype has every method both vendored copies exposed", () => {
    const expectedMethods = [
      "updateSettings",
      "updateState",
      "getState",
      "isConfigured",
      "uploadFile",
      "deleteRemote",
      "handleRename",
      "fullSync",
    ];
    for (const name of expectedMethods) {
      expect(typeof engineModule.SyncEngine.prototype[name as keyof typeof engineModule.SyncEngine.prototype]).toBe(
        "function"
      );
    }
  });

  test("R2SyncSettings type has the expected fields (compile-time + runtime sentinel)", () => {
    // Compile-time: this object must satisfy R2SyncSettings.
    const sentinel: R2SyncSettings = {
      endpoint: "",
      accessKeyId: "",
      secretAccessKey: "",
      bucket: "",
      syncIntervalSeconds: 0,
      ignorePatterns: "",
    };
    expect(Object.keys(sentinel).sort()).toEqual(
      [
        "accessKeyId",
        "bucket",
        "endpoint",
        "ignorePatterns",
        "secretAccessKey",
        "syncIntervalSeconds",
      ].sort()
    );
  });

  test("SyncState + FileSyncRecord types have the expected fields", () => {
    const record: FileSyncRecord = {
      localMtime: 0,
      remoteEtag: "",
      remoteLastModified: 0,
      lastSynced: 0,
    };
    const state: SyncState = { files: { foo: record } };
    expect(Object.keys(record).sort()).toEqual(
      ["lastSynced", "localMtime", "remoteEtag", "remoteLastModified"].sort()
    );
    expect(Object.keys(state)).toEqual(["files"]);
  });

  test("VaultAdapterLike contract — required methods + optional path helpers", () => {
    // Compile-time check: this minimal adapter must satisfy VaultAdapterLike.
    const minimal: VaultAdapterLike = {
      async readBinary() {
        return new ArrayBuffer(0);
      },
      async writeBinary() {},
      async stat() {
        return null;
      },
      async mkdir() {},
    };
    expect(typeof minimal.readBinary).toBe("function");
    // getBasePath / getFullPath must be OPTIONAL (compile-time check via
    // the absence of those keys above; runtime check via undefined).
    expect((minimal as VaultAdapterLike).getBasePath).toBeUndefined();
    expect((minimal as VaultAdapterLike).getFullPath).toBeUndefined();
  });

  test("isConfigured() returns false on empty credentials (matches both vendored copies)", () => {
    const settings: R2SyncSettings = {
      endpoint: "",
      accessKeyId: "",
      secretAccessKey: "",
      bucket: "",
      syncIntervalSeconds: 0,
      ignorePatterns: "",
    };
    const state: SyncState = { files: {} };
    const vault = {
      adapter: {
        async readBinary() {
          return new ArrayBuffer(0);
        },
        async writeBinary() {},
        async stat() {
          return null;
        },
        async mkdir() {},
      } as VaultAdapterLike,
      getFiles() {
        return [] as Array<{ path: string }>;
      },
    };
    const engine = new engineModule.SyncEngine(vault, settings, state);
    expect(engine.isConfigured()).toBe(false);
  });
});
