/**
 * The first replay on a brain that predates it (dream replay task 6.1;
 * spec "An existing brain starts from its retained history", "A brain
 * that is not on the store is never reported as covered").
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dream } from "../../../../src/core/brain/dream.ts";
import { BOOTSTRAP_PAGE_SIZE } from "../../../../src/core/brain/dream-replay/bootstrap.ts";
import { appendLogEvent } from "../../../../src/core/brain/log.ts";
import type { Safeguard } from "../../../../src/core/brain/safeguard.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { partitionDir } from "../../../../src/core/store/store-paths.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import {
  makeDreamReplayFixture,
  type DreamReplayFixture,
} from "../../../helpers/dream-replay-fixtures.ts";
import { at, auditEvents, dateOf } from "../../../helpers/dream-replay-scenarios.ts";
import { dumpStore } from "../../../helpers/dream-history.ts";

let fx: DreamReplayFixture | null = null;
let legacy: StoreEnv | null = null;
afterEach(() => {
  fx?.cleanup();
  fx = null;
  legacy?.cleanup();
  legacy = null;
});

function end(day: number): Date {
  return new Date(`${dateOf(day)}T23:59:59.999Z`);
}

function capture(vault: string, slug: string, topic: string, day: number, agent = "claude") {
  writeSignal(vault, {
    topic,
    signal: "positive",
    agent,
    principle: `Follow the rule of ${topic}.`,
    created_at: at(day, 9),
    date: dateOf(day),
    slug,
    scope: "coding",
  });
}

function admittedDays(f: DreamReplayFixture): string[] {
  return f
    .replayRecords()
    .filter((r) => r.kind === "dream-admission")
    .map((r) => String(r.body["day"]));
}

function bootstraps(f: DreamReplayFixture): Array<Record<string, unknown>> {
  return f
    .replayRecords()
    .filter((r) => r.kind === "dream-bootstrap")
    .map((r) => r.body as Record<string, unknown>);
}

/** A raw signal capture in a given state, as a migrated history holds it. */
function storedSignal(f: DreamReplayFixture, stem: string, topic: string, day: number): string {
  const id = `sig-${dateOf(day)}-${stem}-0b0b0b`;
  f.append(
    "signal",
    {
      id,
      path: `Brain/inbox/${id}.md`,
      frontmatter: {
        kind: "brain-signal",
        id,
        created_at: at(day, 9),
        topic,
        signal: "positive",
        agent: "claude",
        principle: `Follow the rule of ${topic}.`,
        scope: "coding",
        tags: ["brain", "brain/signal"],
      },
      raw: null,
      staged: false,
    },
    "events",
  );
  return id;
}

