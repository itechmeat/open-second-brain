/**
 * Two-stage decision-model skill selection (issue #213, Part 3), through
 * an injected in-process provider. No network.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendContinuityRecord,
  listContinuityRecords,
} from "../../../src/core/brain/continuity/store.ts";
import { joinSkillInvocationsToOffers } from "../../../src/core/brain/skill-usage.ts";
import {
  DecisionProviderError,
  DECISION_MODEL_USES,
  type DecideOptions,
  type DecisionAnswer,
  type DecisionDegradeReason,
  type DecisionModelMode,
  type DecisionPingResult,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResponse,
} from "../../../src/core/decision-model/contract.ts";
import {
  SKILLS_SHORTLIST_MAX,
  SKILLS_STAGE2_MIN_REMAINING_MS,
} from "../../../src/core/decision-model/questions.ts";
import {
  listDecisionModelCalls,
  resetDecisionSpendCache,
} from "../../../src/core/decision-model/record.ts";
import { buildSkillsDecisionReport } from "../../../src/core/decision-model/reports/skills.ts";
import { buildSkillAttachment } from "../../../src/core/surface/skill-attach.ts";
import { buildSkillAttachmentWithDecision } from "../../../src/core/surface/skill-attach-decision.ts";
import { computeSkillOfferId } from "../../../src/core/surface/skill-offer.ts";
import { discoverSkills, type SkillEntry } from "../../../src/core/surface/skills.ts";
import { activeDecisionConfig } from "../../helpers/fake-decision-provider.ts";

const QUERY = "cut a release and write the changelog for the project";

let tmp: string;
let vault: string;
let skills: SkillEntry[];

function writeSkill(root: string, name: string, description: string, extra = ""): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nBody of ${name}.\n`,
  );
}

beforeEach(() => {
  resetDecisionSpendCache();
  tmp = mkdtempSync(join(tmpdir(), "osb-skill-dm-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  const root = join(tmp, "skills");
  writeSkill(root, "release-cut", "Cut a release: version bump, tag and publish.");
  writeSkill(root, "changelog-writer", "Write the changelog entry for a release.");
  writeSkill(root, "release-notes", "Draft release notes from merged pull requests.");
  writeSkill(
    root,
    "secret-release",
    "Private release checklist SECRETWORD.",
    "visibility: private\n",
  );
  writeSkill(root, "embeddings-setup", "Configure embedding providers for semantic search.");
  writeSkill(root, "vault-health", "Check the health of an Obsidian vault.");
  writeSkill(root, "schema-author", "Author schema tokens and aliases.");
  writeSkill(root, "codegraph", "Answer structural code questions.");
  writeSkill(root, "doctor", "Diagnose installation problems.");
  skills = discoverSkills([root]);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

type Scripted = (id: string, req: DecisionRequest) => Partial<DecisionAnswer> | undefined;

/** A provider that answers choice questions with probabilities too. */
class ScriptedProvider implements DecisionProvider {
  readonly name = "fake";
  readonly model = "fake-model-1";
  readonly calibrated = true;
  readonly requests: DecisionRequest[] = [];
  constructor(
    private readonly script: Scripted,
    private readonly failOn: ReadonlyMap<number, DecisionDegradeReason> = new Map(),
    private readonly usage: DecisionResponse["usage"] = { inputTokens: 100, outputTokens: 2 },
  ) {}
  async decide(req: DecisionRequest, _opts: DecideOptions): Promise<DecisionResponse> {
    const index = this.requests.length;
    this.requests.push(req);
    const fail = this.failOn.get(index);
    if (fail !== undefined) throw new DecisionProviderError(fail, `fake ${fail}`);
    const answers: Record<string, DecisionAnswer> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const scripted = this.script(id, req);
      answers[id] = {
        type: q.type,
        value: q.type === "noul" ? 0.5 : "none",
        valid: true,
        ...scripted,
      } as DecisionAnswer;
    }
    // A malicious reply may also carry ids nobody asked for.
    const extra = this.script("__extra__", req);
    if (extra !== undefined) answers["applies_9"] = { type: "noul", value: 0.99, valid: true };
    return { model: "fake-model-1.2", answers, usage: this.usage, calibrated: true };
  }
  async ping(): Promise<DecisionPingResult> {
    return { ok: true, model: this.model };
  }
}

