/**
 * Counts and caps answered below local reach agree with what the caller
 * may read (change `lane-reach-residuals`, package 15, design R13; spec
 * "Counts and caps answered below local reach agree with what the caller
 * may read" and "The claim graph filters before it caps").
 *
 * The dead-end trim runs as the machine's maintenance on the fold of
 * every partition (a private overflow entry is archived within
 * `private`), the trigger scan's `candidates` counts what `created` and
 * `skipped` show, recall feedback answers `events` from the `shared`
 * events while the weights stay folded from every partition, and the
 * claim graph filters before it caps. Each remote case has a local
 * control on its own store.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { buildClaimGraph } from "../../src/core/brain/claim-graph.ts";
import { listDeadEnds, recordDeadEnd } from "../../src/core/brain/dead-ends.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { scanTriggers } from "../../src/core/brain/triggers/scan.ts";
import { createTriggers } from "../../src/core/brain/triggers/store.ts";
import type { InsightCandidate } from "../../src/core/brain/triggers/types.ts";
import { readLearnedWeights } from "../../src/core/search/feedback.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import { withPrivateShown, withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { LEDGER_ROW_KIND } from "../../src/core/store/constants.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  AGENT,
  REGION,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(name: string): LaneEnv {
  const e = makeLaneEnv("store", `osb-lane-counts-${name}-`);
  lanes.push(e);
  return e;
}

describe("the dead-end cap holds after a remote record", () => {
  const CAP = 2;

  /** The lane at its cap, its oldest entry held in `private`. */
  function atCap(e: LaneEnv): string {
    const held = recordDeadEnd(e.vault, {
      approach: "zqcap held approach",
      reason: `held reason ${REGION}`,
      agent: AGENT,
      now: new Date("2026-11-01T10:00:00Z"),
      maxActive: CAP,
    });
    expect(laneEntryInPrivate(e.vault, held.entry.path)).toBe(true);
    recordDeadEnd(e.vault, {
      approach: "zqcap open approach",
      reason: "open reason",
      agent: AGENT,
      now: new Date("2026-11-02T10:00:00Z"),
      maxActive: CAP,
    });
    return held.entry.id;
  }

  function recordAt(e: LaneEnv, remote: boolean): ReadonlyArray<string> {
    const readable = (rel: string) => !laneEntryInPrivate(e.vault, join(e.vault, rel));
    return withPrivateWithheld(remote, () =>
      recordDeadEnd(e.vault, {
        approach: "zqcap new approach",
        reason: "new reason",
        agent: AGENT,
        now: new Date("2026-11-03T10:00:00Z"),
        maxActive: CAP,
        ...(remote ? { readable } : {}),
      }),
    ).archived;
  }

  /** The active entries on the fold of every partition, and the archived held entry's place. */
  function state(e: LaneEnv, heldId: string): { active: number; heldArchivedPrivate: boolean } {
    const active = withPrivateShown(() => listDeadEnds(e.vault)).entries.length;
    const archived = join(e.vault, "Brain", "dead-ends", "archive", `${heldId}.md`);
    return { active, heldArchivedPrivate: laneEntryInPrivate(e.vault, archived) };
  }

  test("remote: the active entries stay within the cap, the overflow is archived within private, and the answer names none", () => {
    const e = env("dead-ends");
    const heldId = atCap(e);
    const archived = recordAt(e, true);
    expect({ archived, ...state(e, heldId) }).toEqual({
      archived: [],
      active: CAP,
      heldArchivedPrivate: true,
    });
  });

  test("local: the same record archives the overflow and names it", () => {
    const e = env("dead-ends-local");
    const heldId = atCap(e);
    const archived = recordAt(e, false);
    expect({ archived, ...state(e, heldId) }).toEqual({
      archived: [heldId],
      active: CAP,
      heldArchivedPrivate: true,
    });
  });
});

