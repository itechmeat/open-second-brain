/**
 * Review obligations written before the reach rule are named by the
 * doctor (change `lane-reach-residuals`, package 12, design R10): a
 * review obligation an earlier release wrote in `shared` for a decision
 * now held in `private` stays in `shared`, with the decision's title in
 * its own. No migration moves it; at local reach the doctor counts such
 * obligations, names them and says how a local caller moves them; below
 * local reach it counts none and names no obligation, decision or title.
 *
 * The old state is built as an earlier release left it: the review
 * obligation is added first, in `shared`, and the decision is recorded
 * after it, in `private`, reusing that obligation as its review. The
 * machine is a store-only one (switched, its legacy tree removed), where
 * the doctor runs its store-side checks.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { basename, join } from "node:path";

import { recordDecision } from "../../src/core/brain/decisions/record.ts";
import { addObligation } from "../../src/core/brain/obligations.ts";
import { decisionPath, obligationPath } from "../../src/core/brain/paths.ts";
import { titleSlug } from "../../src/core/vault.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  AGENT,
  REGION,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

const TITLE = "Zqoldreview choice";
const REVIEW = `Review decision: ${TITLE}`;
const CODE = "review-obligation-shared";
const NOW = new Date("2026-11-20T10:00:00Z");

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

/** A store-only machine: switched, with no legacy `Brain/` tree left in its vault. */
function storeOnly(prefix: string): LaneEnv {
  const e = makeLaneEnv("store", prefix);
  lane = e;
  rmSync(join(e.vault, "Brain"), { recursive: true, force: true });
  return e;
}

/** A store-only machine holding a private decision whose review obligation an earlier release wrote in `shared`. */
function oldReview(): { e: LaneEnv; obligation: string; decision: string } {
  const e = storeOnly("osb-lane-old-review-");
  const added = addObligation(e.vault, {
    title: REVIEW,
    cadence: "quarterly",
    agent: AGENT,
    anchor: "2026-12-01",
    now: NOW,
  });
  const recorded = recordDecision(e.vault, {
    title: TITLE,
    chosen: "zqoldreview path",
    assumption: "it holds",
    reviewDate: "2026-12-01",
    agent: AGENT,
    notes: `held ${REGION}`,
    now: NOW,
  });
  expect({
    reused: recorded.reviewObligationSlug === added.slug && !recorded.obligationCreated,
    decisionPrivate: laneEntryInPrivate(e.vault, recorded.record.path),
    obligationPrivate: laneEntryInPrivate(e.vault, added.path),
  }).toEqual({ reused: true, decisionPrivate: true, obligationPrivate: false });
  return { e, obligation: added.path, decision: recorded.record.path };
}

/**
 * A store-only machine holding a decision placed in `private` only because
 * its notes link a private page: no `visibility` mark in its own
 * frontmatter, no `<private>` region in its text. Its review obligation an
 * earlier release wrote in `shared`.
 */
function oldReviewByReference(): { e: LaneEnv; obligation: string; decision: string } {
  const e = storeOnly("osb-lane-old-review-ref-");
  const secret = recordDecision(e.vault, {
    title: "Zqoldreview secret",
    chosen: "zqoldreview hidden path",
    assumption: "it stays hidden",
    reviewDate: "2027-01-01",
    agent: AGENT,
    notes: `held ${REGION}`,
    now: NOW,
  });
  expect(laneEntryInPrivate(e.vault, secret.record.path)).toBe(true);
  const added = addObligation(e.vault, {
    title: REVIEW,
    cadence: "quarterly",
    agent: AGENT,
    anchor: "2026-12-01",
    now: NOW,
  });
  const recorded = recordDecision(e.vault, {
    title: TITLE,
    chosen: "zqoldreview path",
    assumption: "it holds",
    reviewDate: "2026-12-01",
    agent: AGENT,
    notes: `see [[${slugOf(secret.record.path)}]]`,
    now: NOW,
  });
  expect({
    reused: recorded.reviewObligationSlug === added.slug && !recorded.obligationCreated,
    decisionPrivate: laneEntryInPrivate(e.vault, recorded.record.path),
    obligationPrivate: laneEntryInPrivate(e.vault, added.path),
  }).toEqual({ reused: true, decisionPrivate: true, obligationPrivate: false });
  return { e, obligation: added.path, decision: recorded.record.path };
}

