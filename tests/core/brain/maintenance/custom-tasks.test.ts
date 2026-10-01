/**
 * Install-owned custom lane tasks: declared as flat keys in the machine
 * config file (never the vault), gated by a default-off master switch,
 * resolved into `custom:<name>` identities with every bad declaration
 * named rather than dropped, and run through the platform shell with the
 * home directory as the default cwd, credential-named variables dropped
 * from the env, a closed stdin, a redacted and capped stderr tail on
 * failure, and the whole process group killed on timeout or abort.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCustomLaneTask,
  CUSTOM_TASK_MAX,
  CUSTOM_TASK_TOTAL_TIMEOUT_BUDGET_SECONDS,
  CUSTOM_TASKS_ENV_OFF_NOTICE,
  CUSTOM_TASKS_OFF_NOTICE,
  customTaskEnv,
  customTasksOffNotice,
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
  resolveMaintenanceCustomTasksSwitch,
} from "../../../../src/core/config.ts";
import {
  SafeguardAbortError,
  SafeguardTimeoutError,
} from "../../../../src/core/brain/safeguard.ts";
import { MAINTENANCE_LEASE_TTL_MS } from "../../../../src/core/brain/maintenance/lane.ts";
import { IS_WINDOWS } from "../../../helpers/platform.ts";

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
    expect(CUSTOM_TASK_TIMEOUT_DEFAULT_SECONDS).toBe(120);
    // The full cap fits the budget at the default timeout.
    expect(CUSTOM_TASK_TIMEOUT_DEFAULT_SECONDS * CUSTOM_TASK_MAX).toBeLessThanOrEqual(
      CUSTOM_TASK_TOTAL_TIMEOUT_BUDGET_SECONDS,
    );
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
    expect(resolveMaintenanceCustomTasksSwitch(configPath).enabled).toBe(false);
    writeConfig(["maintenance_custom_tasks: true"]);
    expect(resolveMaintenanceCustomTasksSwitch(configPath).enabled).toBe(true);
    process.env[MAINTENANCE_CUSTOM_TASKS_ENV] = "0";
    expect(resolveMaintenanceCustomTasksSwitch(configPath).enabled).toBe(false);
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
      "maintenance_custom_long_timeout_seconds: 1201",
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

  test("a command-less name with both suffix keys names each key", () => {
    writeConfig([
      "maintenance_custom_tasks: true",
      "maintenance_custom_ghost_cwd: /srv/ghost",
      "maintenance_custom_ghost_timeout_seconds: 30",
    ]);
    const resolved = resolveCustomTasks(configPath);
    expect(resolved.specs).toEqual([]);
    expect(resolved.errors).toEqual([
      "maintenance_custom_ghost_cwd: no maintenance_custom_ghost command is declared for it",
      "maintenance_custom_ghost_timeout_seconds: no maintenance_custom_ghost command is declared for it",
    ]);
  });

  test("the custom timeouts together stay within a budget below the lease", () => {
    expect(CUSTOM_TASK_TOTAL_TIMEOUT_BUDGET_SECONDS).toBe(1200);
    expect(CUSTOM_TASK_TOTAL_TIMEOUT_BUDGET_SECONDS).toBeLessThan(MAINTENANCE_LEASE_TTL_MS / 1000);
    writeConfig([
      "maintenance_custom_tasks: true",
      "maintenance_custom_a: echo a",
      "maintenance_custom_a_timeout_seconds: 700",
      "maintenance_custom_b: echo b",
      "maintenance_custom_b_timeout_seconds: 600",
      "maintenance_custom_c: echo c",
      "maintenance_custom_c_timeout_seconds: 500",
    ]);
    const resolved = resolveCustomTasks(configPath);
    // In name order: a (700) fits, b would make 1300, c makes 1200 exactly.
    expect(resolved.specs.map((s) => s.id)).toEqual(["custom:a", "custom:c"]);
    expect(resolved.errors).toEqual([
      "maintenance_custom_b: its 600 s timeout takes the custom timeouts to 1300 s, " +
        "over the 1200 s budget of the 1800 s maintenance lease; this one is not run",
    ]);
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
    expect(resolved).toEqual({
      enabled: false,
      switchSource: "unset",
      specs: [],
      errors: [],
      declared: 2,
    });
    expect(customTasksOffNotice(resolved)).toBe(CUSTOM_TASKS_OFF_NOTICE);
  });

  test("the off notice names the env variable when the env override decided", () => {
    writeConfig(["maintenance_custom_tasks: true", "maintenance_custom_tidy: ./tidy.sh"]);
    expect(customTasksOffNotice(resolveCustomTasks(configPath))).toBeNull();
    process.env[MAINTENANCE_CUSTOM_TASKS_ENV] = "0";
    const resolved = resolveCustomTasks(configPath);
    expect(resolved.switchSource).toBe("env");
    expect(customTasksOffNotice(resolved)).toBe(CUSTOM_TASKS_ENV_OFF_NOTICE);
    expect(CUSTOM_TASKS_ENV_OFF_NOTICE).toContain(MAINTENANCE_CUSTOM_TASKS_ENV);
    writeConfig(["maintenance_custom_tasks: false", "maintenance_custom_tidy: ./tidy.sh"]);
    delete process.env[MAINTENANCE_CUSTOM_TASKS_ENV];
    expect(customTasksOffNotice(resolveCustomTasks(configPath))).toBe(CUSTOM_TASKS_OFF_NOTICE);
  });

  test("an absent config file declares nothing", () => {
    expect(resolveCustomTasks(join(dir, "missing.yaml"))).toEqual({
      enabled: false,
      switchSource: "unset",
      specs: [],
      errors: [],
      declared: 0,
    });
  });
});

describe("customTaskEnv", () => {
  test("drops credential-named variables and keeps the rest, with O2B_VAULT set", () => {
    const env = customTaskEnv("/v", {
      PATH: "/bin",
      HOME: "/home/op",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      TZ: "UTC",
      TMPDIR: "/t",
      EDITOR: "vi",
      OPENAI_API_KEY: "k",
      GITHUB_TOKEN: "t",
      DB_PASSWORD: "p",
      AWS_SECRET_ACCESS_KEY: "s",
      O2B_VAULT: "/elsewhere",
    });
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/op",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      TZ: "UTC",
      TMPDIR: "/t",
      EDITOR: "vi",
      O2B_VAULT: "/v",
    });
  });
});

/**
 * A portable fixture: the command runs the current Bun binary on a small
 * script, so the same declaration works under `sh -c` and `cmd.exe /c`.
 * Every mode that reports writes to an absolute path given as its second
 * argument, never to its working directory.
 */
