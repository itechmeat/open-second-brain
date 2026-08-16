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

/** The committed rendering, with the two per-machine paths left as tokens. */
function golden(): string {
  return readFileSync(
    join(REPO_ROOT, "tests", "fixtures", "install", "grok-hooks.golden.json"),
    "utf8",
  );
}

/**
 * A generated hooks file reduced to the form the golden is stored in.
 *
 * Only the bun binary and the repository root are tokenised, because only
 * those two are machine-specific by design (grok's restricted
 * session-spawn PATH forces absolute commands). Tokenising anything else
 * would be the golden agreeing not to look at it.
 */
function normalize(json: string): string {
  return json.split(process.execPath).join("<BUN>").split(REPO_ROOT).join("<REPO>");
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
        configPath: join(home, "absent-config.yaml"),
      }),
    ).toEqual({ value: shippedHookTimeoutSeconds(), origin: CONFIG_ORIGIN.default });
  });

  test("the generation matches the committed golden rendering, byte for byte", () => {
    // The anchor. Every other "byte-identical" assertion here and in the
    // adapter suite compared the generator against ITSELF - the same call
    // with the argument the default supplied - so it could only fail if
    // the generator were non-deterministic, and a change to the hook
    // command paths, the `env` map, the entry ordering or the JSON
    // indentation left every one of them green. This compares against
    // bytes committed to the tree.
    //
    // Two substitutions, and only two: the bun binary and the repository
    // root are absolute paths that differ per machine, and the whole
    // reason `grok-asset.ts` emits them is that grok's session-spawn PATH
    // will not resolve a bare command. Everything else - including the
    // derived agent name and the timeout on every entry - is compared
    // literally.
    expect(normalize(grokHooksJson(payload(), shippedHookTimeoutSeconds()))).toBe(golden());
  });

  test("the applied file is the same golden rendering", () => {
    apply();
    expect(normalize(readFileSync(hooksPath(), "utf8"))).toBe(golden());
  });

  test("every generated entry carries the shipped timeout", () => {
    const entries = hookEntries(grokHooksJson(payload(), shippedHookTimeoutSeconds()));
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

  test("it is the golden rendering with only the timeout changed", () => {
    // Pins the SCOPE of the setting as well as its arrival: a knob that
    // also moved a command path or reordered the entries would pass the
    // assertion above and fail this one.
    apply();
    expect(normalize(readFileSync(hooksPath(), "utf8"))).toBe(
      golden().replaceAll(`"timeout": ${shippedHookTimeoutSeconds()}`, `"timeout": ${CONFIGURED}`),
    );
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

  /**
   * The READ paths refuse too, and they are the ones with a blast radius:
   * `o2b install` with no `--target` walks every adapter's `detect`, and
   * `--check` walks every `verify`, so one unparsable file used to take
   * down the status of nine targets that never read it. The refusal is
   * still correct - `syncState` compares against a generation it cannot
   * produce - and `src/cli/main.ts` now renders it as one line rather than
   * a stack trace.
   */
  test("verify refuses and names the file", () => {
    let message = "";
    try {
      grokAdapter.verify(installEnv());
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(brainConfigPath(vault));
  });

  test("detect refuses and names the file", () => {
    let message = "";
    try {
      grokAdapter.detect(installEnv());
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(brainConfigPath(vault));
  });
});
