/**
 * Install-owned custom lane tasks: declared as flat keys in the machine
 * config file (never the vault), gated by a default-off master switch,
 * resolved into `custom:<name>` identities with every bad declaration
 * named rather than dropped, and run through the platform shell with the
 * vault as the default cwd, a closed stdin, a redacted and capped stderr
 * tail on failure, and a kill on timeout.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCustomLaneTask,
  CUSTOM_TASK_MAX,
  CUSTOM_TASK_NAME_PATTERN,
  CUSTOM_TASK_PREFIX,
  CUSTOM_TASK_TIMEOUT_DEFAULT_SECONDS,
  isCustomLaneTask,
  resolveCustomTasks,
  type CustomTaskSpec,
} from "../../../../src/core/brain/maintenance/custom-tasks.ts";
import {
  MAINTENANCE_CUSTOM_TASKS_CONFIG_KEY,
  MAINTENANCE_CUSTOM_TASKS_ENV,
  resolveMaintenanceCustomTasks,
} from "../../../../src/core/config.ts";
import {
  SafeguardAbortError,
  SafeguardTimeoutError,
} from "../../../../src/core/brain/safeguard.ts";
import { shellArgv } from "../../../../src/core/reliability/command-bridge.ts";

let dir: string;
let configPath: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "o2b-custom-tasks-"));
  configPath = join(dir, "config.yaml");
  savedEnv = process.env[MAINTENANCE_CUSTOM_TASKS_ENV];
  delete process.env[MAINTENANCE_CUSTOM_TASKS_ENV];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[MAINTENANCE_CUSTOM_TASKS_ENV];
  else process.env[MAINTENANCE_CUSTOM_TASKS_ENV] = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(lines: ReadonlyArray<string>): void {
  writeFileSync(configPath, `${lines.join("\n")}\n`);
}

describe("the custom task vocabulary", () => {
  test("identities carry the custom: prefix and a pattern-checked name", () => {
    expect(CUSTOM_TASK_PREFIX).toBe("custom:");
    expect(CUSTOM_TASK_MAX).toBe(8);
    expect(CUSTOM_TASK_TIMEOUT_DEFAULT_SECONDS).toBe(600);
    expect(CUSTOM_TASK_NAME_PATTERN.test("tidy")).toBe(true);
    expect(CUSTOM_TASK_NAME_PATTERN.test("a-b9")).toBe(true);
    expect(CUSTOM_TASK_NAME_PATTERN.test("Bad")).toBe(false);
    expect(CUSTOM_TASK_NAME_PATTERN.test("a_b")).toBe(false);
    expect(CUSTOM_TASK_NAME_PATTERN.test(`a${"b".repeat(32)}`)).toBe(false);
    expect(isCustomLaneTask("custom:tidy")).toBe(true);
    expect(isCustomLaneTask("custom:Bad")).toBe(false);
    expect(isCustomLaneTask("custom:")).toBe(false);
    expect(isCustomLaneTask("reindex")).toBe(false);
    expect(isCustomLaneTask(42)).toBe(false);
  });
});

describe("the master switch", () => {
  test("is off by default, on with the config key, and the env 0 overrides config true", () => {
    expect(MAINTENANCE_CUSTOM_TASKS_CONFIG_KEY).toBe("maintenance_custom_tasks");
    expect(MAINTENANCE_CUSTOM_TASKS_ENV).toBe("OPEN_SECOND_BRAIN_MAINTENANCE_CUSTOM_TASKS");
    writeConfig(["vault: /nowhere"]);
    expect(resolveMaintenanceCustomTasks(configPath)).toBe(false);
    writeConfig(["maintenance_custom_tasks: true"]);
    expect(resolveMaintenanceCustomTasks(configPath)).toBe(true);
    process.env[MAINTENANCE_CUSTOM_TASKS_ENV] = "0";
    expect(resolveMaintenanceCustomTasks(configPath)).toBe(false);
  });
});

describe("resolveCustomTasks", () => {
  test("reads a command with its cwd and timeout into one custom:<name> spec, sorted by name", () => {
    writeConfig([
      "maintenance_custom_tasks: true",
      "maintenance_custom_tidy: ./tidy.sh",
      "maintenance_custom_tidy_cwd: /srv/x",
      "maintenance_custom_tidy_timeout_seconds: 120",
      "maintenance_custom_archive: archive --all",
    ]);
    const resolved = resolveCustomTasks(configPath);
    expect(resolved.enabled).toBe(true);
    expect(resolved.errors).toEqual([]);
    expect(resolved.declared).toBe(2);
    expect(resolved.specs).toEqual([
      {
        name: "archive",
        id: "custom:archive",
        command: "archive --all",
        timeoutSeconds: CUSTOM_TASK_TIMEOUT_DEFAULT_SECONDS,
      },
      {
        name: "tidy",
        id: "custom:tidy",
        command: "./tidy.sh",
        cwd: "/srv/x",
        timeoutSeconds: 120,
      },
    ]);
  });

  test("names every bad declaration while the good ones still resolve", () => {
    writeConfig([
      "maintenance_custom_tasks: true",
      "maintenance_custom_good: true-command",
      "maintenance_custom_Bad: echo bad",
      "maintenance_custom_a_b: echo ab",
      "maintenance_custom_empty:",
      "maintenance_custom_zero: echo z",
      "maintenance_custom_zero_timeout_seconds: 0",
      "maintenance_custom_word: echo w",
      "maintenance_custom_word_timeout_seconds: abc",
      "maintenance_custom_long: echo l",
      "maintenance_custom_long_timeout_seconds: 1800",
      "maintenance_custom_orphan_cwd: /srv/orphan",
      "maintenance_custom_rel: echo r",
      "maintenance_custom_rel_cwd: relative/dir",
    ]);
    const resolved = resolveCustomTasks(configPath);
    expect(resolved.specs.map((s) => s.id)).toEqual(["custom:good"]);
    const errors = resolved.errors.join("\n");
    expect(errors).toContain("maintenance_custom_Bad");
    expect(errors).toContain("maintenance_custom_a_b");
    expect(errors).toContain("maintenance_custom_empty");
    expect(errors).toContain("maintenance_custom_zero_timeout_seconds");
    expect(errors).toContain("maintenance_custom_word_timeout_seconds");
    expect(errors).toContain("maintenance_custom_long_timeout_seconds");
    expect(errors).toContain("maintenance_custom_orphan_cwd");
    expect(errors).toContain("maintenance_custom_rel_cwd");
    // One named error per bad declaration, never a silent skip.
    expect(resolved.errors.length).toBe(8);
  });

  test("more than the cap names the ninth declaration onward", () => {
    const names = Array.from({ length: CUSTOM_TASK_MAX + 2 }, (_, i) => `t${i}`);
    writeConfig([
      "maintenance_custom_tasks: true",
      ...names.map((n) => `maintenance_custom_${n}: echo ${n}`),
    ]);
    const resolved = resolveCustomTasks(configPath);
    const sorted = names.toSorted();
    expect(resolved.specs.map((s) => s.name)).toEqual(sorted.slice(0, CUSTOM_TASK_MAX));
    expect(resolved.errors.length).toBe(2);
    expect(resolved.errors[0]).toContain(sorted[CUSTOM_TASK_MAX]!);
    expect(resolved.errors[1]).toContain(sorted[CUSTOM_TASK_MAX + 1]!);
    expect(resolved.declared).toBe(CUSTOM_TASK_MAX + 2);
  });

  test("with the switch off, declared keys are counted and nothing resolves to run", () => {
    writeConfig(["maintenance_custom_tidy: ./tidy.sh", "maintenance_custom_sweep: ./sweep.sh"]);
    const resolved = resolveCustomTasks(configPath);
    expect(resolved).toEqual({ enabled: false, specs: [], errors: [], declared: 2 });
  });

  test("an absent config file declares nothing", () => {
    expect(resolveCustomTasks(join(dir, "missing.yaml"))).toEqual({
      enabled: false,
      specs: [],
      errors: [],
      declared: 0,
    });
  });
});

/**
 * A portable fixture: the command runs the current Bun binary on a small
 * script, so the same declaration works under `sh -c` and `cmd.exe /c`.
 */
