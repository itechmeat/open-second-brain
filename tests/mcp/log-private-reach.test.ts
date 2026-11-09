/**
 * A log event of the store's `private` partition below local reach
 * (review finding F333, the remote side): the `osb://log/{date}` resource
 * withholds it from a remote caller, whatever it names, and still shows it
 * to a local one. A shared event of the same day is shown to both.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { appendLogEvent } from "../../src/core/brain/log.ts";
import { resolveLogEventTraces } from "../../src/core/brain/event-trace.ts";
import { reachView } from "../../src/core/brain/reach-view.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { withOperationPrivacy } from "../../src/core/store/operation-scope.ts";
import { readResource } from "../../src/mcp/resources.ts";
import { switchDevice } from "../core/brain/store-only/fixtures.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv;
beforeEach(() => {
  env = makeStoreEnv("osb-log-private-reach-");
  switchDevice(env.storeRoot);
});
afterEach(() => env.cleanup());

describe("osb://log/{date} on a switched machine", () => {
  test("a private event is withheld from a remote caller, shown to a local one", () => {
    appendLogEvent(env.vault, {
      timestamp: "2026-06-01T09:00:00Z",
      eventType: "note",
      body: { text: "a shared note" },
    });
    withOperationPrivacy(true, () => {
      appendLogEvent(env.vault, {
        timestamp: "2026-06-01T10:00:00Z",
        eventType: "note",
        body: { text: "a private note that names nothing" },
      });
    });
    const uri = "osb://log/2026-06-01";
    const remote = readResource({ vault: env.vault, reach: TRANSPORT_REACH.remote }, uri).text;
    expect(remote).toContain("a shared note");
    expect(remote).not.toContain("a private note");
    const local = readResource({ vault: env.vault, reach: TRANSPORT_REACH.local }, uri).text;
    expect(local).toContain("a shared note");
    expect(local).toContain("a private note that names nothing");
  });

  test("a day with only a private event reads as absent to a remote caller", () => {
    withOperationPrivacy(true, () => {
      appendLogEvent(env.vault, {
        timestamp: "2026-06-02T10:00:00Z",
        eventType: "note",
        body: { text: "only private" },
      });
    });
    expect(() =>
      readResource({ vault: env.vault, reach: TRANSPORT_REACH.remote }, "osb://log/2026-06-02"),
    ).toThrow(/no log events for date/);
  });
});

describe("the event trace on a switched machine", () => {
  test("a private event is withheld from a remote caller, traced for a local one", () => {
    withOperationPrivacy(true, () => {
      appendLogEvent(env.vault, {
        timestamp: "2026-06-03T10:00:00Z",
        eventType: "note",
        body: { text: "a private trace that names nothing" },
      });
    });
    const traced = (reach: (typeof TRANSPORT_REACH)[keyof typeof TRANSPORT_REACH]) =>
      resolveLogEventTraces(env.vault, {
        date: "2026-06-03",
        view: reachView(env.vault, reach),
      });
    expect(traced(TRANSPORT_REACH.remote)).toEqual([]);
    expect(traced(TRANSPORT_REACH.local)).toHaveLength(1);
  });
});

describe("osb://digest/latest on a switched machine", () => {
  test("a private event does not reach a remote caller's digest", () => {
    withOperationPrivacy(true, () => {
      appendLogEvent(env.vault, {
        timestamp: new Date().toISOString(),
        eventType: "note",
        agent: "@secret-agent",
        body: { text: "a private note that names nothing" },
      });
    });
    const uri = "osb://digest/latest";
    const remote = readResource({ vault: env.vault, reach: TRANSPORT_REACH.remote }, uri).text;
    expect(remote).not.toContain("secret-agent");
    const local = readResource({ vault: env.vault, reach: TRANSPORT_REACH.local }, uri).text;
    expect(local).toContain("secret-agent");
  });
});
