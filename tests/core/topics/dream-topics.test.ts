/**
 * The dream pass runs topic planning before its render (task 3.4): on the
 * view writer the summary lists the topic it created with the command
 * that undoes it, and the render that follows writes the topic's page.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { withTopicPass } from "../../../src/core/brain/dream-tail.ts";
import { dreamQueueOn } from "../../../src/core/brain/dream-queue/queue.ts";
import { withModelWork } from "../../../src/core/brain/dream-queue/pass.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import * as appender from "../../../src/core/store/appender.ts";
import { appendRecord, appendRecords } from "../../../src/core/store/appender.ts";
import { STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import { answerClosedQuestions } from "../../helpers/closed-answers.ts";
import {
  PROGRESS_KIND,
  PROGRESS_REASON,
  type ProgressEvent,
} from "../../../src/core/brain/progress.ts";
import { SafeguardTimeoutError } from "../../../src/core/brain/safeguard.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import {
  AUTO_NOW,
  makeAutoViewEnv,
  makeLegacyDreamVault,
  seedWriterStore,
  type AutoViewEnv,
} from "../view/fixtures/auto-env.ts";

let env: AutoViewEnv;
let vault: string;
let store: StoreHandle;

beforeEach(() => {
  env = makeAutoViewEnv("o2b-topics-dream-");
  vault = makeLegacyDreamVault(env.parent);
  store = seedWriterStore(env.root);
});
afterEach(() => env.cleanup());

function seedCluster(on: StoreHandle): void {
  ["s1", "s1", "s2", "s2", "s2"].forEach((session, i) => {
    appendRecord(
      on,
      {
        partition: "shared",
        stream: "events",
        kind: "signal",
        agent: "agent-1",
        body: {
          id: `sig-2026-11-06-c${i}`,
          path: `Brain/inbox/c${i}.md`,
          staged: false,
          frontmatter: {
            principle: `Release notes list every migration step ${i}`,
            project: "o2b",
            session,
          },
          raw: null,
          raw_shape: "bare",
        },
      },
      { now: () => AUTO_NOW - 5_000 + i },
    );
  });
}

describe("topic planning in a dream pass", () => {
  test("the summary lists the created topic with its undo command, and the render writes its page", () => {
    seedCluster(store);
    // The first pass after the claim only waits, in planning and in the
    // render; the second plans, and its render writes the page.
    expect(dream(vault).topics?.report.status).toBe("waiting-for-claim");
    answerClosedQuestions(store);
    const first = dream(vault);
    const report = first.topics?.report;
    expect(report?.status).toBe("planned");
    if (report?.status !== "planned") return;
    expect(report.created.map((c) => [c.title, c.undo])).toEqual([
      ["Release notes list", `o2b topic undo ${report.created[0]!.record}`],
    ]);
    expect(first.topics?.summary).toContain("1 topic(s) created");
    expect(readdirSync(join(env.view, "topics"))).toHaveLength(1);
  });

  test("planning-applied answers count in model_work", () => {
    seedCluster(store);
    answerClosedQuestions(store);
    const stub = dream(vault, { dryRun: true });
    const pass = {
      queue: dreamQueueOn(store, { vault: null, writer: "test" }),
      produced: 0,
      applied: 0,
      abstained: 0,
      warnings: [],
    };
    const out = withTopicPass(stub, {}, undefined, pass);
    expect(withModelWork(out, pass).model_work?.applied).toBe(1);
  });

  test("the pass reports the change it made, and plans in the store its config names", () => {
    // The store is named by the config file only, not by the environment.
    delete process.env[STORE_ROOT_ENV];
    const config = join(env.parent, "config.yaml");
    writeFileSync(config, `store_root: ${env.root}\n`);
    seedCluster(store);
    expect(dream(vault, { configPath: config }).topics?.report.status).toBe("waiting-for-claim");
    answerClosedQuestions(store);
    const second = dream(vault, { configPath: config });
    expect(second.topics?.report.status).toBe("planned");
    expect(second.changed).toBe(true);
  });

  test("the progress stream reports the topic and view steps before it finishes", () => {
    seedCluster(store);
    dream(vault); // the claim's wait
    answerClosedQuestions(store);
    const events: ProgressEvent[] = [];
    dream(vault, { onProgress: (e) => events.push(e) });
    const started = events.filter((e) => e.kind === PROGRESS_KIND.started).map((e) => e.stage);
    // On a large store these two steps are most of the pass; a stream that
    // finished before them read as a pass that hung.
    expect(started.slice(-2)).toEqual(["topics", "view"]);
    expect(events.at(-1)?.kind).toBe(PROGRESS_KIND.finished);
  });

  test("a deadline that passes at the topic step ends the stream stopped, not finished", () => {
    seedCluster(store);
    dream(vault); // the claim's wait
    answerClosedQuestions(store);
    const events: ProgressEvent[] = [];
    let inTopics = false;
    const guard = {
      operation: "dream",
      timeoutMs: 1,
      checkpoint: () => {
        if (inTopics) throw new SafeguardTimeoutError("dream", 1);
      },
    };
    const out = dream(vault, {
      safeguard: guard,
      onProgress: (e) => {
        events.push(e);
        if (e.kind === PROGRESS_KIND.started && e.stage === "topics") inTopics = true;
      },
    });
    expect(out.topics).toBeUndefined();
    const last = events.at(-1);
    expect(last?.kind).toBe(PROGRESS_KIND.stopped);
    expect(last?.stage).toBe("topics");
    expect(last?.reason).toBe(PROGRESS_REASON.timedOut);
    expect(events.some((e) => e.kind === PROGRESS_KIND.finished)).toBe(false);
  });

  test("a failed batch of assignments keeps the earlier batches in the report", () => {
    // Two themes of eight records, each with words of its own (a word
    // every record says joins nothing): each topic's assigns are one
    // batch, and the second topic's batch fails.
    const n = 16;
    appendRecords(
      store,
      Array.from({ length: n }, (_, i) => ({
        partition: "shared" as const,
        stream: "events" as const,
        kind: "signal",
        agent: "agent-1",
        body: {
          id: `sig-2026-11-06-b${i}`,
          path: `Brain/inbox/b${i}.md`,
          staged: false,
          frontmatter: {
            principle: `Notes alpha${i >> 3} bravo${i >> 3} delta${i >> 3}`,
            project: "o2b",
            session: i % 2 === 0 ? "s1" : "s2",
          },
          raw: null,
          raw_shape: "bare",
        },
      })),
      { now: () => AUTO_NOW - 5_000 },
    );
    dream(vault); // the claim's wait
    answerClosedQuestions(store);
    let assignBatches = 0;
    const real = appender.appendRecords;
    const spy = spyOn(appender, "appendRecords").mockImplementation((s, inputs, opts) => {
      if (inputs.some((input) => input.kind === "assign")) {
        assignBatches += 1;
        if (assignBatches === 2) throw new Error("disk full");
      }
      return real(s, inputs, opts);
    });
    let report;
    try {
      report = dream(vault).topics?.report;
    } finally {
      spy.mockRestore();
    }
    expect(report?.status).toBe("error");
    if (report?.status !== "error") return;
    // Before: 0, as if none of the first batch's assigns had landed.
    expect(report.created.reduce((sum, t) => sum + t.members, 0)).toBe(8);
  });

  test("a pass whose deadline has passed plans no topic", () => {
    seedCluster(store);
    dream(vault); // the claim's wait
    answerClosedQuestions(store);
    const stub = dream(vault, { dryRun: true });
    const expired = {
      operation: "dream",
      timeoutMs: 1,
      checkpoint: () => {
        throw new Error("deadline passed");
      },
    };
    const out = withTopicPass(stub, { safeguard: expired });
    expect(out.topics).toBeUndefined();
    const records = readPartition(join(env.root, "shared")).flatMap((s) => s.records);
    expect(records.some((r) => r.kind === "topic-create")).toBe(false);
  });

  test("a pass whose deadline passes while it waits for the planning lock writes no topic", () => {
    seedCluster(store);
    dream(vault); // the claim's wait
    answerClosedQuestions(store);
    const stub = dream(vault, { dryRun: true });
    let asked = 0;
    const expiring = {
      operation: "dream",
      timeoutMs: 1,
      // In time before the lock, past the deadline under it.
      checkpoint: () => {
        asked += 1;
        if (asked > 1) throw new Error("deadline passed");
      },
    };
    const out = withTopicPass(stub, { safeguard: expiring });
    expect(asked).toBe(2);
    expect(out.topics?.report.status).toBe("deferred");
    expect(out.changed).toBe(stub.changed);
    const records = readPartition(join(env.root, "shared")).flatMap((s) => s.records);
    expect(records.some((r) => r.kind === "topic-create")).toBe(false);
  });

  test("a pass that writes only a model verdict reports the change", () => {
    appendRecord(
      store,
      {
        partition: "shared",
        stream: "log",
        kind: "log-event",
        agent: "seed",
        body: {
          timestamp: new Date(AUTO_NOW - 5_000).toISOString(),
          event_type: "note",
          body: { text: "Compaction shipped this week" },
        },
      },
      { now: () => AUTO_NOW - 5_000 },
    );
    dream(vault); // the claim's wait
    // The model answered the note's readability question: keep it.
    const answered = answerClosedQuestions(store, (item) =>
      item.operation === "human-readable" ? { p: 0.9 } : null,
    );
    const stub = dream(vault, { dryRun: true });
    expect(stub.changed).not.toBe(true);
    // A kept note's verdict is a write of its own: the note is settled.
    const out = withTopicPass(stub, {});
    expect(out.topics?.report.status).toBe("planned");
    const records = readPartition(join(env.root, "shared")).flatMap((s) => s.records);
    // One verdict per note answered (the fixture's store holds notes of its own).
    expect(answered).toBeGreaterThan(0);
    expect(records.filter((r) => r.kind === "history-verdict")).toHaveLength(answered);
    expect(out.changed).toBe(true);
  });

  test("the pass plans on the run's own clock: a topic quiet by that date is offered", () => {
    seedCluster(store);
    dream(vault); // the claim's wait
    answerClosedQuestions(store);
    const first = dream(vault).topics?.report;
    if (first?.status !== "planned") throw new Error(String(first?.status));
    const topic = first.created[0]!.topic;
    const later = new Date(Date.now() + 40 * 86_400_000);
    const out = withTopicPass(dream(vault, { dryRun: true }), { now: later });
    const report = out.topics?.report;
    if (report?.status !== "planned") throw new Error(String(report?.status));
    expect(report.quiet.map((q) => q.topic)).toEqual([topic]);
  });

  test("every undo command names the config the pass ran with", () => {
    delete process.env[STORE_ROOT_ENV];
    const config = join(env.parent, "my config.yaml");
    writeFileSync(config, `store_root: ${env.root}\n`);
    seedCluster(store);
    dream(vault, { configPath: config }); // the claim's wait
    answerClosedQuestions(store);
    const report = dream(vault, { configPath: config }).topics?.report;
    if (report?.status !== "planned") throw new Error(String(report?.status));
    expect(report.created.map((c) => c.undo)).toEqual([
      `o2b topic undo ${report.created[0]!.record} --config '${config}'`,
    ]);
  });
});
