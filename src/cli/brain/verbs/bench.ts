/**
 * `o2b brain bench memory` (Memory Observability Suite, t_882c396a):
 * memory quality benchmark over a disposable fixture vault.
 *
 * The harness NEVER touches the operator's configured vault: it
 * materializes the fixture into `<runs-dir>/<run-id>/vault` and runs
 * the public search/context-pack APIs there. Deterministic and
 * network-free by default; `bench_judge_cmd` arms the optional
 * external judge. Quality, latency, and context cost stay separate
 * report families (the MemScore lesson).
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadBenchFixture } from "../../../core/bench/fixture.ts";
import { loadLocomoFixture } from "../../../core/bench/locomo.ts";
import { runMemoryBench } from "../../../core/bench/phases.ts";
import type { BenchFixture, BenchSuiteRegistration } from "../../../core/bench/types.ts";
import { defaultConfigPath, resolveBenchJudgeCmd } from "../../../core/config.ts";
import { fail, parse } from "../helpers.ts";

const USAGE =
  "usage: o2b brain bench memory --fixture <name|path> [--suite <name>] [--resume <run-id>] [--runs-dir <dir>] [--json]";

const DEFAULT_RUNS_DIR = join(".open-second-brain", "bench-runs");
const REPO_FIXTURE_DIR = join("tests", "fixtures", "bench");

/** A suite name must be safe to echo into errors, reports and run ids. */
const SUITE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * The path with no `--suite`: a native fixture loads directly. Not a
 * named suite - it is the byte-identical default the registry must
 * preserve.
 */
const DEFAULT_SUITE_REGISTRATION: BenchSuiteRegistration = Object.freeze({
  loader: (fixturePath: string): BenchFixture => loadBenchFixture(fixturePath),
  capabilities: Object.freeze({ embeddings: false }),
});

/**
 * Suite registry: maps a `--suite` name to its loader and declared
 * capabilities. This map is the appendable registration point - suite
 * modules add their own entries here (or through
 * {@link registerBenchSuite}), never a new branch in the verb body.
 */
const BENCH_SUITES = new Map<string, BenchSuiteRegistration>([
  [
    "locomo",
    Object.freeze({
      loader: (fixturePath: string): BenchFixture => loadLocomoFixture(fixturePath),
      capabilities: Object.freeze({ embeddings: false }),
    }),
  ],
]);

/** Register a bench suite. Refuses an invalid or already-taken name. */
export function registerBenchSuite(name: string, registration: BenchSuiteRegistration): void {
  if (!SUITE_NAME_PATTERN.test(name)) {
    throw new Error(`bench suite name is invalid: '${name}'`);
  }
  if (BENCH_SUITES.has(name)) {
    throw new Error(`bench suite already registered: ${name}`);
  }
  BENCH_SUITES.set(name, registration);
}

/** Look up a registered suite by name. */
export function benchSuite(name: string): BenchSuiteRegistration | undefined {
  return BENCH_SUITES.get(name);
}

/** Registered suite names, sorted for stable listings. */
export function benchSuiteNames(): ReadonlyArray<string> {
  return [...BENCH_SUITES.keys()].toSorted();
}

export async function cmdBrainBench(argv: string[]): Promise<number> {
  if (argv[0] !== "memory") return fail(USAGE);
  const { flags } = parse(argv.slice(1), {
    fixture: { type: "string" },
    suite: { type: "string" },
    resume: { type: "string" },
    "runs-dir": { type: "string" },
    json: { type: "boolean" },
  });
  const fixtureFlag = typeof flags["fixture"] === "string" ? flags["fixture"].trim() : "";
  if (fixtureFlag === "") return fail(USAGE);
  const suite = typeof flags["suite"] === "string" ? flags["suite"].trim() : "";
  let registration = DEFAULT_SUITE_REGISTRATION;
  if (suite !== "") {
    const known = BENCH_SUITES.get(suite);
    if (known === undefined) {
      return fail(
        `brain bench memory: unknown --suite '${suite}' (supported: ${benchSuiteNames().join(", ")})`,
      );
    }
    registration = known;
  }
  const fixturePath = resolveFixturePath(fixtureFlag);
  if (fixturePath === null) {
    return fail(
      `brain bench memory: fixture not found: ${fixtureFlag} (tried the literal path and ${REPO_FIXTURE_DIR}/${fixtureFlag}.json)`,
    );
  }

  // One dispatch for every suite: the registry entry owns loading and
  // declares what the suite may do; the capabilities ride BenchRunOptions.
  const fixture = registration.loader(fixturePath);
  const runsDir = resolve(
    typeof flags["runs-dir"] === "string" && flags["runs-dir"].trim() !== ""
      ? flags["runs-dir"].trim()
      : DEFAULT_RUNS_DIR,
  );
  const resume = typeof flags["resume"] === "string" ? flags["resume"].trim() : undefined;
  const judgeCmd = resolveBenchJudgeCmd(defaultConfigPath());

  const report = await runMemoryBench({
    fixture,
    runsDir,
    ...(suite !== "" ? { suite } : {}),
    capabilities: registration.capabilities,
    ...(resume !== undefined && resume !== "" ? { resume } : {}),
    ...(judgeCmd !== undefined ? { judgeCmd } : {}),
  });

  if (flags["json"] === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.quality.passed === report.quality.total ? 0 : 1;
  }
  process.stdout.write(`bench ${report.fixture} run ${report.run_id}\n`);
  process.stdout.write(
    `quality: ${report.quality.passed}/${report.quality.total} (pass rate ${report.quality.pass_rate})\n`,
  );
  process.stdout.write(`latency_ms: avg ${report.latency_ms.avg} max ${report.latency_ms.max}\n`);
  process.stdout.write(
    `context_cost: avg_chars ${report.context_cost.avg_chars} avg_injected_tokens ${report.context_cost.avg_injected_tokens}\n`,
  );
  process.stdout.write(
    `failure_modes: know_to_ask ${report.failure_modes.know_to_ask_failure_rate} ` +
      `false_fire ${report.failure_modes.false_fire_rate} ` +
      `isolation_violations ${report.failure_modes.source_isolation_violations}\n`,
  );
  process.stdout.write(`judge: ${report.judge.status}\n`);
  for (const question of report.questions) {
    process.stdout.write(
      `  ${question.pass ? "PASS" : "FAIL"}  ${question.id} (${question.category})${question.failure ? ` - ${question.failure}` : ""}\n`,
    );
  }
  return report.quality.passed === report.quality.total ? 0 : 1;
}

function resolveFixturePath(flag: string): string | null {
  if (existsSync(flag)) return flag;
  const repoLocal = join(REPO_FIXTURE_DIR, `${flag}.json`);
  if (existsSync(repoLocal)) return repoLocal;
  return null;
}
