/**
 * `o2b brain skill-proposals rewrite-plan` and `rewrite-score` on a
 * switched vault with no `Brain/` tree. The benchmark task set, its frozen
 * spec and the round transcripts are entries of the store's
 * `skill-benchmark` lane there (the migration imports
 * `Brain/skill-benchmarks/**` into it), so the verbs read them through the
 * lane page store instead of refusing with "no benchmark task set".
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  skillBenchmarkRoundsDir,
  skillBenchmarkSpecPath,
  skillBenchmarkTasksPath,
} from "../../src/core/brain/paths.ts";
import { sha256Hex } from "../../src/core/integrity/digest.ts";
import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { writeLaneText } from "../../src/core/store/lane-pages.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { runCli } from "../helpers/run-cli.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "skill-bench", "example-skill");
const SPEC = JSON.parse(readFileSync(join(FIXTURE_DIR, "spec.json"), "utf8")) as {
  dev_task_ids: ReadonlyArray<string>;
};

const INCUMBENT = [
  "---",
  "name: example-skill",
  "description: The incumbent instructions.",
  "version: 3",
  "---",
  "# example-skill",
  "",
  "Incumbent body.",
  "",
].join("\n");

const CANDIDATE = "Candidate body.";

function cliEnv(e: StoreEnv): Record<string, string> {
  return {
    OPEN_SECOND_BRAIN_CONFIG: e.configPath,
    [STORE_ROOT_ENV]: e.storeRoot,
    O2B_DEVICE_ID: "dev-a",
    HOME: join(e.parent, "home"),
    XDG_STATE_HOME: join(e.parent, "state"),
    LOCALAPPDATA: join(e.parent, "state"),
  };
}

/** A transcript that fails every check, so both arms hold at the same rate. */
function emptyTranscript(taskId: string, bound: Record<string, string> = {}): string {
  const row = { task_id: taskId, steps: [], tools_used: [], artifacts: [], output: {}, ...bound };
  return `${JSON.stringify(row)}\n`;
}

test("rewrite-plan and rewrite-score read the benchmark from the store on a switched vault", async () => {
  env = makeStoreEnv("osb-rewrite-store-only-", { legacyTree: false });
  const { vault, parent } = env;
  writeLaneText(
    vault,
    skillBenchmarkTasksPath(vault, "example-skill"),
    readFileSync(join(FIXTURE_DIR, "tasks.json"), "utf8"),
  );
  writeLaneText(
    vault,
    skillBenchmarkSpecPath(vault, "example-skill"),
    readFileSync(join(FIXTURE_DIR, "spec.json"), "utf8"),
  );
  const rounds = skillBenchmarkRoundsDir(vault, "example-skill");
  const bound = { candidate_sha256: sha256Hex(CANDIDATE) };
  for (const taskId of SPEC.dev_task_ids) {
    writeLaneText(vault, join(rounds, "baseline", `${taskId}.json`), emptyTranscript(taskId));
    writeLaneText(
      vault,
      join(rounds, "candidate", `${taskId}.json`),
      emptyTranscript(taskId, bound),
    );
  }
  const skillsRoot = join(parent, "skills");
  mkdirSync(join(skillsRoot, "example-skill"), { recursive: true });
  writeFileSync(join(skillsRoot, "example-skill", "SKILL.md"), INCUMBENT);
  const candidate = join(parent, "candidate.md");
  writeFileSync(candidate, CANDIDATE);
  expect(existsSync(join(vault, "Brain"))).toBe(false);

  const common = ["example-skill", "--vault", vault, "--candidate-file", candidate];
  const plan = await runCli(
    ["brain", "skill-proposals", "rewrite-plan", ...common, "--skills-root", skillsRoot],
    { env: cliEnv(env) },
  );
  expect(plan.stderr).toBe("");
  expect(plan.returncode).toBe(0);
  expect(plan.stdout).toContain(`rounds/baseline/${SPEC.dev_task_ids[0]}.json`);

  const score = await runCli(
    ["brain", "skill-proposals", "rewrite-score", ...common, "--skills-root", skillsRoot],
    { env: cliEnv(env) },
  );
  expect(score.stderr).toBe("");
  expect(score.returncode).toBe(0);
  expect(score.stdout).toContain("hold");
  expect(existsSync(join(vault, "Brain"))).toBe(false);
});
