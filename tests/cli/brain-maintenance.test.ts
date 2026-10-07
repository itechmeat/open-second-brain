/**
 * `o2b brain maintenance` CLI surface (t_166d1226): run executes
 * dream + reindex under the lease (exit 0 even on a gate skip - cron
 * must not alarm on a quiet hour), status renders lease + journal.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { MAINTENANCE_USAGE, VERB_HELP } from "../../src/cli/brain/help-text.ts";
import {
  MAINTENANCE_EXIT,
  formatSpendBanner,
  maintenanceExitCode,
  renderTaskLine,
} from "../../src/cli/brain/verbs/maintenance.ts";
import {
  LANE_TASK,
  LANE_TASKS,
  type MaintenanceSpendReceipt,
  type MaintenanceTaskResult,
} from "../../src/core/brain/maintenance/lane.ts";
import {
  appendJournal,
  listJournal,
  MAINTENANCE_JOURNAL_CAP,
  MAINTENANCE_SPEND_METRIC,
  MAINTENANCE_VERDICT,
} from "../../src/core/brain/maintenance/journal.ts";
import { listMetrics } from "../../src/core/brain/metrics.ts";
import { currentLease, MAINTENANCE_LEASE_NAME } from "../../src/core/brain/maintenance/lease.ts";
import { MAINTENANCE_EMBEDDINGS_ENV } from "../../src/core/config.ts";
import {
  isEmbeddingPriceSource,
  type EmbeddingPriceSource,
} from "../../src/core/search/embeddings/pricing.ts";
import { MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT } from "../../src/core/brain/policy/blocks/maintenance.ts";
import { sqliteVecLoadable } from "../helpers/sqlite-vec.ts";
import { startFakeHttp, type FakeHttp } from "../helpers/fake-http.ts";
import { FAKE_PROVIDER_KEY } from "../helpers/fake-credentials.ts";
import { homeEnv } from "../helpers/platform.ts";
import { runCli } from "../helpers/run-cli.ts";

/**
 * Whether `sqlite-vec` loaded in THIS process: the spend-surface tests
 * need a vector index, so an unloadable extension skips them rather than
 * failing on an environment fact (same guard the vector-backfill CLI
 * tests declare).
 */
