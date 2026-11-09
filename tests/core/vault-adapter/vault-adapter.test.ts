/**
 * The vault adapter (design D14 item 8, task 2.10): `.base` files only for
 * what this machine may use, wikilink audits and note tools refuse with
 * `vault_required` when there is no vault, and `brain init` with no vault
 * creates the store and writes nothing else; a switched machine writes no
 * legacy tree.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { auditMoc } from "../../../src/core/brain/link-graph/moc-audit.ts";
import { findUnlinkedMentions } from "../../../src/core/brain/link-graph/unlinked-mentions.ts";
import { buildAliasIndex } from "../../../src/core/brain/link-graph/alias-index.ts";
import { buildConceptCluster } from "../../../src/core/brain/link-graph/concept-cluster.ts";
import { createNote } from "../../../src/core/brain/notes/create-note.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { inspectStore, openStore } from "../../../src/core/store/store-open.ts";
import { readStoreBindings } from "../../../src/core/store/store-identity.ts";
import { isDeviceSwitched } from "../../../src/core/store-migration/migration-records.ts";
import { readDeviceId } from "../../../src/core/config.ts";
import { digestVaultTree } from "../../helpers/vault-digest.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import {
  BASE_TEMPLATES,
  basesFor,
  requireVaultAdapter,
  stampBaseTemplates,
  VAULT_ADAPTER_REQUIRED_CODE,
  VaultAdapterRequiredError,
  vaultAdapterActive,
} from "../../../src/core/vault-adapter/index.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function switchDevice(e: StoreEnv): void {
  appendRecord(openStore({ root: e.storeRoot, device: "dev-a" }), {
    partition: "shared",
    stream: "settings",
    kind: "device-switched",
    agent: "test",
    body: { authority: "human", device: "dev-a" },
  });
}

describe("vault adapter activation", () => {
  test("active only with a non-empty vault path", () => {
    expect(vaultAdapterActive("/some/vault")).toBe(true);
    expect(vaultAdapterActive(null)).toBe(false);
    expect(vaultAdapterActive("  ")).toBe(false);
    expect(vaultAdapterActive(undefined)).toBe(false);
  });

  test("a feature asked for with no vault refuses with vault_required, naming it", () => {
    expect(requireVaultAdapter("/v", "x")).toBe("/v");
    try {
      requireVaultAdapter(null, "note writes");
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(VaultAdapterRequiredError);
      expect((err as VaultAdapterRequiredError).code).toBe(VAULT_ADAPTER_REQUIRED_CODE);
      expect((err as Error).message).toContain("note writes needs a vault");
    }
  });

  test("wikilink audits and note tools refuse with no vault", () => {
    expect(() => auditMoc(null, "x")).toThrow(VaultAdapterRequiredError);
    expect(() => findUnlinkedMentions(null, "x")).toThrow(VaultAdapterRequiredError);
    expect(() => buildAliasIndex(null)).toThrow(VaultAdapterRequiredError);
    expect(() => buildConceptCluster(null, "x")).toThrow(VaultAdapterRequiredError);
    expect(() =>
      createNote(null as unknown as string, { path: "Notes/a.md", body: "x" } as never),
    ).toThrow(VaultAdapterRequiredError);
  });
});

describe(".base files", () => {
  test("no bundled base queries user notes, so a store-only machine gets none", () => {
    expect(BASE_TEMPLATES.every((t) => t.queries === "legacy-tree")).toBe(true);
    expect(basesFor(true)).toEqual([]);
    expect(basesFor(false).map((t) => t.file)).toEqual(BASE_TEMPLATES.map((t) => t.file));
  });

  test("stamping on a legacy machine writes every template once, force overwrites", () => {
    env = makeStoreEnv("osb-adapter-bases-", { legacyTree: false });
    mkdirSync(join(env.vault, "Brain", "bases"), { recursive: true });
    const first = stampBaseTemplates(env.vault, { storeOnly: false });
    expect(first.created).toHaveLength(BASE_TEMPLATES.length);
    const again = stampBaseTemplates(env.vault, { storeOnly: false });
    expect(again.skipped).toHaveLength(BASE_TEMPLATES.length);
    const forced = stampBaseTemplates(env.vault, { storeOnly: false, force: true });
    expect(forced.overwritten).toHaveLength(BASE_TEMPLATES.length);
  });

  test("stamping on a store-only machine writes nothing", () => {
    env = makeStoreEnv("osb-adapter-bases-so-", { legacyTree: false });
    const result = stampBaseTemplates(env.vault, { storeOnly: true });
    expect(result).toEqual({ created: [], overwritten: [], skipped: [] });
    expect(existsSync(join(env.vault, "Brain"))).toBe(false);
  });
});

describe("brain init", () => {
  test("with no vault it creates the store and writes nothing else", () => {
    env = makeStoreEnv("osb-adapter-init-none-", {
      legacyTree: false,
      configureVault: false,
      partitions: [],
    });
    const result = bootstrapBrain(null, { configPath: env.configPath });
    expect(result.legacyTree).toBe(false);
    expect(result.created).toEqual([]);
    expect(result.store?.status).toBe("created");
    expect(inspectStore(env.storeRoot)?.partitions.size).toBe(2);
    expect(readdirSync(env.vault)).toEqual([]);
    const again = bootstrapBrain(null, { configPath: env.configPath });
    expect(again.store?.status).toBe("existing");
    expect(again.store?.storeId).toBe(result.store?.storeId);
  });

  test("with no vault an existing store keeps its partitions", () => {
    env = makeStoreEnv("osb-adapter-init-shared-", {
      legacyTree: false,
      configureVault: false,
      partitions: ["shared"],
    });
    const result = bootstrapBrain(null, { configPath: env.configPath });
    expect(result.store?.partitions).toEqual(["shared"]);
  });

  test("with no vault it records this device's switch, as `o2b init` does", () => {
    env = makeStoreEnv("osb-adapter-init-switch-", {
      legacyTree: false,
      configureVault: false,
      partitions: [],
    });
    const result = bootstrapBrain(null, { configPath: env.configPath });
    const inspection = inspectStore(env.storeRoot);
    expect(inspection).not.toBeNull();
    expect(isDeviceSwitched(inspection!, "dev-a")).toBe(true);
    expect(result.freshSwitch).toEqual({ outcome: "recorded" });
    const again = bootstrapBrain(null, { configPath: env.configPath });
    expect(again.freshSwitch).toEqual({ outcome: "already-switched" });
  });

  test.skipIf(CHMOD_CANNOT_DENY)("a switch that could not be recorded is reported", () => {
    env = makeStoreEnv("osb-adapter-init-switch-fail-", {
      legacyTree: false,
      configureVault: false,
      partitions: ["shared"],
    });
    const shared = join(env.storeRoot, "shared");
    chmodSync(shared, 0o500);
    try {
      const result = bootstrapBrain(null, { configPath: env.configPath });
      expect(result.freshSwitch?.outcome).toBe("error");
      expect(result.freshSwitch?.detail).toBeTruthy();
    } finally {
      chmodSync(shared, 0o700);
    }
  });

  test("a first init with no device id binds the store to the id it mints", () => {
    env = makeStoreEnv("osb-adapter-init-mint-", {
      legacyTree: false,
      configureVault: false,
      partitions: [],
    });
    delete process.env["O2B_DEVICE_ID"];
    const result = bootstrapBrain(null, { configPath: env.configPath });
    const device = readDeviceId(env.configPath);
    expect(device).not.toBeNull();
    expect(readStoreBindings()).toContainEqual(
      expect.objectContaining({ store_id: result.store?.storeId, device }),
    );
  });

  test("with no vault --primary-agent is refused: no _brain.yaml is written", () => {
    env = makeStoreEnv("osb-adapter-init-agent-", { legacyTree: false, configureVault: false });
    expect(() =>
      bootstrapBrain(null, { configPath: env!.configPath, primaryAgent: "codex" }),
    ).toThrow(/o2b brain settings set primary_agent/);
  });

  test("a switched machine refuses --primary-agent", () => {
    env = makeStoreEnv("osb-adapter-init-agent-sw-");
    switchDevice(env);
    const before = digestVaultTree(join(env.vault, "Brain"));
    expect(() =>
      bootstrapBrain(env!.vault, { configPath: env!.configPath, primaryAgent: "codex" }),
    ).toThrow(/o2b brain settings set primary_agent/);
    expect(digestVaultTree(join(env.vault, "Brain"))).toEqual(before);
  });

  test("with no vault --starter is refused", () => {
    env = makeStoreEnv("osb-adapter-init-starter-", { legacyTree: false, configureVault: false });
    expect(() => bootstrapBrain(null, { configPath: env!.configPath, starter: true })).toThrow(
      /no vault is configured/,
    );
  });

  test("with a vault on an unswitched machine it keeps today's tree plus the bases", () => {
    env = makeStoreEnv("osb-adapter-init-legacy-", { legacyTree: false });
    const result = bootstrapBrain(env.vault, { configPath: env.configPath });
    expect(result.legacyTree).toBe(true);
    expect(result.store).toBeUndefined();
    expect(existsSync(join(env.vault, "Brain", "_brain.yaml"))).toBe(true);
    for (const { file } of BASE_TEMPLATES) {
      expect(existsSync(join(env.vault, "Brain", "bases", file))).toBe(true);
    }
  });

  test("a switched machine writes no byte under Brain/", () => {
    env = makeStoreEnv("osb-adapter-init-switched-");
    switchDevice(env);
    const before = digestVaultTree(join(env.vault, "Brain"));
    const result = bootstrapBrain(env.vault, { configPath: env.configPath, force: true });
    expect(result.legacyTree).toBe(false);
    expect(digestVaultTree(join(env.vault, "Brain"))).toEqual(before);
  });
});
