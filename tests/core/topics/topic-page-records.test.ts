/**
 * A topic the planner made shows what it is made of. Its notes, signals
 * and decisions are routine by design (spec "Log entries are earned",
 * design D10 `event_kind`: without a kind the agent passed or a model
 * verdict a record is routine), so they are not items of the page; the
 * page and `show` say how many records the topic holds and how to list
 * them, and `show` with `held` lists each with its kind and text. The
 * plain summary of `o2b brain dream` carries the topics line.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { answerClosedQuestions, dreamAnswered } from "../../helpers/closed-answers.ts";
import { writeVaultPointer } from "../../../src/core/brain/portability/pointer.ts";
import { STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import { runTopicAction } from "../../../src/core/topics/actions.ts";
import { removeStoreSignal } from "../../../src/core/brain/signal-state.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { withPrivateWithheld } from "../../../src/core/store/caller-reach.ts";
import { chmodSync, readdirSync, rmSync } from "node:fs";
import { openStore } from "../../../src/core/store/store-open.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import { runCli } from "../../helpers/run-cli.ts";
import type { Fleet, Machine } from "../store-migration/fixtures/fleet.ts";
import { callTool, serverIn, switchedMachine } from "./fixtures/record-project.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const SUBJECT = "Release notes list every migration step";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

/** A switched machine with five related notes of two sessions in a linked project. */
async function machineWithRecords(): Promise<Machine> {
  const made = switchedMachine();
  fleet = made.fleet;
  const a = made.machine;
  const dir = join(fleet.parent, "work", "release-tool");
  mkdirSync(dir, { recursive: true });
  writeVaultPointer(dir, a.vault);
  const one = serverIn(a, dir);
  const two = serverIn(a, dir);
  await Promise.all(
    [0, 1, 2, 3, 4].map((i) =>
      callTool(i < 3 ? one : two, "brain_note", {
        text: `${SUBJECT} ${i}`,
        agent: i < 3 ? "agent-one" : "agent-two",
      }),
    ),
  );
  return a;
}

test("the page and show of a planned topic say how many records it holds and list them on request", async () => {
  const a = await machineWithRecords();
  const report = dreamAnswered(a.vault, a.store()).topics?.report;
  expect(report?.status).toBe("planned");
  if (report?.status !== "planned") return;
  expect(report.created).toHaveLength(1);
  const topic = report.created[0]!.topic;

  const shown = runTopicAction({ action: "show", topic });
  const detail = shown["topic"] as Record<string, unknown>;
  expect(detail["held_records"]).toBe(5);
  const page = String(shown["page"]);
  expect(page).toContain("5 record(s)");
  expect(page).toContain(`o2b topic show ${topic} --held`);

  const listed = runTopicAction({ action: "show", topic, held: true });
  const records = listed["records"] as Array<Record<string, unknown>>;
  expect(records).toHaveLength(5);
  expect(records.every((r) => r["kind"] === "note")).toBe(true);
  expect(records.map((r) => r["text"]).toSorted()).toEqual(
    [0, 1, 2, 3, 4].map((i) => `${SUBJECT} ${i}`),
  );
  expect(records.every((r) => r["project"] === "release-tool")).toBe(true);
});

test("brain_topic show lists the held records when asked", async () => {
  const a = await machineWithRecords();
  const report = dreamAnswered(a.vault, a.store()).topics?.report;
  if (report?.status !== "planned") throw new Error("not planned");
  const topic = report.created[0]!.topic;
  const result = (await callTool(serverIn(a, fleet!.parent), "brain_topic", {
    action: "show",
    topic,
    held: true,
  })) as { structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> };
  const out =
    result.structuredContent ??
    (JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>);
  expect((out["records"] as unknown[]).length).toBe(5);
});

