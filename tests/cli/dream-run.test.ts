/**
 * `o2b dream run` (change `dream-session-trigger`, design D3, spec "A due
 * pass is started once, detached"): the one command that runs a whole
 * live pass and records the day; as the worker, it runs only on the claim
 * it was given, takes the pass lock itself and gives the claim back once
 * the outcome is recorded. The last test starts one real detached worker
 * through the day check, keeps its handle and awaits its exit.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dreamDayCheck } from "../../src/core/brain/dream-trigger/check.ts";
import { dreamWorkerLogPath } from "../../src/core/brain/dream-trigger/due.ts";
import { dreamTriggerClaimPath } from "../../src/core/brain/dream-trigger/record.ts";
import * as gate from "../../src/core/brain/dream-owner/gate.ts";
import * as ownerModule from "../../src/core/brain/dream-owner/owner.ts";
import * as outcomeModule from "../../src/core/brain/dream-trigger/outcome.ts";
import { OPERATION, resolveSafeguardTimeoutMs } from "../../src/core/brain/safeguard.ts";
import * as o2bCommand from "../../src/core/maintenance/o2b-command.ts";
import { WORKER_LOG_ATTEMPT_PREFIX } from "../../src/core/store-migration/worker-log.ts";
import * as decideAuto from "../../src/core/topics/decide-auto.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { homeEnv } from "../helpers/platform.ts";
import { runCli } from "../helpers/run-cli.ts";
import { makeTriggerFixture, type TriggerFixture } from "../core/brain/dream-trigger/fixture.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let f: TriggerFixture;

beforeEach(() => {
  f = makeTriggerFixture();
});

afterEach(() => {
  f.cleanup();
});

function cli(args: string[]) {
  return runCli(["dream", "run", ...args], { env: { OPEN_SECOND_BRAIN_CONFIG: f.configPath } });
}

function claimPath(): string {
  return dreamTriggerClaimPath(f.recordPath);
}

function writeClaim(token: string): void {
  writeFileSync(claimPath(), JSON.stringify({ token, at: Date.now(), pid: 1 }));
}

describe("o2b dream run", () => {
  test("runs the front door and the pass, and records the day", async () => {
    const original = decideAuto.prepareClosedQuestions;
    const front = spyOn(decideAuto, "prepareClosedQuestions").mockImplementation((...args) =>
      original(...args),
    );
    let res;
    let calls = 0;
    try {
      res = await cli([]);
      calls = front.mock.calls.length;
    } finally {
      front.mockRestore();
    }
    expect(res.returncode).toBe(0);
    expect(calls).toBe(1);
    expect(res.stdout).toContain("run_id: ");
    const r = f.record()!;
    expect(r.last_run).toMatchObject({ by: "cli", outcome: "complete" });
    expect(r.closed).toBe(true);
    expect(res.stdout).toContain(`day: ${r.day} closed`);
  });

  test("--catch-up runs passes while the agent answers and the budget lasts, in one document", async () => {
    const budgets: Array<number | undefined> = [];
    let n = 0;
    const front = spyOn(decideAuto, "prepareClosedQuestions").mockImplementation(
      async (_vault, options) => {
        budgets.push(options?.agentBudgetMs);
        n += 1;
        return {
          produced: 0,
          left: 0,
          asked: {},
          answered: 0,
          agent:
            n === 1
              ? { status: "ran", answered: 3 }
              : { status: "skipped", reason: "no-work", answered: 0 },
        };
      },
    );
    let res;
    try {
      res = await cli(["--catch-up", "30", "--json"]);
    } finally {
      front.mockRestore();
    }
    expect(res.returncode).toBe(0);
    const doc = JSON.parse(res.stdout) as {
      ok: boolean;
      catch_up: { budget_ms: number; passes: Array<Record<string, unknown>> };
    };
    expect(doc.ok).toBe(true);
    expect(doc.catch_up.budget_ms).toBe(1_800_000);
    expect(doc.catch_up.passes.map((p) => p["agent_answered"])).toEqual([3, 0]);
    expect(budgets).toHaveLength(2);
    expect(budgets[0]!).toBeLessThanOrEqual(1_800_000);
    expect(budgets[0]!).toBeGreaterThan(1_700_000);
    expect(budgets[1]!).toBeLessThan(budgets[0]!);
    expect(f.record()!.closed).toBe(true);
  });

  // An ordinary run has one deadline: the model work spends it first and
  // the pass gets what is left. The clock is moved past the whole dream
  // timeout while the model work runs, so the pass has nothing left and
  // stops at its first checkpoint; a catch-up pass gets its own timeout
  // after the model work and completes.
  for (const catchUp of [false, true]) {
    test(`${catchUp ? "a catch-up pass gets its own timeout" : "an ordinary run's pass gets what the model work left"} after the model work`, async () => {
      const timeoutMs = resolveSafeguardTimeoutMs(OPERATION.dream, f.configPath)!;
      const front = spyOn(decideAuto, "prepareClosedQuestions").mockImplementation(async () => {
        setSystemTime(Date.now() + timeoutMs + 1000);
        return undefined;
      });
      let res;
      try {
        res = await cli(catchUp ? ["--catch-up", "30", "--json"] : ["--json"]);
      } finally {
        setSystemTime();
        front.mockRestore();
      }
      if (catchUp) {
        expect(res.returncode).toBe(0);
        return;
      }
      expect(res.returncode).not.toBe(0);
      expect(res.stdout + res.stderr).toContain("exceeded its safeguard timeout");
    });
  }

  test("--catch-up needs a number of minutes", async () => {
    for (const bad of ["0", "-5", "soon", "2000"]) {
      const res = await cli(["--catch-up", bad]);
      expect(res.returncode).toBe(2);
      expect(res.stderr).toContain("--catch-up");
    }
  });

  test("--json is one document", async () => {
    const res = await cli(["--json"]);
    expect(res.returncode).toBe(0);
    const doc = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(doc).toMatchObject({ ok: true, day: { closed: true, failures: 0 } });
    expect(typeof doc["run_id"]).toBe("string");
  });

  test("--no-vault runs on no vault, not the one the machine config resolves to", async () => {
    process.env["VAULT_DIR"] = join(f.tmp, "config-vault");
    const gated = spyOn(gate, "assertDreamOwner");
    let res;
    let vaults: unknown[] = [];
    try {
      res = await cli(["--no-vault", "--json"]);
      vaults = gated.mock.calls.map((c) => c[0]);
    } finally {
      gated.mockRestore();
    }
    expect(res.returncode).toBe(0);
    expect(vaults.length).toBeGreaterThan(0);
    expect(vaults.every((v) => v === null)).toBe(true);
  });

  test("--vault and --no-vault together are a usage error", async () => {
    const res = await cli(["--no-vault", "--vault", join(f.tmp, "v")]);
    expect(res.returncode).toBe(2);
  });

  test("is refused on a device that is not the owner, and records nothing", async () => {
    process.env["O2B_DEVICE_ID"] = "dev-b";
    const res = await cli(["--json"]);
    expect(res.returncode).toBe(1);
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: false, code: "dream_not_owner" });
    expect(existsSync(f.recordPath)).toBe(false);
  });

  test("a refused --catch-up --json pass is in the one document, not a document of its own", async () => {
    process.env["O2B_DEVICE_ID"] = "dev-b";
    const res = await cli(["--catch-up", "30", "--json"]);
    expect(res.returncode).toBe(1);
    const doc = JSON.parse(res.stdout) as {
      ok: boolean;
      catch_up: { passes: Array<Record<string, unknown>> };
    };
    expect(doc.ok).toBe(false);
    expect(doc.catch_up.passes).toHaveLength(1);
    expect(doc.catch_up.passes[0]).toMatchObject({ code: "dream_not_owner" });
  });
});

describe("o2b dream run --claim", () => {
  test("runs on its claim, takes the pass lock itself, and gives the claim back after the outcome", async () => {
    writeClaim("tok1");
    const original = ownerModule.withDreamPassLock;
    const seen: Array<{ claim: boolean; worker: unknown }> = [];
    const lock = spyOn(ownerModule, "withDreamPassLock").mockImplementation((...args) => {
      // The claim stands for the whole pass and its outcome, with the
      // worker's own pid written into it.
      const claim = existsSync(claimPath());
      const worker = claim ? JSON.parse(readFileSync(claimPath(), "utf8")).worker_pid : null;
      seen.push({ claim, worker });
      return original(...args);
    });
    let res;
    try {
      res = await cli(["--claim", "tok1"]);
    } finally {
      lock.mockRestore();
    }
    expect(res.returncode).toBe(0);
    // The pass, then the outcome, each under the pass lock this run took.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((s) => s.claim && s.worker === process.pid)).toBe(true);
    expect(f.record()!.last_run).toMatchObject({ by: "worker", outcome: "complete" });
    expect(existsSync(claimPath())).toBe(false);
  });

  test("a pass whose day could not be recorded keeps its claim and says so", async () => {
    writeClaim("tok1");
    const recording = spyOn(outcomeModule, "recordDreamOutcomeResult").mockImplementation(() => ({
      kind: "failed",
      message: "ENOSPC: no space left on device",
    }));
    let res;
    try {
      res = await cli(["--claim", "tok1"]);
    } finally {
      recording.mockRestore();
    }
    expect(res.returncode).toBe(0);
    expect(res.stderr).toContain("could not be recorded: ENOSPC");
    // Left for the next day check, which finds its worker gone and backs off.
    const kept = JSON.parse(readFileSync(claimPath(), "utf8"));
    expect(kept).toMatchObject({ token: "tok1", worker_pid: process.pid });
  });

  test("a token the claim does not hold runs nothing and leaves the claim", async () => {
    writeClaim("tok1");
    const front = spyOn(decideAuto, "prepareClosedQuestions");
    let res;
    let calls = -1;
    try {
      res = await cli(["--claim", "other", "--json"]);
      calls = front.mock.calls.length;
    } finally {
      front.mockRestore();
    }
    expect(res.returncode).toBe(1);
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: false, reason: "claim-not-held" });
    expect(calls).toBe(0);
    expect(existsSync(f.recordPath)).toBe(false);
    expect(JSON.parse(readFileSync(claimPath(), "utf8")).token).toBe("tok1");
  });

  test("no claim at all runs nothing", async () => {
    const res = await cli(["--claim", "tok1"]);
    expect(res.returncode).toBe(1);
    expect(existsSync(f.recordPath)).toBe(false);
  });

  test("a device that is not the owner gives its claim back", async () => {
    writeClaim("tok1");
    process.env["O2B_DEVICE_ID"] = "dev-b";
    const res = await cli(["--claim", "tok1"]);
    expect(res.returncode).toBe(1);
    expect(existsSync(claimPath())).toBe(false);
    expect(existsSync(f.recordPath)).toBe(false);
  });
});

describe("a real worker", () => {
  test("the day check starts one detached worker that closes the day and logs one attempt", async () => {
    const env = {
      ...process.env,
      ...homeEnv(join(f.tmp, "home")),
      OPEN_SECOND_BRAIN_DREAM_AUTO: "true",
    };
    // The worker's handle is kept, so the test awaits its exit and, when
    // a step fails, stops and awaits it before the fixture is removed.
    const original = o2bCommand.spawnSelfDetached;
    let worker: ReturnType<typeof Bun.spawn> | undefined;
    const spawn = spyOn(o2bCommand, "spawnSelfDetached").mockImplementation((argv, opts) => {
      worker = original(argv, opts);
      return worker;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(dreamDayCheck(f.config(), { env }).started).toBe(true);
      expect(worker).toBeDefined();
      // The worker removes its claim after it recorded the outcome, then exits.
      const exited = await Promise.race([
        worker!.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), CLI_SPAWN_BUDGET_MS - 5_000);
        }),
      ]);
      expect(exited).toBe(true);
    } finally {
      clearTimeout(timer);
      spawn.mockRestore();
      if (worker !== undefined) {
        if (worker.exitCode === null) worker.kill();
        await worker.exited;
      }
    }
    expect(existsSync(claimPath())).toBe(false);
    const r = f.record()!;
    expect(r.last_run).toMatchObject({ by: "worker", outcome: "complete" });
    expect(r.closed).toBe(true);
    const log = readFileSync(dreamWorkerLogPath(f.store("dev-a")), "utf8");
    expect(log.split("\n").filter((l) => l.startsWith(WORKER_LOG_ATTEMPT_PREFIX))).toHaveLength(1);
  });
});
