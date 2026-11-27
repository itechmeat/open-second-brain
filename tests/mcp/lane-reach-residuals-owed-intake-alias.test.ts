/**
 * The neutralized-alias half of the staged intake (change
 * `lane-reach-residuals`, package 19; owed by 2.0.4, fifth closure round,
 * finding 5).
 *
 * An untrusted intake under the markdown gate's enforce mode stores each
 * alias neutralized (`# Zqneutral` as `\# Zqneutral`). Below local reach
 * its pre-check (`intake-reach.ts`) judges the aliases the upserts store,
 * so it decides as the write loop does: an entity held in `private` that
 * holds the neutralized alias refuses the staged intake with the fixed
 * answer before any write, and one holding only the raw spelling, which
 * the write never meets, refuses nothing. Each remote case is paired with
 * the local control, and every refused call compares the raw records of
 * both partitions before and after.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import {
  intakeExtraction,
  type IntakeOptions,
} from "../../src/core/brain/intake/extract-intake.ts";
import {
  MARKDOWN_NEUTRALIZE_MODE_ENV,
  neutralizeMarkdown,
} from "../../src/core/brain/text/neutralize-markdown.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import { LaneEntryWithheldError } from "../../src/core/store/lane-reach-guard.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { AGENT, REGION } from "./lane-private-partition-reach-writes-fixture.ts";
import { rawRecords } from "./lane-reach-residuals-owed-fixture.ts";

const NOW = new Date("2026-11-20T10:00:00Z");
const RAW = "# Zqneutral";
const NEUTRAL = neutralizeMarkdown(RAW).text;

const lanes: LaneEnv[] = [];
let savedMode: string | undefined;
afterEach(() => {
  for (const lane of lanes.splice(0).toReversed()) lane.cleanup();
  if (savedMode === undefined) delete process.env[MARKDOWN_NEUTRALIZE_MODE_ENV];
  else process.env[MARKDOWN_NEUTRALIZE_MODE_ENV] = savedMode;
  savedMode = undefined;
});

/**
 * A store whose private canonical entity holds `alias` (only canonical
 * records claim an alias in the registry's index), under the gate's
 * enforce mode.
 */
function seeded(alias: string): LaneEnv {
  const e = makeLaneEnv("store", "osb-lane-owed-intake-alias-");
  lanes.push(e);
  savedMode = process.env[MARKDOWN_NEUTRALIZE_MODE_ENV];
  process.env[MARKDOWN_NEUTRALIZE_MODE_ENV] = "enforce";
  const { entity } = upsertEntity(e.vault, {
    category: "people",
    name: "Zqholder",
    aliases: [alias],
    agent: AGENT,
    now: NOW,
    body: `held ${REGION}\n`,
  });
  expect(laneEntryInPrivate(e.vault, entity.path)).toBe(true);
  return e;
}

const intake = { entities: [{ category: "people", name: "Zqnewcomer", aliases: [RAW] }] };
const opts: IntakeOptions = {
  agent: AGENT,
  now: NOW,
  // A source outside the vault: the untrusted lane, where the gate neutralizes.
  provenance: { level: "stated", sources: ["https://example.org/zqsource"], premises: [] },
  disposition: "stage",
};

function attempt(e: LaneEnv, remote: boolean): unknown {
  return withPrivateWithheld(remote, () => {
    try {
      return intakeExtraction(e.vault, intake, opts);
    } catch (err) {
      return err;
    }
  });
}

describe("a staged untrusted intake whose neutralized alias a private entity holds", () => {
  test("the alias the write stores is the neutralized spelling", () => {
    expect(NEUTRAL).not.toBe(RAW);
  });

  test("a remote intake gets the fixed answer and writes nothing", () => {
    const e = seeded(NEUTRAL);
    const before = rawRecords(e);
    const out = attempt(e, true);
    expect(out).toBeInstanceOf(LaneEntryWithheldError);
    expect(String(out)).not.toContain("Zqholder");
    expect(rawRecords(e)).toBe(before);
  });

  test("the local intake is refused by the holder and writes nothing", () => {
    const e = seeded(NEUTRAL);
    const before = rawRecords(e);
    const out = attempt(e, false);
    expect(out).toBeInstanceOf(Error);
    expect(out).not.toBeInstanceOf(LaneEntryWithheldError);
    expect(String(out)).toContain("is already claimed by ent-people-zqholder");
    expect(rawRecords(e)).toBe(before);
  });
});

describe("a staged untrusted intake whose raw alias spelling a private entity holds", () => {
  test("a remote intake is not refused: the write never meets the raw spelling", () => {
    const e = seeded(RAW);
    const out = attempt(e, true);
    expect(out).not.toBeInstanceOf(Error);
    expect((out as { entitiesCreated: ReadonlyArray<string> }).entitiesCreated).toEqual([
      "ent-people-zqnewcomer",
    ]);
  });

  test("the local intake creates the entity too", () => {
    const e = seeded(RAW);
    const out = attempt(e, false);
    expect(out).not.toBeInstanceOf(Error);
    expect((out as { entitiesCreated: ReadonlyArray<string> }).entitiesCreated).toEqual([
      "ent-people-zqnewcomer",
    ]);
  });
});
