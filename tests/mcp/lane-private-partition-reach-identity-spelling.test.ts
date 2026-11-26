/**
 * A write decision taken from the narrowed view (identity-spelling): a
 * `brain_lifecycle temporal-replace` that names a lane entry held in
 * `private`, while `shared` holds an entry whose path differs from it
 * only in case.
 *
 * A lifecycle target named by a path resolves to the store's entry at
 * that path, or to the one entry that spells it another way. That lookup
 * reads the whole fold: below local reach, a match held in `private` is
 * the fixed refusal before the first write, so a remote call never
 * patches the shared spelling in place of the private entry it named. A
 * local call patches the entry it named.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { temporalReplace } from "../../src/core/brain/lifecycle/temporal-replace.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { LANE_ENTRY_WITHHELD_MESSAGE } from "../../src/core/store/lane-reach-guard.ts";
import { laneEntryInPrivate, writeLaneText } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  REGION,
  call,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

const HELD = "Brain/research/zqspell-fact.md";
const VARIANT = "Brain/research/ZQSpell-fact.md";
const OTHER = "Brain/research/zqspell-other.md";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

/** A lane page with a fixed title stamp. */
const page = (title: string, body: string): string =>
  `---\ntitle: ${title}\ncreated_at: 2026-11-01T00:00:00Z\n---\n\n${body}\n`;

function env(): LaneEnv {
  const e = makeLaneEnv("store", "osb-lane-identity-spelling-");
  lanes.push(e);
  writeLaneText(e.vault, join(e.vault, HELD), page("Held", `zqspell held fact ${REGION}`));
  writeLaneText(e.vault, join(e.vault, VARIANT), page("Variant", "zqspell shared variant"));
  writeLaneText(e.vault, join(e.vault, OTHER), page("Other", "zqspell other fact"));
  expect(
    [HELD, VARIANT, OTHER].map((rel) => laneEntryInPrivate(e.vault, join(e.vault, rel))),
  ).toEqual([true, false, false]);
  return e;
}

const ARGS = { action: "temporal-replace", predecessor: HELD, successor: OTHER, at: "2026-06-01" };

/** The lane records of the entry at `rel`, in both partitions. */
function recordsOf(e: LaneEnv, rel: string): string[] {
  const entry = `"entry":"${rel.slice("Brain/research/".length, -".md".length)}"`;
  return e
    .laneRecords()
    .map((r) => JSON.stringify(r))
    .filter((r) => r.includes(entry));
}

describe("a temporal replace naming a private entry whose spelling a shared entry shares", () => {
  test("a temporal replace below local reach gets the fixed refusal and patches neither entry", () => {
    // The core verb with no reader filter, as any caller below local reach
    // that hands none reaches it: the remote tool's own filter refuses the
    // spelling as missing earlier (the twin with no private entry answers
    // the same), so the lookup itself is held to the rule here.
    const e = env();
    const held = recordsOf(e, HELD);
    const variant = recordsOf(e, VARIANT);
    let refused = "";
    try {
      withPrivateWithheld(true, () =>
        temporalReplace({ vault: e.vault, predecessor: HELD, successor: OTHER, at: "2026-06-01" }),
      );
    } catch (err) {
      refused = String((err as Error).message);
    }
    expect({
      refused: refused.includes(LANE_ENTRY_WITHHELD_MESSAGE),
      names_twin: refused.includes("zqspell"),
      held: recordsOf(e, HELD),
      variant: recordsOf(e, VARIANT),
    }).toEqual({ refused: true, names_twin: false, held, variant });
  });

  test("a remote call through the tool answers as on the twin without the private entry", async () => {
    const e = env();
    const variant = recordsOf(e, VARIANT);
    const answer = await call(server(e), "brain_lifecycle", ARGS);
    expect({ answer: answer.includes("zqspell held"), variant: recordsOf(e, VARIANT) }).toEqual({
      answer: false,
      variant,
    });
  });

  test("a local call patches the entry it named and leaves the variant", async () => {
    const e = env();
    const variant = recordsOf(e, VARIANT);
    const held = recordsOf(e, HELD);
    const answer = await call(localServer(e), "brain_lifecycle", ARGS);
    expect(answer).not.toContain("error");
    expect({
      held_changed: recordsOf(e, HELD).length > held.length,
      variant: recordsOf(e, VARIANT),
    }).toEqual({ held_changed: true, variant });
  });
});
