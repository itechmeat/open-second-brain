/**
 * The brain store guide (`docs/brain-store.md`, task 2.13) runs as written.
 *
 * Every command block of the guide carries an HTML comment that names its
 * scenario, the machine that runs it and how its commands exit:
 *
 *     <!-- doc-test: scenario=setup machine=laptop exit=0 expect="text" -->
 *
 * A `config` block holds lines for that machine's config file instead.
 * This suite extracts the blocks, gives every machine of a scenario its own
 * sandbox (HOME, XDG and Windows profile dirs, config file, device id and
 * device-local state) and runs each command through the real CLI in a
 * child process, in document order, asserting the documented exit code
 * and, when given, the text the block's output contains.
 *
 * Machines share the store the way a sync tool shares it: before a block
 * runs, the partition folders of every machine of the scenario are synced
 * into each other (a file another device appended to is copied when it is
 * missing or shorter; shards are append-only and every device writes only
 * its own), keeping the store's modes. The device-local state is never synced. The server machine
 * receives only `shared/`, so the guide's server commands are checked on a
 * machine that never held `private/`. The migration scenario runs on a
 * fixture legacy vault that both machines name, as a vault synced between
 * them would be.
 *
 * Everything lives under one temp parent removed after each scenario.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { PARTNER_CODEGRAPH_DISABLED_ENV } from "../../src/core/config.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import {
  makeLegacyVault,
  type LegacyVaultFixture,
} from "../core/store-migration/fixtures/legacy-vault.ts";

// A scenario is one test that runs a dozen CLI processes in a row.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS * 4);

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const GUIDE = join(REPO_ROOT, "docs", "brain-store.md");
const CLI_ENTRY = join(REPO_ROOT, "src", "cli", "main.ts");
const PARTITIONS = ["shared", "private"] as const;
type Partition = (typeof PARTITIONS)[number];

const MARKER = "<!-- doc-test:";

interface Block {
  readonly scenario: string;
  readonly machine: string;
  readonly config: boolean;
  /** Expected exit code of every command, or `null` for "any". */
  readonly exit: number | null;
  readonly expect: string | null;
  readonly lines: ReadonlyArray<string>;
  /** 1-based line of the marker in the guide, for failure messages. */
  readonly at: number;
}

/** Parse `key=value`, `key="quoted value"` and bare `key` attributes. */
function parseAttrs(text: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of text.matchAll(/([a-z]+)(?:=(?:"([^"]*)"|(\S+)))?/g)) {
    attrs.set(m[1]!, m[2] ?? m[3] ?? "");
  }
  return attrs;
}

function extractBlocks(markdown: string): Block[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (!line.startsWith(MARKER)) continue;
    const attrs = parseAttrs(line.slice(MARKER.length, line.lastIndexOf("-->")));
    const fence = lines[i + 1] ?? "";
    const indent = fence.length - fence.trimStart().length;
    if (!fence.trimStart().startsWith("```")) {
      throw new Error(`doc-test marker at line ${i + 1} is not followed by a code fence`);
    }
    const body: string[] = [];
    let j = i + 2;
    while (j < lines.length && !lines[j]!.trim().startsWith("```")) {
      body.push(lines[j]!.slice(indent));
      j += 1;
    }
    if (j >= lines.length) {
      throw new Error(`doc-test marker at line ${i + 1} has an unclosed code fence`);
    }
    const scenario = attrs.get("scenario");
    const machine = attrs.get("machine");
    if (!scenario || !machine) {
      throw new Error(`doc-test marker at line ${i + 1} needs scenario= and machine=`);
    }
    const exit = attrs.get("exit");
    blocks.push({
      scenario,
      machine,
      config: attrs.has("config"),
      exit: exit === undefined || exit === "any" ? null : Number(exit),
      expect: attrs.get("expect") ?? null,
      lines: body.filter((l) => l.trim().length > 0),
      at: i + 1,
    });
    i = j;
  }
  return blocks;
}

/** Split a command line into words: bare words, "double" and 'single' quotes. */
function splitWords(line: string): string[] {
  const words: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    words.push(m[1] ?? m[2] ?? m[3]!);
  }
  return words;
}

interface Machine {
  readonly name: string;
  readonly home: string;
  readonly configPath: string;
  readonly partitions: ReadonlyArray<Partition>;
  env(): Record<string, string>;
  /** The configured store root, `null` before the config names one. */
  storeRoot(): string | null;
}

/** The sandbox env of one machine; nothing of the developer's brain leaks in. */
function machineEnv(home: string, configPath: string, device: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(OPEN_SECOND_BRAIN_|O2B_|VAULT_)/i.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    APPDATA: join(home, "AppData", "Roaming"),
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    O2B_DEVICE_ID: device,
    [PARTNER_CODEGRAPH_DISABLED_ENV]: "true",
  };
}