describe("dream replay: the first replay on an existing brain", () => {
  test("a backlog in the inbox is replayed from its oldest signal, archiving nothing early", () => {
    fx = makeDreamReplayFixture();
    capture(fx.vault, "b1", "tabs", 0);
    capture(fx.vault, "b2", "tabs", 0, "codex");
    capture(fx.vault, "b3", "tabs", 0, "hermes");
    capture(fx.vault, "lonely", "lint", 5);
    dream(fx.vault, { now: end(40) });
    const days = admittedDays(fx);
    expect(days[0]).toBe(dateOf(0));
    expect(days.at(-1)).toBe(dateOf(40));
    expect(days).toHaveLength(41);
    const archivedIn = auditEvents(dumpStore(fx.storeRoot), "dream")
      .filter((body) => JSON.stringify(body["archived_signals"] ?? []).includes("-lonely-"))
      .map((body) => body["window"]);
    expect(archivedIn).toEqual([dateOf(19)]);
  });

  test("an empty inbox starts at the day after the last pass that changed something", () => {
    fx = makeDreamReplayFixture();
    appendLogEvent(fx.vault, {
      timestamp: at(3, 12),
      eventType: "dream",
      body: { run_id: "dream-earlier" },
    });
    dream(fx.vault, { now: end(6) });
    expect(admittedDays(fx)).toEqual([dateOf(4), dateOf(5), dateOf(6)]);
  });

  test("a brain that never ran a pass starts today", () => {
    fx = makeDreamReplayFixture();
    dream(fx.vault, { now: end(6) });
    expect(admittedDays(fx)).toEqual([dateOf(6)]);
    expect(bootstraps(fx).at(-1)?.["start"]).toBe(dateOf(6));
  });

  test("an interrupted inventory continues from the page it reached", () => {
    fx = makeDreamReplayFixture();
    const total = BOOTSTRAP_PAGE_SIZE * 2 + 7;
    for (let i = 0; i < total; i++) storedSignal(fx, `n${String(i).padStart(4, "0")}`, `t${i}`, 2);
    // Stop at the checkpoint before the second page.
    let pages = 0;
    const guard: Safeguard = {
      operation: "dream",
      timeoutMs: null,
      checkpoint() {
        if (bootstraps(fx!).length === 1 && ++pages === 1)
          throw new Error("stopped in the inventory");
      },
    };
    expect(() => dream(fx!.vault, { now: end(3), safeguard: guard })).toThrow(
      "stopped in the inventory",
    );
    expect(bootstraps(fx)).toHaveLength(1);
    expect(bootstraps(fx)[0]!["done"]).toBe(false);
    dream(fx.vault, { now: end(3) });
    const written = bootstraps(fx);
    expect(written.map((b) => b["done"])).toEqual([false, false, true]);
    expect((written.at(-1)!["counts"] as Record<string, unknown>)["signals_seen"]).toBe(total);
    expect(written.at(-1)!["start"]).toBe(dateOf(2));
  });

  test("archived signals that may have missed a promotion are counted once, not reopened", () => {
    fx = makeDreamReplayFixture();
    for (const stem of ["x1", "x2", "x3"]) {
      const id = storedSignal(fx, stem, "lost", 1);
      fx.append("signal-state", { authority: "agent", signal: id, state: "archived" }, "events");
    }
    dream(fx.vault, { now: end(20) });
    expect(bootstraps(fx).at(-1)?.["unrecoverable"]).toBe(3);
    const first = auditEvents(dumpStore(fx.storeRoot), "dream").find(
      (body) => body["unrecoverable_archived"] !== undefined,
    );
    expect(first?.["unrecoverable_archived"]).toBe("3");
    expect(
      auditEvents(dumpStore(fx.storeRoot), "dream").filter(
        (body) => body["unrecoverable_archived"] !== undefined,
      ),
    ).toHaveLength(1);
  });

  test("the first live pass after the switch is the inventory; a legacy pass is never covered", () => {
    legacy = makeStoreEnv("osb-dream-replay-legacy-");
    capture(legacy.vault, "l1", "tabs", 0);
    const before = dream(legacy.vault, { now: end(2) });
    expect(before.windows).toBeUndefined();
    legacy.cleanup();
    legacy = null;
    fx = makeDreamReplayFixture();
    capture(fx.vault, "s1", "tabs", 0);
    const after = dream(fx.vault, { now: end(2) });
    expect(bootstraps(fx).at(-1)?.["done"]).toBe(true);
    expect(after.windows?.covered).toBe(dateOf(2));
  });
});

describe("dream replay: an inventory over an incomplete read", () => {
  test("a signal the read cannot see yet does not move the start: the inventory waits", () => {
    fx = makeDreamReplayFixture();
    capture(fx.vault, "old", "tabs", 1);
    capture(fx.vault, "new", "spaces", 4);
    // The signal's line of the events shard does not parse (a torn sync,
    // a bad disk block): the read is incomplete and the signal is hidden.
    const dir = join(partitionDir(fx.storeRoot, "shared"), "events", "dev-a");
    const shard = join(dir, readdirSync(dir)[0]!);
    const original = readFileSync(shard, "utf8");
    writeFileSync(shard, original.replace('"kind":"signal"', '"kind":"signal"#'));
    const stopped = dream(fx.vault, { now: end(5) });
    expect(bootstraps(fx)).toEqual([]);
    expect(admittedDays(fx)).toEqual([]);
    expect(stopped.warnings.map((w) => w.code)).toContain("dream-replay-gap");
    // Once it reads, the inventory runs and starts at the oldest signal.
    writeFileSync(shard, original);
    dream(fx.vault, { now: end(5) });
    expect(bootstraps(fx).at(-1)?.["start"]).toBe(dateOf(1));
  });
});
