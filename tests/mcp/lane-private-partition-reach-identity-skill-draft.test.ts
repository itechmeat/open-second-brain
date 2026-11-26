/**
 * A write decision taken from the narrowed view (identity-skill-draft): a
 * `brain_skill_proposals page_draft` whose name a person already rejected
 * with a private note, so the rejected proposal is held in `private`.
 *
 * The draft's identity check (one name, one proposal; a rejected name is
 * suppressed) reads the proposals on the whole fold. A remote draft that
 * meets the private proposal gets the fixed refusal before any write, and
 * its answer carries nothing of that proposal (ruling 1). A local draft of
 * the same name is suppressed, as released.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { listPendingSkillProposals } from "../../src/core/brain/skill-proposals.ts";
import { LANE_ENTRY_WITHHELD_MESSAGE } from "../../src/core/store/lane-reach-guard.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  REGION,
  call,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

const PAGE = "notes/zqdraft-page.md";

function draft(body: string): Record<string, unknown> {
  return {
    name: "zqdraft-check",
    description: "Check a zqdraft deployment before rollout",
    triggers: ["before a zqdraft rollout"],
    body,
  };
}

/** A local draft of the name, rejected by a person with a private note. Returns its id. */
async function seedRejected(e: LaneEnv): Promise<string> {
  mkdirSync(join(e.vault, "notes"), { recursive: true });
  writeFileSync(join(e.vault, PAGE), "# Zqdraft page\n\nSteps to check a zqdraft rollout.\n");
  const local = localServer(e);
  const made = await callJson(local, "brain_skill_proposals", {
    operation: "page_draft",
    page: PAGE,
    draft: draft("1. run the zqdraft check\n2. read its report\n"),
  });
  expect(made["outcome"]).toBe("created");
  const rejected = await call(local, "brain_skill_proposals", {
    operation: "reject",
    slug: made["slug"],
    note: `not this one ${REGION}`,
  });
  expect(rejected).not.toContain("error");
  return made["id"] as string;
}

const pendingOfName = (e: LaneEnv): string[] =>
  listPendingSkillProposals(e.vault)
    .filter((p) => p.slug.includes("zqdraft"))
    .map((p) => p.slug);

describe("a page draft whose name a private rejected proposal holds", () => {
  test("a remote page draft gets the fixed refusal and drafts nothing", async () => {
    const e = makeLaneEnv("store", "osb-lane-identity-skill-draft-");
    lanes.push(e);
    const id = await seedRejected(e);
    const records = e.laneRecords().length;
    const answer = await call(server(e), "brain_skill_proposals", {
      operation: "page_draft",
      page: PAGE,
      draft: draft("1. a different zqdraft body\n"),
    });
    expect({
      refused: answer.includes(LANE_ENTRY_WITHHELD_MESSAGE),
      names_twin: answer.includes(id),
      pending: pendingOfName(e),
      records: e.laneRecords().length,
    }).toEqual({ refused: true, names_twin: false, pending: [], records });
  });

  test("a local page draft of the same name is suppressed", async () => {
    const e = makeLaneEnv("store", "osb-lane-identity-skill-draft-");
    lanes.push(e);
    await seedRejected(e);
    const local = await callJson(localServer(e), "brain_skill_proposals", {
      operation: "page_draft",
      page: PAGE,
      draft: draft("1. a different zqdraft body\n"),
    });
    expect({ outcome: local["outcome"], pending: pendingOfName(e) }).toEqual({
      outcome: "suppressed",
      pending: [],
    });
  });
});
