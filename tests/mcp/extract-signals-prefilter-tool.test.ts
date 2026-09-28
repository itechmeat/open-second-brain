/**
 * `brain_extract_signals` and `o2b brain extract-signals` with the
 * decision-model turn pre-filter (issue #213, Part 4), end to end over a
 * loopback fake `/v1/systemone` server. Claims pinned here:
 *
 *  1. Without the feature the plan output carries none of the new fields.
 *  2. Enforce with every turn below the threshold returns `llm_step: null`
 *     plus `skipped`, on both surfaces.
 *  3. Enforce with some turns dropped returns `turns_dropped` beside the
 *     kept `turns_mined`.
 *  4. A server failure returns every turn plus `decision_model.degraded`.
 *  5. The commit accepts `source_turn` through the tool's input schema.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importSessionRecall } from "../../src/core/brain/session-recall.ts";
import {
  listDecisionModelExtractCommits,
  resetDecisionSpendCache,
} from "../../src/core/decision-model/record.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { FAKE_DECISION_KEY } from "../helpers/fake-credentials.ts";
import {
  answerAll,
  startFakeSystemOne,
  type FakeSystemOne,
} from "../helpers/fake-decision-provider.ts";
import { runCli } from "../helpers/run-cli.ts";

const TOOL = "brain_extract_signals";
const SESSION = "sess-mcp-prefilter";
const KEY_VAR = "O2B_TEST_EXTRACT_PREFILTER_KEY";

let server: FakeSystemOne;
let tmp: string;
let vault: string;
let configPath: string;
let ctx: ServerContext;

beforeAll(async () => {
  server = await startFakeSystemOne();
});
afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  resetDecisionSpendCache();
  server.requests.length = 0;
  tmp = mkdtempSync(join(tmpdir(), "o2b-extract-prefilter-mcp-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
  importSessionRecall(vault, {
    sessionId: SESSION,
    turns: [
      { turnId: "t1", timestamp: "2026-09-20T09:01:00Z", role: "user", text: "Always use tabs." },
      { turnId: "t2", timestamp: "2026-09-20T09:02:00Z", role: "user", text: "Deploy it now." },
    ],
    createdAt: "2026-09-20T10:00:00Z",
  });
  ctx = { vault, configPath, repoRoot: null };
  process.env[KEY_VAR] = FAKE_DECISION_KEY;
});

afterEach(() => {
  delete process.env[KEY_VAR];
  rmSync(tmp, { recursive: true, force: true });
});

function enable(mode: "shadow" | "enforce"): void {
  writeFileSync(
    configPath,
    [
      `vault: "${vault}"`,
      'decision_model_enabled: "true"',
      'decision_model_provider: "compatible"',
      'decision_model_threshold_profile: "jev-1.13"',
      `decision_model_base_url: "${server.url}"`,
      'decision_model_id: "fake-model-1"',
      `decision_model_env_key: "${KEY_VAR}"`,
      `decision_model_uses: "extract_prefilter:${mode}"`,
    ].join("\n") + "\n",
  );
}

/** The turn "Always use tabs." states a rule; anything else does not. */
function scoreByText(ruleP: number, otherP: number): void {
  server.setReply((req) => {
    const turns = (req.body["state"] as { turns: Record<string, string> }).turns;
    return {
      json: answerAll(req, (id) =>
        turns[`T${id.replace("sig_", "")}`] === "Always use tabs." ? ruleP : otherP,
      ),
    };
  });
}

async function plan(): Promise<Record<string, unknown>> {
  return (await findTool(buildToolTable("full"), TOOL).handler(ctx, {
    session: SESSION,
  })) as Record<string, unknown>;
}

test("without the feature the plan carries none of the new fields", async () => {
  const res = await plan();
  expect(res["turns_dropped"]).toBeUndefined();
  expect(res["skipped"]).toBeUndefined();
  expect(res["decision_model"]).toBeUndefined();
  expect(JSON.stringify(res["llm_step"])).not.toContain("source_turn");
  expect(server.requests).toHaveLength(0);
});

test("enforce, every turn below the threshold: llm_step null plus skipped", async () => {
  enable("enforce");
  scoreByText(0.01, 0.01);
  const res = await plan();
  expect(res["llm_step"]).toBeNull();
  expect(res["skipped"]).toEqual({ reason: "decision_model_prefilter", turns_dropped: 2 });
  expect(res["turns_dropped"]).toEqual(["t1", "t2"]);
  expect(res["turns_mined"]).toEqual([]);
  expect(server.requests).toHaveLength(1);
  expect(server.requests[0]!.bodyText).not.toContain("t1");

  const cli = await runCli(["brain", "extract-signals", SESSION, "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath, [KEY_VAR]: FAKE_DECISION_KEY },
  });
  expect(cli.returncode).toBe(0);
  expect(cli.stdout).toContain("nothing to mine");
});

test("enforce, some turns dropped: turns_dropped next to the kept turns", async () => {
  enable("enforce");
  scoreByText(0.9, 0.01);
  const res = await plan();
  expect((res["turns_mined"] as Array<{ turn_id: string }>).map((t) => t.turn_id)).toEqual(["t1"]);
  expect(res["turns_dropped"]).toEqual(["t2"]);
  expect(res["skipped"]).toBeUndefined();
  expect(JSON.stringify(res["llm_step"])).toContain("source_turn");

  const cli = await runCli(["brain", "extract-signals", SESSION, "--vault", vault, "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath, [KEY_VAR]: FAKE_DECISION_KEY },
  });
  expect(cli.returncode).toBe(0);
  const json = JSON.parse(cli.stdout) as Record<string, unknown>;
  expect(json["turns_dropped"]).toEqual(["t2"]);
});

test("a server failure returns every turn and names the reason", async () => {
  enable("enforce");
  server.setReply(() => ({ status: 529, json: { error: "overloaded" } }));
  const res = await plan();
  expect((res["turns_mined"] as unknown[]).length).toBe(2);
  expect(res["decision_model"]).toEqual({ degraded: "http_529" });
  expect(res["turns_dropped"]).toBeUndefined();
});

test("shadow commit: source_turn reaches the commit record through the tool", async () => {
  enable("shadow");
  scoreByText(0.9, 0.01);
  const planned = await plan();
  expect(planned["turns_dropped"]).toBeUndefined();
  const res = (await findTool(buildToolTable("full"), TOOL).handler(ctx, {
    session: SESSION,
    items: [
      {
        topic: "indent-with-tabs",
        signal: "positive",
        principle: "Indent code with tabs.",
        confidence: 0.9,
        source_turn: "t1",
      },
    ],
  })) as { written: unknown[] };
  expect(res.written).toHaveLength(1);
  const commits = listDecisionModelExtractCommits(vault);
  expect(commits).toHaveLength(1);
  expect(commits[0]!.payload).toMatchObject({
    written_count: 1,
    source_turns: ["t1"],
    without_source_turn_count: 0,
  });
  const schema = findTool(buildToolTable("full"), TOOL).inputSchema as {
    properties: { items: { items: { properties: Record<string, unknown> } } };
  };
  expect(schema.properties.items.items.properties["source_turn"]).toBeDefined();
});
