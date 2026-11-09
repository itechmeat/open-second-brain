/**
 * Machine state on a switched machine whose legacy tree is still in the
 * vault: storage measures the state dot-dirs in the device-local state and
 * counts a copy the legacy tree keeps in the vault under the tree surface,
 * and a protect manifest write leaves nothing in the vault.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  PROTECT_SCHEMA_VERSION,
  readManifest,
  writeManifest,
} from "../../../src/core/brain/protect.ts";
import { resolveSecretReadOnly, setSecret } from "../../../src/core/brain/secrets/store.ts";
import { measureStorageUsage } from "../../../src/core/brain/storage/usage.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

let env: StoreEnv;

beforeEach(() => {
  env = makeStoreEnv("osb-storage-switched-");
  switchDevice(env.storeRoot);
});

afterEach(() => env.cleanup());

const treeBytes = (): number =>
  measureStorageUsage(env.vault, { configPath: env.configPath }).surfaces.find(
    (s) => s.surface === "brain_tree",
  )?.bytes ?? 0;

test("a leftover in-vault state copy is counted by the tree surface", () => {
  const before = treeBytes();
  mkdirSync(join(env.vault, "Brain", ".state"), { recursive: true });
  writeFileSync(join(env.vault, "Brain", ".state", "leftover.bin"), Buffer.alloc(4096));
  expect(treeBytes() - before).toBe(4096);
});

test("a protect manifest write on a switched machine leaves no folder in the vault", () => {
  writeManifest(env.vault, {
    schema_version: PROTECT_SCHEMA_VERSION,
    target: "claudecode",
    vault: env.vault,
    owned_deny: [],
    owned_allow: [],
  });
  expect(readManifest(env.vault, "claudecode")?.target).toBe("claudecode");
  expect(existsSync(join(env.vault, ".open-second-brain"))).toBe(false);
});

test("secrets a vault kept before its tree left are read from the moved state", () => {
  const fresh = makeStoreEnv("osb-secrets-moved-");
  try {
    setSecret(fresh.vault, {
      name: "api",
      value: "s3cret",
      agent: "tester",
      now: new Date("2026-11-06T12:00:00Z"),
    });
    // The vault loses its legacy tree: its machine state now lives in the
    // device-local state, and the vault copy is left in place.
    rmSync(join(fresh.vault, "Brain"), { recursive: true, force: true });
    expect(resolveSecretReadOnly(fresh.vault, "api").value).toBe("s3cret");
    expect(existsSync(join(fresh.vault, ".open-second-brain", "secrets", "keyfile"))).toBe(true);
  } finally {
    fresh.cleanup();
  }
});
