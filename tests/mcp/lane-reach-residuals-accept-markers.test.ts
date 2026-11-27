/**
 * A device-local marker the caller may not read is left for a local
 * caller (change `lane-reach-residuals`, package 4, design R4): below
 * local reach the skill-proposal recovery neither discards nor names an
 * unreadable accept marker, with or without `discard_unreadable`, and a
 * later local recovery still finds it; an accept below local reach leaves
 * and names such a marker the same way; a readable marker naming an entry
 * held in `private` is left unread and unnamed as well (a guard of the
 * 2.0.4 rule).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  skillAcceptJournalPath,
  skillProposalAcceptedPath,
  skillProposalPendingPath,
} from "../../src/core/brain/paths.ts";
import { writeSkillAcceptJournal } from "../../src/core/brain/skill-accept-journal.ts";
import {
  laneEntryInPrivate,
  lanePageExists,
  writeLaneText,
} from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  REGION,
  call,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";
import { writeProposal } from "./lane-private-partition-reach-maintenance-fixture.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

const SLUG = "zqmarkerslug";

/** An accept marker that does not parse; its path. */
function unreadableMarker(): { e: LaneEnv; path: string } {
  const e = makeLaneEnv("store", "osb-lane-accept-markers-");
  lane = e;
  const path = skillAcceptJournalPath(e.vault, SLUG);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{zq not a marker", "utf8");
  return { e, path };
}

const HELD_SLUG = "zqmarkerheld";

/**
 * A readable accept marker (archive phase) whose pending proposal is held
 * in `private`; the marker's path.
 */
function readableMarkerOfPrivateProposal(): { e: LaneEnv; path: string } {
  const e = makeLaneEnv("store", "osb-lane-accept-markers-");
  lane = e;
  const pending = skillProposalPendingPath(e.vault, HELD_SLUG);
  writeLaneText(
    e.vault,
    pending,
    `---\nkind: skill-proposal\nslug: ${HELD_SLUG}\n---\n\n# ${HELD_SLUG}\n\nzqmarker draft ${REGION}\n`,
  );
  expect(laneEntryInPrivate(e.vault, pending)).toBe(true);
  writeSkillAcceptJournal(e.vault, {
    slug: HELD_SLUG,
    id: "zqmarker-id",
    phase: "archive",
    startedAt: "2026-01-01T00:00:00.000Z",
    acceptedExisted: false,
    materializedExisted: false,
  });
  const path = skillAcceptJournalPath(e.vault, HELD_SLUG);
  expect(existsSync(path)).toBe(true);
  return { e, path };
}

describe("a readable skill-accept marker naming a private entry", () => {
  // A guard of the 2.0.4 rule (`journalWithheldAtReach`): it passes before
  // package 4 and must keep passing after it.
  for (const discard of [true, false]) {
    test(`a remote recovery ${discard ? "with" : "without"} discard_unreadable leaves the marker and names nothing of it`, async () => {
      const { e, path } = readableMarkerOfPrivateProposal();
      const answer = await call(server(e), "brain_skill_proposals", {
        operation: "recover",
        ...(discard ? { discard_unreadable: true } : {}),
      });
      expect({
        kept: existsSync(path),
        slug: answer.includes(HELD_SLUG),
        path: answer.includes("accept-journal"),
        failed: answer.includes('"error"'),
      }).toEqual({ kept: true, slug: false, path: false, failed: false });
    });
  }

  test("local control: a local recovery resolves the marker and names it", async () => {
    const { e, path } = readableMarkerOfPrivateProposal();
    const answer = await call(localServer(e), "brain_skill_proposals", { operation: "recover" });
    expect({ kept: existsSync(path), named: answer.includes(HELD_SLUG) }).toEqual({
      kept: false,
      named: true,
    });
  });
});

describe("an unreadable skill-accept marker and a recovery below local reach", () => {
  for (const discard of [true, false]) {
    test(`a remote recovery ${discard ? "with" : "without"} discard_unreadable leaves the marker and names nothing of it`, async () => {
      const { e, path } = unreadableMarker();
      const answer = await call(server(e), "brain_skill_proposals", {
        operation: "recover",
        ...(discard ? { discard_unreadable: true } : {}),
      });
      expect({
        kept: existsSync(path),
        slug: answer.includes(SLUG),
        path: answer.includes("accept-journal"),
        failed: answer.includes('"error"'),
      }).toEqual({ kept: true, slug: false, path: false, failed: false });
      const later = await call(localServer(e), "brain_skill_proposals", { operation: "recover" });
      expect(later).toContain(SLUG);
    });
  }

  test("local control: a local recovery with discard_unreadable discards the marker and names it", async () => {
    const { e, path } = unreadableMarker();
    const answer = await call(localServer(e), "brain_skill_proposals", {
      operation: "recover",
      discard_unreadable: true,
    });
    expect({ kept: existsSync(path), named: answer.includes(SLUG) }).toEqual({
      kept: false,
      named: true,
    });
  });

  test("local control: a local recovery without discard_unreadable refuses, naming the marker", async () => {
    const { e, path } = unreadableMarker();
    const answer = await call(localServer(e), "brain_skill_proposals", { operation: "recover" });
    expect({ kept: existsSync(path), named: answer.includes(SLUG) }).toEqual({
      kept: true,
      named: true,
    });
  });
});

describe("an unreadable skill-accept marker and an accept below local reach", () => {
  const OPEN_SLUG = "zqmarkeropen";

  test("a remote accept of an open proposal succeeds, leaves the marker and names nothing of it", async () => {
    const { e, path } = unreadableMarker();
    writeProposal(e.vault, OPEN_SLUG, "zqmarker open draft");
    const answer = await call(server(e), "brain_skill_proposals", {
      operation: "accept",
      slug: OPEN_SLUG,
    });
    expect({
      kept: existsSync(path),
      slug: answer.includes(SLUG + ".json") || answer.includes(`"${SLUG}"`),
      path: answer.includes("accept-journal"),
      failed: answer.includes('"error"') || answer.includes('"isError":true'),
      accepted: lanePageExists(e.vault, skillProposalAcceptedPath(e.vault, OPEN_SLUG)),
    }).toEqual({ kept: true, slug: false, path: false, failed: false, accepted: true });
    const later = await call(localServer(e), "brain_skill_proposals", { operation: "recover" });
    expect(later).toContain(SLUG);
  });

  test("local control: a local accept refuses on the unreadable marker, naming it", async () => {
    const { e, path } = unreadableMarker();
    writeProposal(e.vault, OPEN_SLUG, "zqmarker open draft");
    const answer = await call(localServer(e), "brain_skill_proposals", {
      operation: "accept",
      slug: OPEN_SLUG,
    });
    expect({
      kept: existsSync(path),
      named: answer.includes(SLUG),
      accepted: lanePageExists(e.vault, skillProposalAcceptedPath(e.vault, OPEN_SLUG)),
    }).toEqual({ kept: true, named: true, accepted: false });
  });
});
