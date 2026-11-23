/**
 * Admission and the inputs of a window (dream replay task 3.1; spec "A
 * late record counts from its admission and reopens nothing", "Unknown
 * input stops coverage", "A replaced shard is rebased and the loss is
 * reported").
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dream } from "../../../../src/core/brain/dream.ts";
import type { DreamAdmissionBody } from "../../../../src/core/brain/dream-replay/records.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import type { Safeguard } from "../../../../src/core/brain/safeguard.ts";
import { readStoreEntities } from "../../../../src/core/store/read/store-entities.ts";
import { withStoreReadView } from "../../../../src/core/store/read/read-view.ts";
import { readStoreLogEvents } from "../../../../src/core/store/read/log-events.ts";
import { appendApplyEvidence } from "../../../../src/core/brain/apply-evidence.ts";
import { writePreference } from "../../../../src/core/brain/preference.ts";
import {
  makeDreamReplayFixture,
  type DreamReplayFixture,
} from "../../../helpers/dream-replay-fixtures.ts";
import { at, dateOf } from "../../../helpers/dream-replay-scenarios.ts";
import { partitionRecords } from "../store-only/fixtures.ts";

let fx: DreamReplayFixture | null = null;
afterEach(() => {
  fx?.cleanup();
  fx = null;
});

function end(day: number): Date {
  return new Date(`${dateOf(day)}T23:59:59.999Z`);
}

function capture(
  vault: string,
  slug: string,
  topic: string,
  day: number,
  options: { readonly agent?: string; readonly raw?: string; readonly hour?: number } = {},
): void {
  const createdAt = at(day, options.hour ?? 9);
  writeSignal(vault, {
    topic,
    signal: "positive",
    agent: options.agent ?? "claude",
    principle: `Follow the rule of ${topic}.`,
    created_at: createdAt,
    date: createdAt.slice(0, 10),
    slug,
    scope: "coding",
    ...(options.raw !== undefined ? { raw: options.raw } : {}),
  });
}

function admissions(f: DreamReplayFixture): DreamAdmissionBody[] {
  return f
    .replayRecords()
    .filter((r) => r.kind === "dream-admission")
    .map((r) => r.body as unknown as DreamAdmissionBody);
}

function signalState(f: DreamReplayFixture, stem: string): string | undefined {
  for (const [id, signal] of readStoreEntities()?.signals ?? []) {
    if (id.includes(`-${stem}-`)) return signal.state;
  }
  return undefined;
}

/** A signal whose body is larger than a line, so it is stored as a blob. */
function bigCapture(f: DreamReplayFixture, stem: string, day: number): void {
  const id = `sig-${dateOf(day)}-${stem}-0a0a0a`;
  f.append(
    "signal",
    {
      id,
      path: `Brain/inbox/${id}.md`,
      frontmatter: {
        kind: "brain-signal",
        id,
        created_at: at(day, 9),
        topic: "tabs",
        signal: "positive",
        agent: "claude",
        principle: "Follow the rule of tabs.",
        scope: "coding",
        tags: ["brain", "brain/signal"],
      },
      raw: "y".repeat(20_000),
      staged: false,
    },
    "events",
  );
}

/** The blobs of the shared partition moved aside, and how to bring them back. */
function hideBlobs(f: DreamReplayFixture): () => void {
  const blobs = join(f.storeRoot, "shared", "blobs");
  const aside = join(f.parent, "blobs-aside");
  renameSync(blobs, aside);
  return () => renameSync(aside, blobs);
}