function config(
  mode: DecisionModelMode,
  overrides: Parameters<typeof activeDecisionConfig>[0] = {},
) {
  const uses = Object.fromEntries(DECISION_MODEL_USES.map((u) => [u, "off"])) as Record<
    string,
    DecisionModelMode
  >;
  uses["skills"] = mode;
  return activeDecisionConfig({
    vault,
    uses: uses as never,
    configuredUses: uses as never,
    ...overrides,
  });
}

/** The mask key a skill got in the stage-1 state. */
function keyOf(req: DecisionRequest, name: string): string | undefined {
  const state = req.state as { skills: Record<string, string> };
  return Object.entries(state.skills).find(([, text]) => text.startsWith(`${name} - `))?.[0];
}

/** Stage 1 picks `favourite`; stage 2 scores finalists by name. */
function preferring(favourite: string, applies: Record<string, number>, needsAny = 0.9): Scripted {
  return (id, req) => {
    if (id === "needs_any_skill") return { value: needsAny };
    if (id === "pick") {
      const key = keyOf(req, favourite)!;
      const state = req.state as { skills: Record<string, string> };
      const probabilities: Record<string, number> = {};
      const others = Object.keys(state.skills).filter((k) => k !== key);
      probabilities[key] = 0.6;
      for (const k of others) probabilities[k] = 0.4 / Math.max(1, others.length);
      return { value: key, probabilities };
    }
    if (id.startsWith("applies_")) {
      const state = req.state as { skills: Record<string, string> };
      const text = state.skills[`F${id.slice("applies_".length)}`] ?? "";
      const name = Object.keys(applies).find((n) => text.includes(`Body of ${n}.`));
      return { value: name !== undefined ? applies[name]! : 0.1 };
    }
    return undefined;
  };
}

function baseline(maxSkills = 3) {
  return buildSkillAttachment({ query: QUERY, skills, maxSkills });
}

function skillRecords() {
  return listDecisionModelCalls(vault).filter((r) => r.payload["use"] === "skills");
}

test("off: exactly the BM25 attachment, no request, no record", async () => {
  const provider = new ScriptedProvider(preferring("release-notes", {}));
  const result = await buildSkillAttachmentWithDecision({
    query: QUERY,
    skills,
    config: config("off"),
    provider,
  });
  const { decisionModel, ...attachment } = result;
  expect(decisionModel).toBeNull();
  expect(attachment).toEqual(baseline());
  expect(provider.requests).toHaveLength(0);
  expect(skillRecords()).toHaveLength(0);
});

test("shadow: byte-identical block, two stage records sharing a correlation id", async () => {
  const provider = new ScriptedProvider(
    preferring("changelog-writer", { "changelog-writer": 0.9 }),
  );
  const result = await buildSkillAttachmentWithDecision({
    query: QUERY,
    skills,
    config: config("shadow"),
    provider,
    tokenImpact: true,
  });
  const { decisionModel, ...attachment } = result;
  expect(attachment).toEqual(baseline());
  expect(decisionModel).toEqual({ mode: "shadow", applied: false, model: "fake-model-1.2" });
  expect(provider.requests).toHaveLength(2);

  const records = skillRecords();
  expect(records).toHaveLength(2);
  const [s1, s2] = records.toSorted(
    (a, b) => (a.payload["stage"] as number) - (b.payload["stage"] as number),
  );
  expect(s1!.payload["correlation_id"]).toBe(s2!.payload["correlation_id"]);
  expect(s1!.payload["final"]).toBe(false);
  expect(s2!.payload["final"]).toBe(true);
  expect(s2!.payload["deterministic_offered"]).toEqual(baseline().items.map((i) => i.name));
  expect(s2!.payload["decision_offered"]).toEqual(["changelog-writer"]);
  expect(s2!.payload["offer_id"]).toBe(baseline().offerId);
  expect(s2!.payload["needs_any_skill"]).toBe(0.9);
  // Identifiers and numbers only: neither the turn nor any skill text.
  const raw = JSON.stringify(records);
  expect(raw).not.toContain("changelog for the project");
  expect(raw).not.toContain("Body of");

  // Shadow returns the BM25 block, so there is no saving to sample.
  expect(listContinuityRecords(vault, { kind: "token_impact" })).toHaveLength(0);
});

