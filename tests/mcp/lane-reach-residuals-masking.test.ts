/**
 * An identity matcher's error is masked only when the caller's own view
 * does not raise it (change `lane-reach-residuals`, package 13, design
 * R12; spec "An identity matcher's error is masked only when the caller's
 * own view does not raise it").
 *
 * When the identity decision of a create below local reach raises on the
 * fold of every partition, the caller gets that class of error when its
 * own narrowed view raises an error of the same class, and the fixed
 * answer otherwise. Each case asserts the error class by name and pairs
 * the remote call with a local control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { obligationPath, reportPagePath } from "../../src/core/brain/paths.ts";
import { writeResearchReport } from "../../src/core/brain/research/research.ts";
import { privateWithheld, withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { laneEntryInPrivate, writeLaneText } from "../../src/core/store/lane-pages.ts";
import { assertCreateMatchAtReach } from "../../src/core/store/lane-reach-guard.ts";
import { isoDate } from "../../src/core/brain/time.ts";
import { slugify, titleSlug } from "../../src/core/vault.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { AGENT, REGION, call, server } from "./lane-private-partition-reach-writes-fixture.ts";

const WITHHELD = "this entry cannot be written at this reach";
const NOW = new Date("2026-11-20T10:00:00Z");
const TITLE = "Zqmask quarterly report";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(mode: "legacy" | "store", name: string): LaneEnv {
  const e = makeLaneEnv(mode, `osb-lane-masking-${name}-`);
  lanes.push(e);
  return e;
}

/** The class name of what `fn` throws, or "none". */
function thrownClass(fn: () => unknown): string {
  try {
    fn();
    return "none";
  } catch (err) {
    return (err as Error).name;
  }
}

/**
 * Both pages a report of `TITLE` could take today are held by shared
 * reports of another title: the slot is full in the caller's own view.
 */
function fillReportSlot(e: LaneEnv): void {
  const base = slugify(TITLE);
  const digest = createHash("sha256").update(TITLE, "utf8").digest("hex").slice(0, 8);
  for (const slug of [base, `${base}-${digest}`]) {
    const path = reportPagePath(e.vault, isoDate(NOW), slug);
    writeLaneText(e.vault, path, `---\ntitle: "Zqmask other report"\n---\n\n# Other\n`);
    expect(laneEntryInPrivate(e.vault, path)).toBe(false);
  }
}

const REPORT = {
  title: TITLE,
  sources: ["https://example.com/zqmask"],
  findings: [{ statement: "zqmask finding", sources: ["https://example.com/zqmask"] }],
};

function recordReport(e: LaneEnv, remote: boolean): string {
  return withPrivateWithheld(remote, () =>
    thrownClass(() => writeResearchReport(e.vault, REPORT, { agent: AGENT, now: NOW })),
  );
}

describe("a validation error of the caller's own view is kept", () => {
  test("files: a remote report for a full slot gets the research validation error", () => {
    const e = env("legacy", "report");
    fillReportSlot(e);
    expect(recordReport(e, true)).toBe("ResearchValidationError");
  });

  test("files: a local report for the same slot gets the same error", () => {
    const e = env("legacy", "report-local");
    fillReportSlot(e);
    expect(recordReport(e, false)).toBe("ResearchValidationError");
  });

  test("an error of one class from both views reaches the caller as its own", () => {
    const e = env("legacy", "helper");
    class ZqmaskError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "ZqmaskError";
      }
    }
    const thrown = withPrivateWithheld(true, () =>
      thrownClass(() =>
        assertCreateMatchAtReach(e.vault, () => {
          throw new ZqmaskError(privateWithheld() ? "own view" : "every partition");
        }),
      ),
    );
    expect(thrown).toBe("ZqmaskError");
  });
});

describe("an error only the private view raises is masked", () => {
  const REVIEW = "Review decision: Zqmaskheld";

  /** A private obligation whose page cannot be read, at the decision's review slot. */
  function unreadablePrivateObligation(e: LaneEnv): void {
    const path = obligationPath(e.vault, titleSlug(REVIEW));
    writeLaneText(
      e.vault,
      path,
      [
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
        `held notes ${REGION}`,
        "",
      ].join("\n"),
    );
    expect(laneEntryInPrivate(e.vault, path)).toBe(true);
  }

  const DECISION = {
    action: "record",
    title: "Zqmaskheld",
    chosen: "zqmask path",
    assumption: "it holds",
    review_date: "2026-12-01",
  };

  test("a remote decision at that slot gets the fixed answer", async () => {
    const e = env("store", "decision");
    unreadablePrivateObligation(e);
    const answer = await call(server(e), "brain_decision", DECISION);
    expect({ fixed: answer.includes(WITHHELD), names: answer.includes("zqmaskheld") }).toEqual({
      fixed: true,
      names: false,
    });
  });

  test("an error only the private view raises is the fixed answer, by class", () => {
    const e = env("store", "helper-private");
    unreadablePrivateObligation(e);
    const thrown = withPrivateWithheld(true, () =>
      thrownClass(() =>
        assertCreateMatchAtReach(e.vault, () => {
          if (!privateWithheld()) throw new TypeError("names the private entry");
          return [];
        }),
      ),
    );
    expect(thrown).toBe("LaneEntryWithheldError");
  });

  test("an error of another class from the caller's own view is masked too", () => {
    const e = env("store", "helper-other");
    unreadablePrivateObligation(e);
    const thrown = withPrivateWithheld(true, () =>
      thrownClass(() =>
        assertCreateMatchAtReach(e.vault, () => {
          if (privateWithheld()) throw new RangeError("own view");
          throw new TypeError("names the private entry");
        }),
      ),
    );
    expect(thrown).toBe("LaneEntryWithheldError");
  });
});
