/**
 * `o2b install --friction` — the operator surface of the friction matrix.
 *
 * The verb's other modes are covered by `install-verb.test.ts`; this file
 * covers the comparison mode and the two properties it exists for: the
 * table is derived from the live registry, and the DIFF form names only
 * the dimensions the two hosts answer differently. A diff that reprints
 * the dimensions they share is a table, so the silence is asserted
 * against the matrix itself rather than against a copied list.
 */

import { describe, expect, test, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { runCli as baseRunCli, type RunCliOptions, type RunResult } from "../helpers/run-cli.ts";
import { INSTALL_EXIT } from "../../src/cli/install/install.ts";
import { FRICTION_DIMENSIONS } from "../../src/core/install/friction.ts";
import { INSTALL_TARGET_IDS } from "../../src/core/runtime/host-facts.ts";

// The adapters resolve the target home at module-load time, so each call
// needs a fresh process to honour this file's per-case temp HOME.
function runCli(args: ReadonlyArray<string>, opts: RunCliOptions = {}): Promise<RunResult> {
  return baseRunCli(args, { ...opts, subprocess: true });
}

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let vault: string;
let home: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-friction-cli-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-friction-cli-h-"));
  configPath = join(home, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\nagent_name: "claude-vps"\ntimezone: "UTC"\n`);
});

afterEach(() => {
  for (const p of [vault, home]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // temp cleanup is best-effort
    }
  }
});

function envBase(extra: Record<string, string> = {}) {
  return {
    HOME: home,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    VAULT_DIR: vault,
    VAULT_AGENT_NAME: "claude-vps",
    VAULT_TIMEZONE: "UTC",
    ...extra,
  };
}

/**
 * The identifier tokens of `text`, split on everything an id cannot hold.
 *
 * Plain containment let a SHORTER id ride on a longer one:
 * `"copilot-cli".includes("pi")` is true, so "every registered target is
 * listed" held for a table that had dropped the `pi` row entirely, and the
 * refusal message satisfied all ten names while offering nine. A token set
 * answers the question the assertion means to ask.
 */
function tokensOf(text: string): ReadonlySet<string> {
  return new Set(text.split(/[^A-Za-z0-9_-]+/).filter((token) => token.length > 0));
}

interface FrictionCellJson {
  readonly dimension: string;
  readonly value: string;
  readonly detail: string | null;
}

interface FrictionTargetJson {
  readonly target: string;
  readonly label: string;
  readonly cells: ReadonlyArray<FrictionCellJson>;
}

interface FrictionJson {
  readonly schema_version: number;
  readonly friction: {
    readonly dimensions: ReadonlyArray<string>;
    readonly targets: ReadonlyArray<FrictionTargetJson>;
  };
}

interface FrictionDiffJson {
  readonly schema_version: number;
  readonly friction_diff: {
    readonly base: string;
    readonly compare: string;
    readonly shared: number;
    readonly differing: ReadonlyArray<{
      readonly dimension: string;
      readonly base_value: string;
      readonly compare_value: string;
    }>;
  };
}

async function frictionJson(extra: ReadonlyArray<string> = []): Promise<FrictionJson> {
  const r = await runCli(["install", "--friction", "--json", ...extra], { env: envBase() });
  expect(`exit ${r.returncode}\n${r.stderr}`).toBe("exit 0\n");
  return JSON.parse(r.stdout) as FrictionJson;
}

describe("o2b install --friction — the matrix", () => {
  test("the human table carries every registered target and every dimension", async () => {
    const r = await runCli(["install", "--friction"], { env: envBase() });
    expect(r.returncode).toBe(INSTALL_EXIT.ok);
    const printed = tokensOf(r.stdout);
    for (const target of INSTALL_TARGET_IDS) {
      expect(`${target} listed: ${printed.has(target)}`).toBe(`${target} listed: true`);
    }
    for (const dimension of FRICTION_DIMENSIONS) {
      expect(`${dimension} listed: ${printed.has(dimension)}`).toBe(`${dimension} listed: true`);
    }
  });

  test("--json is machine-readable and versioned", async () => {
    const payload = await frictionJson();
    expect(payload.schema_version).toBe(1);
    expect(payload.friction.dimensions).toEqual([...FRICTION_DIMENSIONS]);
    expect(payload.friction.targets.map((t) => t.target).toSorted()).toEqual(
      [...INSTALL_TARGET_IDS].toSorted(),
    );
    for (const target of payload.friction.targets) {
      expect(target.cells.map((c) => c.dimension)).toEqual([...FRICTION_DIMENSIONS]);
    }
  });

  test("--target narrows the matrix to one host", async () => {
    const payload = await frictionJson(["--target", "cursor"]);
    expect(payload.friction.targets.map((t) => t.target)).toEqual(["cursor"]);
  });

  test("an unknown --target is refused by name, with the known list", async () => {
    const r = await runCli(["install", "--friction", "--target", "claude-code"], {
      env: envBase(),
    });
    expect(r.returncode).toBe(INSTALL_EXIT.usage);
    expect(r.stderr).toContain("claude-code");
    const offered = tokensOf(r.stderr);
    for (const target of INSTALL_TARGET_IDS) {
      expect(`${target} offered: ${offered.has(target)}`).toBe(`${target} offered: true`);
    }
  });
});

describe("o2b install --friction --base <a> --compare <b> — the diff", () => {
  test("it names every dimension the two answer differently and no other", async () => {
    const matrix = await frictionJson();
    const row = (target: string): ReadonlyArray<FrictionCellJson> =>
      matrix.friction.targets.find((t) => t.target === target)!.cells;
    const r = await runCli(
      ["install", "--friction", "--base", "cursor", "--compare", "pi", "--json"],
      { env: envBase() },
    );
    expect(`exit ${r.returncode}\n${r.stderr}`).toBe("exit 0\n");
    const diff = (JSON.parse(r.stdout) as FrictionDiffJson).friction_diff;
    const named = new Set(diff.differing.map((d) => d.dimension));
    const wrong: string[] = [];
    for (const dimension of FRICTION_DIMENSIONS) {
      const base = row("cursor").find((c) => c.dimension === dimension)!;
      const compare = row("pi").find((c) => c.dimension === dimension)!;
      if ((base.value !== compare.value) !== named.has(dimension)) wrong.push(dimension);
    }
    expect(wrong.join(", ")).toBe("");
    expect(diff.differing.length).toBeGreaterThan(0);
    expect(diff.differing.length + diff.shared).toBe(FRICTION_DIMENSIONS.length);
  });

  test("the human diff prints the differing dimensions and says how many it withheld", async () => {
    const r = await runCli(["install", "--friction", "--base", "cursor", "--compare", "pi"], {
      env: envBase(),
    });
    expect(r.returncode).toBe(INSTALL_EXIT.ok);
    // `pi` as a whole token: `copilot-cli` contains it as a substring, so
    // plain containment would have accepted a diff that never named it.
    const printed = tokensOf(r.stdout);
    expect(`cursor: ${printed.has("cursor")}, pi: ${printed.has("pi")}`).toBe(
      "cursor: true, pi: true",
    );
    expect(r.stdout).toContain("differ");
  });

  test("--base without --compare is a usage error naming the missing flag", async () => {
    const r = await runCli(["install", "--friction", "--base", "cursor"], { env: envBase() });
    expect(r.returncode).toBe(INSTALL_EXIT.usage);
    expect(r.stderr).toContain("--compare");
  });

  test("an unknown --compare is refused by name", async () => {
    const r = await runCli(
      ["install", "--friction", "--base", "cursor", "--compare", "claude-code"],
      { env: envBase() },
    );
    expect(r.returncode).toBe(INSTALL_EXIT.usage);
    expect(r.stderr).toContain("claude-code");
  });

  test("--target alongside --base/--compare is refused rather than silently ignored", async () => {
    const r = await runCli(
      ["install", "--friction", "--target", "cursor", "--base", "cursor", "--compare", "pi"],
      { env: envBase() },
    );
    expect(r.returncode).toBe(INSTALL_EXIT.usage);
    expect(r.stderr).toContain("--target");
  });
});

describe("the flags the friction mode added are advertised", () => {
  test("help --json declares every flag o2b install parses", async () => {
    const r = await runCli(["help", "--json"], { env: envBase() });
    expect(r.returncode).toBe(0);
    const manifest = JSON.parse(r.stdout) as {
      commands: ReadonlyArray<{
        name: string;
        flags?: ReadonlyArray<{ name: string; inherited?: boolean }>;
      }>;
    };
    const install = manifest.commands.find((c) => c.name === "install");
    // `--json` is inherited by every verb and stated once in the help
    // header, so parity is asserted over the flags this verb DECLARES.
    const declared = (install?.flags ?? [])
      .filter((f) => f.inherited !== true)
      .map((f) => f.name)
      .toSorted();
    expect(declared).toEqual(
      [
        "apply",
        "base",
        "check",
        "compare",
        "config",
        "dry-run",
        "force",
        "format",
        "friction",
        "out",
        "target",
        "vault",
      ].toSorted(),
    );
  });
});
