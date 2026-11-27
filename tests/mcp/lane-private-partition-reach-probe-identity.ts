/**
 * The identity part of the differential write probe of
 * `lane-private-partition-reach` (the write rule, this round's rulings).
 *
 * 1. Hand-written arguments for the tools whose required arguments are
 *    objects or arrays of objects, so no tool of the registry is skipped.
 * 2. Identity twins: with private entries, a `private` entry with the same
 *    identity as a remote create of the plan, under ANOTHER key, which the
 *    same-key guard of the lane primitives never sees: one per creating
 *    verb of the plan ({@link IDENTITY_TWINS}: an entity whose alias is the
 *    name the entity intakes create, a pledge of the intake's promise at
 *    its suffixed stem, a report of the report's title on its digest page),
 *    and every other creating verb named with the reason it has no
 *    identity under another key ({@link NO_IDENTITY_TWIN}).
 * 3. The identity invariant: no lane gains a shared entry whose identity
 *    (title, name or alias, topic, cooldown key, publish target, question)
 *    equals that of an entry held in `private` before the calls.
 */

import { join } from "node:path";

import { expect } from "bun:test";

import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { pledgePath } from "../../src/core/brain/paths.ts";
import { pledgeSlugCandidates } from "../../src/core/brain/pledges.ts";
import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import { laneEntryInPrivate, removeLanePage } from "../../src/core/store/lane-pages.ts";
import type { MCPServer } from "../../src/mcp/server.ts";
import type { LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { PROBE_SOURCE } from "./lane-private-partition-reach-probe-writers.ts";
import { AGENT, REGION, callJson } from "./lane-private-partition-reach-writes-fixture.ts";

/** The name the probe's entity intakes create; a private entity answers to it in the seeded store. */
export const PROBE_ENTITY = "Zqprobe Person";

/** The promise the probe's pledge intake records; a private pledge of it sits at its suffixed stem. */
const PROBE_PLEDGE = { title: "Zqprobe pledge", due: "2026-12-01" } as const;
/** The title of the probe's research report; a private report of it sits on its digest page. */
const PROBE_REPORT = "Zqprobe report";
const EVIDENCE = ["We will ship the report."];

const DATASET = {
  queries: [{ id: "zqprobe-q1", query: "zqcommonword", expected: [PROBE_SOURCE] }],
};

/** Required (and overriding) arguments a plain probe value cannot give, per tool. */
export const HAND_ARGS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  brain_observed_use: { entries: [{ id: "zqprobe-doc:chunk", verdict: "USED" }] },
  brain_benchmark: { dataset: DATASET },
  brain_eval: { dataset: DATASET },
  brain_intake_entities: {
    source: `[[${PROBE_SOURCE}]]`,
    entities: [{ category: "people", name: PROBE_ENTITY }],
  },
  brain_ingest_source: {
    source_path: PROBE_SOURCE,
    summary: "zqprobewrite summary of the source.",
    entities: [{ category: "people", name: PROBE_ENTITY }],
  },
  brain_distill_source: { source_path: PROBE_SOURCE, claims: [{ text: "zqprobewrite claim" }] },
  brain_research_report: {
    title: PROBE_REPORT,
    sources: ["zqprobewrite source"],
    findings: [{ statement: "zqprobewrite finding", sources: ["zqprobewrite source"] }],
  },
  brain_write_batch: {
    operations: [{ op: "create_note", path: "Notes/zqprobe-batch.md", content: "zqprobewrite" }],
  },
  brain_agenda: {
    events: [
      { title: "zqprobewrite event", start: "2026-11-20T10:00:00Z", end: "2026-11-20T11:00:00Z" },
    ],
  },
  brain_intake_pledges: {
    source: PROBE_SOURCE,
    pledges: [{ ...PROBE_PLEDGE, evidence: EVIDENCE }],
  },
  schema_apply_mutations: { mutations: [] },
};

/**
 * Verbs under the coarse rule of the fourth closure round (bulk form): a
 * verb that rewrites lane entries the caller did not address one by one
 * is refused with the fixed text below local reach while any lane holds a
 * `private` entry. On the seeded store such a call may answer the fixed
 * refusal where the twin succeeds; nothing else about it is excused.
 */
