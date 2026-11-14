import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STORE_ROOT_CONFIG_KEY, STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import {
  blobPath,
  blobStamp,
  deviceStateDirFor,
  isPathInside,
  partitionDir,
  resolveStoreRoot,
  shardPath,
  shardRelPath,
  StoreRootInsideVaultError,
  type StoreRootSource,
} from "../../../src/core/store/store-paths.ts";

const posixSource = (over: Partial<StoreRootSource> = {}): StoreRootSource => ({
  platform: "linux",
  home: "/home/u",
  env: {},
  config: {},
  configPath: "/home/u/.config/open-second-brain/config.yaml",
  vault: "/home/u/vault",
  ...over,
});

const windowsSource = (over: Partial<StoreRootSource> = {}): StoreRootSource => ({
  platform: "win32",
  home: "C:\\Users\\u",
  env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
  config: {},
  configPath: "C:\\Users\\u\\AppData\\Local\\open-second-brain\\config.yaml",
  vault: "D:\\Vault",
  ...over,
});

describe("store root resolution", () => {
  test("defaults to the per-user data directory", () => {
    expect(resolveStoreRoot(posixSource())).toEqual({
      root: "/home/u/.local/share/open-second-brain/store",
      origin: "default",
    });
  });

  test("the default honours XDG_DATA_HOME", () => {
    expect(resolveStoreRoot(posixSource({ env: { XDG_DATA_HOME: "/data" } })).root).toBe(
      "/data/open-second-brain/store",
    );
  });

  test("the config key overrides the default, with ~ and relative values resolved", () => {
    expect(
      resolveStoreRoot(posixSource({ config: { [STORE_ROOT_CONFIG_KEY]: "~/sync/brain" } })),
    ).toEqual({
      root: "/home/u/sync/brain",
      origin: "config",
    });
    expect(
      resolveStoreRoot(posixSource({ config: { [STORE_ROOT_CONFIG_KEY]: "brain" } })).root,
    ).toBe("/home/u/.config/open-second-brain/brain");
  });

  test("the environment variable beats the config key", () => {
    const source = posixSource({
      env: { [STORE_ROOT_ENV]: "/srv/brain" },
      config: { [STORE_ROOT_CONFIG_KEY]: "/elsewhere" },
    });
    expect(resolveStoreRoot(source)).toEqual({ root: "/srv/brain", origin: "env" });
  });

  test("a root inside the vault is refused with an error naming the setting", () => {
    const fromConfig = posixSource({ config: { [STORE_ROOT_CONFIG_KEY]: "/home/u/vault/.brain" } });
    expect(() => resolveStoreRoot(fromConfig)).toThrow(StoreRootInsideVaultError);
    expect(() => resolveStoreRoot(fromConfig)).toThrow(STORE_ROOT_CONFIG_KEY);
    const fromEnv = posixSource({ env: { [STORE_ROOT_ENV]: "/home/u/vault" } });
    expect(() => resolveStoreRoot(fromEnv)).toThrow(STORE_ROOT_ENV);
  });

  test("a sibling whose name only starts with the vault's is not inside it", () => {
    expect(
      resolveStoreRoot(posixSource({ env: { [STORE_ROOT_ENV]: "/home/u/vault-brain" } })).root,
    ).toBe("/home/u/vault-brain");
  });

  test("a child folder whose name starts with two dots is inside the vault", () => {
    const dotted = posixSource({ env: { [STORE_ROOT_ENV]: "/home/u/vault/..store" } });
    expect(() => resolveStoreRoot(dotted)).toThrow(StoreRootInsideVaultError);
    expect(isPathInside("/home/u/vault/..store", "/home/u/vault", "linux")).toBe(true);
    expect(isPathInside("/home/u/other", "/home/u/vault", "linux")).toBe(false);
    expect(isPathInside("/home/u", "/home/u/vault", "linux")).toBe(false);
  });

  test("macOS compares without case, like its default volumes", () => {
    const mac = posixSource({
      platform: "darwin",
      home: "/Users/u",
      vault: "/Users/u/Notes/Vault",
      env: { [STORE_ROOT_ENV]: "/Users/u/notes/vault/store" },
    });
    expect(() => resolveStoreRoot(mac)).toThrow(StoreRootInsideVaultError);
    expect(isPathInside("/Users/u/notes/vault/store", "/Users/u/Notes/Vault", "linux")).toBe(false);
  });

  test("no vault configured means nothing to refuse", () => {
    expect(
      resolveStoreRoot(posixSource({ vault: null, env: { [STORE_ROOT_ENV]: "/home/u/vault/x" } }))
        .root,
    ).toBe("/home/u/vault/x");
  });

  describe("Windows paths", () => {
    test("defaults under LOCALAPPDATA", () => {
      expect(resolveStoreRoot(windowsSource()).root).toBe(
        "C:\\Users\\u\\AppData\\Local\\open-second-brain\\store",
      );
    });

    test("expands ~\\ and anchors a relative value to the config directory", () => {
      expect(
        resolveStoreRoot(windowsSource({ config: { [STORE_ROOT_CONFIG_KEY]: "~\\Brain" } })).root,
      ).toBe("C:\\Users\\u\\Brain");
      expect(
        resolveStoreRoot(windowsSource({ config: { [STORE_ROOT_CONFIG_KEY]: "brain" } })).root,
      ).toBe("C:\\Users\\u\\AppData\\Local\\open-second-brain\\brain");
    });

    test("refuses a root inside the vault regardless of case and separator", () => {
      const inside = windowsSource({ env: { [STORE_ROOT_ENV]: "d:/vault/Store" } });
      expect(() => resolveStoreRoot(inside)).toThrow(StoreRootInsideVaultError);
      expect(resolveStoreRoot(windowsSource({ env: { [STORE_ROOT_ENV]: "D:\\Brain" } })).root).toBe(
        "D:\\Brain",
      );
    });
  });
});

