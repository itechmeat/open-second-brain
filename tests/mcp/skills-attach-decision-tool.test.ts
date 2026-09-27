/**
 * `skills_attach` with the optional `skills` decision-model use (issue
 * #213, Part 3), end to end through the MCP handler and a loopback fake
 * `/v1/systemone` server. No network beyond loopback.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listDecisionModelCalls,
  resetDecisionSpendCache,
} from "../../src/core/decision-model/record.ts";
import { SKILL_TOOLS } from "../../src/mcp/skill-tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { FAKE_DECISION_KEY } from "../helpers/fake-credentials.ts";
import {
  startFakeSystemOne,
  type FakeSystemOne,
  type SystemOneRequestLog,
} from "../helpers/fake-decision-provider.ts";

const KEY_VAR = "O2B_TEST_SKILLS_DECISION_KEY";
const QUERY = "cut a release and write the changelog";

let tmp: string;
let vault: string;
let configPath: string;
let server: FakeSystemOne;

function writeSkill(root: string, name: string, description: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`,
  );
}

beforeEach(async () => {
  resetDecisionSpendCache();
  tmp = mkdtempSync(join(tmpdir(), "osb-attach-dm-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  const root = join(tmp, "skills");
  writeSkill(root, "release-cut", "Cut a release: version bump, tag and publish.");
  writeSkill(root, "changelog-writer", "Write the changelog entry for a release.");
  for (const n of ["vault-health", "schema-author", "codegraph", "doctor", "embeddings-setup"]) {
    writeSkill(root, n, `Helper for ${n}.`);
  }
  configPath = join(tmp, "config.yaml");
  server = await startFakeSystemOne();
  process.env[KEY_VAR] = FAKE_DECISION_KEY;
});

afterEach(async () => {
  delete process.env[KEY_VAR];
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(uses: string | null, enabled = true): void {
  const lines = [`vault: "${vault}"`, `skill_auto_attach: "true"`];
  if (uses !== null) {
    lines.push(
      `decision_model_enabled: "${enabled}"`,
      "decision_model_provider: compatible",
      "decision_model_threshold_profile: jev-1.13",
      `decision_model_base_url: ${server.url}`,
      "decision_model_id: fake-model-1",
      `decision_model_env_key: ${KEY_VAR}`,
      `decision_model_allow_insecure_http: "true"`,
      `decision_model_uses: "${uses}"`,
    );
  }
  writeFileSync(configPath, lines.join("\n") + "\n");
}

function ctx(): ServerContext {
  return { vault, configPath, repoRoot: tmp };
}

async function attach(): Promise<Record<string, unknown>> {
  const tool = SKILL_TOOLS.find((t) => t.name === "skills_attach")!;
  return (await tool.handler(ctx(), { query: QUERY })) as Record<string, unknown>;
}

/** Stage 1 prefers `changelog-writer`; stage 2 accepts every finalist. */
function reply(req: SystemOneRequestLog) {
  const questions = req.body["questions"] as Record<string, { type: string; criteria: object }>;
  const state = req.body["state"] as { skills: Record<string, string> };
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      answers[id] = { type: "noul", noul: 0.9 };
      continue;
    }
    const keys = Object.keys(q.criteria);
    const favourite =
      Object.entries(state.skills).find(([, t]) => t.startsWith("changelog-writer"))?.[0] ?? "none";
    const probabilities: Record<string, number> = {};
    for (const k of keys) probabilities[k] = k === favourite ? 0.7 : 0.3 / (keys.length - 1);
    answers[id] = { type: "choice", choice: favourite, probabilities };
  }
  return {
    json: { model: "fake-model-1.0", answers, usage: { input_tokens: 50, output_tokens: 2 } },
  };
}

test("with no decision config the result is today's, with no field and no request", async () => {
  writeConfig(null);
  const plain = await attach();
  expect(plain).not.toHaveProperty("decision_model");
  writeConfig("rerank:enforce");
  const withOtherUse = await attach();
  expect(JSON.stringify(withOtherUse)).toBe(JSON.stringify(plain));
  expect(server.requests).toHaveLength(0);
  expect(listDecisionModelCalls(vault)).toHaveLength(0);
});

test("skills use configured but the feature disabled: today's result", async () => {
  writeConfig(null);
  const plain = await attach();
  writeConfig("skills:enforce", false);
  expect(JSON.stringify(await attach())).toBe(JSON.stringify(plain));
  expect(server.requests).toHaveLength(0);
});

test("enabled without the key: today's result, no request", async () => {
  writeConfig(null);
  const plain = await attach();
  writeConfig("skills:enforce");
  delete process.env[KEY_VAR];
  expect(JSON.stringify(await attach())).toBe(JSON.stringify(plain));
  expect(server.requests).toHaveLength(0);
});

test("shadow: same block, skills and offer id, plus the decision_model field", async () => {
  writeConfig(null);
  const plain = await attach();
  writeConfig("skills:shadow");
  server.setReply(reply);
  const shadow = await attach();
  const { decision_model: field, ...rest } = shadow;
  expect(JSON.stringify(rest)).toBe(JSON.stringify(plain));
  expect(field).toEqual({ mode: "shadow", applied: false, model: "fake-model-1.0" });
  expect(server.requests).toHaveLength(2);
  expect(listDecisionModelCalls(vault).filter((r) => r.payload["use"] === "skills")).toHaveLength(
    2,
  );
});

test("enforce: the decision offer is returned", async () => {
  writeConfig("skills:enforce");
  server.setReply(reply);
  const result = await attach();
  const skills = result["skills"] as Array<{ name: string }>;
  expect(skills[0]!.name).toBe("changelog-writer");
  expect(result["decision_model"]).toEqual({
    mode: "enforce",
    applied: true,
    model: "fake-model-1.0",
  });
  expect(typeof result["offer_id"]).toBe("string");
});

test("enforce: a server failure returns today's result with the degrade reason", async () => {
  writeConfig(null);
  const plain = await attach();
  writeConfig("skills:enforce");
  server.setReply(() => ({ status: 529, json: { error: "overloaded" } }));
  const result = await attach();
  const { decision_model: field, ...rest } = result;
  expect(JSON.stringify(rest)).toBe(JSON.stringify(plain));
  expect(field).toEqual({ mode: "enforce", applied: false, degraded: "http_529" });
});