export const COARSE_VERBS: ReadonlySet<string> = new Set([
  "brain_hygiene apply",
  "brain_hygiene refresh",
]);

/** One identity twin: the creating call it answers, and the private entry it seeds. */
export interface IdentityTwin {
  /** The creating call, `<tool> <verb>` as the plan labels it. */
  readonly verb: string;
  /** What the creating call's arguments carry that the twin's identity answers to. */
  readonly carries: string;
  /** Seed the private twin; answers the canary marks only it carries. */
  readonly seed: (e: LaneEnv, local: MCPServer) => Promise<string[]>;
}

/** An entity held in `private` whose alias is the name the entity intakes create. */
async function entityTwin(e: LaneEnv): Promise<string[]> {
  const { entity } = upsertEntity(e.vault, {
    category: "people",
    name: "Zqprobe Held Name",
    aliases: [PROBE_ENTITY],
    agent: AGENT,
    now: new Date("2026-11-20T10:00:00Z"),
    body: `zqprobe held notes ${REGION}\n`,
  });
  expect(laneEntryInPrivate(e.vault, entity.path)).toBe(true);
  return ["Zqprobe Held Name", "zqprobe held notes"];
}

const slugOf = (answer: Record<string, unknown>): unknown =>
  (answer["pledge"] as Record<string, unknown> | undefined)?.["slug"];

/**
 * A pledge of the intake's promise held in `private` at its suffixed
 * stem: a pledge of another promise holds the base slot while it is
 * added, then goes, leaving the base slot free.
 */
async function pledgeTwin(e: LaneEnv, local: MCPServer): Promise<string[]> {
  const [base, suffixed] = pledgeSlugCandidates(PROBE_PLEDGE.title, PROBE_PLEDGE.due, PROBE_SOURCE);
  const add = (due: string, notes?: string): Record<string, unknown> => ({
    operation: "add",
    title: PROBE_PLEDGE.title,
    due,
    source: PROBE_SOURCE,
    evidence: EVIDENCE,
    agent: AGENT,
    ...(notes === undefined ? {} : { notes }),
  });
  expect(slugOf(await callJson(local, "brain_pledge", add("2026-12-09")))).toBe(base);
  const held = await callJson(
    local,
    "brain_pledge",
    add(PROBE_PLEDGE.due, `zqtwinpledgenote ${REGION}`),
  );
  expect(slugOf(held)).toBe(suffixed);
  expect(removeLanePage(e.vault, pledgePath(e.vault, base!))).toBe(true);
  expect(laneEntryInPrivate(e.vault, pledgePath(e.vault, suffixed!))).toBe(true);
  return ["zqtwinpledgenote"];
}

/** The arguments of a research report of `title` with one finding. */
const report = (title: string, statement: string): Record<string, unknown> => ({
  title,
  sources: ["zqprobewrite source"],
  findings: [{ statement, sources: ["zqprobewrite source"] }],
});

/** The live report pages of the store, by key. */
const reportKeys = (): string[] =>
  [...wholeLaneStoreFold().entries.keys()].filter((key) => key.startsWith("reports/"));

/**
 * A report of the probe report's title held in `private` on its digest
 * page: a report of another title with the same slug holds the base page
 * while it is written, then goes, leaving the base page free.
 */
async function reportTwin(e: LaneEnv, local: MCPServer): Promise<string[]> {
  const before = new Set(reportKeys());
  await callJson(local, "brain_research_report", report("Zqprobe-report", "zqtwinbase finding"));
  const basePage = reportKeys().find((key) => !before.has(key));
  expect(basePage).toBeDefined();
  await callJson(
    local,
    "brain_research_report",
    report(PROBE_REPORT, `zqtwinreportfinding ${REGION}`),
  );
  const digestPage = reportKeys().find((key) => !before.has(key) && key !== basePage);
  expect(digestPage).toBeDefined();
  expect(removeLanePage(e.vault, join(e.vault, "Brain", `${basePage!}.md`))).toBe(true);
  expect(laneEntryInPrivate(e.vault, join(e.vault, "Brain", `${digestPage!}.md`))).toBe(true);
  return ["zqtwinreportfinding"];
}

