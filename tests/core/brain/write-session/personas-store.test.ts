/**
 * Panel personas are records (task 3.12, design D19 item 2): on a
 * store-only machine a persona is a `lane-entry` of the lane `personas`,
 * written and removed by the persona verbs and read from the fold, so a
 * persona the operator curates on one machine is the panel's lens on every
 * machine of the store, with or without a vault. An unswitched machine
 * keeps the persona notes under `Brain/personas/`.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_PERSONAS,
  listPersonas,
  loadPersonas,
  PersonaError,
  removePersona,
  setPersona,
} from "../../../../src/core/brain/write-session/personas.ts";
import { freezeVault, unfreezeVault } from "../../../../src/core/brain/freeze.ts";
import { VaultFrozenError } from "../../../../src/core/brain/freeze-marker.ts";
import {
  holdMigrationGate,
  MigrationInProgressError,
  releaseMigrationGate,
} from "../../../../src/core/migration-gate.ts";
import { STORE_DUAL_WRITE_ENV } from "../../../../src/core/store/constants.ts";
import { writeLanePage } from "../../../../src/core/store/lane-pages.ts";
import { runCli } from "../../../helpers/run-cli.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../../helpers/cli-timeout.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { brainTreeDigest, partitionRecords, switchDevice } from "../store-only/fixtures.ts";
import { sync, twoMachines, use } from "../store-only/two-machines.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const LEGAL = {
  slug: "legal",
  lens: "legal exposure",
  prompt: "Assess the topic through legal exposure: contracts, licences and liability.",
};

const personaRecords = (root: string) =>
  partitionRecords(root, "shared").filter(
    (r) => r.kind.startsWith("lane-entry") && r.body["lane"] === "personas",
  );

describe("personas on a store-only machine", () => {
  test("a persona set on one machine is the panel's lens on another, and no file is written", () => {
    env = makeStoreEnv("osb-personas-store-");
    const [a, b] = twoMachines(env);
    const before = brainTreeDigest(a.vault);
    use(a);
    expect(setPersona(a.vault, LEGAL)).toEqual({ slug: "legal", changed: true });
    expect(brainTreeDigest(a.vault)).toBe(before);
    expect(personaRecords(a.storeRoot)).toHaveLength(1);
    expect(loadPersonas(a.vault)).toEqual([LEGAL]);

    use(b);
    expect(loadPersonas(b.vault)).toEqual(DEFAULT_PERSONAS);
    sync(a, b);
    expect(loadPersonas(b.vault)).toEqual([LEGAL]);
    expect(listPersonas(b.vault)).toEqual({ source: "custom", personas: [LEGAL] });
  });

  test("removing the last persona brings the default set back on every machine", () => {
    env = makeStoreEnv("osb-personas-remove-");
    const [a, b] = twoMachines(env);
    use(a);
    setPersona(a.vault, LEGAL);
    sync(a, b);
    use(b);
    expect(removePersona(b.vault, "legal")).toBe(true);
    expect(removePersona(b.vault, "legal")).toBe(false);
    sync(b, a);
    use(a);
    expect(loadPersonas(a.vault)).toEqual(DEFAULT_PERSONAS);
    expect(listPersonas(a.vault).source).toBe("default");
  });

  test("works with no vault at all", () => {
    env = makeStoreEnv("osb-personas-novault-", { configureVault: false, legacyTree: false });
    setPersona(null, LEGAL);
    expect(listPersonas(null)).toEqual({ source: "custom", personas: [LEGAL] });
  });

  test("a slug that is no plain lowercase name, or an empty prompt, is refused", () => {
    env = makeStoreEnv("osb-personas-refuse-");
    switchDevice(env.storeRoot);
    expect(() => setPersona(env!.vault, { ...LEGAL, slug: "../x" })).toThrow(PersonaError);
    expect(() => setPersona(env!.vault, { ...LEGAL, slug: "Legal" })).toThrow(PersonaError);
    expect(() => setPersona(env!.vault, { ...LEGAL, prompt: "  " })).toThrow(PersonaError);
    expect(personaRecords(env.storeRoot)).toHaveLength(0);
  });
});

describe("personas on an unswitched machine", () => {
  test("stay notes under Brain/personas/", () => {
    env = makeStoreEnv("osb-personas-legacy-", { dualWrite: false });
    setPersona(env.vault, LEGAL);
    const path = join(env.vault, "Brain", "personas", "legal.md");
    expect(readFileSync(path, "utf8")).toContain("kind: persona");
    expect(loadPersonas(env.vault)).toEqual([LEGAL]);
    expect(removePersona(env.vault, "legal")).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});

describe("personas on an unswitched machine with dual writes", () => {
  test("a persona removed before the switch stays removed after it", () => {
    env = makeStoreEnv("osb-personas-dual-remove-");
    const path = join(env.vault, "Brain", "personas", "legal.md");
    setPersona(env.vault, LEGAL);
    expect(personaRecords(env.storeRoot)).toHaveLength(1);
    expect(removePersona(env.vault, "legal")).toBe(true);
    expect(existsSync(path)).toBe(false);
    switchDevice(env.storeRoot);
    expect(loadPersonas(env.vault)).toEqual(DEFAULT_PERSONAS);
    expect(removePersona(env.vault, "legal")).toBe(false);
  });

  test("a persona that never reached the store is removed as a file alone", () => {
    env = makeStoreEnv("osb-personas-dual-legacy-only-", { dualWrite: false });
    setPersona(env.vault, LEGAL);
    process.env[STORE_DUAL_WRITE_ENV] = "1";
    expect(removePersona(env.vault, "legal")).toBe(true);
    expect(personaRecords(env.storeRoot)).toEqual([]);
  });
});

describe("the persona verbs of o2b brain panel", () => {
  test("write a human persona record and list it", async () => {
    env = makeStoreEnv("osb-personas-cli-");
    switchDevice(env.storeRoot);
    const promptFile = join(env.parent, "prompt.txt");
    writeFileSync(promptFile, `${LEGAL.prompt}\n`);
    const cliEnv = { env: { OPEN_SECOND_BRAIN_CONFIG: env.configPath } };
    const set = await runCli(
      ["brain", "panel", "persona-set", "legal", "--lens", LEGAL.lens, "--file", promptFile],
      cliEnv,
    );
    expect(set.returncode).toBe(0);
    const [record] = personaRecords(env.storeRoot);
    expect(record?.body["authority"]).toBe("human");
    const list = await runCli(["brain", "panel", "personas", "--json"], cliEnv);
    expect(list.returncode).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject({ source: "custom", personas: [LEGAL] });
    const removed = await runCli(["brain", "panel", "persona-remove", "legal"], cliEnv);
    expect(removed.returncode).toBe(0);
    expect(loadPersonas(env.vault)).toEqual(DEFAULT_PERSONAS);
  });
});

describe("the persona verbs refuse", () => {
  test("in a frozen vault, and while a store migration runs on it", () => {
    env = makeStoreEnv("osb-personas-frozen-", { dualWrite: false });
    const vault = env.vault;
    setPersona(vault, LEGAL);
    const path = join(vault, "Brain", "personas", "legal.md");
    const before = readFileSync(path, "utf8");
    freezeVault(vault, { agent: "@operator", reason: "moving machines" });
    expect(() => setPersona(vault, { ...LEGAL, prompt: "changed" })).toThrow(VaultFrozenError);
    expect(() => setPersona(vault, { ...LEGAL, slug: "new" })).toThrow(VaultFrozenError);
    expect(() => removePersona(vault, "legal")).toThrow(VaultFrozenError);
    expect(readFileSync(path, "utf8")).toBe(before);
    unfreezeVault(vault);
    holdMigrationGate(vault, "run-personas");
    try {
      expect(() => removePersona(vault, "legal")).toThrow(MigrationInProgressError);
      expect(existsSync(path)).toBe(true);
    } finally {
      releaseMigrationGate(vault, "run-personas");
    }
  });

  test("on a switched machine too, in a frozen vault; a leftover migration gate refuses nothing", () => {
    env = makeStoreEnv("osb-personas-frozen-switched-");
    switchDevice(env.storeRoot);
    const vault = env.vault;
    setPersona(vault, LEGAL);
    expect(personaRecords(env.storeRoot)).toHaveLength(1);
    freezeVault(vault, { agent: "@operator", reason: "moving machines" });
    try {
      expect(() => setPersona(vault, { ...LEGAL, prompt: "changed" })).toThrow(VaultFrozenError);
      expect(() => removePersona(vault, "legal")).toThrow(VaultFrozenError);
    } finally {
      unfreezeVault(vault);
    }
    expect(personaRecords(env.storeRoot)).toHaveLength(1);
    expect(loadPersonas(vault)).toEqual([LEGAL]);
    // The migration that switched the machine is over: a gate it left
    // naming the vault refuses no store write (design D14 item 13).
    holdMigrationGate(vault, "run-personas-switched");
    try {
      expect(removePersona(vault, "legal")).toBe(true);
    } finally {
      releaseMigrationGate(vault, "run-personas-switched");
    }
  });

  test("a replacement of a persona that lives in private, by name, and keeps it", () => {
    env = makeStoreEnv("osb-personas-private-target-");
    switchDevice(env.storeRoot);
    const path = join(env.vault, "Brain", "personas", "legal.md");
    writeLanePage(
      env.vault,
      path,
      { kind: "persona", lens: LEGAL.lens, visibility: "private" },
      `${LEGAL.prompt}\n`,
    );
    const privateEntries = () =>
      partitionRecords(env!.storeRoot, "private").filter((r) => r.kind.startsWith("lane-entry"));
    expect(privateEntries()).toHaveLength(1);
    expect(() => setPersona(env!.vault, { ...LEGAL, prompt: "A shared prompt." })).toThrow(
      /lives in private.*persona-remove legal/,
    );
    expect(privateEntries()).toHaveLength(1);
    expect(personaRecords(env.storeRoot)).toHaveLength(0);
    // Removed first, it can be recreated as shared.
    expect(removePersona(env.vault, "legal")).toBe(true);
    setPersona(env.vault, { ...LEGAL, prompt: "A shared prompt." });
    expect(personaRecords(env.storeRoot)).toHaveLength(1);
  });

  test("a persona whose text is private, by name", () => {
    env = makeStoreEnv("osb-personas-private-");
    switchDevice(env.storeRoot);
    for (const input of [
      { ...LEGAL, prompt: "Assess it. <private>the client's name</private>" },
      { ...LEGAL, lens: "<private>secret</private> lens" },
    ]) {
      expect(() => setPersona(env!.vault, input)).toThrow(/private/);
    }
    expect(personaRecords(env.storeRoot)).toHaveLength(0);
    expect(
      partitionRecords(env.storeRoot, "private").filter((r) => r.kind.startsWith("lane-entry")),
    ).toHaveLength(0);
  });

  test("a prompt over 16 KB, a lens over 200 characters, and a lens with a line separator", () => {
    env = makeStoreEnv("osb-personas-bounds-");
    switchDevice(env.storeRoot);
    const refused = [
      { ...LEGAL, prompt: "x".repeat(16 * 1024 + 1) },
      { ...LEGAL, prompt: "é".repeat(8 * 1024 + 1) },
      { ...LEGAL, lens: "l".repeat(201) },
      { ...LEGAL, lens: "legal exposure" },
      { ...LEGAL, lens: "legal exposure" },
      { ...LEGAL, lens: "legal\u0085exposure" },
    ];
    for (const input of refused) expect(() => setPersona(env!.vault, input)).toThrow(PersonaError);
    expect(personaRecords(env.storeRoot)).toHaveLength(0);
    // At the limits it is accepted.
    setPersona(env.vault, { ...LEGAL, lens: "l".repeat(200), prompt: "x".repeat(16 * 1024) });
    expect(personaRecords(env.storeRoot)).toHaveLength(1);
  });

  test("on a note at that path that is no persona", () => {
    env = makeStoreEnv("osb-personas-other-note-", { dualWrite: false });
    const path = join(env.vault, "Brain", "personas", "readme.md");
    mkdirSync(join(env.vault, "Brain", "personas"), { recursive: true });
    const note = "---\nkind: note\n---\nHow to write personas.\n";
    writeFileSync(path, note);
    expect(() => removePersona(env!.vault, "readme")).toThrow(PersonaError);
    expect(() => setPersona(env!.vault, { ...LEGAL, slug: "readme" })).toThrow(PersonaError);
    expect(readFileSync(path, "utf8")).toBe(note);
  });
});

describe("the persona verbs with no vault configured", () => {
  test("write and list a persona record", async () => {
    env = makeStoreEnv("osb-personas-cli-novault-", { configureVault: false, legacyTree: false });
    const promptFile = join(env.parent, "prompt.txt");
    writeFileSync(promptFile, `${LEGAL.prompt}\n`);
    const cliEnv = { env: { OPEN_SECOND_BRAIN_CONFIG: env.configPath } };
    const set = await runCli(
      ["brain", "panel", "persona-set", "legal", "--lens", LEGAL.lens, "--file", promptFile],
      cliEnv,
    );
    expect(set.returncode).toBe(0);
    const list = await runCli(["brain", "panel", "personas", "--json"], cliEnv);
    expect(JSON.parse(list.stdout)).toMatchObject({ source: "custom", personas: [LEGAL] });
  });
});
