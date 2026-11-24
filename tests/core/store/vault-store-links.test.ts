/**
 * In a vault's reserved store folder (`.open-second-brain-store/`) the store
 * root and its partition folders arrive with the vault's sync, so a link
 * there (a junction on Windows) is no choice of this machine's user: the
 * store is neither opened nor written through one, and status and doctor
 * say why (`safe-fs.ts`, `store-open.ts`). An explicit store root outside
 * the vault keeps accepting a linked partition folder.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import type { PlatformDirsEnv } from "../../../src/core/platform-dirs.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { writeBlob } from "../../../src/core/store/blobs.ts";
import { STORE_VAULT_DIR } from "../../../src/core/store/constants.ts";
import { StoreUnsafePathError } from "../../../src/core/store/safe-fs.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import {
  inspectStore,
  LinkedVaultStoreFolderError,
  openStore,
} from "../../../src/core/store/store-open.ts";
import { relocateStore } from "../../../src/core/store/store-relocation.ts";
import { buildStoreStatusBlock } from "../../../src/core/store/store-status.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import {
  EVENT,
  machineOnOldDefault,
  staleHandle,
  type OldDefaultMachine,
} from "./fixtures/old-default-store.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const LINK = process.platform === "win32" ? "junction" : "dir";

let scratch: string | null = null;
let machine: OldDefaultMachine | null = null;
afterEach(() => {
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  scratch = null;
  machine?.fleet.cleanup();
  machine = null;
});

interface Store {
  readonly root: string;
  readonly elsewhere: string;
  readonly dirs: PlatformDirsEnv;
}

/** A store at `<scratch>/<rel>`, created with both partitions, and a folder outside it. */
function storeAt(rel: string): Store {
  scratch = mkdtempSync(join(tmpdir(), "osb-vault-store-links-"));
  const root = join(scratch, ...rel.split("/"));
  initStore({ root });
  const dirs: PlatformDirsEnv = {
    platform: process.platform,
    home: join(scratch, "home"),
    env: { XDG_STATE_HOME: join(scratch, "state"), LOCALAPPDATA: join(scratch, "state") },
  };
  return { root, elsewhere: join(scratch, "elsewhere"), dirs };
}

/** Replace the folder `path` with a link to `target`, where its contents now are. */
function moveBehindLink(path: string, target: string): void {
  renameSync(path, target);
  symlinkSync(target, path, LINK);
}

/** Every file below `dir` with its size, so a write through a link shows. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((rel) => statSync(join(dir, rel)).isFile())
    .map((rel) => `${rel}:${readFileSync(join(dir, rel)).length}`)
    .toSorted();
}

describe("the vault's store folder", () => {
  test("a partition folder that is a link: the store is not opened through it", () => {
    const { root, elsewhere, dirs } = storeAt(`vault/${STORE_VAULT_DIR}`);
    const shared = join(root, "shared");
    moveBehindLink(shared, elsewhere);
    expect(() => openStore({ root, device: "dev-a", dirs })).toThrow(LinkedVaultStoreFolderError);
    expect(() => openStore({ root, device: "dev-a", dirs })).toThrow(shared);
    expect(() => inspectStore(root)).toThrow(LinkedVaultStoreFolderError);
  });

  test("a partition folder that becomes a link after the open: nothing is written through it", () => {
    const { root, elsewhere, dirs } = storeAt(`vault/${STORE_VAULT_DIR}`);
    const store = openStore({ root, device: "dev-a", dirs });
    const shared = join(root, "shared");
    moveBehindLink(shared, elsewhere);
    const before = filesUnder(elsewhere);
    expect(() => appendRecord(store, EVENT)).toThrow(StoreUnsafePathError);
    expect(() => appendRecord(store, EVENT)).toThrow(shared);
    expect(() => writeBlob(shared, "a blob")).toThrow(StoreUnsafePathError);
    expect(filesUnder(elsewhere)).toEqual(before);
  });

  test("the folder itself is a link: the store is neither opened nor written through it", () => {
    const { root, elsewhere, dirs } = storeAt(`vault/${STORE_VAULT_DIR}`);
    const store = openStore({ root, device: "dev-a", dirs });
    moveBehindLink(root, elsewhere);
    const before = filesUnder(elsewhere);
    expect(() => openStore({ root, device: "dev-a", dirs })).toThrow(LinkedVaultStoreFolderError);
    expect(() => inspectStore(root)).toThrow(root);
    expect(() => appendRecord(store, EVENT)).toThrow(StoreUnsafePathError);
    expect(() => writeBlob(join(root, "shared"), "a blob")).toThrow(StoreUnsafePathError);
    expect(filesUnder(elsewhere)).toEqual(before);
  });

  test("status and doctor name the linked folder", async () => {
    machine = machineOnOldDefault();
    const { a } = machine;
    staleHandle(a);
    expect(relocateStore().kind).toBe("relocated");
    a.use();
    expect(a.root()).toBe(a.vaultStore);
    const shared = join(a.vaultStore, "shared");
    moveBehindLink(shared, join(a.home, "elsewhere"));
    const status = buildStoreStatusBlock({ vault: a.vault, configPath: null });
    expect(status["error"]).toBe(new LinkedVaultStoreFolderError(shared).message);
    const doctor = JSON.stringify(await runDoctor(a.vault));
    expect(doctor).toContain("store-root-invalid");
    expect(doctor).toContain(JSON.stringify(new LinkedVaultStoreFolderError(shared).message));
  });
});

describe("an explicit store root outside the vault", () => {
  test("a partition folder that is a link stays the user's choice", () => {
    const { root, elsewhere, dirs } = storeAt("store");
    moveBehindLink(join(root, "shared"), elsewhere);
    const store = openStore({ root, device: "dev-a", dirs });
    expect([...store.partitions].toSorted()).toEqual(["private", "shared"]);
    appendRecord(store, EVENT);
    expect(filesUnder(join(elsewhere, "events")).length).toBe(1);
  });
});

describe("a store root configured as an alias of the vault's store folder", () => {
  test("keeps the folder's link rule: a sync that turns the folder into a link is refused at the next write", () => {
    const store = storeAt(`vault/${STORE_VAULT_DIR}`);
    // The person's alias outside the vault, leading to the reserved folder.
    const alias = join(scratch!, "my-store");
    symlinkSync(store.root, alias, LINK);
    const handle = openStore({ root: alias, device: "dev-a", dirs: store.dirs });
    // Through the unchanged alias, writes go on.
    appendRecord(handle, EVENT);
    // The sync replaces the reserved folder with a link to a folder of another name.
    const other = join(scratch!, "vault", "other-folder");
    moveBehindLink(store.root, other);
    const before = filesUnder(other);
    expect(() => appendRecord(handle, EVENT)).toThrow(StoreUnsafePathError);
    expect(() => openStore({ root: alias, device: "dev-a", dirs: store.dirs })).toThrow(
      LinkedVaultStoreFolderError,
    );
    expect(filesUnder(other)).toEqual(before);
  });
});
