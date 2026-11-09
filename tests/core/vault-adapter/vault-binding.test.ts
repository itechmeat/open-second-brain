/**
 * The vault binding of a store-only vault (design D14 items 8 and 13,
 * task 2.10): no marker file in the vault; init and the migration bind the
 * vault (its real path and its root directory identity) to the store in
 * the device-local state, and the note tools refuse a vault swapped under
 * that binding. A legacy vault keeps `Brain/vault-id.json`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";

import { writeVaultIdentity } from "../../../src/core/brain/vault-identity.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { DEVICE_SWITCHED_KIND } from "../../../src/core/store/store-only.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { assertNoteVaultForWrite } from "../../../src/core/vault-adapter/index.ts";
import {
  bindVaultToStore,
  vaultBindingPath,
  vaultBindingStatus,
  VaultBindingMismatchError,
  VaultBindingsUnreadableError,
  VAULT_BINDING_FILE,
  unbindVaultFromStore,
} from "../../../src/core/vault-adapter/vault-binding.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function fresh(prefix: string, options: { device?: string } = {}): StoreEnv {
  env = makeStoreEnv(prefix, { legacyTree: false, ...options });
  return env;
}

describe("binding a store-only vault", () => {
  test("binds in the device-local state and writes nothing into the vault", () => {
    const e = fresh("osb-vbind-bind-");
    const binding = bindVaultToStore(e.vault, { configPath: e.configPath });
    expect(binding).not.toBeNull();
    expect(binding!.root).toBe(e.storeRoot);
    expect(existsSync(vaultBindingPath())).toBe(true);
    expect(vaultBindingPath().startsWith(join(e.parent, "state"))).toBe(true);
    expect(readdirSync(e.vault)).toEqual([]);
    expect(vaultBindingStatus(e.vault, { configPath: e.configPath }).state).toBe("match");
  });

  test("the migration binds with its own store handle", () => {
    const e = fresh("osb-vbind-handle-", { device: "" });
    const store = openStore({ root: e.storeRoot, device: "dev-m" });
    const binding = bindVaultToStore(e.vault, { store });
    expect(binding?.device).toBe("dev-m");
    expect(binding?.store_id).toBe(store.storeId);
    expect(vaultBindingStatus(e.vault, { configPath: e.configPath }).state).toBe("match");
  });

  test("an unbound vault is reported unbound and the note guard lets it through", () => {
    const e = fresh("osb-vbind-unbound-");
    expect(vaultBindingStatus(e.vault, { configPath: e.configPath }).state).toBe("unbound");
    expect(assertNoteVaultForWrite(e.vault, "create note")).toBe(e.vault);
  });

  test("a machine with no device id has no device-local state to bind in", () => {
    const e = fresh("osb-vbind-nodevice-", { device: "" });
    expect(bindVaultToStore(e.vault, { configPath: e.configPath })).toBeNull();
    expect(existsSync(vaultBindingPath())).toBe(false);
  });

  test("another vault directory is refused by the note guard", () => {
    const e = fresh("osb-vbind-other-");
    bindVaultToStore(e.vault, { configPath: e.configPath });
    const other = join(e.parent, "other-vault");
    mkdirSync(other);
    const status = vaultBindingStatus(other, { configPath: e.configPath });
    expect(status.state).toBe("mismatch");
    expect(() => assertNoteVaultForWrite(other, "create note")).toThrow(VaultBindingMismatchError);
  });

  test("a directory swapped in at the bound path is refused", () => {
    const e = fresh("osb-vbind-swap-");
    bindVaultToStore(e.vault, { configPath: e.configPath });
    // The original stays on disk, so the new directory cannot reuse its inode.
    renameSync(e.vault, join(e.parent, "vault-original"));
    mkdirSync(e.vault);
    const status = vaultBindingStatus(e.vault, { configPath: e.configPath });
    expect(status.state).toBe("mismatch");
    if (status.state === "mismatch") expect(status.detail).toContain("replaced");
    expect(() => assertNoteVaultForWrite(e.vault, "create note")).toThrow(
      VaultBindingMismatchError,
    );
  });

  test("the bound vault moved to another path is still the bound vault", () => {
    const e = fresh("osb-vbind-moved-");
    bindVaultToStore(e.vault, { configPath: e.configPath });
    const moved = join(e.parent, "vault-moved");
    renameSync(e.vault, moved);
    expect(vaultBindingStatus(moved, { configPath: e.configPath }).state).toBe("match");
  });

  test("an unreadable binding file refuses note writes and is kept aside by a new bind", () => {
    const e = fresh("osb-vbind-corrupt-");
    bindVaultToStore(e.vault, { configPath: e.configPath });
    writeFileSync(vaultBindingPath(), "{ not json");
    const other = join(e.parent, "other-vault");
    mkdirSync(other);
    expect(vaultBindingStatus(other, { configPath: e.configPath }).state).toBe("unreadable");
    expect(() => assertNoteVaultForWrite(other, "create note")).toThrow(
      VaultBindingsUnreadableError,
    );
    bindVaultToStore(e.vault, { configPath: e.configPath });
    expect(vaultBindingStatus(e.vault, { configPath: e.configPath }).state).toBe("match");
    const kept = readdirSync(dirname(vaultBindingPath())).filter((n) =>
      n.startsWith(`${VAULT_BINDING_FILE}.unreadable-`),
    );
    expect(kept).toHaveLength(1);
  });

  test("a rollback's unbind leaves an unreadable binding file in place", () => {
    const e = fresh("osb-vbind-unbind-corrupt-");
    bindVaultToStore(e.vault, { configPath: e.configPath });
    writeFileSync(vaultBindingPath(), "{ not json");
    unbindVaultFromStore(e.storeRoot);
    // Still refusing: the damaged file was neither dropped nor emptied.
    expect(readFileSync(vaultBindingPath(), "utf8")).toBe("{ not json");
    expect(vaultBindingStatus(e.vault, { configPath: e.configPath }).state).toBe("unreadable");
  });

  test("a binding file that cannot be read at all is never moved aside", () => {
    const e = fresh("osb-vbind-io-");
    bindVaultToStore(e.vault, { configPath: e.configPath });
    // A folder at the file's name: every read is an I/O error, not a parse error.
    rmSync(vaultBindingPath());
    mkdirSync(vaultBindingPath());
    expect(() => bindVaultToStore(e.vault, { configPath: e.configPath })).toThrow(
      VaultBindingsUnreadableError,
    );
    expect(statSync(vaultBindingPath()).isDirectory()).toBe(true);
    const kept = readdirSync(dirname(vaultBindingPath())).filter((n) =>
      n.startsWith(`${VAULT_BINDING_FILE}.unreadable-`),
    );
    expect(kept).toHaveLength(0);
  });

  test("a store root spelled another way finds the binding", () => {
    const e = fresh("osb-vbind-spelling-");
    // The migration binds with its store handle's root as given: here with
    // a trailing separator, which the configured root never carries.
    const store = openStore({ root: `${e.storeRoot}${sep}`, device: "dev-a" });
    bindVaultToStore(e.vault, { store });
    const other = join(e.parent, "other-vault");
    mkdirSync(other);
    expect(vaultBindingStatus(other, { configPath: e.configPath }).state).toBe("mismatch");
    unbindVaultFromStore(e.storeRoot);
    expect(vaultBindingStatus(other, { configPath: e.configPath }).state).toBe("unbound");
  });

  test("binding again accepts the swapped vault", () => {
    const e = fresh("osb-vbind-rebind-");
    bindVaultToStore(e.vault, { configPath: e.configPath });
    const other = join(e.parent, "other-vault");
    mkdirSync(other);
    bindVaultToStore(other, { configPath: e.configPath });
    expect(vaultBindingStatus(other, { configPath: e.configPath }).state).toBe("match");
    expect(assertNoteVaultForWrite(other, "create note")).toBe(other);
  });

  test("a legacy vault with its own marker keeps its marker guard and ignores the binding", () => {
    env = makeStoreEnv("osb-vbind-legacy-");
    const e = env;
    const other = join(e.parent, "other-vault");
    mkdirSync(join(other, "Brain"), { recursive: true });
    writeFileSync(join(other, "Brain", "_brain.yaml"), "schema_version: 1\n");
    writeVaultIdentity(other);
    bindVaultToStore(e.vault, { configPath: e.configPath });
    expect(assertNoteVaultForWrite(other, "create note")).toBe(other);
  });

  test("the refusal names no other vault's path", () => {
    const e = fresh("osb-vbind-nopath-");
    const other = join(e.parent, "bound-elsewhere");
    mkdirSync(other, { recursive: true });
    bindVaultToStore(other, { configPath: e.configPath });
    let message = "";
    try {
      assertNoteVaultForWrite(e.vault, "create note");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("not the vault bound to the brain store");
    expect(message).not.toContain(other);
  });

  test("a stray Brain/ folder with no marker does not bypass the binding", () => {
    env = makeStoreEnv("osb-vbind-stray-");
    const e = env;
    const other = join(e.parent, "other-vault");
    mkdirSync(join(other, "Brain"), { recursive: true });
    bindVaultToStore(e.vault, { configPath: e.configPath });
    expect(() => assertNoteVaultForWrite(other, "create note")).toThrow(VaultBindingMismatchError);
  });

  test("an unswitched legacy vault with no marker is not refused for a damaged binding file", () => {
    env = makeStoreEnv("osb-vbind-unswitched-corrupt-");
    const e = env;
    bindVaultToStore(e.vault, { configPath: e.configPath });
    writeFileSync(vaultBindingPath(), "{ not json");
    const legacy = join(e.parent, "legacy-vault");
    mkdirSync(join(legacy, "Brain"), { recursive: true });
    expect(assertNoteVaultForWrite(legacy, "create note")).toBe(legacy);
  });

  test("a switched machine whose legacy tree is kept checks the binding", () => {
    env = makeStoreEnv("osb-vbind-switched-");
    const e = env;
    appendRecord(openStore({ root: e.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "settings",
      kind: DEVICE_SWITCHED_KIND,
      agent: "o2b",
      body: { authority: "human", vault_id: null, device: "dev-a" },
    });
    const other = join(e.parent, "other-vault");
    mkdirSync(join(other, "Brain"), { recursive: true });
    writeVaultIdentity(other);
    bindVaultToStore(e.vault, { configPath: e.configPath });
    expect(assertNoteVaultForWrite(e.vault, "create note")).toBe(e.vault);
    expect(() => assertNoteVaultForWrite(other, "create note")).toThrow(VaultBindingMismatchError);
  });
});