const FIXTURE = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const mode = process.argv[2];
const out = process.argv[3];
if (mode === "ok") {
  fs.writeFileSync(out, JSON.stringify({
    vault: process.env.O2B_VAULT ?? null,
    cwd: process.cwd(),
    stdin: fs.readFileSync(0, "utf8"),
    secret: process.env.O2B_FIXTURE_API_KEY ?? null,
    plain: process.env.O2B_FIXTURE_PLAIN ?? null,
  }));
} else if (mode === "fail") {
  process.stderr.write("x".repeat(10000) + "\n");
  process.stderr.write("api_key=abcd1234secretvalue\n");
  process.exit(3);
} else if (mode === "tree") {
  // A child that starts a grandchild, both recording their pids.
  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
  });
  fs.writeFileSync(out, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
  setTimeout(() => {}, 30000);
} else if (mode === "linger") {
  // Left in the background by its shell, holding the inherited stderr.
  fs.writeFileSync(out, String(process.pid));
  setTimeout(() => {}, 30000);
}
`;

/** What `run` rejected with; `undefined` when it resolved. */
function rejection(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => undefined,
    (e: unknown) => e,
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolve once every pid is gone; fail after `boundMs`. */
async function expectGone(pids: ReadonlyArray<number>, boundMs = 4000): Promise<void> {
  const until = Date.now() + boundMs;
  while (pids.some(alive)) {
    if (Date.now() > until) {
      throw new Error(`still running after ${boundMs} ms: ${pids.filter(alive).join(", ")}`);
    }
    await Bun.sleep(50);
  }
}

/**
 * Per-test budget for the process-tree cases: above the task timeout plus
 * the {@link expectGone} bound, so a surviving child fails on the
 * "still running" assertion rather than on the runner's 5 s default.
 */
const PROCESS_TREE_TEST_TIMEOUT_MS = 15_000;

async function waitForFile(path: string, boundMs = 4000): Promise<string> {
  const until = Date.now() + boundMs;
  while (!existsSync(path) || readFileSync(path, "utf8") === "") {
    if (Date.now() > until) throw new Error(`${path} was not written within ${boundMs} ms`);
    await Bun.sleep(20);
  }
  return readFileSync(path, "utf8");
}

describe("createCustomLaneTask", () => {
  let vault: string;
  let script: string;
  let seenPath: string;

  beforeEach(() => {
    vault = join(dir, "vault");
    mkdirSync(vault);
    script = join(dir, "fixture.cjs");
    writeFileSync(script, FIXTURE);
    seenPath = join(dir, "seen.json");
  });

  function command(mode: string, out: string = seenPath): string {
    return `"${process.execPath}" "${script}" ${mode} "${out}"`;
  }

  function spec(mode: string, extra: Partial<CustomTaskSpec> = {}): CustomTaskSpec {
    return {
      name: "fx",
      id: "custom:fx",
      command: command(mode),
      timeoutSeconds: 30,
      ...extra,
    };
  }

  test("the task carries its identity", () => {
    expect(createCustomLaneTask(spec("ok"), { vault }).name).toBe("custom:fx");
  });

  test("exit 0 resolves with no receipt; cwd is the home directory, O2B_VAULT is set, stdin is closed", async () => {
    const receipt = await createCustomLaneTask(spec("ok"), { vault }).run();
    expect(receipt).toBeUndefined();
    const seen = JSON.parse(readFileSync(seenPath, "utf8")) as {
      vault: string;
      cwd: string;
      stdin: string;
    };
    expect(seen.vault).toBe(vault);
    expect(realpathSync(seen.cwd)).toBe(realpathSync(homedir()));
    expect(seen.stdin).toBe("");
  });

  test("a credential-named variable of this process does not reach the command", async () => {
    process.env["O2B_FIXTURE_API_KEY"] = "do-not-pass";
    process.env["O2B_FIXTURE_PLAIN"] = "pass";
    try {
      await createCustomLaneTask(spec("ok"), { vault }).run();
    } finally {
      delete process.env["O2B_FIXTURE_API_KEY"];
      delete process.env["O2B_FIXTURE_PLAIN"];
    }
    const seen = JSON.parse(readFileSync(seenPath, "utf8")) as {
      secret: string | null;
      plain: string | null;
    };
    expect(seen.secret).toBeNull();
    expect(seen.plain).toBe("pass");
  });

  test("a declared cwd, the vault included, replaces the home directory", async () => {
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    await createCustomLaneTask(spec("ok", { cwd: elsewhere }), { vault }).run();
    let seen = JSON.parse(readFileSync(seenPath, "utf8")) as { cwd: string };
    expect(realpathSync(seen.cwd)).toBe(realpathSync(elsewhere));
    await createCustomLaneTask(spec("ok", { cwd: vault }), { vault }).run();
    seen = JSON.parse(readFileSync(seenPath, "utf8")) as { cwd: string };
    expect(realpathSync(seen.cwd)).toBe(realpathSync(vault));
  });

  test("a non-zero exit throws exit <N> with the stderr tail, redacted and capped", async () => {
    const err = (await rejection(createCustomLaneTask(spec("fail"), { vault }).run())) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message.startsWith("exit 3:")).toBe(true);
    expect(err.message).toContain("api_key=");
    expect(err.message).not.toContain("abcd1234secretvalue");
    expect(Buffer.byteLength(err.message, "utf8")).toBeLessThanOrEqual(4096);
  });

  test(
    "past its timeout the child and its grandchild are killed and it throws SafeguardTimeoutError",
    async () => {
      const pidsPath = join(dir, "tree.json");
      const started = Date.now();
      const pending = createCustomLaneTask(
        spec("tree", { command: command("tree", pidsPath), timeoutSeconds: 1 }),
        { vault },
      ).run();
      const err = await rejection(pending);
      expect(err).toBeInstanceOf(SafeguardTimeoutError);
      expect((err as SafeguardTimeoutError).operation).toBe("custom:fx");
      expect(Date.now() - started).toBeLessThan(4000);
      const pids = JSON.parse(await waitForFile(pidsPath)) as { child: number; grandchild: number };
      await expectGone([pids.child, pids.grandchild]);
    },
    PROCESS_TREE_TEST_TIMEOUT_MS,
  );

  test(
    "an aborted signal kills the child and its grandchild and rejects",
    async () => {
      const pidsPath = join(dir, "tree.json");
      const controller = new AbortController();
      const started = Date.now();
      const pending = createCustomLaneTask(spec("tree", { command: command("tree", pidsPath) }), {
        vault,
        signal: controller.signal,
      }).run();
      const pids = JSON.parse(await waitForFile(pidsPath)) as { child: number; grandchild: number };
      controller.abort();
      const err = await rejection(pending);
      expect(err).toBeInstanceOf(SafeguardAbortError);
      expect(Date.now() - started).toBeLessThan(6000);
      await expectGone([pids.child, pids.grandchild]);

      const already = new AbortController();
      already.abort();
      const early = await rejection(
        createCustomLaneTask(spec("ok"), { vault, signal: already.signal }).run(),
      );
      expect(early).toBeInstanceOf(SafeguardAbortError);
    },
    PROCESS_TREE_TEST_TIMEOUT_MS,
  );

  test.skipIf(IS_WINDOWS)(
    "a shell that exits 0 succeeds at once; what it left in the background dies at the timeout",
    async () => {
      const pidPath = join(dir, "linger.pid");
      const started = Date.now();
      await createCustomLaneTask(
        spec("linger", { command: `${command("linger", pidPath)} & exit 0`, timeoutSeconds: 2 }),
        { vault },
      ).run();
      expect(Date.now() - started).toBeLessThan(1500);
      const pid = Number(await waitForFile(pidPath));
      expect(alive(pid)).toBe(true);
      await expectGone([pid], 5000);
    },
    PROCESS_TREE_TEST_TIMEOUT_MS,
  );

  test.skipIf(IS_WINDOWS)(
    "a shell that exits 0 just before its deadline, a stderr holder left behind, succeeds",
    async () => {
      const pidPath = join(dir, "linger.pid");
      // The shell exits about 150 ms before the 1 s deadline, inside the
      // stderr drain window the background holder keeps open.
      const err = await rejection(
        createCustomLaneTask(
          spec("linger", {
            command: `${command("linger", pidPath)} & sleep 0.85; exit 0`,
            timeoutSeconds: 1,
          }),
          { vault },
        ).run(),
      );
      expect(err).toBeUndefined();
      const pid = Number(await waitForFile(pidPath));
      await expectGone([pid], 5000);
    },
    PROCESS_TREE_TEST_TIMEOUT_MS,
  );

  test("a working directory that does not exist fails by name before the spawn", async () => {
    const missing = join(dir, "missing");
    const err = (await rejection(
      createCustomLaneTask(spec("ok", { cwd: missing }), { vault }).run(),
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(`custom task fx: cwd does not exist: ${missing}`);
  });
});