const VEC_LOADABLE = sqliteVecLoadable();

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-maint-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("run executes dream and reindex; status shows the journal", async () => {
  const init = await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(init.returncode).toBe(0);

  const run = await runCli(["brain", "maintenance", "run", "--vault", vault, "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(run.returncode).toBe(0);
  const ran = JSON.parse(run.stdout) as {
    verdict: string;
    tasks: Array<{ name: string; ok: boolean }>;
  };
  expect(ran.verdict).toBe("run");
  // The lane's population, not a hand-copied list: a fifth task is added
  // to LANE_TASKS in one place or not at all (the drift the surface-parity
  // census exists for).
  expect(ran.tasks.map((t) => t.name).toSorted()).toEqual([...LANE_TASKS].toSorted());
  expect(ran.tasks.every((t) => t.ok)).toBe(true);
  expect(existsSync(join(vault, ".open-second-brain", "maintenance-runs.jsonl"))).toBe(true);

  const status = await runCli(["brain", "maintenance", "status", "--vault", vault, "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(status.returncode).toBe(0);
  const state = JSON.parse(status.stdout) as {
    lease: unknown;
    journal: Array<{ verdict: string }>;
  };
  expect(state.lease).toBeNull();
  expect(state.journal.length).toBeGreaterThanOrEqual(2);
});

test("a window that excludes the current hour skips with exit 0", async () => {
  const init = await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(init.returncode).toBe(0);
  // A degenerate 1-hour window that the current hour cannot match:
  // pick the hour after next in UTC, exclusive end one hour later.
  const hour = (new Date().getUTCHours() + 2) % 24;
  const end = (hour + 1) % 24;
  const run = await runCli(
    ["brain", "maintenance", "run", "--window", `${hour}-${end}`, "--vault", vault, "--json"],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
  expect(run.returncode).toBe(0);
  expect(JSON.parse(run.stdout).verdict).toBe("skipped:window");
});

test("a malformed window is a usage error", async () => {
  const result = await runCli(
    ["brain", "maintenance", "run", "--window", "25-3", "--vault", vault],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
  expect(result.returncode).toBe(2);
});

/**
 * The per-test config, which alone names the test vault. The lane mints per-device state and runs custom tasks from the home
 * directory, so every lane-running child gets a home of its own under
 * the test's temp dir rather than the runner's.
 */
function baseEnv(): Record<string, string> {
  const home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  return { OPEN_SECOND_BRAIN_CONFIG: configPath, ...homeEnv(home) };
}

/** The local provider is configured, model-free and price-free, and the lane is opted in. */
function localSemanticEnv(): Record<string, string> {
  return {
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    OPEN_SECOND_BRAIN_SEARCH_SEMANTIC: "true",
    OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER: "local",
    [MAINTENANCE_EMBEDDINGS_ENV]: "true",
  };
}

/** Seed `task`'s journal with the failures that trip the streak refusal. */
function seedFailureStreak(task: string, count: number): void {
  const path = join(vault, ".open-second-brain", "maintenance-runs.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  for (let i = 0; i < count; i++) {
    appendFileSync(
      path,
      JSON.stringify({
        ts: new Date(Date.now() - (count - i) * 86_400_000).toISOString(),
        holder: `seed@${i}`,
        verdict: "run",
        task,
        ok: false,
        duration_ms: 1,
        error: "seeded failure",
      }) + "\n",
    );
  }
}

test("a refused task is reported as refused, with its own exit code", async () => {
  const init = await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(init.returncode).toBe(0);
  seedFailureStreak("dream", MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT);

  const run = await runCli(["brain", "maintenance", "run", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  // Not 1: nothing was attempted, so nothing failed - and not 0, because
  // a heavy pass is standing refused and only an operator can change that.
  expect(run.returncode).toBe(MAINTENANCE_EXIT.refused);
  expect(run.stdout).toContain("dream: REFUSED");
  expect(run.stdout).not.toContain("dream: FAILED");
  // The healthy tasks still ran under the same lease.
  expect(run.stdout).toContain("reindex: ok");
});

test("--retry runs the refused task and names an unknown task as a usage error", async () => {
  const init = await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(init.returncode).toBe(0);
  seedFailureStreak("dream", MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT);

  const typo = await runCli(
    ["brain", "maintenance", "run", "--retry", "dreams", "--vault", vault],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
  expect(typo.returncode).toBe(MAINTENANCE_EXIT.usage);
  expect(typo.stderr).toContain("dreams");

  const retried = await runCli(
    ["brain", "maintenance", "run", "--retry", "dream", "--vault", vault, "--json"],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
  expect(retried.returncode).toBe(MAINTENANCE_EXIT.ok);
  const payload = JSON.parse(retried.stdout) as {
    tasks: Array<{ name: string; ok: boolean; refused?: boolean }>;
  };
  const dream = payload.tasks.find((t) => t.name === "dream");
  expect(dream?.refused).toBeUndefined();
  expect(dream?.ok).toBe(true);
});

/** `run --cron-template` with `extra` flags against the test vault. */
function recipe(extra: ReadonlyArray<string>) {
  return runCli(["brain", "maintenance", "run", "--cron-template", "--vault", vault, ...extra], {
    env: baseEnv(),
  });
}

describe("run --cron-template prints the lane recipe and writes nothing", () => {
  test("prints a recipe naming the job and the vault; no lease, no journal", async () => {
    const printed = await recipe([]);
    expect(printed.returncode).toBe(MAINTENANCE_EXIT.ok);
    expect(printed.stdout).toContain("osb-maintenance");
    expect(printed.stdout).toContain(`o2b brain maintenance run --vault '${vault}' --json`);
    expect(printed.stdout).toContain("0 */1 * * *");
    // Returned before the lease and the journal: printing a recipe is not
    // a lane pass, so it must leave no trace a later status would read.
    expect(currentLease(vault, { name: MAINTENANCE_LEASE_NAME, now: new Date() })).toBeNull();
    expect(listJournal(vault, MAINTENANCE_JOURNAL_CAP)).toEqual([]);
    expect(existsSync(join(vault, ".open-second-brain", "maintenance-runs.jsonl"))).toBe(false);
  });

  test("a bad interval or format is the lane's usage code, with the kernel's message", async () => {
    const seconds = await recipe(["--interval", "30s"]);
    expect(seconds.returncode).toBe(MAINTENANCE_EXIT.usage);
    expect(seconds.stderr).toContain("second-level intervals are not supported");
    const months = await recipe(["--interval", "90d"]);
    expect(months.returncode).toBe(MAINTENANCE_EXIT.usage);
    expect(months.stderr).toContain("an interval of 90 days cannot be expressed");
    const launchd = await recipe(["--format", "launchd"]);
    expect(launchd.returncode).toBe(MAINTENANCE_EXIT.usage);
    expect(launchd.stderr).toContain("systemd");
  });

  test("a lane-run flag beside --cron-template is the usage code, named, and writes nothing", async () => {
    const forced = await recipe(["--force"]);
    expect(forced.returncode).toBe(MAINTENANCE_EXIT.usage);
    expect(forced.stderr).toContain(
      "--cron-template prints the recipe only and does not take --force (a lane-run flag)",
    );
    expect(forced.stdout).toBe("");
    const several = await recipe(["--json", "--retry", "dream"]);
    expect(several.returncode).toBe(MAINTENANCE_EXIT.usage);
    expect(several.stderr).toContain("--retry, --json");
    expect(currentLease(vault, { name: MAINTENANCE_LEASE_NAME, now: new Date() })).toBeNull();
    expect(listJournal(vault, MAINTENANCE_JOURNAL_CAP)).toEqual([]);
  });

  test("the window is validated and carried into the printed body", async () => {
    const bad = await recipe(["--window", "25-3"]);
    expect(bad.returncode).toBe(MAINTENANCE_EXIT.usage);
    const windowed = await recipe(["--window", "3-5", "--tz", "Europe/Berlin"]);
    expect(windowed.returncode).toBe(MAINTENANCE_EXIT.ok);
    expect(windowed.stdout).toContain("--window 3-5");
    expect(windowed.stdout).toContain("--tz Europe/Berlin");
    const unwindowed = await recipe([]);
    expect(unwindowed.stdout).not.toContain("--window");
  });

  test("status refuses --cron-template", async () => {
    const status = await runCli(
      ["brain", "maintenance", "status", "--cron-template", "--vault", vault],
      { env: baseEnv() },
    );
    expect(status.returncode).toBe(MAINTENANCE_EXIT.usage);
    expect(status.stderr).toContain("--cron-template");
  });

  test("--format systemd prints a user timer at the default interval", async () => {
    const timer = await recipe(["--format", "systemd"]);
    expect(timer.returncode).toBe(MAINTENANCE_EXIT.ok);
    expect(timer.stdout).toContain("OnUnitActiveSec=1h");
    expect(timer.stdout).toContain(`o2b brain maintenance run --vault '${vault}' --json`);
  });
});

/** Rewrite the per-test config with `lines` after the vault key. */
function writeConfig(lines: ReadonlyArray<string>): void {
  writeFileSync(configPath, [`vault: ${vault}`, ...lines].join("\n") + "\n");
}

async function initVault(): Promise<void> {
  const init = await runCli(["brain", "init", "--vault", vault], { env: baseEnv() });
  expect(init.returncode).toBe(0);
}

describe("declared custom tasks ride the lane", () => {
  test("with the switch on, run reports the custom row after the built-ins", async () => {
    writeConfig(["maintenance_custom_tasks: true", "maintenance_custom_tidy: exit 0"]);
    await initVault();
    const run = await runCli(["brain", "maintenance", "run", "--vault", vault, "--json"], {
      env: baseEnv(),
    });
    expect(run.returncode).toBe(MAINTENANCE_EXIT.ok);
    const payload = JSON.parse(run.stdout) as { tasks: Array<{ name: string; ok: boolean }> };
    const tidy = payload.tasks.find((t) => t.name === "custom:tidy");
    expect(tidy?.ok).toBe(true);
    expect(payload.tasks.map((t) => t.name).toSorted()).toEqual(
      [...LANE_TASKS, "custom:tidy"].toSorted(),
    );
  });

  test("--retry accepts a declared custom task and names an undeclared one", async () => {
    writeConfig(["maintenance_custom_tasks: true", "maintenance_custom_tidy: exit 0"]);
    await initVault();
    seedFailureStreak("custom:tidy", MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT);

    const refused = await runCli(["brain", "maintenance", "run", "--vault", vault], {
      env: baseEnv(),
    });
    expect(refused.returncode).toBe(MAINTENANCE_EXIT.refused);
    expect(refused.stdout).toContain("custom:tidy: REFUSED");

    const unknown = await runCli(
      ["brain", "maintenance", "run", "--retry", "custom:nope", "--vault", vault],
      { env: baseEnv() },
    );
    expect(unknown.returncode).toBe(MAINTENANCE_EXIT.usage);
    expect(unknown.stderr).toContain("custom:nope");
    expect(unknown.stderr).toContain("custom:tidy");

    const retried = await runCli(
      ["brain", "maintenance", "run", "--retry", "custom:tidy", "--vault", vault, "--json"],
      { env: baseEnv() },
    );
    expect(retried.returncode).toBe(MAINTENANCE_EXIT.ok);
    const payload = JSON.parse(retried.stdout) as {
      tasks: Array<{ name: string; ok: boolean; refused?: boolean }>;
    };
    const tidy = payload.tasks.find((t) => t.name === "custom:tidy");
    expect(tidy?.refused).toBeUndefined();
    expect(tidy?.ok).toBe(true);
  });

  test("a bad declaration is named on stderr and the valid tasks still run", async () => {
    writeConfig([
      "maintenance_custom_tasks: true",
      "maintenance_custom_tidy: exit 0",
      "maintenance_custom_Bad: exit 0",
    ]);
    await initVault();
    const run = await runCli(["brain", "maintenance", "run", "--vault", vault, "--json"], {
      env: baseEnv(),
    });
    expect(run.stderr).toContain("custom task refused:");
    expect(run.stderr).toContain("Bad");
    const payload = JSON.parse(run.stdout) as {
      tasks: MaintenanceTaskResult[];
    };
    // A refused declaration journals nothing and is not a failed attempt:
    // the run that only refused it exits 0.
    expect(run.returncode).toBe(0);
    expect(payload.tasks.find((t) => t.name === "custom:Bad")).toBeUndefined();
    expect(payload.tasks.find((t) => t.name === "custom:tidy")?.ok).toBe(true);
  });

  test("status shows custom rows, and says when declared tasks are switched off", async () => {
    writeConfig(["maintenance_custom_tasks: true", "maintenance_custom_tidy: exit 0"]);
    await initVault();
    const run = await runCli(["brain", "maintenance", "run", "--vault", vault], {
      env: baseEnv(),
    });
    expect(run.returncode).toBe(MAINTENANCE_EXIT.ok);
    const on = await runCli(["brain", "maintenance", "status", "--vault", vault], {
      env: baseEnv(),
    });
    expect(on.stdout).toContain("custom:tidy ok");
    expect(on.stdout).not.toContain("custom tasks declared but maintenance_custom_tasks is off");

    writeConfig(["maintenance_custom_tidy: exit 0"]);
    const off = await runCli(["brain", "maintenance", "status", "--vault", vault], {
      env: baseEnv(),
    });
    expect(off.returncode).toBe(MAINTENANCE_EXIT.ok);
    expect(off.stdout).toContain("custom tasks declared but maintenance_custom_tasks is off");
  });
});

/** A clean task row, as the lane produces it. */
function okRow(name: MaintenanceTaskResult["name"]): MaintenanceTaskResult {
  return { name, ok: true, duration_ms: 1 };
}

/** A deterministic task fault: the pass ran and failed for a named reason. */
function errorRow(name: MaintenanceTaskResult["name"]): MaintenanceTaskResult {
  return { name, ok: false, duration_ms: 5, error: "deterministic fault" };
}

/** A safeguard-deadline row: the pass was killed mid-run, its outcome unmeasured. */
function timedOutRow(name: MaintenanceTaskResult["name"]): MaintenanceTaskResult {
  return {
    name,
    ok: false,
    duration_ms: 120_001,
    error: `${name} exceeded its safeguard timeout of 120000ms - aborted at a checkpoint`,
    timed_out: true,
  };
}

/** A streak-refusal row: the task never ran. */
function refusedRow(name: MaintenanceTaskResult["name"]): MaintenanceTaskResult {
  return {
    name,
    ok: false,
    duration_ms: 0,
    error: "refused: 3 consecutive journaled failures",
    refused: true,
    failure_streak: 3,
  };
}

describe("brain maintenance --help", () => {
  test("opens with the verb's own usage line and names custom tasks and the recipe", () => {
    const help = VERB_HELP["maintenance"]!;
    expect(help.startsWith(`${MAINTENANCE_USAGE}\n`)).toBe(true);
    for (const flag of [
      "--cron-template",
      "--interval",
      "--format",
      "--force-cost",
      "--progress",
    ]) {
      expect(MAINTENANCE_USAGE).toContain(flag);
    }
    expect(help).toContain("custom:<name>");
    expect(help).toContain("maintenance_custom_tasks: true");
  });
});

describe("maintenanceExitCode", () => {
  test("a clean run exits 0 and a deterministic task fault exits 1", () => {
    expect(maintenanceExitCode([okRow(LANE_TASK.dream), okRow(LANE_TASK.reindex)])).toBe(
      MAINTENANCE_EXIT.ok,
    );
    expect(maintenanceExitCode([errorRow(LANE_TASK.reindex)])).toBe(MAINTENANCE_EXIT.failed);
  });

  test("a timed-out pass exits 6: the run could not find out", () => {
    // The safeguard killed the task mid-run, so its outcome is unmeasured -
    // the same "could not find out" `SEARCH_CHECK_EXIT` and `DOCTOR_EXIT`
    // already spend 6 on, not the proved failure 1 names.
    expect(maintenanceExitCode([timedOutRow(LANE_TASK.bridges)])).toBe(
      MAINTENANCE_EXIT.probeIncomplete,
    );
    // The healthy tasks around it do not make the run clean.
    expect(maintenanceExitCode([timedOutRow(LANE_TASK.bridges), okRow(LANE_TASK.clusters)])).toBe(
      MAINTENANCE_EXIT.probeIncomplete,
    );
  });

  test("a timed-out custom task exits 1: the streak counts its hang as a failure", () => {
    expect(maintenanceExitCode([timedOutRow("custom:tidy")])).toBe(MAINTENANCE_EXIT.failed);
    expect(maintenanceExitCode([timedOutRow("custom:tidy"), timedOutRow(LANE_TASK.bridges)])).toBe(
      MAINTENANCE_EXIT.failed,
    );
  });

  test("a refusal-only run still exits 7", () => {
    expect(maintenanceExitCode([refusedRow(LANE_TASK.dream), okRow(LANE_TASK.reindex)])).toBe(
      MAINTENANCE_EXIT.refused,
    );
  });

  test("a proved failure outranks an unmeasured pass; an unmeasured pass outranks a refusal", () => {
    // error + timeout -> 1: the specific proved failure must not be masked.
    expect(maintenanceExitCode([errorRow(LANE_TASK.dream), timedOutRow(LANE_TASK.reindex)])).toBe(
      MAINTENANCE_EXIT.failed,
    );
    // timeout + refusal -> 6: something ran, so the run outranks a refusal
    // (which records that nothing did).
    expect(maintenanceExitCode([timedOutRow(LANE_TASK.reindex), refusedRow(LANE_TASK.dream)])).toBe(
      MAINTENANCE_EXIT.probeIncomplete,
    );
  });

  test("the table is a table and agrees with the 6 the other surfaces already spend", () => {
    const codes = Object.values(MAINTENANCE_EXIT);
    expect(new Set(codes).size).toBe(codes.length);
    expect(MAINTENANCE_EXIT.probeIncomplete).toBe(6);
  });
});

describe("renderTaskLine", () => {
  test("a timed-out pass is TIMED OUT, not FAILED: the safeguard killed it mid-run", () => {
    const line = renderTaskLine(timedOutRow(LANE_TASK.bridges));
    expect(line).toContain("bridges: TIMED OUT");
    expect(line).not.toContain("FAILED");
    // The error names the safeguard and its budget; the line carries it.
    expect(line).toContain("120000ms");
    expect(line).toContain("in 120001ms");
  });

  test("a refusal, a deterministic failure and a pass keep their existing renderings", () => {
    expect(renderTaskLine(refusedRow(LANE_TASK.dream))).toContain("dream: REFUSED");
    expect(renderTaskLine(errorRow(LANE_TASK.reindex))).toContain("reindex: FAILED");
    expect(renderTaskLine(okRow(LANE_TASK.clusters))).toContain("clusters: ok in 1ms");
  });

  test("a receipt rides the line as a parenthetical", () => {
    const receipt: MaintenanceSpendReceipt = {
      model: "text-embedding-3-small",
      tokens: 38110,
      estimatedUsd: 0.0076,
      forced: false,
    };
    const line = renderTaskLine({ ...okRow(LANE_TASK.reindex), receipt });
    expect(line).toContain("reindex: ok in 1ms");
    expect(line).toContain("(tokens=38110, estimatedUsd=0.0076, model=text-embedding-3-small)");
  });

  test("a receipt for an unknown price says so instead of a dollar figure", () => {
    const receipt: MaintenanceSpendReceipt = {
      model: "zembed-1",
      tokens: 120,
      estimatedUsd: null,
      forced: true,
      priceSource: "unknown",
    };
    const line = renderTaskLine({ ...okRow(LANE_TASK.reindex), receipt });
    expect(line).toContain("(tokens=120, price unknown, model=zembed-1)");
    expect(line).not.toContain("$0");
  });
});

describe("the journal listing", () => {
  test("a receipt written before price sources renders as unrecorded, its estimate as written", async () => {
    const init = await runCli(["brain", "init", "--vault", vault], { env: baseEnv() });
    expect(init.returncode).toBe(0);
    appendJournal(vault, {
      ts: "2026-09-01T00:00:00Z",
      holder: "test",
      verdict: MAINTENANCE_VERDICT.run,
      task: LANE_TASK.reindex,
      ok: true,
      receipt: {
        model: "text-embedding-3-small",
        tokens: 500,
        estimatedUsd: 0.0123,
        forced: false,
      },
    });
    appendJournal(vault, {
      ts: "2026-09-02T00:00:00Z",
      holder: "test",
      verdict: MAINTENANCE_VERDICT.run,
      task: LANE_TASK.reindex,
      ok: true,
      receipt: {
        model: "zembed-1",
        tokens: 40,
        estimatedUsd: null,
        forced: true,
        priceSource: "unknown",
      },
    });
    const status = await runCli(["brain", "maintenance", "status", "--vault", vault], {
      env: baseEnv(),
    });
    expect(status.returncode).toBe(0);
    expect(status.stdout).toContain(
      "(tokens=500, estimatedUsd=0.0123, model=text-embedding-3-small, price_source=unrecorded)",
    );
    expect(status.stdout).toContain(
      "(tokens=40, price unknown, model=zembed-1, price_source=unknown)",
    );
  });
});

describe("a journaled receipt without a numeric estimate", () => {
  test("reads price unknown and never breaks the listing", async () => {
    const init = await runCli(["brain", "init", "--vault", vault], { env: baseEnv() });
    expect(init.returncode).toBe(0);
    // Rows another build, another device's shard or a hand edit could
    // write: the journal read casts them, so the listing must not trust
    // the estimate's type.
    const receipts = [
      { model: "m-absent", tokens: 3, forced: false },
      { model: "m-string", tokens: 4, forced: false, estimatedUsd: "x" },
    ] as unknown as ReadonlyArray<MaintenanceSpendReceipt>;
    for (const [i, receipt] of receipts.entries()) {
      appendJournal(vault, {
        ts: `2026-09-0${i + 4}T00:00:00Z`,
        holder: "test",
        verdict: MAINTENANCE_VERDICT.run,
        task: LANE_TASK.reindex,
        ok: true,
        receipt,
      });
    }
    const status = await runCli(["brain", "maintenance", "status", "--vault", vault], {
      env: baseEnv(),
    });
    expect(status.returncode).toBe(0);
    expect(status.stdout).toContain(
      "(tokens=3, price unknown, model=m-absent, price_source=unrecorded)",
    );
    expect(status.stdout).toContain(
      "(tokens=4, price unknown, model=m-string, price_source=unrecorded)",
    );
  });
});

describe("a receipt whose price source this build does not know", () => {
  test("renders as unrecorded, never as the stray value", async () => {
    expect(isEmbeddingPriceSource("vendor")).toBe(false);
    const init = await runCli(["brain", "init", "--vault", vault], { env: baseEnv() });
    expect(init.returncode).toBe(0);
    appendJournal(vault, {
      ts: "2026-09-03T00:00:00Z",
      holder: "test",
      verdict: MAINTENANCE_VERDICT.run,
      task: LANE_TASK.reindex,
      ok: true,
      receipt: {
        model: "voyage-3",
        tokens: 70,
        estimatedUsd: 0.0001,
        forced: false,
        priceSource: "vendor" as EmbeddingPriceSource,
      },
    });
    const status = await runCli(["brain", "maintenance", "status", "--vault", vault], {
      env: baseEnv(),
    });
    expect(status.returncode).toBe(0);
    expect(status.stdout).toContain("model=voyage-3, price_source=unrecorded)");
    expect(status.stdout).not.toContain("vendor");
  });
});

describe("formatSpendBanner", () => {
  test("names the model, the pending census and the gate - including a zero gate", () => {
    expect(
      formatSpendBanner(
        {
          model: "text-embedding-3-small",
          pendingChunks: 214,
          tokens: 1,
          estimatedUsd: 0.011,
          priceSource: "builtin",
          blocked: false,
          reason: null,
        },
        0,
      ),
    ).toBe(
      "embedding spend: model text-embedding-3-small, 214 chunks pending, " +
        "estimated $0.0110 (gate: off)",
    );
    expect(
      formatSpendBanner(
        {
          model: null,
          pendingChunks: 1,
          tokens: 0,
          estimatedUsd: 0,
          priceSource: "builtin",
          blocked: false,
          reason: null,
        },
        0.5,
      ),
    ).toBe("embedding spend: model unknown, 1 chunks pending, estimated $0.0000 (gate: $0.5000)");
  });

  test("an unknown price prints price unknown, never a dollar figure", () => {
    expect(
      formatSpendBanner(
        {
          model: "zembed-1",
          pendingChunks: 3,
          tokens: 9,
          estimatedUsd: null,
          priceSource: "unknown",
          blocked: true,
          reason: "unpriced",
        },
        0.5,
      ),
    ).toBe("embedding spend: model zembed-1, 3 chunks pending, price unknown (gate: $0.5000)");
  });
});

/** Initialize the vault, drop one note in, and index it keyword-only. */
async function seedPendingChunks(): Promise<void> {
  const init = await runCli(["brain", "init", "--vault", vault], { env: baseEnv() });
  expect(init.returncode).toBe(0);
  writeFileSync(
    join(vault, "Brain", "note.md"),
    "# note\n\nprose long enough to cut at least one chunk for the index.\n",
  );
  const indexed = await runCli(["search", "index", "--vault", vault], { env: baseEnv() });
  expect(indexed.returncode).toBe(0);
}

describe("the spend surface end to end", () => {
  test.skipIf(!VEC_LOADABLE)(
    "a semantic lane announces spend before the pass and receipts it after",
    async () => {
      await seedPendingChunks();

      const run = await runCli(["brain", "maintenance", "run", "--vault", vault], {
        env: localSemanticEnv(),
      });
      expect(run.returncode).toBe(0);
      expect(run.stdout).toContain("embedding spend: model hashing-ngram-v1");
      expect(run.stdout).toContain("chunks pending");
      expect(run.stdout).toContain("(gate: off)");
      expect(run.stdout).toMatch(
        /reindex: ok in \d+ms \(tokens=\d+, estimatedUsd=0\.0000, model=hashing-ngram-v1\)/,
      );
    },
  );

  test.skipIf(!VEC_LOADABLE)(
    "--json carries banner and receipt; a run with nothing pending reports neither",
    async () => {
      await seedPendingChunks();

      const first = await runCli(["brain", "maintenance", "run", "--vault", vault, "--json"], {
        env: localSemanticEnv(),
      });
      expect(first.returncode).toBe(0);
      const payload = JSON.parse(first.stdout) as {
        spend?: {
          banner: {
            model: string;
            pendingChunks: number;
            estimatedUsd: number;
            priceSource: string;
            gateUsd: number;
          };
          receipt: MaintenanceSpendReceipt;
        };
        tasks: Array<{ name: string; ok: boolean; receipt?: MaintenanceSpendReceipt }>;
      };
      expect(payload.spend?.banner.model).toBe("hashing-ngram-v1");
      expect(payload.spend?.banner.pendingChunks).toBeGreaterThan(0);
      expect(payload.spend?.banner.gateUsd).toBe(0);
      const reindex = payload.tasks.find((t) => t.name === "reindex");
      expect(reindex?.ok).toBe(true);
      expect(payload.spend?.receipt).toEqual(reindex?.receipt);
      expect(payload.spend?.receipt.tokens).toBeGreaterThan(0);
      expect(payload.spend?.receipt.forced).toBe(false);
      // Who stated the price rides the banner, the receipt and the metric.
      expect(payload.spend?.banner.priceSource).toBe("builtin");
      expect(payload.spend?.receipt.priceSource).toBe("builtin");
      const metric = listMetrics(vault, { surface: MAINTENANCE_SPEND_METRIC }).at(-1);
      expect(metric?.payload["price_source"]).toBe("builtin");

      // The receipt the lane journaled agrees with the row it reported.
      const status = await runCli(["brain", "maintenance", "status", "--vault", vault, "--json"], {
        env: baseEnv(),
      });
      expect(status.returncode).toBe(0);
      const state = JSON.parse(status.stdout) as {
        journal: Array<{ task?: string; receipt?: MaintenanceSpendReceipt }>;
      };
      expect(state.journal.find((e) => e.task === "reindex")?.receipt).toEqual(
        payload.spend?.receipt,
      );

      // The next run's census is over the index BEFORE its walk, and
      // every embedded chunk the first pass left cannot spend again: the
      // banner is absent. (The receipt may still be present - the lane's
      // dream writes pages this run's walk then indexes, and the phase
      // prices what ITS census finds - which is exactly why the receipt
      // is the phase's own number and not the banner's.)
      const second = await runCli(["brain", "maintenance", "run", "--vault", vault, "--json"], {
        env: localSemanticEnv(),
      });
      expect(second.returncode).toBe(0);
      const secondPayload = JSON.parse(second.stdout) as {
        spend?: { banner?: unknown };
        tasks: Array<{ name: string; receipt?: unknown }>;
      };
      expect(secondPayload.spend?.banner).toBeUndefined();
    },
  );

  test.skipIf(!VEC_LOADABLE)(
    "without the opt-in a remote provider and an off gate stay keyword-only and spend nothing",
    async () => {
      let server: FakeHttp | null = null;
      try {
        server = await startFakeHttp();
        await seedPendingChunks();
        const remoteEnv = {
          OPEN_SECOND_BRAIN_CONFIG: configPath,
          OPEN_SECOND_BRAIN_SEARCH_SEMANTIC: "true",
          OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER: "openai-compat",
          OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL: server.url,
          OPEN_SECOND_BRAIN_EMBEDDING_MODEL: "text-embedding-3-small",
          OPEN_SECOND_BRAIN_EMBEDDING_KEY: FAKE_PROVIDER_KEY,
          OPEN_SECOND_BRAIN_EMBEDDING_COST_GATE: "0",
        };

        const run = await runCli(["brain", "maintenance", "run", "--vault", vault, "--json"], {
          env: remoteEnv,
        });
        expect(run.returncode).toBe(0);
        const payload = JSON.parse(run.stdout) as {
          spend?: unknown;
          tasks: Array<{ name: string; ok: boolean; receipt?: unknown }>;
        };
        const reindex = payload.tasks.find((t) => t.name === LANE_TASK.reindex);
        expect(reindex?.ok).toBe(true);
        expect(reindex?.receipt).toBeUndefined();
        expect(payload.spend).toBeUndefined();
        expect(server.callCount()).toBe(0);
      } finally {
        await server?.close();
      }
    },
  );

  test.skipIf(!VEC_LOADABLE)(
    "a positive gate refuses the pass unforced; --force-cost flags the receipt",
    async () => {
      let server: FakeHttp | null = null;
      try {
        server = await startFakeHttp();
        await seedPendingChunks();
        const pricedEnv = () => ({
          OPEN_SECOND_BRAIN_CONFIG: configPath,
          OPEN_SECOND_BRAIN_SEARCH_SEMANTIC: "true",
          OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER: "openai-compat",
          OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL: server!.url,
          OPEN_SECOND_BRAIN_EMBEDDING_MODEL: "text-embedding-3-small",
          OPEN_SECOND_BRAIN_EMBEDDING_KEY: FAKE_PROVIDER_KEY,
          OPEN_SECOND_BRAIN_EMBEDDING_COST_GATE: "0.000001",
          [MAINTENANCE_EMBEDDINGS_ENV]: "true",
        });

        const blocked = await runCli(["brain", "maintenance", "run", "--vault", vault], {
          env: pricedEnv(),
        });
        expect(blocked.returncode).toBe(MAINTENANCE_EXIT.failed);
        expect(blocked.stdout).toContain("embedding spend: model text-embedding-3-small");
        expect(blocked.stdout).toContain("reindex: FAILED");
        // The refusal is the cost gate's own message, naming the ceiling
        // and the remedy; a failed pass receipts nothing.
        expect(blocked.stdout).toContain("exceeds embedding_cost_gate_usd");
        expect(blocked.stdout).toContain("Re-run with --force-cost");
        // Refused BEFORE the provider was contacted: the gate spends nothing.
        expect(server.callCount()).toBe(0);

        const forced = await runCli(
          ["brain", "maintenance", "run", "--vault", vault, "--force-cost", "--json"],
          { env: pricedEnv() },
        );
        expect(forced.returncode).toBe(0);
        const payload = JSON.parse(forced.stdout) as {
          spend?: { receipt?: MaintenanceSpendReceipt };
          tasks: Array<{ name: string; ok: boolean; receipt?: MaintenanceSpendReceipt }>;
        };
        const reindex = payload.tasks.find((t) => t.name === "reindex");
        expect(reindex?.ok).toBe(true);
        expect(reindex?.receipt?.forced).toBe(true);
        expect(payload.spend?.receipt?.forced).toBe(true);
        expect(server.callCount()).toBeGreaterThan(0);
      } finally {
        await server?.close();
      }
    },
  );
});
