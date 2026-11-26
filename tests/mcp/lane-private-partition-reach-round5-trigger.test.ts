/**
 * A trigger whose cooldown key it adopted from a private trigger (fifth
 * closure round, finding 1).
 *
 * A batch sighting whose artifacts a persisted batch trigger already
 * covers takes that trigger's key, so the key may name a preference the
 * new sighting never saw. The key's parts count for the new trigger's
 * placement (a key that names a private preference keeps the trigger in
 * `private`) and for what an answer below local reach may name.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writePreference } from "../../src/core/brain/preference.ts";
import { createTriggersAtReach } from "../../src/core/brain/triggers/create-at-reach.ts";
import { createTriggers } from "../../src/core/brain/triggers/store.ts";
import type { InsightCandidate } from "../../src/core/brain/triggers/types.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import {
  laneEntryInPrivate,
  readLaneText,
  writeLaneText,
} from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  REGION,
  call,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

const HELD = "zqheldvalue";
const SHARED = ["pref-zqb", "pref-zqc", "pref-zqd", "pref-zqe", "pref-zqf"];
const HELD_KEY = `batch_inflation:pref-${HELD}:pref-zqf`;
const OLD = new Date("2026-09-01T10:00:00Z");
const NOW = new Date("2026-11-20T10:00:00Z");

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function pref(e: LaneEnv, slug: string, principle: string): void {
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
}

function batch(artifacts: ReadonlyArray<string>, key: string, snippet: string): InsightCandidate {
  return {
    kind: "batch_inflation",
    urgency: "medium",
    reason: "zqbatch finding",
    suggestedAction: "review the batch",
    sourceArtifacts: artifacts,
    contextSnippets: [snippet],
    cooldownKey: key,
  } as InsightCandidate;
}

/** A store with one private preference, five shared ones and an expired private batch trigger over all six. */
function seed(): LaneEnv {
  const e = makeLaneEnv("store", "osb-lane-round5-trigger-");
  lanes.push(e);
  pref(e, HELD, `Held rule ${REGION}`);
  for (const id of SHARED) pref(e, id.slice("pref-".length), `Open rule ${id}`);
  const { created } = createTriggers(
    e.vault,
    [batch([`pref-${HELD}`, ...SHARED], HELD_KEY, "batch of six")],
    { now: OLD },
  );
  expect(laneEntryInPrivate(e.vault, created[0]!.path)).toBe(true);
  return e;
}

describe("a batch sighting that adopts the key of a private batch trigger", () => {
  test("below local reach the new trigger stays out of shared and the answer does not name the held preference", () => {
    const e = seed();
    const result = withPrivateWithheld(true, () =>
      createTriggersAtReach(
        e.vault,
        [batch(SHARED, "batch_inflation:pref-zqb:pref-zqf", "batch of five")],
        { now: NOW },
      ),
    );
    const shared = JSON.stringify(e.laneRecords("shared"));
    expect({
      shared_names_held: shared.includes(HELD),
      answer_names_held: JSON.stringify(result).includes(HELD),
    }).toEqual({ shared_names_held: false, answer_names_held: false });
  });

  test("at local reach the new trigger takes the adopted key and is placed in private", () => {
    const e = seed();
    const result = createTriggersAtReach(
      e.vault,
      [batch(SHARED, "batch_inflation:pref-zqb:pref-zqf", "batch of five")],
      { now: NOW },
    );
    expect(result.created.map((r) => r.cooldownKey)).toEqual([HELD_KEY]);
    expect(laneEntryInPrivate(e.vault, result.created[0]!.path)).toBe(true);
    expect(JSON.stringify(e.laneRecords("shared")).includes(HELD)).toBe(false);
  });

  test("a remote trigger listing leaves out a shared trigger whose key names a private preference", async () => {
    const e = seed();
    // A trigger an earlier release placed in shared under such a key:
    // made under a neutral key of another kind, then given the held key.
    const neutral = "batch_inflation:pref-zqb:pref-zqc";
    const made = createTriggers(
      e.vault,
      [{ ...batch(SHARED, neutral, "legacy batch"), kind: "contradiction" } as InsightCandidate],
      { now: NOW },
    ).created[0]!;
    const path = made.path;
    writeLaneText(e.vault, path, readLaneText(e.vault, path)!.replace(neutral, HELD_KEY));
    expect(laneEntryInPrivate(e.vault, path)).toBe(false);
    const local = await call(localServer(e), "brain_trigger", { operation: "list" });
    expect(local.includes(HELD_KEY)).toBe(true);
    const answer = await call(server(e), "brain_trigger", { operation: "list" });
    expect(answer.includes(HELD)).toBe(false);
  });
});
