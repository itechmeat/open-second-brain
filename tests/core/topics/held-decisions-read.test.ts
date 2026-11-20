/**
 * The derived decision items and the held listing read a topic's log
 * records by one path (`readStreamRecords`, with its seen-shard and gap
 * checks) and one privacy rule (the record's own partition and its
 * `<private>` regions; below local reach `shared` only): a decision the
 * held listing withholds is never a derived item, and a `log` shard that
 * cannot be read or that vanished is said, never read as absent.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { writeVaultPointer } from "../../../src/core/brain/portability/pointer.ts";
import { withPrivateWithheld } from "../../../src/core/store/caller-reach.ts";
import { runTopicAction } from "../../../src/core/topics/actions.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import type { Fleet, Machine } from "../store-migration/fixtures/fleet.ts";
import { callTool, serverIn, switchedMachine } from "./fixtures/record-project.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const SUBJECT = "Release notes list every migration step";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

/** A planned topic of four notes and one decision (`chosen`) from two sessions. */
async function topicWithDecision(chosen: string): Promise<{ a: Machine; topic: string }> {
  const made = switchedMachine();
  fleet = made.fleet;
  const a = made.machine;
  const dir = join(fleet.parent, "work", "release-tool");
  mkdirSync(dir, { recursive: true });
  writeVaultPointer(dir, a.vault);
  const one = serverIn(a, dir);
  const two = serverIn(a, dir);
  await callTool(one, "brain_note", { text: `${SUBJECT} 0`, agent: "agent-one" });
  await callTool(one, "brain_note", { text: `${SUBJECT} 1`, agent: "agent-one" });
  await callTool(one, "brain_decision", {
    action: "record",
    title: "Release notes order",
    chosen,
    assumption: "Readers follow the steps top to bottom",
    review_date: "2027-01-01",
    agent: "agent-one",
  });
  await callTool(two, "brain_note", { text: `${SUBJECT} 2`, agent: "agent-two" });
  await callTool(two, "brain_note", { text: `${SUBJECT} 3`, agent: "agent-two" });
  const report = dream(a.vault).topics?.report;
  if (report?.status !== "planned") throw new Error("not planned");
  expect(report.created[0]!.members).toBe(5);
  return { a, topic: report.created[0]!.topic };
}

function show(topic: string, below: boolean): Record<string, unknown> {
  return withPrivateWithheld(below, () => runTopicAction({ action: "show", topic, held: true }));
}

function decisionItems(answer: Record<string, unknown>): Array<Record<string, unknown>> {
  return (
    (answer["topic"] as Record<string, unknown>)["items"] as Array<Record<string, unknown>>
  ).filter((i) => i["kind"] === "decision");
}

function heldDecisions(answer: Record<string, unknown>): Array<Record<string, unknown>> {
  return (answer["records"] as Array<Record<string, unknown>>).filter(
    (r) => r["kind"] === "decision-record",
  );
}

test("a complete read derives the decision and lists it, at both reaches", async () => {
  const { topic } = await topicWithDecision(`${SUBJECT} in commit order`);
  for (const below of [false, true]) {
    const answer = show(topic, below);
    expect(decisionItems(answer)).toHaveLength(1);
    expect(heldDecisions(answer)).toHaveLength(1);
    expect(answer["decisions_incomplete"]).toBeUndefined();
  }
});

test("a decision with a private region is neither derived nor listed below local reach", async () => {
  const { a, topic } = await topicWithDecision(`${SUBJECT} in commit order`);
  // A second decision, with a private region, routed to the shared topic.
  const dir = join(fleet!.parent, "work", "release-tool");
  await callTool(serverIn(a, dir), "brain_decision", {
    action: "record",
    title: "Release notes wording",
    chosen: `${SUBJECT} in plain words <private>kept here</private>`,
    assumption: "Readers follow the steps top to bottom",
    review_date: "2027-01-01",
    agent: "agent-one",
  });
  dream(a.vault);
  const local = show(topic, false);
  expect((local["topic"] as Record<string, unknown>)["held_records"]).toBe(6);
  expect(decisionItems(local)).toHaveLength(2);
  expect(JSON.stringify(local)).not.toContain("kept here");
  const remote = show(topic, true);
  expect(decisionItems(remote)).toHaveLength(1);
  expect(heldDecisions(remote)).toHaveLength(1);
  expect(JSON.stringify(remote)).not.toContain("in plain words");
});

test.skipIf(CHMOD_CANNOT_DENY)(
  "a log shard that cannot be read is said by show, at both reaches",
  async () => {
    const { a, topic } = await topicWithDecision(`${SUBJECT} in commit order`);
    const logDir = join(a.storeRoot, "shared", "log");
    const device = readdirSync(logDir)[0]!;
    const shard = join(logDir, device, readdirSync(join(logDir, device))[0]!);
    chmodSync(shard, 0o000);
    try {
      for (const below of [false, true]) {
        const answer = show(topic, below);
        expect(answer["decisions_incomplete"]).toBe(true);
        expect(decisionItems(answer)).toHaveLength(0);
      }
    } finally {
      chmodSync(shard, 0o644);
    }
  },
);

test("a log shard that vanished after this machine read it is said by show, at both reaches", async () => {
  const { a, topic } = await topicWithDecision(`${SUBJECT} in commit order`);
  expect(decisionItems(show(topic, false))).toHaveLength(1);
  const logDir = join(a.storeRoot, "shared", "log");
  const device = readdirSync(logDir)[0]!;
  rmSync(join(logDir, device, readdirSync(join(logDir, device))[0]!));
  for (const below of [false, true]) {
    expect(show(topic, below)["decisions_incomplete"]).toBe(true);
  }
});
