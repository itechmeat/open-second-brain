/**
 * `o2b init`, `o2b brain init` and `o2b onboarding` with no vault (design
 * D14 items 1 and 8, task 2.10): init creates the store and nothing else,
 * a second run finds it, and the onboarding checklist walks the store.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { inspectStore } from "../../src/core/store/store-open.ts";
import { storesStateDir } from "../../src/core/store/store-paths.ts";
import {
  readVaultBindings,
  VAULT_BINDING_FILE,
} from "../../src/core/vault-adapter/vault-binding.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { runCli } from "../helpers/run-cli.ts";

let parent: string;
let configPath: string;
let storeRoot: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-init-no-vault-"));
  configPath = join(parent, "config.yaml");
  storeRoot = join(parent, "store");
  writeFileSync(configPath, "");
});

afterEach(() => {
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function env(): Record<string, string> {
  return {
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    [STORE_ROOT_ENV]: storeRoot,
    O2B_DEVICE_ID: "dev-a",
    HOME: join(parent, "home"),
    XDG_STATE_HOME: join(parent, "state"),
    LOCALAPPDATA: join(parent, "state"),
  };
}

describe("init with a fresh vault", () => {
  test("o2b init --vault creates the store and binds the vault, writing nothing in it", async () => {
    const vault = join(parent, "vault");
    mkdirSync(vault);
    const r = await runCli(["init", "--vault", vault], { env: env() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(`initialized the brain store: ${storeRoot}`);
    expect(r.stdout).toContain("vault bound to the brain store");
    expect(inspectStore(storeRoot)).not.toBeNull();
    expect(readdirSync(vault)).toEqual([]);
    const stateDir = storesStateDir({
      platform: process.platform,
      home: join(parent, "home"),
      env: env(),
    });
    const bindings = readVaultBindings(join(stateDir, VAULT_BINDING_FILE));
    expect(bindings.map((b) => b.root)).toEqual([storeRoot]);
    const again = await runCli(["init", "--vault", vault], { env: env() });
    expect(again.returncode).toBe(0);
    expect(again.stdout).toContain(`the brain store already exists: ${storeRoot}`);
  });

  test("o2b init --vault on a fresh vault records this device's switch once the store exists", async () => {
    const vault = join(parent, "vault");
    mkdirSync(vault);
    const r = await runCli(["init", "--vault", vault], { env: env() });
    expect(r.returncode).toBe(0);
    const switched = readPartition(join(storeRoot, "shared"))
      .flatMap((shard) => shard.records)
      .filter((record) => record.kind === "device-switched")
      .map((record) => record.body["device"]);
    expect(switched).toEqual(["dev-a"]);
  });
});

describe("init with a legacy vault", () => {
  test("o2b init --vault on a vault with a Brain/ tree creates no store", async () => {
    // A store moves the legacy vault's search index (design D5); the
    // migration, not init, is the legacy vault's way into the store.
    const vault = join(parent, "vault");
    mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
    writeFileSync(join(vault, "Brain", "inbox", "2026-11-01-a.md"), "---\nid: sig-a\n---\n");
    const r = await runCli(["init", "--vault", vault], { env: env() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("brain store");
    expect(inspectStore(storeRoot)).toBeNull();
  });

  test("a Brain/ of only what bootstrap writes is a fresh install: init creates the store", async () => {
    const vault = join(parent, "vault");
    mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
    writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
    const r = await runCli(["init", "--vault", vault], { env: env() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("vault bound to the brain store");
    expect(inspectStore(storeRoot)).not.toBeNull();
  });
});

describe("a vault configured after a vault-free switch", () => {
  test("an empty vault is just bound to the store", async () => {
    expect((await runCli(["init"], { env: env() })).returncode).toBe(0);
    const vault = join(parent, "vault");
    mkdirSync(vault, { recursive: true });
    const r = await runCli(["init", "--vault", vault], { env: env() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("vault bound to the brain store");
  });
});

describe("init with no vault", () => {
  test("o2b init creates the store, persists the agent name and walks onboarding", async () => {
    const r = await runCli(["init", "--agent-name", "tester"], { env: env() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(`initialized the brain store: ${storeRoot}`);
    expect(r.stdout).toContain("[ ] Record a first feedback signal");
    expect(r.stdout).toContain("[x] Create the brain store");
    expect(inspectStore(storeRoot)).not.toBeNull();
    expect(readFileSync(configPath, "utf8")).toContain('agent_name: "tester"');
    expect(readFileSync(configPath, "utf8")).not.toContain("vault:");
    const again = await runCli(["init"], { env: env() });
    expect(again.returncode).toBe(0);
    expect(again.stdout).toContain(`the brain store already exists: ${storeRoot}`);
  });

  test("o2b brain init creates the store and reports it as JSON", async () => {
    const r = await runCli(["brain", "init", "--json"], { env: env() });
    expect(r.returncode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      vault: unknown;
      created: unknown[];
      store: { status: string; root: string; partitions: string[] };
    };
    expect(out.vault).toBeNull();
    expect(out.created).toEqual([]);
    expect(out.store.status).toBe("created");
    expect(out.store.root).toBe(storeRoot);
    expect(out.store.partitions).toEqual(["shared", "private"]);
  });

  test("o2b onboarding answers the store checklist with no vault", async () => {
    const r = await runCli(["onboarding", "--json"], { env: env() });
    expect(r.returncode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      vault: unknown;
      data_ownership: unknown;
      steps: Array<{ id: string; done: boolean; optional: boolean }>;
    };
    expect(out.vault).toBeNull();
    expect(out.data_ownership).toBeNull();
    const store = out.steps.find((s) => s.id === "store_initialized")!;
    expect(store.done).toBe(false);
    expect(out.steps.find((s) => s.id === "vault_configured")!.optional).toBe(true);
  });
});

describe("init without --vault on an install that has one", () => {
  test("a legacy vault in the config gets no store and no switch record", async () => {
    const vault = join(parent, "vault");
    // Legacy data, not just a folder: a Brain/ of only what bootstrap
    // writes is a fresh install (`store/legacy-tree.ts`), which gets a store.
    mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
    writeFileSync(join(vault, "Brain", "preferences", "pref-old.md"), "---\nid: pref-old\n---\n");
    writeFileSync(configPath, `vault: ${vault}\n`);
    const r = await runCli(["init", "--agent-name", "tester"], { env: env() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("no vault configured");
    expect(inspectStore(storeRoot)).toBeNull();
    expect(readFileSync(configPath, "utf8")).toContain('agent_name: "tester"');
  });

  test("a session's VAULT_DIR is never written back as the machine's vault", async () => {
    const vault = join(parent, "vault");
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(configPath, `vault: ${vault}\n`);
    const session = join(parent, "session-vault");
    mkdirSync(session);
    const r = await runCli(["init", "--agent-name", "tester"], {
      env: { ...env(), VAULT_DIR: session },
    });
    expect(r.returncode).toBe(0);
    // The config spells paths with forward slashes on every platform.
    const config = readFileSync(configPath, "utf8").replaceAll("\\", "/");
    const posix = (path: string): string => path.replaceAll("\\", "/");
    expect(config).not.toContain(posix(session));
    expect(config).toContain(posix(vault));
  });

  test("an explicit blank --vault is refused, never the working directory", async () => {
    const r = await runCli(["init", "--vault", "  "], { env: env() });
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain("--vault");
    expect(readFileSync(configPath, "utf8")).not.toContain("vault:");
  });
});