/** The doctor's answer as `server` gives it, and its warnings of {@link CODE}. */
async function doctor(
  s: ReturnType<typeof server>,
): Promise<{ text: string; ours: Array<Record<string, unknown>> }> {
  const answer = await callJson(s, "brain_doctor", {});
  const warnings = (answer["warnings"] ?? []) as Array<Record<string, unknown>>;
  return { text: JSON.stringify(answer), ours: warnings.filter((w) => w["code"] === CODE) };
}

/** The file stem of a lane page path: its slug. */
function slugOf(path: string): string {
  return basename(path, ".md");
}

describe("a local update of an old review obligation", () => {
  test("a local done leaves it in shared", async () => {
    const { e, obligation } = oldReview();
    const done = await callJson(localServer(e), "brain_obligation", {
      operation: "done",
      slug: titleSlug(REVIEW),
    });
    expect(done["error"] ?? null).toBeNull();
    expect(laneEntryInPrivate(e.vault, obligation)).toBe(false);
  });

  test("a local remove and add under the same title writes it in shared again", async () => {
    const { e, obligation } = oldReview();
    const s = localServer(e);
    const removed = await callJson(s, "brain_obligation", {
      operation: "remove",
      slug: titleSlug(REVIEW),
    });
    expect(removed["error"] ?? null).toBeNull();
    const added = await callJson(s, "brain_obligation", {
      operation: "add",
      title: REVIEW,
      cadence: "quarterly",
    });
    expect(added["error"] ?? null).toBeNull();
    expect(laneEntryInPrivate(e.vault, obligation)).toBe(false);
  });

  test("a local remove and add with a private region in its notes writes it in private", async () => {
    const { e, obligation } = oldReview();
    const s = localServer(e);
    await callJson(s, "brain_obligation", { operation: "remove", slug: titleSlug(REVIEW) });
    const added = await callJson(s, "brain_obligation", {
      operation: "add",
      title: REVIEW,
      cadence: "quarterly",
      notes: REGION,
    });
    expect(added["error"] ?? null).toBeNull();
    expect(laneEntryInPrivate(e.vault, obligation)).toBe(true);
  });
});

describe("the doctor names review obligations written before the reach rule", () => {
  test("local: the doctor counts the old review obligation, names it and says what moves it", async () => {
    const { e } = oldReview();
    const { ours } = await doctor(localServer(e));
    expect(ours.length).toBe(1);
    const message = String(ours[0]!["message"]);
    expect({
      counted: message.startsWith("1 review obligation(s)"),
      named: message.includes(titleSlug(REVIEW)),
      remedy: message.includes("remove") && message.includes("<private>"),
    }).toEqual({ counted: true, named: true, remedy: true });
  });

  test("remote: the doctor counts none and names no obligation, decision or title", async () => {
    const { e, obligation, decision } = oldReview();
    const { text, ours } = await doctor(server(e));
    expect({
      counted: ours.length,
      named: [TITLE, REVIEW, slugOf(obligation), slugOf(decision), titleSlug(TITLE)].filter((s) =>
        text.includes(s),
      ),
    }).toEqual({ counted: 0, named: [] });
  });

  test("local: a decision held in private only by a link to a private page is named too", async () => {
    const { e } = oldReviewByReference();
    const { ours } = await doctor(localServer(e));
    expect(ours.length).toBe(1);
    const message = String(ours[0]!["message"]);
    expect({
      counted: message.startsWith("1 review obligation(s)"),
      named: message.includes(titleSlug(REVIEW)),
    }).toEqual({ counted: true, named: true });
  });

  test("remote: a decision held in private by a link names nothing either", async () => {
    const { e, obligation, decision } = oldReviewByReference();
    const { text, ours } = await doctor(server(e));
    expect({
      counted: ours.length,
      named: [TITLE, REVIEW, slugOf(obligation), slugOf(decision), titleSlug(TITLE)].filter((s) =>
        text.includes(s),
      ),
    }).toEqual({ counted: 0, named: [] });
  });

  test("local control: a review recorded under the reach rule is not named", async () => {
    const e = storeOnly("osb-lane-old-review-control-");
    const recorded = recordDecision(e.vault, {
      title: TITLE,
      chosen: "zqoldreview path",
      assumption: "it holds",
      reviewDate: "2026-12-01",
      agent: AGENT,
      notes: `held ${REGION}`,
      now: NOW,
    });
    expect(laneEntryInPrivate(e.vault, decisionPath(e.vault, titleSlug(TITLE)))).toBe(true);
    expect(
      laneEntryInPrivate(e.vault, obligationPath(e.vault, recorded.reviewObligationSlug)),
    ).toBe(true);
    const { ours } = await doctor(localServer(e));
    expect(ours).toEqual([]);
  });
});