const FIXTURE = String.raw`
const fs = require("node:fs");
const mode = process.argv[2];
if (mode === "ok") {
  fs.writeFileSync("seen.json", JSON.stringify({
    vault: process.env.O2B_VAULT ?? null,
    cwd: process.cwd(),
    stdin: fs.readFileSync(0, "utf8"),
  }));
} else if (mode === "fail") {
  process.stderr.write("x".repeat(10000) + "\n");
  process.stderr.write("api_key=abcd1234secretvalue\n");
  process.exit(3);
} else if (mode === "sleep") {
  setTimeout(() => {}, 5000);
}
`;

describe("createCustomLaneTask", () => {
  let vault: string;
  let script: string;

  beforeEach(() => {
    vault = join(dir, "vault");
    mkdirSync(vault);
    script = join(dir, "fixture.cjs");
    writeFileSync(script, FIXTURE);
  });

  function spec(mode: string, extra: Partial<CustomTaskSpec> = {}): CustomTaskSpec {
    return {
      name: "fx",
      id: "custom:fx",
      command: `"${process.execPath}" "${script}" ${mode}`,
      timeoutSeconds: 30,
      ...extra,
    };
  }

  test("the task carries its identity and runs through the shared shell form", () => {
    expect(createCustomLaneTask(spec("ok"), { vault }).name).toBe("custom:fx");
    if (process.platform !== "win32") expect(shellArgv("a b")).toEqual(["sh", ["-c", "a b"]]);
  });

  test("exit 0 resolves with no receipt; cwd is the vault, O2B_VAULT is set, stdin is closed", async () => {
    const receipt = await createCustomLaneTask(spec("ok"), { vault }).run();
    expect(receipt).toBeUndefined();
    const seen = JSON.parse(readFileSync(join(vault, "seen.json"), "utf8")) as {
      vault: string;
      cwd: string;
      stdin: string;
    };
    expect(seen.vault).toBe(vault);
    expect(realpathSync(seen.cwd)).toBe(realpathSync(vault));
    expect(seen.stdin).toBe("");
  });

  test("a declared cwd replaces the vault as the working directory", async () => {
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    await createCustomLaneTask(spec("ok", { cwd: elsewhere }), { vault }).run();
    const seen = JSON.parse(readFileSync(join(elsewhere, "seen.json"), "utf8")) as { cwd: string };
    expect(realpathSync(seen.cwd)).toBe(realpathSync(elsewhere));
  });

  test("a non-zero exit throws exit <N> with the stderr tail, redacted and capped", async () => {
    const run = createCustomLaneTask(spec("fail"), { vault }).run();
    const err = (await run.then(
      () => undefined,
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message.startsWith("exit 3:")).toBe(true);
    expect(err.message).toContain("api_key=");
    expect(err.message).not.toContain("abcd1234secretvalue");
    expect(Buffer.byteLength(err.message, "utf8")).toBeLessThanOrEqual(4096);
  });

  test("a command running past its timeout is killed and throws SafeguardTimeoutError", async () => {
    const started = Date.now();
    const err = await createCustomLaneTask(spec("sleep", { timeoutSeconds: 1 }), { vault })
      .run()
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(SafeguardTimeoutError);
    expect((err as SafeguardTimeoutError).operation).toBe("custom:fx");
    expect(Date.now() - started).toBeLessThan(4000);
  });

  test("an aborted signal kills the child and rejects", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = createCustomLaneTask(spec("sleep"), { vault, signal: controller.signal }).run();
    setTimeout(() => controller.abort(), 200);
    const err = await pending.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SafeguardAbortError);
    expect(Date.now() - started).toBeLessThan(4000);

    const already = new AbortController();
    already.abort();
    const early = await createCustomLaneTask(spec("ok"), { vault, signal: already.signal })
      .run()
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(early).toBeInstanceOf(SafeguardAbortError);
  });

  test("a working directory that does not exist fails by name", async () => {
    const err = (await createCustomLaneTask(spec("ok", { cwd: join(dir, "missing") }), { vault })
      .run()
      .then(
        () => undefined,
        (e: unknown) => e,
      )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("custom:fx");
  });
});
