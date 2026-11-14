/**
 * The store identity check (design D14 item 13, task 2.10): a store-only
 * write binds the store and the device in the device-local state, and a
 * later write to another store at the same root, or as another device,
 * is refused with the `store-identity` reason; `o2b init` binds again.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureBrainStore } from "../../../src/core/brain/init-store.ts";
import { readStoreBindings, storeIdentityPath } from "../../../src/core/store/store-identity.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import { StoreWriteError, storeWrite } from "../../../src/core/store/store-write.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const BUILD = () => [
  {
    partition: "shared" as const,
    stream: "events" as const,
    kind: "note",
    agent: "test",
    body: { text: "hello" },
  },
];

const STORE_WRITE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "src",
  "core",
  "store",
  "store-write.ts",
);

/** The refusal reason of the same store write run in a fresh process (`null`: it went through). */
function reasonInChild(e: StoreEnv): string | null {
  const code =
    `import { storeWrite, StoreWriteError } from ${JSON.stringify(STORE_WRITE)};\n` +
    `try {\n` +
    `  storeWrite(() => [{ partition: "shared", stream: "events", kind: "note", agent: "test", body: { text: "hello" } }],\n` +
    `    { vault: null, configPath: ${JSON.stringify(e.configPath)} });\n` +
    `  console.log("reason=null");\n` +
    `} catch (err) {\n` +
    `  if (!(err instanceof StoreWriteError)) throw err;\n` +
    `  console.log("reason=" + err.reason);\n` +
    `}\n`;
  const child = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const match = /reason=(\S+)/.exec(child.stdout.toString());
  if (match === null) throw new Error(`child failed: ${child.stderr.toString()}`);
  return match[1] === "null" ? null : match[1]!;
}

function write(e: StoreEnv) {
  return storeWrite(BUILD, { vault: null, configPath: e.configPath });
}

function remakeStore(e: StoreEnv): void {
  rmSync(e.storeRoot, { recursive: true, force: true });
  initStore({ root: e.storeRoot });
}

function reasonOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof StoreWriteError ? err.reason : `other: ${String(err)}`;
  }
}

describe("store identity check", () => {
  test("the first store write binds the store and the device", () => {
    env = makeStoreEnv("osb-store-identity-bind-", { legacyTree: false, configureVault: false });
    expect(write(env)).toHaveLength(1);
    const bindings = readStoreBindings(storeIdentityPath());
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.root).toBe(env.storeRoot);
    expect(bindings[0]!.device).toBe("dev-a");
  });

  test("another store at the same root is refused, in this process and the next", () => {
    env = makeStoreEnv("osb-store-identity-swap-", { legacyTree: false, configureVault: false });
    write(env);
    remakeStore(env);
    expect(reasonOf(() => write(env!))).toBe("store-identity");
    // The next process starts with no pins: it refuses from the binding in
    // the device-local state alone.
    expect(reasonInChild(env)).toBe("store-identity");
  });

  test("another device id over the same device-local state is refused", () => {
    env = makeStoreEnv("osb-store-identity-device-", { legacyTree: false, configureVault: false });
    write(env);
    process.env["O2B_DEVICE_ID"] = "dev-b";
    expect(reasonOf(() => write(env!))).toBe("store-identity");
  });

  test("init binds the machine again, and writes go through", () => {
    env = makeStoreEnv("osb-store-identity-rebind-", { legacyTree: false, configureVault: false });
    write(env);
    remakeStore(env);
    expect(reasonOf(() => write(env!))).toBe("store-identity");
    ensureBrainStore({ configPath: env.configPath });
    expect(reasonOf(() => write(env!))).toBeNull();
  });

  test("a corrupt binding file refuses the write and keeps its content", () => {
    env = makeStoreEnv("osb-store-identity-corrupt-", { legacyTree: false, configureVault: false });
    write(env);
    remakeStore(env);
    writeFileSync(storeIdentityPath(), "{ not json");
    // The next process has no pins: the corrupt file must not bind the new store.
    expect(reasonInChild(env)).toBe("store-identity");
    expect(readFileSync(storeIdentityPath(), "utf8")).toBe("{ not json");
  });
});