describe("store root inside the vault through a symlink", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "osb-store-paths-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test.skipIf(process.platform === "win32")("is refused once the link is resolved", () => {
    const vault = join(dir, "vault");
    mkdirSync(join(vault, "inner"), { recursive: true });
    const link = join(dir, "link");
    symlinkSync(join(vault, "inner"), link);
    const source = posixSource({ home: dir, vault, env: { [STORE_ROOT_ENV]: link } });
    expect(() => resolveStoreRoot(source)).toThrow(StoreRootInsideVaultError);
  });
});

describe("store layout paths", () => {
  test("shards are named by partition, stream, device and month", () => {
    expect(shardPath("/s", "shared", { stream: "events" }, "dev-a", "2026-11")).toBe(
      join("/s", "shared", "events", "dev-a", "2026-11.jsonl"),
    );
    expect(
      shardPath("/s", "private", { stream: "ledgers", ledger: "receipts" }, "dev-a", "2026-01"),
    ).toBe(join("/s", "private", "ledgers", "receipts", "dev-a", "2026-01.jsonl"));
    expect(shardRelPath({ stream: "ledgers", ledger: "receipts" }, "dev-a", "2026-01")).toBe(
      "ledgers/receipts/dev-a/2026-01.jsonl",
    );
  });

  test("a ledger stream needs a valid ledger name, other streams take none", () => {
    expect(() => shardRelPath({ stream: "ledgers" }, "dev-a", "2026-01")).toThrow();
    expect(() => shardRelPath({ stream: "ledgers", ledger: "../x" }, "dev-a", "2026-01")).toThrow();
    expect(() => shardRelPath({ stream: "events", ledger: "x" }, "dev-a", "2026-01")).toThrow();
    expect(() => shardRelPath({ stream: "events" }, "../dev", "2026-01")).toThrow();
  });

  test("blobs are fanned out by the first two hex characters", () => {
    const sha = "ab".padEnd(64, "0");
    expect(blobPath(partitionDir("/s", "shared"), sha)).toBe(
      join("/s", "shared", "blobs", "ab", sha),
    );
    expect(() => blobPath("/s/shared", "not-a-sha")).toThrow();
  });

  test("the device-local directory is keyed by store id and lives in the state directory", () => {
    const id = "01JBZ3NDEKTSV4RRFFQ69G5FAV";
    expect(deviceStateDirFor(id, { platform: "linux", home: "/home/u", env: {} })).toBe(
      "/home/u/.local/state/open-second-brain/stores/01JBZ3NDEKTSV4RRFFQ69G5FAV",
    );
    expect(
      deviceStateDirFor(id, {
        platform: "win32",
        home: "C:\\Users\\u",
        env: { LOCALAPPDATA: "C:\\L" },
      }),
    ).toBe("C:\\L\\open-second-brain\\stores\\01JBZ3NDEKTSV4RRFFQ69G5FAV");
    expect(() =>
      deviceStateDirFor("../../x", { platform: "linux", home: "/h", env: {} }),
    ).toThrow();
  });
});

describe("the blob availability stamp", () => {
  const SHA = "ab".padEnd(64, "0");
  const BLOB = "hello";

  let root = "";
  let partitionRoot = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "o2b-blobstamp-"));
    partitionRoot = partitionDir(root, "shared");
    mkdirSync(join(partitionRoot, "blobs", "ab"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("an absent blob reads as absent, a present one by its identity", () => {
    expect(blobStamp(partitionRoot, SHA)).toBe("absent");
    writeFileSync(blobPath(partitionRoot, SHA), BLOB);
    expect(blobStamp(partitionRoot, SHA)).not.toBe("absent");
    expect(blobStamp(partitionRoot, "zz")).toBe("absent");
  });

  test("a link swapped for the real file moves the stamp at a standstill of size and mtime", () => {
    writeFileSync(blobPath(partitionRoot, SHA), BLOB);
    const blobFile = blobPath(partitionRoot, SHA);
    const before = blobStamp(partitionRoot, SHA);
    // A twin of the same size, its mtime set back to the original's, with
    // the blob path turned into a link to it: the reader refuses the link,
    // and a size:mtime stamp would not notice the swap.
    const twin = join(root, "twin");
    writeFileSync(twin, BLOB);
    const stat = statSync(blobFile);
    utimesSync(twin, stat.atime, stat.mtime);
    rmSync(blobFile);
    symlinkSync(twin, blobFile, "file");
    expect(blobStamp(partitionRoot, SHA)).not.toBe(before);
    // The operator repairs the link in place (`mv`, `cp -p`): the size and
    // the mtime stay, only ctime moves.
    rmSync(blobFile);
    writeFileSync(blobFile, BLOB);
    utimesSync(blobFile, stat.atime, stat.mtime);
    expect(blobStamp(partitionRoot, SHA)).not.toBe(before);
  });

  test("the blobs/<ab> folder's identity is stamped too", () => {
    writeFileSync(blobPath(partitionRoot, SHA), BLOB);
    const abDir = join(partitionRoot, "blobs", "ab");
    const before = blobStamp(partitionRoot, SHA);
    // The blob's own folder arrives as a link (a synced move): the blob
    // file keeps its identity, the folder's does not, and the reader
    // refuses a blob whose fan-out folder is a link.
    const kept = join(root, "ab-real");
    renameSync(abDir, kept);
    symlinkSync(kept, abDir, "dir");
    expect(blobStamp(partitionRoot, SHA)).not.toBe(before);
  });
});
