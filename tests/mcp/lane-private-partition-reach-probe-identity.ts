/**
 * The identity part of the differential write probe of
 * `lane-private-partition-reach` (the write rule, this round's rulings).
 *
 * 1. Hand-written arguments for the tools whose required arguments are
 *    objects or arrays of objects, so no tool of the registry is skipped.
 * 2. Identity twins: with private entries, a `private` entry with the same
 *    identity as a remote create of the plan, under ANOTHER key (an entity
 *    whose alias is the name the probe's entity intakes create), which the
 *    same-key guard of the lane primitives never sees.
 * 3. The identity invariant: no lane gains a shared entry whose identity
 *    (title, name or alias, topic, cooldown key, publish target, question)
 *    equals that of an entry held in `private` before the calls.
 */

import { expect } from "bun:test";

import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import type { LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { PROBE_SOURCE } from "./lane-private-partition-reach-probe-writers.ts";
import { AGENT, REGION } from "./lane-private-partition-reach-writes-fixture.ts";

/** The name the probe's entity intakes create; a private entity answers to it in the seeded store. */
export const PROBE_ENTITY = "Zqprobe Person";

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
    title: "Zqprobe report",
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
    pledges: [
      { title: "Zqprobe pledge", due: "2026-12-01", evidence: ["We will ship the report."] },
    ],
  },
  schema_apply_mutations: { mutations: [] },
};

/** Tools whose base call meets an identity twin in the seeded store: the fixed refusal is their answer there. */
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

export const IDENTITY_TOOLS: ReadonlySet<string> = new Set([
  "brain_intake_entities",
  "brain_ingest_source",
]);

/** Seed the identity twins (with private entries only). */
export function seedIdentityTwins(e: LaneEnv, withPrivate: boolean): void {
  if (!withPrivate) return;
  const { entity } = upsertEntity(e.vault, {
    category: "people",
    name: "Zqprobe Held Name",
    aliases: [PROBE_ENTITY],
    agent: AGENT,
    now: new Date("2026-11-20T10:00:00Z"),
    body: `zqprobe held notes ${REGION}\n`,
  });
  expect(laneEntryInPrivate(e.vault, entity.path)).toBe(true);
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
