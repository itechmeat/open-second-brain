/**
 * `o2b decision-model eval run|list` and the doctor probe's measured
 * state (cycle 20261020, card t_4e1681b3, task C4).
 *
 * `eval run` grades the preregistered take over the real adapter - the
 * loopback fake here, never a hosted route - and a promote verdict
 * writes the machine-side tuning mark under the state root, which the
 * config resolver and the doctor then honor. `eval list` round-trips
 * the cached grade records and skips malformed ones with a named note.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probeDecisionModel } from "../../src/core/doctor-readiness.ts";
import {
  decisionEvalSpecFor,
  decisionEvalSpecHash,
} from "../../src/core/decision-model/eval-spec.ts";
import { FAKE_DECISION_KEY } from "../helpers/fake-credentials.ts";
import { startFakeSystemOne, type FakeSystemOne } from "../helpers/fake-decision-provider.ts";
import { runCli } from "../helpers/run-cli.ts";

const KEY_VAR = "O2B_TEST_DECISION_EVAL_KEY";

let server: FakeSystemOne;
let tmp: string;
let vault: string;
let configPath: string;
let stateDir: string;

beforeAll(async () => {
  server = await startFakeSystemOne();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-dm-eval-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  stateDir = join(tmp, "state");
  server.requests.length = 0;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(entries: Record<string, string>): void {
  const lines = [`vault: "${vault}"`, ...Object.entries(entries).map(([k, v]) => `${k}: "${v}"`)];
  writeFileSync(configPath, lines.join("\n") + "\n");
}

/** Env for a CLI child: the loopback key, this vault's config, this state root. */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    XDG_STATE_HOME: stateDir,
    [KEY_VAR]: FAKE_DECISION_KEY,
    ...extra,
  };
}

/** The active eval config; the loopback base URL is added at call time. */
const ENABLED = {
  decision_model_enabled: "true",
  decision_model_provider: "laya",
  decision_model_uses: "rerank:shadow",
};

function writeEnabledConfig(): void {
  writeConfig({ ...ENABLED, decision_model_base_url: server.url, decision_model_id: "english" });
}

/**
 * Answer every relevance question by the fixtures' labeling rule, read
 * off the request body the adapter actually sent: an on-topic passage
 * helps. This is the same rule the committed gold labels follow.
 */
function answerByLabel(req: { body: Record<string, unknown> }): {
  json: unknown;
} {
  const state = req.body["state"] as {
    query?: string;
    passages?: Record<string, string>;
  };
  const subject = /the (.+)\?/.exec(state.query ?? "")![1] ?? "\u0000";
  const questions = req.body["questions"] as Record<string, { type: string }>;
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    const key = id.startsWith("rel_") ? `P${id.slice(4)}` : null;
    const text = key === null ? "" : (state.passages?.[key] ?? "");
    answers[id] = { type: q.type, noul: text.includes(subject) ? 0.99 : 0.01 };
  }
  return {
    json: {
      model: "fake-model-1.0",
      answers,
      usage: { input_tokens: 321, output_tokens: 7 },
    },
  };
}