test("the turn is sent without its <private> regions", async () => {
  const provider = new ScriptedProvider(
    preferring("changelog-writer", { "changelog-writer": 0.9 }),
  );
  await buildSkillAttachmentWithDecision({
    query: `${QUERY} <private>internal codename zephyr</private>`,
    skills,
    config: config("shadow"),
    provider,
  });
  expect(provider.requests.length).toBeGreaterThan(0);
  for (const req of provider.requests) {
    const body = JSON.stringify(req.state);
    expect(body).toContain("changelog");
    expect(body).not.toContain("zephyr");
  }
});

test("enforce: a reorder of the shortlist, capped at max_skills, offer id over what is offered", async () => {
  const provider = new ScriptedProvider(
    preferring("release-notes", { "release-notes": 0.95, "changelog-writer": 0.7 }),
  );
  const result = await buildSkillAttachmentWithDecision({
    query: QUERY,
    skills,
    maxSkills: 2,
    config: config("enforce"),
    provider,
    tokenImpact: true,
  });
  expect(result.decisionModel).toEqual({ mode: "enforce", applied: true, model: "fake-model-1.2" });
  const names = result.items.map((i) => i.name);
  expect(names).toEqual(["release-notes", "changelog-writer"]);
  const shortlist = buildSkillAttachment({ query: QUERY, skills, maxSkills: 40 }).items.map(
    (i) => i.name,
  );
  for (const n of names) expect(shortlist).toContain(n);
  expect(result.offerId).toBe(
    computeSkillOfferId(
      QUERY,
      result.items.map((i) => ({ name: i.name, path: i.path })),
    ),
  );
  expect(result.block).toContain(`Offer ${result.offerId}`);
  expect(result.block.length).toBeLessThanOrEqual(1200);

  const final = skillRecords().find((r) => r.payload["final"] === true)!;
  expect(final.payload["applied"]).toBe(true);
  expect(final.payload["offer_id"]).toBe(result.offerId);
  const impacts = listContinuityRecords(vault, { kind: "token_impact" });
  expect(impacts).toHaveLength(1);
  const impact = impacts[0]!;
  expect(impact.payload["source"]).toBe("decision_model:skills");
  expect(impact.payload["pack_id"]).toBeUndefined();
  expect(impact.payload["packed_tokens"]).not.toBe(impact.payload["baseline_tokens"]);
});

test("enforce: the char budget still applies to the decision offer", async () => {
  const provider = new ScriptedProvider(
    preferring("release-notes", {
      "release-notes": 0.95,
      "changelog-writer": 0.9,
      "release-cut": 0.8,
    }),
  );
  const result = await buildSkillAttachmentWithDecision({
    query: QUERY,
    skills,
    maxChars: 250,
    config: config("enforce"),
    provider,
  });
  expect(result.block.length).toBeLessThanOrEqual(250);
  expect(result.items.length).toBeLessThan(3);
});

test("enforce: low needs_any_skill offers nothing with a null offer id, in one request", async () => {
  const provider = new ScriptedProvider(preferring("release-notes", {}, 0.05));
  const result = await buildSkillAttachmentWithDecision({
    query: QUERY,
    skills,
    config: config("enforce"),
    provider,
  });
  expect(result.offerId).toBeNull();
  expect(result.block).toBe("");
  expect(result.items).toHaveLength(0);
  expect(result.decisionModel?.applied).toBe(true);
  expect(provider.requests).toHaveLength(1);
  const [record] = skillRecords();
  expect(record!.payload["final"]).toBe(true);
  expect(record!.payload["decision_offered"]).toEqual([]);
  expect(record!.payload["offer_id"]).toBeNull();
});

test("a malicious reply naming an unknown key is never offered", async () => {
  // Stage 1 picks a key that was never offered.
  const unknownPick = new ScriptedProvider((id) =>
    id === "pick" ? { value: "S99" } : id === "needs_any_skill" ? { value: 0.9 } : undefined,
  );
  const r1 = await buildSkillAttachmentWithDecision({
    query: QUERY,
    skills,
    config: config("enforce"),
    provider: unknownPick,
  });
  expect(r1.block).toBe(baseline().block);
  expect(r1.decisionModel?.degraded).toBe("invalid_reply");

  // A known pick whose distribution favours an unknown key, and a stage-2
  // reply carrying an answer for a finalist that was never asked about.
  const script = preferring("release-notes", { "release-notes": 0.9 });
  const smuggling = new ScriptedProvider((id, req) => {
    if (id === "__extra__") return {};
    const answer = script(id, req);
    if (id === "pick" && answer !== undefined) {
      return { ...answer, probabilities: { ...answer.probabilities, S77: 0.99, evil: 1 } };
    }
    return answer;
  });
  const r2 = await buildSkillAttachmentWithDecision({
    query: QUERY,
    skills,
    config: config("enforce"),
    provider: smuggling,
  });
  const allowed = new Set(skills.map((s) => s.name));
  for (const item of r2.items) expect(allowed.has(item.name)).toBe(true);
  expect(r2.items.map((i) => i.name)).toEqual(["release-notes"]);
});

