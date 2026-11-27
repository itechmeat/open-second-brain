/**
 * `brain_truth state` with a private lexicon (change `lane-reach-residuals`,
 * package 19; owed by 2.0.4, the truth-lexicon test of the third closure
 * round left unfinished).
 *
 * A stated claim commits only when its subject and object anchor in the
 * text, and the store-learned entity lexicon gates the anchoring forms:
 * behind a caseful lexicon an all-caps form (`shouted-heading`) does not
 * anchor. The lexicon is a derived artifact of the machine, resolved on
 * the fold of every partition whatever the caller's reach
 * (`resolveEntityLexicon`), so an artifact held in `private` gates a
 * remote call exactly as it gates the local control: the claim is
 * reported unanchored and nothing is written. Without the artifact both
 * reaches commit the same claim.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  __clearEntityLexiconCache,
  deriveEntityLexicon,
  ENTITY_LEXICON_ARTIFACT_REL,
  entityLexiconDatasetHash,
  loadEntityLexicon,
} from "../../src/core/brain/entities/lexicon.ts";
import { withPrivateShown } from "../../src/core/store/caller-reach.ts";
import { laneEntryInPrivate, writeLaneText } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { callJson, localServer, server } from "./lane-private-partition-reach-writes-fixture.ts";
import { rawRecords } from "./lane-reach-residuals-owed-fixture.ts";

const NOW = new Date("2026-11-20T10:00:00Z");
const SOURCE = "Notes/zqtruth-source.md";
const CLAIM = { subject: "ZQSHOUT", relation: "related", object: "Zqobject" };
const TEXT = "ZQSHOUT is related to Zqobject.";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0).toReversed()) lane.cleanup();
  __clearEntityLexiconCache();
});

/** A store-only machine with a cased corpus; with `lexicon`, a fresh lexicon held in `private`. */
function seeded(lexicon: boolean): LaneEnv {
  const e = makeLaneEnv("store", "osb-lane-owed-truth-lexicon-");
  lanes.push(e);
  mkdirSync(join(e.vault, "Notes"), { recursive: true });
  writeFileSync(join(e.vault, "Notes", "zqcorpus.md"), "# Corpus\n\nZqalpha met Zqbeta.\n");
  writeFileSync(join(e.vault, SOURCE), `# Source\n\n${TEXT}\n`);
  if (lexicon) {
    const doc = deriveEntityLexicon(e.vault, { now: NOW });
    expect(doc.caseful).toBe(true);
    const artifact = join(e.vault, ENTITY_LEXICON_ARTIFACT_REL);
    writeLaneText(
      e.vault,
      artifact,
      `${JSON.stringify({ ...doc, visibility: ["private"] }, null, 2)}\n`,
    );
    expect(laneEntryInPrivate(e.vault, artifact)).toBe(true);
    const fresh = withPrivateShown(() =>
      loadEntityLexicon(e.vault, entityLexiconDatasetHash(e.vault)),
    );
    expect(fresh).not.toBeNull();
  }
  __clearEntityLexiconCache();
  return e;
}

const state = { operation: "state", claims: [CLAIM], text: TEXT, source: SOURCE, agent: "tester" };

/** The verdict of a `state` call: committed values and ungrounded reasons. */
function verdict(answer: Record<string, unknown>): { committed: number; reasons: unknown } {
  return {
    committed: ((answer["committed"] as unknown[] | undefined) ?? []).length,
    reasons: ((answer["ungrounded"] as Array<{ reasons: unknown }> | undefined) ?? []).map(
      (u) => u.reasons,
    ),
  };
}

describe("a stated claim whose subject a private lexicon refuses to anchor", () => {
  test("a remote call reports it unanchored and writes nothing", async () => {
    const e = seeded(true);
    const before = rawRecords(e);
    const answer = await callJson(server(e), "brain_truth", state);
    expect(verdict(answer)).toEqual({ committed: 0, reasons: [["subject_unanchored"]] });
    expect(rawRecords(e)).toBe(before);
  });

  test("the local control reports it unanchored too", async () => {
    const e = seeded(true);
    const before = rawRecords(e);
    const answer = await callJson(localServer(e), "brain_truth", state);
    expect(verdict(answer)).toEqual({ committed: 0, reasons: [["subject_unanchored"]] });
    expect(rawRecords(e)).toBe(before);
  });
});

describe("the same claim with no lexicon", () => {
  test("a remote call commits it", async () => {
    const answer = await callJson(server(seeded(false)), "brain_truth", state);
    expect(verdict(answer)).toEqual({ committed: 1, reasons: [] });
  });

  test("the local control commits it too", async () => {
    const answer = await callJson(localServer(seeded(false)), "brain_truth", state);
    expect(verdict(answer)).toEqual({ committed: 1, reasons: [] });
  });
});