describe("o2b decision-model eval", () => {
  test("an unknown subcommand prints usage and exits 2", async () => {
    const res = await runCli(["decision-model", "eval", "--config", configPath], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("usage: o2b decision-model");
    expect(res.stderr).toContain("eval run");
    expect(res.stderr).toContain("eval list");
  });

  test("eval run refuses an unknown use, a specless use and an inactive config", async () => {
    writeEnabledConfig();
    const env = childEnv();
    const bad = await runCli(
      ["decision-model", "eval", "run", "--use", "nonsense", "--config", configPath],
      { env },
    );
    expect(bad.returncode).toBe(2);
    expect(bad.stderr).toContain("decision-model use");

    const specless = await runCli(
      ["decision-model", "eval", "run", "--use", "dedup", "--config", configPath],
      { env },
    );
    expect(specless.returncode).toBe(2);
    expect(specless.stderr).toContain("no preregistered spec");

    // An inactive config is a refusal: a keyed preset without its key is
    // no_key (the keyless laya loopback above cannot produce one).
    writeConfig({
      decision_model_enabled: "true",
      decision_model_provider: "compatible",
      decision_model_base_url: server.url,
      decision_model_id: "fake-model-1",
      decision_model_env_key: KEY_VAR,
      decision_model_uses: "rerank:shadow",
    });
    const noKey = await runCli(
      ["decision-model", "eval", "run", "--use", "rerank", "--config", configPath],
      { env: { OPEN_SECOND_BRAIN_CONFIG: configPath, XDG_STATE_HOME: stateDir } },
    );
    expect(noKey.returncode).toBe(2);
    expect(noKey.stderr).toContain("o2b decision-model check");
  });

  test("eval run refuses a use that is off before sending or caching anything", async () => {
    // decision_model_uses lists only rerank: recall_inject defaults to
    // off, and the runner's mode override would send nothing, score
    // every item degraded, cache that junk grade and exit 0 - a named
    // refusal is owed instead, before any of that happens.
    writeEnabledConfig();
    server.setReply(answerByLabel);
    const res = await runCli(
      ["decision-model", "eval", "run", "--use", "recall_inject", "--config", configPath],
      { env: childEnv() },
    );
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("recall_inject");
    expect(res.stderr).toContain("decision_model_uses");
    expect(server.requests).toHaveLength(0);
    const listJson = await runCli(
      ["decision-model", "eval", "list", "--config", configPath, "--json"],
      { env: childEnv() },
    );
    expect(listJson.returncode).toBe(0);
    const listed = JSON.parse(listJson.stdout) as { grades: unknown[]; skipped: unknown[] };
    expect(listed.grades).toHaveLength(0);
    expect(listed.skipped).toHaveLength(0);
  }, 30000);

  test("a promote run writes the mark, caches the grade and the doctor names it", async () => {
    writeEnabledConfig();
    server.setReply(answerByLabel);
    const res = await runCli(
      ["decision-model", "eval", "run", "--use", "rerank", "--config", configPath, "--json"],
      { env: childEnv() },
    );
    expect(res.returncode).toBe(0);
    const run = JSON.parse(res.stdout) as {
      verdict: string;
      mark_written: boolean;
      grade_record_id: string | null;
      counted: { n: number; error: number | null };
    };
    expect(run.verdict).toBe("promote");
    expect(run.mark_written).toBe(true);
    expect(run.counted).toMatchObject({ n: 30, error: 0 });

    // The machine-side mark exists under this run's state root, for the
    // resolved profile and use.
    const markPath = join(
      stateDir,
      "open-second-brain",
      "decision-model",
      "tuning-marks",
      "laya",
      "rerank.json",
    );
    expect(existsSync(markPath)).toBe(true);
    const mark = JSON.parse(readFileSync(markPath, "utf8")) as { verdict: string; use: string };
    expect(mark).toMatchObject({ verdict: "promote", use: "rerank" });

    // The grade record is cached in the vault and round-trips through
    // eval list, in prose and as JSON.
    expect(run.grade_record_id).not.toBeNull();
    const listJson = await runCli(
      ["decision-model", "eval", "list", "--use", "rerank", "--config", configPath, "--json"],
      { env: childEnv() },
    );
    expect(listJson.returncode).toBe(0);
    const listed = JSON.parse(listJson.stdout) as {
      grades: Array<{ use: string; verdict: string; spec_hash: string }>;
      skipped: string[];
    };
    expect(listed.grades).toHaveLength(1);
    expect(listed.grades[0]).toMatchObject({ use: "rerank", verdict: "promote" });
    expect(listed.skipped).toEqual([]);

    const listProse = await runCli(["decision-model", "eval", "list", "--config", configPath], {
      env: childEnv(),
    });
    const spec12 = decisionEvalSpecHash(decisionEvalSpecFor("rerank")!).slice(0, 12);
    expect(listProse.stdout).toContain("eval grades: 1 record(s)");
    expect(listProse.stdout).toContain("rerank (laya) promote");
    expect(listProse.stdout).toContain(`spec ${spec12}`);

    // The doctor probe names the measured state for the active config.
    const verdict = await probeDecisionModel({
      vault,
      config: configPath,
      env: childEnv() as unknown as NodeJS.ProcessEnv,
    });
    expect(verdict.status).toBe("pass");
    expect(verdict.detail).toContain("measured under spec hash");
    expect(verdict.detail).toContain("(rerank)");
  }, 30000);

  test("eval list skips a malformed record with a named note, in prose and JSON", async () => {
    writeEnabledConfig();
    server.setReply(answerByLabel);
    await runCli(["decision-model", "eval", "run", "--use", "rerank", "--config", configPath], {
      env: childEnv(),
    });
    // A hand-written record that claims a measurement without the fields.
    const { appendContinuityRecord } = await import("../../src/core/brain/continuity/store.ts");
    appendContinuityRecord(vault, {
      kind: "decision_model_eval_grade",
      createdAt: new Date().toISOString(),
      sourceRefs: [],
      payload: { use: "rerank", verdict: "promote" },
    });

    const listJson = await runCli(
      ["decision-model", "eval", "list", "--config", configPath, "--json"],
      {
        env: childEnv(),
      },
    );
    const listed = JSON.parse(listJson.stdout) as { grades: unknown[]; skipped: string[] };
    expect(listed.grades).toHaveLength(1);
    expect(listed.skipped).toHaveLength(1);
    expect(listed.skipped[0]).toMatch(/decision_model_eval_grade record .+ skipped: spec_hash/);

    const listProse = await runCli(["decision-model", "eval", "list", "--config", configPath], {
      env: childEnv(),
    });
    expect(listProse.stdout).toContain("skipped: decision_model_eval_grade record");
  }, 30000);

  test("eval list with no records says so and exits 0", async () => {
    writeEnabledConfig();
    const res = await runCli(["decision-model", "eval", "list", "--config", configPath], {
      env: childEnv(),
    });
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("eval grades: none cached");
  });
});