const FAILURES: ReadonlyArray<DecisionDegradeReason> = [
  "timeout",
  "network",
  "invalid_reply",
  "egress_refused",
  "http_401",
  "http_402",
  "http_429",
  "http_529",
];

for (const reason of FAILURES) {
  for (const stage of [0, 1]) {
    test(`a ${reason} degrade in stage ${stage + 1} returns today's block`, async () => {
      const provider = new ScriptedProvider(
        preferring("release-notes", { "release-notes": 0.9 }),
        new Map([[stage, reason]]),
      );
      const result = await buildSkillAttachmentWithDecision({
        query: QUERY,
        skills,
        config: config("enforce"),
        provider,
      });
      const { decisionModel, ...attachment } = result;
      expect(attachment).toEqual(baseline());
      expect(decisionModel?.applied).toBe(false);
      expect(decisionModel?.degraded).toBe(reason);
      const final = skillRecords().find((r) => r.payload["final"] === true)!;
      expect(final.payload["outcome"]).toBe(reason);
      expect(final.payload["offer_id"]).toBe(baseline().offerId);
    });
  }
}

test("a budget degrade returns today's block", async () => {
  const provider = new ScriptedProvider(preferring("release-notes", {}));
  const result = await buildSkillAttachmentWithDecision({
    query: QUERY,
    skills,
    config: config("enforce", { maxStateTokens: 10 }),
    provider,
  });
  expect(result.block).toBe(baseline().block);
  expect(result.decisionModel?.degraded).toBe("budget");
  expect(provider.requests).toHaveLength(0);
});

test("the cost gate returns today's block", async () => {
  const cfg = config("enforce", { dailyCostGateUsd: 0.001 });
  const spender = new ScriptedProvider(preferring("release-notes", {}, 0.05), new Map(), {
    inputTokens: 10,
    costUsd: 0.01,
  });
  await buildSkillAttachmentWithDecision({ query: QUERY, skills, config: cfg, provider: spender });
  const provider = new ScriptedProvider(preferring("release-notes", {}));
  const result = await buildSkillAttachmentWithDecision({
    query: QUERY,
    skills,
    config: cfg,
    provider,
  });
  expect(result.block).toBe(baseline().block);
  expect(result.decisionModel?.degraded).toBe("cost_gate");
  expect(provider.requests).toHaveLength(0);
});

test("stage 2 is skipped below the minimum remaining budget", async () => {
  const provider = new ScriptedProvider(preferring("release-notes", { "release-notes": 0.9 }));
  const decide = provider.decide.bind(provider);
  provider.decide = async (req, opts) => {
    await new Promise((r) => setTimeout(r, 120));
    return decide(req, opts);
  };
  const result = await buildSkillAttachmentWithDecision({
    query: QUERY,
    skills,
    config: config("enforce", { timeoutMs: SKILLS_STAGE2_MIN_REMAINING_MS + 100 }),
    provider,
  });
  expect(provider.requests).toHaveLength(1);
  expect(result.block).toBe(baseline().block);
  expect(result.decisionModel?.degraded).toBe("timeout");
});

test("stage 2 gets only the time that remains", async () => {
  const seen: number[] = [];
  const provider = new ScriptedProvider(preferring("release-notes", { "release-notes": 0.9 }));
  const decide = provider.decide.bind(provider);
  provider.decide = async (req, opts) => {
    seen.push(opts.timeoutMs);
    await new Promise((r) => setTimeout(r, 60));
    return decide(req, opts);
  };
  await buildSkillAttachmentWithDecision({
    query: QUERY,
    skills,
    config: config("enforce", { timeoutMs: 3000 }),
    provider,
  });
  expect(seen).toHaveLength(2);
  expect(seen[0]).toBe(3000);
  expect(seen[1]!).toBeLessThanOrEqual(3000 - 55);
  expect(seen[1]!).toBeGreaterThan(SKILLS_STAGE2_MIN_REMAINING_MS);
});

