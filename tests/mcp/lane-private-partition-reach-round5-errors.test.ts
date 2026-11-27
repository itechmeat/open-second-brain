/**
 * An error raised while the identity decision of a create reads the fold
 * of every partition (fifth closure round, finding 2).
 *
 * `assertCreateMatchAtReach` runs its `matches` with `private` shown. An
 * error that escapes `matches` was composed from that view, so below
 * local reach it becomes the fixed refusal whenever the store holds an
 * entry in `private`: the caller is never told the name of an entry it
 * may not read. On a store without such an entry the error is the one a
 * local caller gets.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { obligationPath } from "../../src/core/brain/paths.ts";
import { privateWithheld, withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import {
  LANE_ENTRY_WITHHELD_MESSAGE,
  LaneEntryWithheldError,
  assertCreateMatchAtReach,
  treeMembersAtReach,
} from "../../src/core/store/lane-reach-guard.ts";
import { laneEntryInPrivate, writeLaneText } from "../../src/core/store/lane-pages.ts";
import { titleSlug } from "../../src/core/vault.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { dropPrivateEvents } from "./lane-private-partition-reach-store-fixture.ts";
import {
  REGION,
  call,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

const TITLE = "Zqheldfoo";
const REVIEW = `Review decision: ${TITLE}`;

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function obligationText(notes: string): string {
  return [
    "---",
    `title: ${JSON.stringify(REVIEW)}`,
    "cadence: zqnot-a-cadence",
    "created_at: 2026-11-01T00:00:00Z",
    "anchor: 2026-11-01",
    "last_done: ",
    "next_due: 2026-12-01",
    'agent: "tester"',
    "---",
    "",
    notes,
    "",
  ].join("\n");
}

function seed(notes: string): { e: LaneEnv; path: string } {
  const e = makeLaneEnv("store", "osb-lane-round5-errors-");
  lanes.push(e);
  const path = obligationPath(e.vault, titleSlug(REVIEW));
  writeLaneText(e.vault, path, obligationText(notes));
  return { e, path };
}

const ARGS = {
  action: "record",
  title: TITLE,
  chosen: "zqheld path",
  assumption: "it holds",
  review_date: "2026-12-01",
};

describe("an error escaping the identity decision of a create below local reach", () => {
  test("a remote decision whose review obligation is private and unreadable gets the fixed refusal", async () => {
    const { e, path } = seed(`held notes ${REGION}`);
    expect(laneEntryInPrivate(e.vault, path)).toBe(true);
    const answer = await call(server(e), "brain_decision", ARGS);
    expect({
      fixed: answer.includes(LANE_ENTRY_WITHHELD_MESSAGE),
      names: answer.includes(titleSlug(REVIEW)),
    }).toEqual({ fixed: true, names: false });
  });

  // Modified by the requirement "An identity matcher's error is masked
  // only when the caller's own view does not raise it" (change
  // `lane-reach-residuals`, design R12): an error the caller's own view
  // raises too reaches it, so the masked error is one only the view with
  // `private` shown raises.
  test("the helper turns an error only the private view raises into the fixed refusal while a private entry is held", () => {
    const { e } = seed(`held notes ${REGION}`);
    const thrown = withPrivateWithheld(true, () => {
      try {
        assertCreateMatchAtReach(e.vault, () => {
          if (!privateWithheld()) throw new Error("zqnamed-held-entry");
          return [];
        });
        return null;
      } catch (err) {
        return err;
      }
    });
    expect(thrown).toBeInstanceOf(LaneEntryWithheldError);
  });

  test("on a store without a private entry the matcher's own error reaches the caller", () => {
    const { e, path } = seed("open notes");
    expect(laneEntryInPrivate(e.vault, path)).toBe(false);
    const thrown = withPrivateWithheld(true, () => {
      try {
        assertCreateMatchAtReach(e.vault, () => {
          throw new Error("zqopen-entry");
        });
        return null;
      } catch (err) {
        return err;
      }
    });
    expect(String(thrown)).toContain("zqopen-entry");
  });
});

const report = (title: string, statement: string) => ({
  title,
  sources: ["https://example.com/zqrel"],
  findings: [{ statement, sources: ["https://example.com/zqrel"] }],
});

describe("a research report whose two pages other titles hold, one in private (finding 6)", () => {
  const TITLE_A = "Отчёт zqrel";
  const TITLE_B = "Обзор zqrel";
  const digest = createHash("sha256").update(TITLE_B, "utf8").digest("hex").slice(0, 8);

  async function seeded(): Promise<LaneEnv> {
    const e = makeLaneEnv("store", "osb-lane-round5-research-");
    lanes.push(e);
    const local = localServer(e);
    const held = await callJson(local, "brain_research_report", report(TITLE_A, `held ${REGION}`));
    expect(held["error"]).toBeUndefined();
    const open = await callJson(
      local,
      "brain_research_report",
      report(`zqrel-${digest}`, "open finding"),
    );
    expect(open["error"]).toBeUndefined();
    return e;
  }

  test("a remote report gets the fixed refusal and writes nothing", async () => {
    const e = await seeded();
    const before = JSON.stringify(e.laneRecords());
    const answer = await call(server(e), "brain_research_report", report(TITLE_B, "new finding"));
    expect(answer.includes(LANE_ENTRY_WITHHELD_MESSAGE)).toBe(true);
    expect(JSON.stringify(e.laneRecords())).toBe(before);
  });

  test("a local report is refused because both pages are held", async () => {
    const e = await seeded();
    const answer = await call(localServer(e), "brain_research_report", report(TITLE_B, "new"));
    expect(answer.includes("holds both pages")).toBe(true);
  });
});

describe("the members of a tree operation while the fold may miss a record (finding 13)", () => {
  test("below local reach the operation gets the fixed refusal", () => {
    const { e } = seed(`held notes ${REGION}`);
    const open = obligationPath(e.vault, "zqopen-member");
    writeLaneText(e.vault, open, obligationText("open notes"));
    dropPrivateEvents(e);
    const thrown = withPrivateWithheld(true, () => {
      try {
        treeMembersAtReach(e.vault, () => [open]);
        return null;
      } catch (err) {
        return err;
      }
    });
    expect(thrown).toBeInstanceOf(LaneEntryWithheldError);
  });
});