describe("a trigger skipped for a private trigger is not counted", () => {
  const NOW = new Date("2026-11-20T10:00:00Z");

  function candidate(key: string, snippet: string): InsightCandidate {
    return {
      kind: "batch_inflation",
      urgency: "medium",
      reason: "zqcount finding",
      suggestedAction: "review the batch",
      sourceArtifacts: [],
      contextSnippets: [snippet],
      cooldownKey: key,
    } as InsightCandidate;
  }

  /** A private trigger holds `zqcount:held`; a scan meets it and a fresh finding. */
  function scanAt(remote: boolean): { candidates: number; shown: number } {
    const e = env(remote ? "triggers" : "triggers-local");
    const { created } = createTriggers(e.vault, [candidate("zqcount:held", `held ${REGION}`)], {
      now: new Date("2026-11-19T10:00:00Z"),
    });
    expect(laneEntryInPrivate(e.vault, created[0]!.path)).toBe(true);
    const result = withPrivateWithheld(remote, () =>
      scanTriggers(e.vault, {
        now: NOW,
        extraCandidates: [
          candidate("zqcount:held", "held again"),
          candidate("zqcount:open", "open finding"),
        ],
      }),
    );
    return { candidates: result.candidates, shown: result.created.length + result.skipped.length };
  }

  test("remote: candidates equals what created and skipped show", () => {
    const { candidates, shown } = scanAt(true);
    expect(candidates).toBe(shown);
  });

  test("local: candidates equals what created and skipped show", () => {
    const { candidates, shown } = scanAt(false);
    expect(candidates).toBe(shown);
  });
});

describe("recall feedback counts the caller's events", () => {
  /** Two feedback events the `shared` partition holds, as another device appends them. */
  function sharedEvents(e: LaneEnv): void {
    const store = openStore({ root: e.env.storeRoot, device: "dev-b" });
    for (const ts of [1_700_000_000_000, 1_700_000_001_000]) {
      appendRecord(store, {
        partition: "shared",
        stream: "ledgers",
        ledger: "search-feedback",
        kind: LEDGER_ROW_KIND,
        agent: "o2b",
        body: {
          row: {
            ts,
            queryHash: "0000abcd",
            resultPath: "Notes/zqfeedback.md",
            verdict: "up",
            contributions: { keyword: 1, semantic: 0, entity: 0, recency: 0 },
          },
        },
      });
    }
  }

  async function feedback(e: LaneEnv, remote: boolean): Promise<Record<string, unknown>> {
    const answer = await callJson(remote ? server(e) : localServer(e), "brain_recall_feedback", {
      query: "zqfeedback quarterly ledger",
      result_path: "Notes/zqfeedback.md",
      verdict: "down",
    });
    expect(answer["error"]).toBeUndefined();
    return answer["learned"] as Record<string, unknown>;
  }

  test("remote: the answer's events counts only the shared events; the weights keep every event", async () => {
    const e = env("feedback");
    sharedEvents(e);
    await feedback(e, false);
    const learned = await feedback(e, true);
    expect({
      answered: learned["events"],
      written: readLearnedWeights(e.vault)?.events,
    }).toEqual({ answered: 2, written: 4 });
  });

  test("local: the answer's events counts every event", async () => {
    const e = env("feedback-local");
    sharedEvents(e);
    await feedback(e, false);
    const learned = await feedback(e, false);
    expect(learned["events"]).toBe(4);
  });
});

describe("the claim graph filters before it caps", () => {
  /** Three private preferences that sort first, two shared ones after. */
  function claims(e: LaneEnv): void {
    const write = (slug: string, principle: string) =>
      writePreference(e.vault, {
        slug,
        topic: slug,
        principle,
        created_at: "2026-08-01T00:00:00Z",
        unconfirmed_until: "2026-08-08T00:00:00Z",
        status: "confirmed",
        confirmed_at: "2026-08-01T00:00:00Z",
        evidenced_by: [],
      });
    for (const slug of ["zqa-held", "zqb-held", "zqc-held"]) write(slug, `Held ${REGION}`);
    for (const slug of ["zqx-open", "zqy-open"]) write(slug, "Open rule");
  }

  test("a projection kept to what a reader may read caps only that", () => {
    const e = env("claims");
    claims(e);
    const keep = (node: { readonly path: string }) => !node.path.includes("-held");
    const graph = buildClaimGraph(e.vault, { maxNodes: 2, keep });
    expect({
      nodes: graph.nodes.map((n) => n.path.replace(/^.*\//, "")),
      truncated: graph.truncated,
    }).toEqual({ nodes: ["pref-zqx-open.md", "pref-zqy-open.md"], truncated: false });
  });

  test("remote history answers the shared claims, local history every claim", async () => {
    const e = env("claims-tool");
    claims(e);
    const ids = async (s: ReturnType<typeof server>) =>
      (
        (await callJson(s, "brain_claims", { operation: "history" }))["claims"] as ReadonlyArray<{
          id: string;
        }>
      ).map((c) => c.id);
    expect((await ids(server(e))).toSorted()).toEqual(["pref-zqx-open", "pref-zqy-open"]);
    expect((await ids(localServer(e))).length).toBe(5);
  });
});