describe("dream replay: admission", () => {
  test("the admission record is written before any effect, and stays when the window fails", () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(0));
    capture(fx.vault, "x1", "tabs", 1);
    let calls = 0;
    const safeguard: Safeguard = {
      operation: "dream",
      timeoutMs: null,
      checkpoint() {
        calls += 1;
        if (calls > 2) throw new Error("stopped inside the window");
      },
    };
    expect(() => dream(fx!.vault, { now: end(1), safeguard })).toThrow("stopped inside the window");
    const records = fx.replayRecords();
    expect(records.filter((r) => r.kind === "dream-admission")).toHaveLength(1);
    expect(records.filter((r) => r.kind === "dream-coverage")).toHaveLength(1); // the seeded one
  });

  test("a late record is judged from its window's start, and keeps that time across passes", () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(5));
    // Dated on day 2, first seen after day 5 was covered.
    capture(fx.vault, "late", "tabs", 2);
    dream(fx.vault, { now: end(6) });
    const first = admissions(fx);
    expect(first).toHaveLength(1);
    expect(first[0]!.late).toHaveLength(1);
    expect(first[0]!.late[0]!.at).toBe(`${dateOf(6)}T00:00:00.000Z`);
    // Its own date left the 14-day window on day 17; its admission keeps it
    // until day 21, so the pass of day 18 does not archive it.
    dream(fx.vault, { now: end(18) });
    expect(fx.replayState().effective.get(first[0]!.late[0]!.id)).toBe(first[0]!.late[0]!.at);
    expect(signalState(fx, "late")).toBe("active");
    dream(fx.vault, { now: end(21) });
    expect(signalState(fx, "late")).toBe("archived");
  });

  test("a record dated ahead of the admission is judged at the moment of admission", () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(0));
    capture(fx.vault, "ahead", "tabs", 30);
    dream(fx.vault, { now: end(1) });
    const [admission] = admissions(fx);
    expect(admission!.clamped).toEqual([
      { id: expect.any(String), at: end(1).toISOString() } as never,
    ]);
  });

  test("a record read at an early window's admission is an input of the window of its day", () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(0));
    for (const [slug, agent] of [
      ["r1", "claude"],
      ["r2", "codex"],
      ["r3", "hermes"],
    ] as const) {
      capture(fx.vault, slug, "naming", 3, { agent });
    }
    dream(fx.vault, { now: end(5) });
    // Five windows, one admission each; the first read the three signals.
    expect(admissions(fx).map((a) => a.day)).toEqual([1, 2, 3, 4, 5].map(dateOf));
    expect(admissions(fx)[0]!.late).toEqual([]);
    const promoted = [...(readStoreEntities()?.preferences.values() ?? [])].find(
      (p) => p.state.fields["topic"] === "naming",
    );
    expect(String(promoted?.state.fields["created_at"])).toStartWith(dateOf(3));
  });

  test("a gap stops the pass at its window with nothing planned, and the next pass admits it again", () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(0));
    // A body larger than a line is a blob; without the blob the shard reads incomplete.
    bigCapture(fx, "big", 1);
    const restore = hideBlobs(fx);
    const stopped = dream(fx.vault, { now: end(2) });
    expect(stopped.warnings.map((w) => w.code)).toContain("dream-replay-gap");
    expect(admissions(fx)).toHaveLength(1);
    expect(admissions(fx)[0]!.gaps).not.toHaveLength(0);
    expect(fx.replayState().lastCovered).toBe(dateOf(0));
    expect(fx.replayRecords().some((r) => r.kind === "dream-window-plan")).toBe(false);
    restore();
    dream(fx.vault, { now: end(2) });
    const again = admissions(fx);
    expect(again.map((a) => a.day)).toEqual([dateOf(1), dateOf(1), dateOf(2)]);
    expect(again[1]!.gaps).toEqual([]);
    expect(again[1]!.late).toEqual([]);
    expect(fx.replayState().lastCovered).toBe(dateOf(2));
  });

  test("a gap that lasts three days is left out, reported, and its records come in late", () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(0));
    bigCapture(fx, "stuck", 1);
    const restore = hideBlobs(fx);
    dream(fx.vault, { now: end(1) });
    expect(admissions(fx)[0]!.gaps).not.toHaveLength(0);
    // Three days of passes later the window goes on without the shard.
    dream(fx.vault, { now: new Date(end(1).getTime() + 3 * 86_400_000) });
    const leftOut = admissions(fx).find((a) => a.left_out.length > 0);
    expect(leftOut?.day).toBe(dateOf(1));
    expect(fx.replayState().lastCovered).toBe(dateOf(4));
    restore();
    dream(fx.vault, { now: end(5) });
    const last = admissions(fx).at(-1)!;
    expect(last.day).toBe(dateOf(5));
    expect(last.late.length).toBeGreaterThan(0);
  });

  test("a gap on a shard never read is kept when the shard goes, until three days leave it out", () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(0));
    bigCapture(fx, "gone", 1);
    hideBlobs(fx);
    dream(fx.vault, { now: end(1) });
    const [gap] = admissions(fx)[0]!.gaps;
    expect(gap).toBeDefined();
    expect(admissions(fx)[0]!.positions.some((p) => p.shard === gap!.shard)).toBe(false);
    // The shard goes before any admission read it: no position names it.
    rmSync(join(fx.storeRoot, gap!.partition, gap!.shard));
    const stopped = dream(fx.vault, { now: end(2) });
    expect(stopped.warnings.map((w) => w.code)).toContain("dream-replay-gap");
    const again = admissions(fx).at(-1)!;
    expect(again.day).toBe(dateOf(1));
    expect(again.gaps.map((g) => [g.shard, g.since])).toEqual([[gap!.shard, gap!.since]]);
    expect(fx.replayState().lastCovered).toBe(dateOf(0));
    // Three days after it was first seen incomplete it is left out and reported.
    dream(fx.vault, { now: new Date(end(1).getTime() + 3 * 86_400_000) });
    const leftOut = admissions(fx).find((a) => a.left_out.length > 0);
    expect(leftOut?.day).toBe(dateOf(1));
    expect(leftOut!.left_out.map((l) => [l.shard, l.since])).toEqual([[gap!.shard, gap!.since]]);
    expect(fx.replayState().lastCovered).toBe(dateOf(4));
  });

  test("a rewritten shard is rebased: covered records are taken as seen and counted", () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(0));
    capture(fx.vault, "seen", "tabs", 0);
    capture(fx.vault, "also", "lint", 0);
    dream(fx.vault, { now: end(1) });
    // Rewrite the events shard under its name: same records, another order
    // of bytes before the recorded offset.
    const dir = join(fx.storeRoot, "shared", "events", "dev-a");
    const shard = join(dir, readdirSync(dir)[0]!);
    const lines = readFileSync(shard, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    writeFileSync(shard, `${[...lines].toReversed().join("\n")}\n`);
    dream(fx.vault, { now: end(2) });
    const last = admissions(fx).at(-1)!;
    expect(last.rebased).not.toBeNull();
    expect(last.rebased!.seen).toBeGreaterThan(0);
    expect(last.late).toEqual([]);
  });
});