function makeMachine(
  parent: string,
  name: string,
  device: string,
  partitions: ReadonlyArray<Partition>,
): Machine {
  const home = join(parent, name);
  const configPath = join(home, ".config", "open-second-brain", "config.yaml");
  mkdirSync(dirname(configPath), { recursive: true });
  // The user's (empty) Obsidian vault, for the guide's `--vault ~/vault`.
  mkdirSync(join(home, "vault"), { recursive: true });
  return {
    name,
    home,
    configPath,
    partitions,
    env: () => machineEnv(home, configPath, device),
    storeRoot() {
      const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
      const m = /^store_root:\s*"?([^"\n]+?)"?\s*$/m.exec(text);
      // A machine whose config names no store root is not set up yet.
      if (m === null) return null;
      const value = m[1]!;
      return value.startsWith("~/") ? join(home, value.slice(2)) : value;
    },
  };
}

function filesBelow(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

/** One direction of a file sync of one partition folder. */
function syncFolder(from: string, to: string): void {
  for (const src of filesBelow(from)) {
    const dst = join(to, relative(from, src));
    if (existsSync(dst) && statSync(dst).size >= statSync(src).size) continue;
    // A sync tool that keeps permissions (Syncthing does by default)
    // creates the store's folders and files with the modes they have.
    mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
    copyFileSync(src, dst);
    chmodSync(dst, 0o600);
  }
}

/** Sync every partition both machines hold, both ways, as a sync tool would. */
function syncInto(target: Machine, machines: ReadonlyArray<Machine>): void {
  for (const other of machines) {
    if (other === target) continue;
    for (const partition of PARTITIONS) {
      if (!target.partitions.includes(partition) || !other.partitions.includes(partition)) continue;
      const [targetRoot, otherRoot] = [target.storeRoot(), other.storeRoot()];
      if (targetRoot === null || otherRoot === null) continue;
      const mine = join(targetRoot, partition);
      const theirs = join(otherRoot, partition);
      syncFolder(theirs, mine);
      syncFolder(mine, theirs);
    }
  }
}

interface RunOutcome {
  readonly code: number;
  readonly output: string;
}

function runCommand(machine: Machine, line: string): RunOutcome {
  const words = splitWords(line).map((w) =>
    w.startsWith("~/") ? join(machine.home, w.slice(2)) : w,
  );
  expect(words[0]).toBe("o2b");
  const proc = Bun.spawnSync([process.execPath, "run", CLI_ENTRY, ...words.slice(1)], {
    cwd: machine.home,
    env: machine.env(),
    stdin: "ignore",
  });
  return {
    code: proc.exitCode ?? -1,
    output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
}

const blocks = extractBlocks(readFileSync(GUIDE, "utf8"));

let parent: string | null = null;
let legacy: LegacyVaultFixture | null = null;
afterEach(() => {
  if (parent !== null)
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  legacy?.cleanup();
  parent = null;
  legacy = null;
});

/** Run every block of `scenario` in document order on `machines`. */
function runScenario(scenario: string, machines: ReadonlyArray<Machine>): Map<string, string[]> {
  const outputs = new Map<string, string[]>();
  const scenarioBlocks = blocks.filter((b) => b.scenario === scenario);
  expect(scenarioBlocks.length).toBeGreaterThan(0);
  for (const block of scenarioBlocks) {
    const machine = machines.find((m) => m.name === block.machine);
    if (machine === undefined) throw new Error(`no machine ${block.machine} (line ${block.at})`);
    if (block.config) {
      appendFileSync(machine.configPath, `${block.lines.join("\n")}\n`);
      continue;
    }
    syncInto(machine, machines);
    let output = "";
    for (const line of block.lines) {
      const res = runCommand(machine, line);
      output += res.output;
      if (block.exit !== null && res.code !== block.exit) {
        throw new Error(
          `docs/brain-store.md line ${block.at}, ${machine.name}: \`${line}\` exited ` +
            `${res.code}, the guide says ${block.exit}\n${res.output}`,
        );
      }
    }
    if (block.expect !== null && !output.includes(block.expect)) {
      throw new Error(
        `docs/brain-store.md line ${block.at}, ${machine.name}: the output does not contain ` +
          `"${block.expect}"\n${output}`,
      );
    }
    outputs.set(machine.name, [...(outputs.get(machine.name) ?? []), output]);
  }
  return outputs;
}

/** The store root of a machine the scenario has set up. */
function rootOf(machine: Machine): string {
  const root = machine.storeRoot();
  if (root === null) throw new Error(`${machine.name} has no store_root in its config`);
  return root;
}

/** The store id a machine's copy of a partition carries. */
function storeIdOf(machine: Machine, partition: Partition): string {
  const path = join(rootOf(machine), partition, "store.json");
  return (JSON.parse(readFileSync(path, "utf8")) as { store_id: string }).store_id;
}

function newParent(): string {
  parent = mkdtempSync(join(tmpdir(), "osb-doc-brain-store-"));
  return parent;
}

describe("docs/brain-store.md", () => {
  test("every o2b command block of the guide is run by a scenario", () => {
    const markdown = readFileSync(GUIDE, "utf8").split(/\r?\n/);
    const unmarked: number[] = [];
    markdown.forEach((line, i) => {
      if (!/^\s*```(sh|yaml)\s*$/.test(line)) return;
      if (!markdown[i - 1]?.trim().startsWith(MARKER)) unmarked.push(i + 1);
    });
    expect(unmarked).toEqual([]);
    const scenarios = new Set(blocks.map((b) => b.scenario));
    expect([...scenarios].toSorted()).toEqual(["migration", "server-first", "setup", "vault"]);
  });

  // One run of the 19-command scenario (cold CLI processes) proves both
  // the shared store id and the server's private refusal.
  test("setup: one machine, a second machine and a shared-only server, run as written", () => {
    const root = newParent();
    const machines = [
      makeMachine(root, "laptop", "laptop", PARTITIONS),
      makeMachine(root, "desktop", "desktop", PARTITIONS),
      makeMachine(root, "server", "vps", ["shared"]),
    ];
    const outputs = runScenario("setup", machines);
    const [laptop, desktop, server] = machines;
    // One store: every machine holds the store id the first one created.
    expect(storeIdOf(desktop!, "shared")).toBe(storeIdOf(laptop!, "shared"));
    // A server that gets only shared/ never holds private/ and refuses
    // private writes.
    expect(existsSync(join(rootOf(server!), "shared", "store.json"))).toBe(true);
    expect(existsSync(join(rootOf(server!), "private"))).toBe(false);
    const serverOutput = (outputs.get("server") ?? []).join("");
    expect(serverOutput).toContain("private:");
    expect(serverOutput).toContain("brain doctor: clean");
    // The documented refusal is the one the guide quotes, word for word
    // up to the machine's own store path.
    const guide = readFileSync(GUIDE, "utf8");
    const quoted = /```text\n(error: the brain store write failed: [^\n]+)\n```/.exec(guide)?.[1];
    expect(quoted).toBeDefined();
    // Checked on the whole output first, so a missing refusal fails with
    // what the server printed instead of a TypeError.
    expect(serverOutput).toContain("error: the brain store");
    const actual =
      serverOutput.split("\n").find((l) => l.startsWith("error: the brain store")) ?? "";
    expect(actual.replace(rootOf(server!), "/home/me/brain-store")).toBe(quoted!);
  });

  test("vault: a fresh vault gets a store and no Brain/ tree", () => {
    const root = newParent();
    const laptop = makeMachine(root, "laptop", "laptop", PARTITIONS);
    appendFileSync(laptop.configPath, "store_root: ~/brain-store\n");
    runScenario("vault", [laptop]);
    expect(existsSync(join(rootOf(laptop), "shared", "store.json"))).toBe(true);
    expect(existsSync(join(laptop.home, "vault", "Brain"))).toBe(false);
  });

  test("server-first: the store is created with shared only, private added on a trusted machine", () => {
    const root = newParent();
    const machines = [
      makeMachine(root, "server", "vps", ["shared"]),
      makeMachine(root, "desktop", "desktop", PARTITIONS),
    ];
    // The setup scenario's config blocks name the store root; here the
    // test does, so the sync finds it on every platform.
    for (const m of machines) appendFileSync(m.configPath, "store_root: ~/brain-store\n");
    runScenario("server-first", machines);
    const [server, desktop] = machines;
    expect(existsSync(join(rootOf(server!), "private"))).toBe(false);
    expect(storeIdOf(desktop!, "private")).toBe(storeIdOf(server!, "shared"));
  });

  test("migration: first machine, later machine, transition, rollback and removal", () => {
    const root = newParent();
    legacy = makeLegacyVault("osb-doc-brain-store-vault-");
    // A clean legacy install: drop the fixture's entries no mapping covers.
    for (const rel of [
      "Brain/log/2026-11-01.sync-conflict-20261101-120000-ABC.jsonl",
      "Brain/log/stray.txt",
      "Brain/procedures/index.bin",
    ]) {
      rmSync(join(legacy.vault, ...rel.split("/")), { recursive: true });
    }
    // The fixture's cohort is dev-a, dev-b and dev-c; dev-c never upgrades.
    const machines = [
      makeMachine(root, "laptop", "dev-a", PARTITIONS),
      makeMachine(root, "desktop", "dev-b", PARTITIONS),
    ];
    for (const m of machines) {
      appendFileSync(
        m.configPath,
        `vault: "${legacy.vault}"\nstore_root: ~/brain-store\nview_target: ~/brain-view\n`,
      );
    }
    runScenario("migration", machines);
    expect(existsSync(join(legacy.vault, "Brain"))).toBe(false);
    expect(existsSync(join(legacy.vault, ".open-second-brain"))).toBe(false);
    expect(existsSync(join(machines[0]!.home, "brain-view", "about-me.md"))).toBe(true);
  });
});
