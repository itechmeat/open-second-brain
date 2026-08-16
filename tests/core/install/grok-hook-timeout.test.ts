/**
 * The generated grok hook entries read their timeout from the committed
 * vault tier instead of a literal.
 *
 * Two obligations pull against each other here and both are pinned below.
 *
 * A vault that declares no `install:` block must still generate the file
 * it generated before this knob existed - install verification works by
 * RE-CONSTRUCTION, never a stored hash, so a single changed byte reads as
 * drift on every machine that already applied. The baseline is DERIVED
 * rather than restated: `hooks/hooks.json` is the shipped plugin hook set
 * and carries the same timeout on every entry, which is the number the
 * generator used to hardcode. The parity suite next door already reads
 * that file for the event -> hook-name map; this reads it for the one
 * scalar the generator now resolves.
 *
 * A vault that DOES declare one must have it reach every entry, and an
 * unreadable `_brain.yaml` must stop the write rather than quietly
 * regenerate the default - the file is a writer's input, and a writer
 * cannot infer intent from bytes it could not parse.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { grokAdapter } from "../../../src/core/install/adapters/grok.ts";
import { grokHooksJson } from "../../../src/core/install/grok-asset.ts";
import { buildPayload } from "../../../src/core/install/payload.ts";
import { resolveInstallHookTimeoutSeconds } from "../../../src/core/install/settings.ts";
import { INSTALL_HOOK_TIMEOUT_SECONDS_DEFAULT } from "../../../src/core/brain/policy/blocks/install.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { CONFIG_ORIGIN } from "../../../src/core/validate.ts";
import type { InstallEnv } from "../../../src/core/install/types.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

interface HookEntry {
  readonly type: string;
  readonly command: string;
  readonly env: Record<string, string>;
  readonly timeout: number;
}

/**
 * The one timeout the shipped plugin hook set uses, read off
 * `hooks/hooks.json`. Derived, not restated: this is the literal the grok
 * generator carried before the `install:` block existed, so a vault with
 * no block must still produce it.
 */
function shippedHookTimeoutSeconds(): number {
  const raw = readFileSync(join(REPO_ROOT, "hooks", "hooks.json"), "utf8");
  const timeouts = new Set([...raw.matchAll(/"timeout"\s*:\s*(\d+)/g)].map((m) => Number(m[1])));
  expect(timeouts.size).toBe(1);
  return [...timeouts][0]!;
}

function hookEntries(json: string): ReadonlyArray<HookEntry> {
  const parsed = JSON.parse(json) as {
    hooks: Record<string, Array<{ hooks: HookEntry[] }>>;
  };
  return Object.values(parsed.hooks)
    .flat()
    .flatMap((group) => group.hooks);
}

let vault: string;
let home: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-grok-timeout-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-grok-timeout-h-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  for (const dir of [vault, home]) rmSync(dir, { recursive: true, force: true });
});

function installEnv(): InstallEnv {
  return {
    vault,
    home,
    cwd: home,
    env: { VAULT_AGENT_NAME: "claude-dev-agent", VAULT_TIMEZONE: "UTC" },
    now: new Date("2026-06-12T12:00:00.000Z"),
  };
}

function payload() {
  return buildPayload({ vault, agent_name: "claude-dev-agent", timezone: "UTC" });
}

function apply(): void {
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const opts = {
    dryRun: false,
    force: false,
    stdout: sink as unknown as NodeJS.WriteStream,
    stderr: sink as unknown as NodeJS.WriteStream,
  };
  const env = installEnv();
  grokAdapter.apply(grokAdapter.plan(payload(), env), payload(), env, opts);
}

function hooksPath(): string {
  return join(home, ".grok", "hooks", "open-second-brain.json");
}

describe("a vault with no install: block regenerates the committed output", () => {
  test("the compiled default is the timeout the shipped hook set carries", () => {
    expect(INSTALL_HOOK_TIMEOUT_SECONDS_DEFAULT).toBe(shippedHookTimeoutSeconds());
  });

  test("resolution reports the default layer and the shipped value", () => {
    expect(
      resolveInstallHookTimeoutSeconds({
        vault,
        env: {},
        configPath: join(home, "absent-config.yaml"),
      }),
    ).toEqual({ value: shippedHookTimeoutSeconds(), origin: CONFIG_ORIGIN.default });
  });

  test("generation with the resolved value is byte-identical to the unparameterised form", () => {
    expect(grokHooksJson(payload(), shippedHookTimeoutSeconds())).toBe(grokHooksJson(payload()));
  });

  test("the applied file is byte-identical to the unparameterised generation", () => {
    apply();
    expect(readFileSync(hooksPath(), "utf8")).toBe(grokHooksJson(payload()));
  });

  test("every generated entry carries the shipped timeout", () => {
    const entries = hookEntries(grokHooksJson(payload()));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.timeout).toBe(shippedHookTimeoutSeconds());
  });
});

describe("a configured hook_timeout_seconds reaches every entry", () => {
  const CONFIGURED = 45;

  beforeEach(() => {
    atomicWriteFileSync(
      brainConfigPath(vault),
      `schema_version: 1\ninstall:\n  hook_timeout_seconds: ${CONFIGURED}\n`,
    );
  });

  test("the resolver reports the vault-config layer", () => {
    expect(
      resolveInstallHookTimeoutSeconds({
        vault,
        env: {},
        configPath: join(home, "absent-config.yaml"),
      }),
    ).toEqual({ value: CONFIGURED, origin: CONFIG_ORIGIN.vaultConfig });
  });

  test("the applied hooks file carries it on every entry", () => {
    apply();
    const entries = hookEntries(readFileSync(hooksPath(), "utf8"));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.timeout).toBe(CONFIGURED);
  });

  test("the applied file equals the generation for that timeout", () => {
    apply();
    expect(readFileSync(hooksPath(), "utf8")).toBe(grokHooksJson(payload(), CONFIGURED));
  });

  test("a freshly applied install reports no drift", () => {
    apply();
    expect(grokAdapter.verify(installEnv()).status).toBe("ok");
  });
});

describe("an unreadable _brain.yaml refuses the generation", () => {
  beforeEach(() => {
    atomicWriteFileSync(
      brainConfigPath(vault),
      "schema_version: 1\ninstall:\n  hook_timeout_seconds: [broken\n",
    );
  });

  test("apply refuses and names the file", () => {
    let message = "";
    try {
      apply();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(brainConfigPath(vault));
  });

  test("nothing is written", () => {
    try {
      apply();
    } catch {
      // The refusal is the assertion below: no hooks file exists.
    }
    expect(() => readFileSync(hooksPath(), "utf8")).toThrow();
  });
});