/** The identity twin of every creating verb that has an identity under another key. */
export const IDENTITY_TWINS: ReadonlyArray<IdentityTwin> = [
  { verb: "brain_intake_entities (no verb)", carries: PROBE_ENTITY, seed: entityTwin },
  // The same entity twin answers the ingest's entities (seeded once).
  { verb: "brain_ingest_source (no verb)", carries: PROBE_ENTITY, seed: async () => [] },
  { verb: "brain_intake_pledges (no verb)", carries: PROBE_PLEDGE.title, seed: pledgeTwin },
  { verb: "brain_research_report (no verb)", carries: PROBE_REPORT, seed: reportTwin },
];

/**
 * The creating verbs of the plan with no identity under another key, each
 * with the reason. A creating verb is one whose call adds a shared lane
 * entry on the twin; the probe fails on one named in neither list.
 */
export const NO_IDENTITY_TWIN: Readonly<Record<string, string>> = {
  "brain_distill_source (no verb)":
    "the distillation is keyed by the source's digest alone (`dist-<source>`): no other key holds its identity",
  "brain_intention move": "moves the named intention to its history page: no new identity",
  "brain_skill_proposals accept":
    "accepts the named proposal: the accepted copy and the procedure are that proposal's",
  "brain_obligation remove": "archives the named obligation: no new identity",
  "brain_pledge remove": "archives the named pledge: no new identity",
};

/** Seed the identity twins (with private entries only); answers their canary marks. */
export async function seedIdentityTwins(
  e: LaneEnv,
  local: MCPServer,
  withPrivate: boolean,
): Promise<string[]> {
  if (!withPrivate) return [];
  const marks: string[] = [];
  for (const twin of IDENTITY_TWINS) {
    // oxlint-disable-next-line no-await-in-loop -- one store, written in order
    marks.push(...(await twin.seed(e, local)));
  }
  return marks;
}

/** Whether the call `label` (`<tool> <verb> <names>`), passing `passed`, meets an identity twin. */
export function meetsIdentityTwin(label: string, passed: string | undefined): boolean {
  return IDENTITY_TWINS.some(
    (twin) => label.startsWith(`${twin.verb} `) && passed?.includes(twin.carries) === true,
  );
}

const laneOf = (key: string): string => key.split("/")[0]!;

const IDENTITY_FIELDS = ["title", "name", "topic", "cooldown_key", "publish_target", "question"];

const norm = (v: string): string =>
  v
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The identity strings of a lane entry's fields. */
export function identityOf(fields: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const f of IDENTITY_FIELDS) {
    const v = fields[f];
    if (typeof v === "string" && norm(v) !== "") out.push(`${f}:${norm(v)}`);
  }
  const names = [fields["name"], ...(Array.isArray(fields["aliases"]) ? fields["aliases"] : [])];
  for (const n of names) if (typeof n === "string" && norm(n) !== "") out.push(`name:${norm(n)}`);
  return out;
}

/**
 * The shared entries `added` (key to fields) whose identity equals that of
 * an entry of the same lane `held` in `private` before the calls.
 */
export function identityProblems(
  held: ReadonlyMap<string, string>,
  added: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): string[] {
  const privateIds = new Map<string, Set<string>>();
  for (const [key, value] of held) {
    const fields = (JSON.parse(value) as { fields: Record<string, unknown> }).fields ?? {};
    const set = privateIds.get(laneOf(key)) ?? new Set<string>();
    for (const id of identityOf(fields)) set.add(id);
    privateIds.set(laneOf(key), set);
  }
  const problems: string[] = [];
  for (const [key, fields] of added) {
    const ids = privateIds.get(laneOf(key));
    if (ids === undefined) continue;
    const same = identityOf(fields).filter((id) => ids.has(id));
    if (same.length > 0)
      problems.push(`shared ${key} gained beside a private entry of identity ${same[0]}`);
  }
  return problems;
}