test("a private skill is never sent and never offered", async () => {
  expect(
    buildSkillAttachment({ query: "private release checklist", skills }).items.map((i) => i.name),
  ).toContain("secret-release");
  const provider = new ScriptedProvider(preferring("release-notes", { "release-notes": 0.9 }));
  const result = await buildSkillAttachmentWithDecision({
    query: "private release checklist",
    skills,
    config: config("enforce"),
    provider,
  });
  const sent = JSON.stringify(provider.requests);
  expect(sent).not.toContain("SECRETWORD");
  expect(sent).not.toContain("secret-release");
  expect(JSON.stringify(skillRecords())).not.toContain("secret-release");
  expect(result.decisionModel?.applied).toBe(true);
  expect(result.items.map((i) => i.name)).toEqual(["release-notes"]);
});

test("a record written before any request still masks a private skill", async () => {
  const query = "private release checklist";
  expect(buildSkillAttachment({ query, skills }).items.map((i) => i.name)).toContain(
    "secret-release",
  );
  const provider = new ScriptedProvider(preferring("release-notes", {}));
  const result = await buildSkillAttachmentWithDecision({
    query,
    skills,
    config: config("enforce", { maxStateTokens: 10 }),
    provider,
  });
  expect(result.decisionModel?.degraded).toBe("budget");
  expect(provider.requests).toHaveLength(0);
  const raw = JSON.stringify(skillRecords());
  expect(raw).toContain("(withheld)");
  expect(raw).not.toContain("secret-release");
});

test("enforce: a finalist without a valid stage-2 answer returns today's block", async () => {
  const scripted = preferring("release-notes", {
    "release-notes": 0.95,
    "changelog-writer": 0.9,
  });
  const provider = new ScriptedProvider((id, req) =>
    id === "applies_1" ? { valid: false, value: Number.NaN } : scripted(id, req),
  );
  const result = await buildSkillAttachmentWithDecision({
    query: QUERY,
    skills,
    config: config("enforce"),
    provider,
  });
  expect(provider.requests).toHaveLength(2);
  expect(result.block).toBe(baseline().block);
  expect(result.decisionModel).toMatchObject({ applied: false, degraded: "invalid_reply" });
});

test("the shortlist is capped and stays inside the choice limit", async () => {
  const root = join(tmp, "many");
  for (let i = 0; i < 60; i++) writeSkill(root, `release-${i}`, `Release helper number ${i}.`);
  for (let i = 0; i < 70; i++) writeSkill(root, `other-${i}`, `Unrelated helper ${i}.`);
  const many = discoverSkills([root]);
  const provider = new ScriptedProvider((id) =>
    id === "needs_any_skill" ? { value: 0.05 } : undefined,
  );
  await buildSkillAttachmentWithDecision({
    query: "release",
    skills: many,
    config: config("shadow"),
    provider,
  });
  const pick = provider.requests[0]!.questions["pick"]!;
  expect(pick.type).toBe("choice");
  const options = Object.keys((pick as { criteria: Record<string, unknown> }).criteria);
  expect(options).toHaveLength(SKILLS_SHORTLIST_MAX + 1);
  expect(options).toContain("none");
});

test("the skill_invoked join and the report work over enforced offers", async () => {
  const provider = new ScriptedProvider(preferring("release-notes", { "release-notes": 0.9 }));
  const result = await buildSkillAttachmentWithDecision({
    query: QUERY,
    skills,
    config: config("enforce"),
    provider,
  });
  appendContinuityRecord(vault, {
    kind: "skill_invoked",
    createdAt: new Date().toISOString(),
    sourceRefs: [],
    payload: { skill: "release-notes", offer_id: result.offerId },
  });
  const joined = joinSkillInvocationsToOffers(vault);
  expect(joined.offers.map((o) => o.offerId)).toEqual([result.offerId!]);

  const report = buildSkillsDecisionReport(vault);
  expect(report.compared).toBe(1);
  expect(report.invoked).toBe(1);
  expect(report.decision.offer_hit_rate).toBe(1);
  expect(report.bm25.offer_hit_rate).toBe(
    baseline().items.some((i) => i.name === "release-notes") ? 1 : 0,
  );
});