describe("dream replay: a clock behind the windows", () => {
  test("a clock earlier than the last covered day evaluates nothing and says why", () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(5));
    capture(fx.vault, "early", "tabs", 2);
    const back = dream(fx.vault, { now: end(3) });
    expect(back.warnings.map((w) => w.code)).toContain("dream-replay-clock-behind");
    expect(admissions(fx)).toEqual([]);
    expect(fx.replayState().lastCovered).toBe(dateOf(5));
  });

  test("a clock earlier than the open window leaves it open and admits no earlier day", () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(5));
    capture(fx.vault, "open", "tabs", 6);
    let calls = 0;
    const safeguard: Safeguard = {
      operation: "dream",
      timeoutMs: null,
      checkpoint() {
        calls += 1;
        if (calls > 2) throw new Error("stopped inside the window");
      },
    };
    expect(() => dream(fx!.vault, { now: end(6), safeguard })).toThrow("stopped inside the window");
    expect(fx.replayState().open?.body.day).toBe(dateOf(6));
    const back = dream(fx.vault, { now: end(4) });
    expect(back.warnings.map((w) => w.code)).toContain("dream-replay-clock-behind");
    expect(admissions(fx).map((a) => a.day)).toEqual([dateOf(6)]);
    expect(fx.replayState().open?.body.day).toBe(dateOf(6));
    expect(fx.replayState().lastCovered).toBe(dateOf(5));
  });
});

