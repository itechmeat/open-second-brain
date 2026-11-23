/**
 * What the replay shows (dream replay task 8.1; spec "The status tells
 * three things apart"): the status section, the doctor codes, the
 * archivable count against the next window, the digest's interval.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { renameSync } from "node:fs";
import { join } from "node:path";

import { renderDigest } from "../../../../src/core/brain/digest.ts";
import { dream } from "../../../../src/core/brain/dream.ts";
import { dreamReplayCheck } from "../../../../src/core/brain/doctor/dream-replay-check.ts";
import { inboxArchivableCheck } from "../../../../src/core/brain/doctor/inbox-archive-check.ts";
import type { DoctorFindings } from "../../../../src/core/brain/doctor/check.ts";
import type { DreamQueueStatus } from "../../../../src/core/brain/dream-queue/queue.ts";
import {
  describeReplayStatus,
  replayStatus,
} from "../../../../src/core/brain/dream-replay/status-view.ts";
import { loadBrainConfig } from "../../../../src/core/brain/policy.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import {
  makeDreamReplayFixture,
  type DreamReplayFixture,
} from "../../../helpers/dream-replay-fixtures.ts";
import { at, dateOf } from "../../../helpers/dream-replay-scenarios.ts";

let fx: DreamReplayFixture | null = null;
afterEach(() => {
  fx?.cleanup();
  fx = null;
});

function end(day: number): Date {
  return new Date(`${dateOf(day)}T23:59:59.999Z`);
}

function capture(vault: string, slug: string, day: number): void {
  writeSignal(vault, {
    topic: "tabs",
    signal: "positive",
    agent: "claude",
    principle: "Follow the rule of tabs.",
    created_at: at(day, 9),
    date: dateOf(day),
    slug,
    scope: "coding",
  });
}

function doctor(f: DreamReplayFixture, now: Date): DoctorFindings {
  const out: DoctorFindings = { issues: [], uncertain: [] };
  dreamReplayCheck.run({ vault: f.vault, now, configPath: f.configPath } as never, out);
  return out;
}

function codes(findings: DoctorFindings): string[] {
  return [...findings.issues, ...findings.uncertain].map((f) => f.code);
}

describe("dream replay: the status", () => {
  test("it tells admitted, covered and unfinished model work apart", () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(0));
    capture(fx.vault, "s1", 1);
    dream(fx.vault, { now: end(2) });
    const queue = {
      available: true,
      items: [
        { occurrence: `${dateOf(1)}:0`, state: "waiting" },
        { occurrence: `${dateOf(2)}:0`, state: "finished" },
      ],
    } as unknown as DreamQueueStatus;
    const status = replayStatus(fx.vault, { now: end(10), queue });
    expect(status.available).toBe(true);
    if (!status.available) return;
    expect(status.sources).toBeGreaterThan(0);
    expect(status.lastCovered).toBe(dateOf(2));
    // Days 3 to 9 are behind; day 10 is today's window.
    expect(status.behind).toBe(7);
    expect(status.unfinishedModelWork).toEqual([dateOf(1)]);
    const lines = describeReplayStatus(status).join("\n");
    expect(lines).toContain(`Last covered window: ${dateOf(2)}; 7 window(s) behind.`);
    expect(lines).toContain(`Model work unfinished for: ${dateOf(1)}`);
  });

  test("a brain not on the store is never reported as covered", () => {
    expect(replayStatus(null).available).toBe(false);
  });
});

describe("dream replay: doctor", () => {
  test("windows behind, a gap by name, and the unrecoverable count", () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(0));
    expect(codes(doctor(fx, end(5)))).toContain("dream-replay-behind");
    // A gap: a body stored as a blob whose blob is missing.
    fx.append(
      "signal",
      {
        id: "sig-big",
        path: "Brain/inbox/sig-big.md",
        frontmatter: { kind: "brain-signal", id: "sig-big", created_at: at(1, 9), topic: "t" },
        raw: "z".repeat(20_000),
        staged: false,
      },
      "events",
    );
    renameSync(join(fx.storeRoot, "shared", "blobs"), join(fx.parent, "blobs-aside"));
    dream(fx.vault, { now: end(2) });
    const found = doctor(fx, end(2));
    const gap = found.issues.find((i) => i.code === "dream-replay-gap");
    expect(gap?.message).toContain("shared/events/");
  });

  test("the inventory's unrecoverable count", () => {
    fx = makeDreamReplayFixture();
    for (const stem of ["u1", "u2", "u3"]) {
      const id = `sig-${dateOf(1)}-${stem}-0c0c0c`;
      fx.append(
        "signal",
        {
          id,
          path: `Brain/inbox/${id}.md`,
          frontmatter: { kind: "brain-signal", id, created_at: at(1, 9), topic: "lost" },
          raw: null,
          staged: false,
        },
        "events",
      );
      fx.append("signal-state", { authority: "agent", signal: id, state: "archived" }, "events");
    }
    dream(fx.vault, { now: end(3) });
    expect(codes(doctor(fx, end(3)))).toContain("dream-replay-unrecoverable");
  });

  test("inbox-archivable counts against the next window, not the present", () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(0));
    capture(fx.vault, "old", 0);
    const out: DoctorFindings = { issues: [], uncertain: [] };
    const config = loadBrainConfig(fx.vault);
    inboxArchivableCheck.run({ vault: fx.vault, now: end(30), config } as never, out);
    // Judged today it is archivable; the next pass judges day 1 first.
    expect(out.issues.map((i) => i.code)).not.toContain("inbox-archivable");
  });
});

describe("dream replay: the digest", () => {
  test("it names the interval the passes covered", () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(0));
    for (const [slug, day] of [
      ["d1", 1],
      ["d2", 1],
      ["d3", 2],
    ] as const) {
      capture(fx.vault, slug, day);
    }
    dream(fx.vault, { now: end(3) });
    const digest = renderDigest(fx.vault, {
      now: end(3),
      since: new Date(`${dateOf(0)}T00:00:00Z`),
      until: end(4),
    });
    expect(digest.content).toContain("## Dream windows");
    expect(digest.content).toContain(dateOf(2));
  });
});