test("the plain summary of o2b brain dream carries the topics line", async () => {
  const a = await machineWithRecords();
  const env: Record<string, string> = {};
  for (const key of [
    STORE_ROOT_ENV,
    "O2B_DEVICE_ID",
    "HOME",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "OPEN_SECOND_BRAIN_CONFIG",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // The model's answers, as a live pass's front door would have them.
  answerClosedQuestions(a.store());
  const run = await runCli(["brain", "dream", "--vault", a.vault], { env });
  expect(run.returncode, run.stderr).toBe(0);
  expect(run.stdout).toMatch(/^topics: 1 topic\(s\) created, 0 record\(s\) routed/m);
});

test("the held listing never shows a signal the product forgot", async () => {
  const made = switchedMachine();
  fleet = made.fleet;
  const a = made.machine;
  const dir = join(fleet.parent, "work", "release-tool");
  mkdirSync(dir, { recursive: true });
  writeVaultPointer(dir, a.vault);
  const one = serverIn(a, dir);
  const two = serverIn(a, dir);
  await Promise.all([
    ...[0, 1, 2].map((i) =>
      callTool(one, "brain_note", { text: `${SUBJECT} ${i}`, agent: "agent-one" }),
    ),
    ...["removed", "rejected"].map((tag) =>
      callTool(two, "brain_feedback", {
        topic: `release-notes-${tag}`,
        signal: "positive",
        principle: `${SUBJECT} ${tag}`,
        agent: "agent-two",
      }),
    ),
  ]);
  const report = dreamAnswered(a.vault, a.store()).topics?.report;
  if (report?.status !== "planned") throw new Error("not planned");
  expect(report.created[0]!.members).toBe(5);
  const topic = report.created[0]!.topic;
  const signalId = (tag: string): string =>
    String(
      a
        .records()
        .find(
          (r) =>
            r.kind === "signal" &&
            (r.body["frontmatter"] as Record<string, unknown>)["principle"] === `${SUBJECT} ${tag}`,
        )!.body["id"],
    );
  expect(removeStoreSignal(a.vault, signalId("removed"))).toBe(true);
  appendRecord(a.store(), {
    partition: "shared",
    stream: "events",
    kind: "signal-state",
    agent: "t",
    body: { authority: "human", signal: signalId("rejected"), state: "rejected" },
  });

  const listed = runTopicAction({ action: "show", topic, held: true });
  const texts = (listed["records"] as Array<Record<string, unknown>>).map((r) => r["text"]);
  expect(texts.toSorted()).toEqual([0, 1, 2].map((i) => `${SUBJECT} ${i}`));
  expect(listed["records_missing"]).toBeUndefined();
});

// Root and Windows read through any mode bits: no denial to test there.
test.skipIf(CHMOD_CANNOT_DENY)(
  "below local reach the held listing names no shard it could not read, only how many",
  async () => {
    const a = await machineWithRecords();
    const report = dreamAnswered(a.vault, a.store()).topics?.report;
    if (report?.status !== "planned") throw new Error("not planned");
    const topic = report.created[0]!.topic;
    // One log shard this machine cannot open.
    const logDir = join(a.storeRoot, "shared", "log");
    const device = readdirSync(logDir)[0]!;
    const shard = join(logDir, device, readdirSync(join(logDir, device))[0]!);
    chmodSync(shard, 0o000);
    try {
      const local = runTopicAction({ action: "show", topic, held: true });
      expect((local["records_unreadable"] as string[]).length).toBe(1);
      const remote = withPrivateWithheld(true, () =>
        runTopicAction({ action: "show", topic, held: true }),
      );
      expect(remote["records_unreadable"]).toBeUndefined();
      expect(remote["records_unreadable_count"]).toBe(1);
      expect(JSON.stringify(remote)).not.toContain(device);
    } finally {
      chmodSync(shard, 0o644);
    }
  },
);

/**
 * A planned topic of three notes and two signals ("kept", "other"), and
 * the store id of the "other" signal.
 */
async function topicWithSignals(): Promise<{
  a: Machine;
  topic: string;
  signal: (tag: string) => string;
}> {
  const made = switchedMachine();
  fleet = made.fleet;
  const a = made.machine;
  const dir = join(fleet.parent, "work", "release-tool");
  mkdirSync(dir, { recursive: true });
  writeVaultPointer(dir, a.vault);
  const one = serverIn(a, dir);
  const two = serverIn(a, dir);
  await Promise.all([
    ...[0, 1, 2].map((i) =>
      callTool(one, "brain_note", { text: `${SUBJECT} ${i}`, agent: "agent-one" }),
    ),
    ...["kept", "other"].map((tag) =>
      callTool(two, "brain_feedback", {
        topic: `release-notes-${tag}`,
        signal: "positive",
        principle: `${SUBJECT} ${tag}`,
        agent: "agent-two",
      }),
    ),
  ]);
  const report = dreamAnswered(a.vault, a.store()).topics?.report;
  if (report?.status !== "planned") throw new Error("not planned");
  expect(report.created[0]!.members).toBe(5);
  const signal = (tag: string): string =>
    String(
      a
        .records()
        .find(
          (r) =>
            r.kind === "signal" &&
            (r.body["frontmatter"] as Record<string, unknown>)["principle"] === `${SUBJECT} ${tag}`,
        )!.body["id"],
    );
  return { a, topic: report.created[0]!.topic, signal };
}

type Listed = Array<Record<string, unknown>>;

/** Whether the listing shows `text` (below local reach it is fenced as stored text). */
function shows(answer: Record<string, unknown>, text: string): boolean {
  return (answer["records"] as Listed).some(
    (r) =>
      typeof r["text"] === "string" && (r["text"] === text || r["text"].includes(`\n${text}\n`)),
  );
}

/** The held listing at local reach and below it. */
function bothReaches(topic: string): {
  local: Record<string, unknown>;
  remote: Record<string, unknown>;
} {
  return {
    local: runTopicAction({ action: "show", topic, held: true }),
    remote: withPrivateWithheld(true, () => runTopicAction({ action: "show", topic, held: true })),
  };
}

function signalEntry(
  answer: Record<string, unknown>,
  tag: string,
): Record<string, unknown> | undefined {
  return (answer["records"] as Listed).find(
    (r) => r["kind"] === "signal" && (r["text"] === undefined || String(r["text"]).endsWith(tag)),
  );
}

/** A removal of signal `id` written by another device, in its own events shard. */
function removalFromAnotherDevice(a: Machine, id: string): string {
  const other = openStore({ root: a.storeRoot, device: "dev-z" });
  appendRecord(other, {
    partition: "shared",
    stream: "events",
    kind: "signal-removed",
    agent: "t",
    body: { authority: "human", signal: id },
  });
  const dir = join(a.storeRoot, "shared", "events", "dev-z");
  return join(dir, readdirSync(dir)[0]!);
}

test("a complete read lists the signals nobody removed, with their text, at both reaches", async () => {
  const { topic } = await topicWithSignals();
  for (const answer of Object.values(bothReaches(topic))) {
    expect(shows(answer, `${SUBJECT} kept`)).toBe(true);
    expect(shows(answer, `${SUBJECT} other`)).toBe(true);
    expect(answer["records_withheld"]).toBeUndefined();
  }
});

test.skipIf(CHMOD_CANNOT_DENY)(
  "a signal whose removal sits in an unreadable events shard is withheld, at both reaches",
  async () => {
    const { a, topic, signal } = await topicWithSignals();
    const shard = removalFromAnotherDevice(a, signal("other"));
    chmodSync(shard, 0o000);
    try {
      for (const answer of Object.values(bothReaches(topic))) {
        expect(shows(answer, `${SUBJECT} other`)).toBe(false);
        expect(shows(answer, `${SUBJECT} kept`)).toBe(false);
        const withheld = (answer["records"] as Listed).filter((r) => r["withheld"] !== undefined);
        expect(withheld.map((r) => r["withheld"])).toEqual(["incomplete-read", "incomplete-read"]);
        expect(answer["records_withheld"]).toEqual([
          expect.objectContaining({ reason: "incomplete-read", count: 2 }),
        ]);
      }
    } finally {
      chmodSync(shard, 0o644);
    }
  },
);

test("a signal whose removal shard vanished after this machine read it is withheld, at both reaches", async () => {
  const { a, topic, signal } = await topicWithSignals();
  const shard = removalFromAnotherDevice(a, signal("other"));
  // Read once: the removal shard is seen, and the signal is forgotten.
  const before = bothReaches(topic);
  expect(signalEntry(before.local, "other")).toBeUndefined();
  rmSync(shard);
  for (const answer of Object.values(bothReaches(topic))) {
    expect(shows(answer, `${SUBJECT} other`)).toBe(false);
    expect((answer["records_withheld"] as Listed)[0]).toEqual(
      expect.objectContaining({ reason: "incomplete-read" }),
    );
  }
});

test("a signal made private later is listed at local reach and withheld below it", async () => {
  const { a, topic, signal } = await topicWithSignals();
  appendRecord(a.store(), {
    partition: "private",
    stream: "events",
    kind: "signal-state",
    agent: "t",
    body: { authority: "human", signal: signal("other"), fields: { note: "kept here" } },
  });
  const { local, remote } = bothReaches(topic);
  const mine = (local["records"] as Listed).find((r) => r["text"] === `${SUBJECT} other`);
  expect(mine?.["private"]).toBe(true);
  expect(shows(remote, `${SUBJECT} other`)).toBe(false);
  expect(shows(remote, `${SUBJECT} kept`)).toBe(true);
  expect(remote["records_withheld"]).toEqual([
    expect.objectContaining({ reason: "private", count: 1 }),
  ]);
});

test.skipIf(CHMOD_CANNOT_DENY)(
  "the plain o2b topic show --held warns about a shard it could not read, and a complete listing does not",
  async () => {
    const a = await machineWithRecords();
    const report = dreamAnswered(a.vault, a.store()).topics?.report;
    if (report?.status !== "planned") throw new Error("not planned");
    const topic = report.created[0]!.topic;
    const env: Record<string, string> = {};
    for (const key of [
      STORE_ROOT_ENV,
      "O2B_DEVICE_ID",
      "HOME",
      "XDG_STATE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "OPEN_SECOND_BRAIN_CONFIG",
    ]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    const complete = await runCli(["topic", "show", topic, "--held"], { env });
    expect(complete.returncode, complete.stderr).toBe(0);
    expect(complete.stdout).not.toContain("could not be read");
    const logDir = join(a.storeRoot, "shared", "log");
    const device = readdirSync(logDir)[0]!;
    const shard = join(logDir, device, readdirSync(join(logDir, device))[0]!);
    chmodSync(shard, 0o000);
    try {
      const run = await runCli(["topic", "show", topic, "--held"], { env });
      expect(run.returncode, run.stderr).toBe(0);
      expect(run.stdout).toMatch(
        /^warning: 1 store shard\(s\) could not be read in full \(shared\/log\//m,
      );
      expect(run.stdout).toContain("o2b brain doctor");
    } finally {
      chmodSync(shard, 0o644);
    }
  },
);

test("assign refuses a signal while a shard that may hold its removal cannot be read", async () => {
  const { a, topic: grouped, signal } = await topicWithSignals();
  const topic = String(runTopicAction({ action: "create", title: "By hand" })["topic"]);
  const capture = (tag: string): string =>
    a.records().find((r) => r.kind === "signal" && r.body["id"] === signal(tag))!.id;
  const shard = removalFromAnotherDevice(a, signal("other"));
  // Read once, so the removal shard is seen; then it is gone.
  expect(signalEntry(bothReaches(grouped).local, "other")).toBeUndefined();
  rmSync(shard);
  expect(() => runTopicAction({ action: "assign", topic, record: capture("other") })).toThrow(
    /could not be read, so whether it was removed or rejected cannot be told/,
  );
  // The held listing withholds every signal on such a read, so a live one is refused too.
  expect(() => runTopicAction({ action: "assign", topic, record: capture("kept") })).toThrow(
    /could not be read/,
  );
  expect(runTopicAction({ action: "show", topic, held: true })["records"]).toEqual([]);
});

test("assign refuses a signal capture whose id is not a non-empty string, and a record with no text the listing can show", async () => {
  const { a } = await topicWithSignals();
  const topic = String(runTopicAction({ action: "create", title: "By hand" })["topic"]);
  const append = (stream: "events" | "log", kind: string, body: Record<string, unknown>): string =>
    appendRecord(a.store(), { partition: "shared", stream, kind, agent: "t", body }).record.id;
  const numericId = append("events", "signal", {
    id: 42,
    frontmatter: { principle: `${SUBJECT} numeric` },
  });
  const emptyId = append("events", "signal", {
    id: "",
    frontmatter: { principle: `${SUBJECT} empty` },
  });
  const noText = append("events", "signal", { id: "sig-no-text", frontmatter: {} });
  const privateNote = append("log", "log-event", {
    event_type: "note",
    body: { text: "<private>only mine</private>" },
  });
  for (const id of [numericId, emptyId]) {
    expect(() => runTopicAction({ action: "assign", topic, record: id })).toThrow(
      /id is not a non-empty string/,
    );
  }
  for (const id of [noText, privateNote]) {
    expect(() => runTopicAction({ action: "assign", topic, record: id })).toThrow(
      /no text a topic can show/,
    );
  }
  const listed = runTopicAction({ action: "show", topic, held: true });
  expect(listed["records"]).toEqual([]);
  expect(listed["records_missing"]).toBeUndefined();
});
