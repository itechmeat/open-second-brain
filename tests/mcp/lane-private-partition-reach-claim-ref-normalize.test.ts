/**
 * A log event naming a decision held in `private` by a path with a
 * redundant separator: the row is judged private on the write side and
 * is withheld from a caller below local reach, like the plain spelling.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { appendLogEvent } from "../../src/core/brain/log.ts";
import { logRefsNamePrivatePage } from "../../src/core/store/reference-privacy.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import { readStreamRecords } from "../../src/core/store/read/stream-read.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  AGENT,
  REGION,
  call,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

function env(): LaneEnv {
  lane = makeLaneEnv("store", "osb-lane-claim-ref-normalize-");
  return lane;
}

/** Log rows of `partition` whose body names `token`. */
function rowsNaming(e: LaneEnv, partition: "shared" | "private", token: string): number {
  return readStreamRecords(e.env.storeRoot, partition, { stream: "log" }).records.filter((r) =>
    JSON.stringify(r.body).includes(token),
  ).length;
}

/** A decision held in `private`; returns its id. */
async function privateDecision(e: LaneEnv, title: string): Promise<string> {
  const recorded = await callJson(localServer(e), "brain_decision", {
    action: "record",
    title,
    chosen: "zqdecchosen path",
    assumption: "it holds",
    review_date: "2026-12-01",
    notes: `zqdecnotes\n\n${REGION}`,
  });
  const id = String(recorded["id"] ?? "");
  expect(id).not.toBe("");
  expect(laneEntryInPrivate(e.vault, join(e.vault, "Brain", "decisions", `${id}.md`))).toBe(true);
  return id;
}

describe("a reference spelled with a redundant separator", () => {
  for (const [label, refOf] of [
    ["plain", (id: string) => `Brain/decisions/${id}.md`],
    ["redundant", (id: string) => `Brain//decisions/${id}.md`],
  ] as const) {
    test(`a remote answer withholds a log row naming a private decision by its ${label} path`, async () => {
      const e = env();
      const id = await privateDecision(e, `Zqclaimnorm ${label}`);
      const subject = `zqclaimnorm${label}`;
      appendLogEvent(e.vault, {
        timestamp: "2026-11-20T10:00:00Z",
        eventType: "tension",
        agent: AGENT,
        body: { tension: refOf(id), action: "noted", subject_a: subject, agent: AGENT },
      });
      const judged = logRefsNamePrivatePage(e.vault, [refOf(id)]);
      const local = await call(localServer(e), "brain_agent_query", {});
      const remote = await call(server(e), "brain_agent_query", {});
      expect(local).toContain(subject);
      expect({
        judged,
        private_rows: rowsNaming(e, "private", subject),
        shared_rows: rowsNaming(e, "shared", subject),
      }).toEqual({ judged: true, private_rows: 1, shared_rows: 0 });
      expect(remote).not.toContain(subject);
    });
  }

  test("a remote answer withholds a log row naming a private decision by its trailing-slash path", async () => {
    const e = env();
    const id = await privateDecision(e, "Zqclaimnorm slash");
    const ref = `Brain/decisions/${id}.md/`;
    const subject = "zqclaimnormslash";
    appendLogEvent(e.vault, {
      timestamp: "2026-11-20T10:00:00Z",
      eventType: "tension",
      agent: AGENT,
      body: { tension: ref, action: "noted", subject_a: subject, agent: AGENT },
    });
    expect(logRefsNamePrivatePage(e.vault, [ref])).toBe(true);
    expect({
      private_rows: rowsNaming(e, "private", subject),
      shared_rows: rowsNaming(e, "shared", subject),
    }).toEqual({ private_rows: 1, shared_rows: 0 });
    expect(await call(server(e), "brain_agent_query", {})).not.toContain(subject);
  });
});