describe("dream replay: the inputs of a window", () => {
  test("captures and applications are judged by time below the boundary; state is read as it is", () => {
    fx = makeDreamReplayFixture();
    writePreference(fx.vault, {
      slug: "rule",
      topic: "rule-topic",
      principle: "Keep the rule.",
      created_at: at(0, 0),
      unconfirmed_until: at(14, 0),
      status: "confirmed",
      confirmed_at: at(0, 0),
      evidenced_by: [],
      scope: "coding",
    });
    for (const day of [1, 3]) {
      appendApplyEvidence(
        fx.vault,
        {
          pref_id: "pref-rule",
          artifact: `Daily/${dateOf(day)}.md`,
          result: "applied",
          agent: "c",
        },
        { now: new Date(at(day, 10)) },
      );
    }
    capture(fx.vault, "early", "tabs", 1);
    capture(fx.vault, "later", "tabs", 3);
    dream(fx.vault, { now: end(0) });
    const boundary = admissions(fx).at(-1)!.positions;
    // A person's edit beyond the boundary.
    writePreference(
      fx.vault,
      {
        slug: "rule",
        topic: "rule-topic",
        principle: "Keep the rule, edited.",
        created_at: at(0, 0),
        unconfirmed_until: at(14, 0),
        status: "confirmed",
        confirmed_at: at(0, 0),
        evidenced_by: [],
        scope: "coding",
      },
      { overwrite: true },
    );
    capture(fx.vault, "beyond", "tabs", 1);
    const view = { token: "t", boundary, instant: end(2), effective: new Map<string, string>() };
    withStoreReadView(view, () => {
      const entities = readStoreEntities()!;
      const rule = entities.preferences.get("pref-rule")!;
      expect(rule.state.counters.applied_count).toBe(1);
      expect(rule.state.fields["principle"]).toBe("Keep the rule, edited.");
      const signals = [...entities.signals.keys()];
      expect(signals.some((id) => id.includes("-early-"))).toBe(true);
      expect(signals.some((id) => id.includes("-later-"))).toBe(false);
      expect(signals.some((id) => id.includes("-beyond-"))).toBe(false);
      const log = readStoreLogEvents(
        { from: "0000-01-01", to: "9999-12-31" },
        { vault: fx!.vault },
      );
      const applications = (log ?? []).filter((e) => e.entry.eventType === "apply-evidence");
      expect(applications.map((e) => e.entry.timestamp)).toEqual([at(1, 10)]);
    });
    // Outside the view every record is read.
    expect(readStoreEntities()!.preferences.get("pref-rule")!.state.counters.applied_count).toBe(2);
    expect(partitionRecords(fx.storeRoot, "shared").length).toBeGreaterThan(0);
  });

  test("an unchanged repeat of the last covered day keeps the positions it read past", () => {
    const f = makeDreamReplayFixture();
    fx = f;
    f.cover(dateOf(2));
    dream(f.vault, { now: new Date(`${dateOf(3)}T12:00:00.000Z`) });
    // A lone signal of the same day changes nothing when the day is evaluated again.
    capture(f.vault, "lone", "lone-topic", 3, { hour: 13 });
    const repeat = dream(f.vault, { now: new Date(`${dateOf(3)}T18:00:00.000Z`) });
    expect(repeat.changed).toBe(false);
    expect(f.replayState().lastCovered).toBe(dateOf(3));
    // The next day reads it as already admitted, not as late.
    dream(f.vault, { now: new Date(`${dateOf(4)}T12:00:00.000Z`) });
    const day4 = admissions(f).filter((a) => a.day === dateOf(4));
    expect(day4).toHaveLength(1);
    expect(day4[0]!.late).toEqual([]);
  });
});
