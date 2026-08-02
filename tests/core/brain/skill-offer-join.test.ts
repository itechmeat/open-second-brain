/**
 * Offer-to-invocation join, end to end (Unit J, t_ccb05134, decision J1).
 *
 * The chain under test runs all the way through: `skills_attach` mints an
 * offer id over what it offered, an agent quotes that id back on the
 * `get_skill` call, the session log records the call, the session importer
 * stamps the cited offer onto the `skill_invoked` continuity record, and the
 * read side joins the invocation back to the offer it came from.
 *
 * Nothing here is asserted in the abstract: the offer id the join reports is
 * recomputed from the attachment, and the invocation record is the one the
 * real importer wrote from a real session fixture.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../src/core/brain/config-template.ts";
import { loadNormalizedContinuityRecords } from "../../../src/core/brain/continuity/read-model.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { importSession } from "../../../src/core/brain/sessions/import.ts";
import {
  deriveSkillUsage,
  joinSkillInvocationsToOffers,
} from "../../../src/core/brain/skill-usage.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { buildSkillAttachment } from "../../../src/core/surface/skill-attach.ts";
import { SKILL_OFFER_ID_KEY } from "../../../src/core/surface/skill-offer.ts";
import type { SkillEntry } from "../../../src/core/surface/skills.ts";

let vault: string;

function entry(name: string, description: string): SkillEntry {
  return Object.freeze({
    name,
    description,
    triggers: "",
    path: `/skills/${name}`,
    skillFile: `/skills/${name}/SKILL.md`,
    shadowed: Object.freeze([]),
  });
}

const SKILLS = [
  entry("release", "Cut a release: changelog, version bump, tag."),
  entry("triage", "Sort incoming issues by severity."),
  entry("schema-author", "Author Brain schema vocabulary packs."),
];

const TURN = "cut a release with a changelog and a version bump";

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-skill-offer-join-"));
  const dirs = brainDirs(vault);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
    dirs.snapshots,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  atomicWriteFileSync(join(dirs.brain, "_brain.yaml"), DEFAULT_BRAIN_CONFIG_YAML);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** A Claude session log whose get_skill calls carry the offers they cite. */
function writeSessionFixture(
  path: string,
  calls: ReadonlyArray<{ id: string; skill: string; offerId?: string }>,
): void {
  const lines = [
    `{"parentUuid":null,"sessionId":"offer-join","entrypoint":"sdk-cli","type":"user","message":{"role":"user","content":${JSON.stringify(TURN)}},"uuid":"u1","timestamp":"2026-06-01T10:00:00.000Z"}`,
  ];
  calls.forEach((call, i) => {
    const input: Record<string, unknown> = { name: call.skill };
    if (call.offerId !== undefined) input[SKILL_OFFER_ID_KEY] = call.offerId;
    lines.push(
      JSON.stringify({
        parentUuid: "u1",
        sessionId: "offer-join",
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: call.id, name: "get_skill", input }],
        },
        uuid: `a${i + 1}`,
        timestamp: `2026-06-01T10:00:0${i + 1}.000Z`,
      }),
    );
  });
  lines.push("");
  writeFileSync(path, lines.join("\n"));
}

test("an invocation citing an offer joins back to it across a real import", async () => {
  const attachment = buildSkillAttachment({ query: TURN, skills: SKILLS });
  expect(attachment.items.map((i) => i.name)).toContain("release");
  const offerId = attachment.offerId!;
  expect(offerId).not.toBeNull();

  const fixture = join(vault, "session.jsonl");
  writeSessionFixture(fixture, [{ id: "c1", skill: "release", offerId }]);
  const res = await importSession(vault, fixture, { agent: "test" });
  expect(res.skill_invocations).toBe(1);

  // The importer put the cited offer on the record, not next to it.
  const records = loadNormalizedContinuityRecords(vault, { kind: "skill_invoked" });
  expect(records).toHaveLength(1);
  expect(records[0]!.payload[SKILL_OFFER_ID_KEY]).toBe(offerId);

  const report = joinSkillInvocationsToOffers(vault);
  expect(report.offers).toHaveLength(1);
  expect(report.offers[0]!.offerId).toBe(offerId);
  expect(report.offers[0]!.invocations.map((i) => i.skill)).toEqual(["release"]);
  expect(report.unattributed).toHaveLength(0);
});

test("an invocation citing no offer is reported unattributed, never guessed into one", async () => {
  const offerId = buildSkillAttachment({ query: TURN, skills: SKILLS }).offerId!;
  const fixture = join(vault, "session.jsonl");
  writeSessionFixture(fixture, [
    { id: "c1", skill: "release", offerId },
    { id: "c2", skill: "triage" },
  ]);
  await importSession(vault, fixture, { agent: "test" });

  const report = joinSkillInvocationsToOffers(vault);
  expect(report.offers.map((o) => o.offerId)).toEqual([offerId]);
  expect(report.offers[0]!.invocations.map((i) => i.skill)).toEqual(["release"]);
  expect(report.unattributed.map((i) => i.skill)).toEqual(["triage"]);
  expect(report.unattributed[0]!.offerId).toBeNull();
});

test("two invocations of the same offer group under one offer id", async () => {
  const offerId = buildSkillAttachment({ query: TURN, skills: SKILLS }).offerId!;
  const fixture = join(vault, "session.jsonl");
  writeSessionFixture(fixture, [
    { id: "c1", skill: "release", offerId },
    { id: "c2", skill: "triage", offerId },
  ]);
  await importSession(vault, fixture, { agent: "test" });

  const report = joinSkillInvocationsToOffers(vault);
  expect(report.offers).toHaveLength(1);
  expect(report.offers[0]!.invocations.map((i) => i.skill).toSorted()).toEqual([
    "release",
    "triage",
  ]);
});

test("a malformed offer id on the call is not an offer, and is not stamped", async () => {
  const fixture = join(vault, "session.jsonl");
  writeSessionFixture(fixture, [{ id: "c1", skill: "release", offerId: "not-an-offer-id" }]);
  await importSession(vault, fixture, { agent: "test" });

  const records = loadNormalizedContinuityRecords(vault, { kind: "skill_invoked" });
  expect(records).toHaveLength(1);
  expect(records[0]!.payload[SKILL_OFFER_ID_KEY]).toBeUndefined();
  expect(joinSkillInvocationsToOffers(vault).unattributed).toHaveLength(1);
});

test("per-skill usage reports how much of it came from a recorded offer", async () => {
  const offerId = buildSkillAttachment({ query: TURN, skills: SKILLS }).offerId!;
  const fixture = join(vault, "session.jsonl");
  writeSessionFixture(fixture, [
    { id: "c1", skill: "release", offerId },
    { id: "c2", skill: "release" },
    { id: "c3", skill: "triage" },
  ]);
  await importSession(vault, fixture, { agent: "test" });

  const usage = deriveSkillUsage(vault, { nowMs: Date.parse("2026-06-02T00:00:00Z") });
  const release = usage.find((u) => u.skill === "release")!;
  expect(release.invocationCount).toBe(2);
  expect(release.offerAttributedCount).toBe(1);
  const triage = usage.find((u) => u.skill === "triage")!;
  expect(triage.invocationCount).toBe(1);
  expect(triage.offerAttributedCount).toBe(0);
});

test("a vault with no invocations joins to an empty report", () => {
  expect(joinSkillInvocationsToOffers(vault)).toEqual({ offers: [], unattributed: [] });
});
