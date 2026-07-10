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
import { defaultConfigPath, resolveBenchJudgeCmd } from "../../../core/config.ts";
import { fail, parse } from "../helpers.ts";

const USAGE =
  "usage: o2b brain bench memory --fixture <name|path> [--suite locomo] [--resume <run-id>] [--runs-dir <dir>] [--json]";

const DEFAULT_RUNS_DIR = join(".open-second-brain", "bench-runs");
const REPO_FIXTURE_DIR = join("tests", "fixtures", "bench");

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
  if (suite !== "" && suite !== "locomo") {
    return fail(`brain bench memory: unknown --suite '${suite}' (supported: locomo)`);
  }
  const fixturePath = resolveFixturePath(fixtureFlag);
  if (fixturePath === null) {
    return fail(
      `brain bench memory: fixture not found: ${fixtureFlag} (tried the literal path and ${REPO_FIXTURE_DIR}/${fixtureFlag}.json)`,
    );
  }

  // The LoCoMo suite loads a LoCoMo-shaped dataset and converts it to a
  // BenchFixture; the default path loads a native fixture directly.
  const fixture =
    suite === "locomo" ? loadLocomoFixture(fixturePath) : loadBenchFixture(fixturePath);
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
    `context_cost: avg_chars ${report.context_cost.avg_chars} est_tokens ${report.context_cost.est_tokens}\n`,
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
