/**
 * `discoverConfig` and the ONE failure it is allowed to absorb.
 *
 * The plugin config (`config.yaml`) is the twin of `Brain/_brain.yaml`, and
 * the same two conditions have to stay apart here:
 *
 *   - ABSENT - no config file at all. Every flag is off by documented
 *     default and every resolver answers with its default. This is the
 *     common case on a fresh install and must stay byte-identical.
 *   - PRESENT BUT UNREADABLE - a directory where the file should be, or a
 *     file that cannot be opened. The operator's settings exist and are
 *     NOT in force; answering with the defaults reverts every gate to
 *     `false` while the install looks exactly like one that never set a
 *     flag.
 *
 * There is no third "parses but is invalid" condition to test on this file:
 * `parseSimpleYaml` skips every line that is not `key: value` by design
 * (parity with the legacy Python parser), so it has no failure mode. A
 * malformed plugin config is only ever one of the two I/O conditions above,
 * and the lossy-parse test below pins that the fix did not quietly turn the
 * tolerant parser into a strict one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ConfigReadError,
  discoverConfig,
  resolveSkillAutoAttach,
  resolveVault,
  setConfigValue,
} from "../../src/core/config.ts";

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks");

/** Env keys these tests must own outright, whatever the outer shell set. */
const OWNED_ENV = [
  "OPEN_SECOND_BRAIN_SKILL_AUTO_ATTACH",
  "VAULT_DIR",
  "OPEN_SECOND_BRAIN_CONFIG",
  "XDG_CONFIG_HOME",
] as const;

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-config-read-failure-"));
  for (const key of OWNED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A config an operator could plausibly have written. */
const VALID_CONFIG = `vault: "/srv/example-vault"\nskill_auto_attach: "true"\n`;

describe("discoverConfig: absent config", () => {
  test("a missing file in an existing directory reports absent, with no data", () => {
    const path = join(tmp, "config.yaml");
    const result = discoverConfig(path);
    expect(result.exists).toBe(false);
    expect(result.path).toBe(path);
    expect(result.data).toEqual({});
  });

  test("a missing parent directory reports absent too", () => {
    const path = join(tmp, "never", "created", "config.yaml");
    const result = discoverConfig(path);
    expect(result.exists).toBe(false);
    expect(result.path).toBe(path);
    expect(result.data).toEqual({});
  });
});

describe("discoverConfig: present but unreadable config", () => {
  test("a directory where the file should be raises, naming the path", () => {
    const path = join(tmp, "config.yaml");
    mkdirSync(path, { recursive: true });
    let caught: unknown;
    try {
      discoverConfig(path);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigReadError);
    expect((caught as ConfigReadError).path).toBe(path);
    expect((caught as ConfigReadError).message).toContain(path);
  });

  test("a file that cannot be opened raises rather than reading as absent", () => {
    const path = join(tmp, "config.yaml");
    writeFileSync(path, VALID_CONFIG, "utf8");
    chmodSync(path, 0o000);
    try {
      let caught: unknown;
      try {
        discoverConfig(path);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConfigReadError);
      expect((caught as ConfigReadError).path).toBe(path);
      expect((caught as ConfigReadError).message).toContain(path);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  /**
   * The opposite outcome, on the same surface: content this parser cannot
   * represent is not an unreadable config. Nested YAML and junk lines are
   * skipped exactly as before, so tightening the read did not tighten the
   * parse - an operator whose file has a comment block and an indented
   * section keeps the keys it can read.
   */
  test("content the flat parser cannot represent is still read, not raised", () => {
    const path = join(tmp, "config.yaml");
    writeFileSync(
      path,
      `# a comment\nvault: "/srv/example-vault"\nnested:\n  key: value\nno-colon-here\n`,
      "utf8",
    );
    const result = discoverConfig(path);
    expect(result.exists).toBe(true);
    expect(result.data["vault"]).toBe("/srv/example-vault");
  });
});

describe("call sites: an unreadable plugin config is surfaced, never read as `off`", () => {
  test("a flag gate on an absent config is off, exactly as before", () => {
    expect(resolveSkillAutoAttach(join(tmp, "config.yaml"))).toBe(false);
  });

  test("a flag gate on an unreadable config raises instead of answering `off`", () => {
    const path = join(tmp, "config.yaml");
    writeFileSync(path, VALID_CONFIG, "utf8");
    chmodSync(path, 0o000);
    try {
      expect(() => resolveSkillAutoAttach(path)).toThrow(ConfigReadError);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  /**
   * The env twin is the escape hatch that makes the raise survivable: an
   * operator whose config file broke can still drive every gate from the
   * environment, because the file is not opened when the env key is set.
   */
  test("the env twin still answers without opening an unreadable config", () => {
    const path = join(tmp, "config.yaml");
    writeFileSync(path, VALID_CONFIG, "utf8");
    chmodSync(path, 0o000);
    process.env["OPEN_SECOND_BRAIN_SKILL_AUTO_ATTACH"] = "true";
    try {
      expect(resolveSkillAutoAttach(path)).toBe(true);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  test("resolveVault on an absent config is `no vault configured`", () => {
    expect(resolveVault(join(tmp, "config.yaml"), { cwd: tmp })).toBeNull();
  });

  test("resolveVault on an unreadable config raises instead of reporting no vault", () => {
    const path = join(tmp, "config.yaml");
    writeFileSync(path, VALID_CONFIG, "utf8");
    chmodSync(path, 0o000);
    try {
      expect(() => resolveVault(path, { cwd: tmp })).toThrow(ConfigReadError);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  /**
   * The write path is the one that made the collapse destructive: reading
   * the existing file as absent meant the merge had nothing to merge, so
   * persisting one key rewrote the operator's whole config down to that
   * single line.
   */
  test("setConfigValue raises rather than overwriting a config it could not read", () => {
    const path = join(tmp, "config.yaml");
    writeFileSync(path, VALID_CONFIG, "utf8");
    chmodSync(path, 0o400);
    let caught: unknown;
    try {
      // Readable-but-not-writable is not the condition under test; make the
      // read itself fail, which is what the old catch absorbed.
      chmodSync(path, 0o000);
      try {
        setConfigValue("agent_name", "someone", path);
      } catch (err) {
        caught = err;
      }
    } finally {
      chmodSync(path, 0o600);
    }
    expect(caught).toBeInstanceOf(ConfigReadError);
    expect(readFileSync(path, "utf8")).toBe(VALID_CONFIG);
  });
});

/**
 * Hooks are the call sites with no channel of their own: every hook wraps
 * its body in a fail-open catch so a broken install can never take down a
 * session. The raise must therefore change NOTHING observable for them -
 * same exit code, same silence - which is also why the operator's channel
 * for this condition is the CLI, not the hook.
 */
describe("hooks stay fail-open on an unreadable plugin config", () => {
  interface RunResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly exit: number;
  }

  async function run(argv: string[], payload: unknown, env: Record<string, string>) {
    const proc = Bun.spawn(argv, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env["PATH"] ?? "", HOME: tmp, ...env },
    });
    proc.stdin.write(JSON.stringify(payload));
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    return { stdout, stderr, exit } satisfies RunResult;
  }

  test("gap-agenda exits clean and emits nothing when the config cannot be read", async () => {
    const path = join(tmp, "config.yaml");
    writeFileSync(path, VALID_CONFIG, "utf8");
    chmodSync(path, 0o000);
    try {
      const result = await run(
        ["bun", "run", join(HOOKS_DIR, "gap-agenda.ts")],
        { hook_event_name: "SessionStart", session_id: "s1" },
        { OPEN_SECOND_BRAIN_CONFIG: path },
      );
      expect(result.exit).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      chmodSync(path, 0o600);
    }
  });

  /**
   * The opposite outcome for the test above, which would otherwise pass on
   * a build where nothing raises at all: the SAME resolver, on the SAME
   * broken config, outside a hook's fail-open catch. It exits non-zero and
   * names the file - so the hook's silence is the hook's contract, not an
   * absent raise.
   */
  test("the same gate outside the hook's catch exits non-zero, naming the file", async () => {
    const path = join(tmp, "config.yaml");
    writeFileSync(path, VALID_CONFIG, "utf8");
    chmodSync(path, 0o000);
    const configModule = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "src",
      "core",
      "config.ts",
    );
    try {
      const result = await run(
        [
          "bun",
          "-e",
          `const m = await import(${JSON.stringify(configModule)});
m.resolveGapLoopEnabled(${JSON.stringify(path)});`,
        ],
        {},
        { OPEN_SECOND_BRAIN_CONFIG: path },
      );
      expect(result.exit).not.toBe(0);
      expect(result.stderr).toContain(path);
    } finally {
      chmodSync(path, 0o600);
    }
  });
});
