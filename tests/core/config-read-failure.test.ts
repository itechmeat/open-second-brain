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
  resolveDeviceId,
  resolveInstallationSecret,
  resolveSkillAutoAttach,
  resolveVault,
  setConfigValue,
} from "../../src/core/config.ts";
import { receiptShardPath } from "../../src/core/brain/decisions/receipts.ts";
import { claimShardPath } from "../../src/core/brain/truth/store.ts";

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks");

/** Env keys these tests must own outright, whatever the outer shell set. */
const OWNED_ENV = [
  "OPEN_SECOND_BRAIN_SKILL_AUTO_ATTACH",
  "VAULT_DIR",
  "OPEN_SECOND_BRAIN_CONFIG",
  "XDG_CONFIG_HOME",
  // The suite preload pins the device id to "" for deterministic log
  // shards; the identity tests below need the config path to be the
  // resolution source, so they own both identity overrides outright.
  "O2B_DEVICE_ID",
  "O2B_INSTALLATION_SECRET",
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
   * The condition an existence check cannot express. `existsSync` answers
   * `false` for EVERY stat failure, not only ENOENT, so a perfectly
   * readable config behind a directory that cannot be traversed reported as
   * absent - the operator's `vault:` and every gate in the file reverting
   * to its default while the install looked like one that never ran
   * `o2b init`. Only ENOENT on the path itself is an absence.
   */
  test("a config behind an untraversable directory raises, it is not absent", () => {
    const dir = join(tmp, "locked");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "config.yaml");
    writeFileSync(path, VALID_CONFIG, "utf8");
    chmodSync(dir, 0o000);
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
      chmodSync(dir, 0o755);
    }
  });

  /**
   * Same reasoning at the gate: an untraversable parent must never resolve
   * a default-OFF flag to `false`, which is indistinguishable from the
   * operator never having set it.
   */
  test("a flag gate behind an untraversable directory raises rather than answering `off`", () => {
    const dir = join(tmp, "locked");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "config.yaml");
    writeFileSync(path, VALID_CONFIG, "utf8");
    chmodSync(dir, 0o000);
    try {
      expect(() => resolveSkillAutoAttach(path)).toThrow(ConfigReadError);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  /**
   * A directory whose contents cannot be listed is still a directory in the
   * config file's place - the not-a-regular-file refusal, reached through
   * the stat rather than through a failed read.
   */
  test("an unreadable directory in the config file's place raises too", () => {
    const path = join(tmp, "config.yaml");
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0o000);
    try {
      expect(() => discoverConfig(path)).toThrow(ConfigReadError);
    } finally {
      chmodSync(path, 0o755);
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
 * Identity resolution on a config that cannot be read.
 *
 * The decision this pins: it RAISES. `resolveDeviceId` and
 * `resolveInstallationSecret` generate-and-persist on a miss, and an
 * unreadable file is not a miss - proceeding would mint a fresh identity
 * and write it through `setConfigValue`, which merges onto what it read
 * and would therefore flatten the operator's config to a single line. A
 * fresh device id also silently re-shards this device's log; a fresh
 * installation secret silently changes every `vault://` reference agents
 * correlate by. Both are worse than a refusal that names the file.
 */
describe("identity resolution refuses rather than minting a new identity", () => {
  /** Config the resolvers would otherwise overwrite. */
  const IDENTITY_CONFIG = `device_id: "abc12345"\ninstallation_secret: "${"0".repeat(32)}"\n`;

  function brokenConfig(): string {
    const path = join(tmp, "config.yaml");
    writeFileSync(path, IDENTITY_CONFIG, "utf8");
    chmodSync(path, 0o000);
    return path;
  }

  test("resolveDeviceId raises and persists nothing", () => {
    const path = brokenConfig();
    try {
      expect(() => resolveDeviceId(path)).toThrow(ConfigReadError);
    } finally {
      chmodSync(path, 0o600);
    }
    expect(readFileSync(path, "utf8")).toBe(IDENTITY_CONFIG);
  });

  test("resolveInstallationSecret raises and persists nothing", () => {
    const path = brokenConfig();
    try {
      expect(() => resolveInstallationSecret(path)).toThrow(ConfigReadError);
    } finally {
      chmodSync(path, 0o600);
    }
    expect(readFileSync(path, "utf8")).toBe(IDENTITY_CONFIG);
  });

  test("the claim shard path raises rather than silently choosing the legacy file", () => {
    const path = brokenConfig();
    try {
      expect(() => claimShardPath(join(tmp, "vault"), path)).toThrow(ConfigReadError);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  test("the receipt shard path raises rather than silently choosing the legacy file", () => {
    const path = brokenConfig();
    try {
      expect(() => receiptShardPath(join(tmp, "vault"), path)).toThrow(ConfigReadError);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  /**
   * The env escape hatch survives the raise, exactly as it does for the
   * flag gates: an operator whose config broke can still name the device
   * id without the file being opened at all.
   */
  test("the device-id env override still answers without opening the file", () => {
    const path = brokenConfig();
    process.env["O2B_DEVICE_ID"] = "workstation";
    try {
      expect(resolveDeviceId(path)).toBe("workstation");
    } finally {
      chmodSync(path, 0o600);
    }
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
