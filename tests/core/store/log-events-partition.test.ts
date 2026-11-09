/**
 * The partition of a store log event (design D2 of lane-pages-split):
 * every event read from the store carries the partition its record was
 * read from, and the report is `null` on an unswitched vault. The export
 * rules built on it (private wins for a record in both partitions, the
 * refusal on an unreadable shard) are proven at the export, in
 * `tests/core/brain/portability/okf-store-only.test.ts`.
 */
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import {
  readStoreLogEvents,
  readStoreLogEventsReport,
} from "../../../src/core/store/read/log-events.ts";
import { withOperationPrivacy } from "../../../src/core/store/operation-scope.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";
import { switchDevice } from "../brain/store-only/fixtures.ts";

let env: StoreEnv;

beforeEach(() => {
  env = makeStoreEnv("osb-log-partition-");
  switchDevice(env.storeRoot);
});

afterEach(() => env.cleanup());

/** The whole-log range `log-days.ts` reads. */
const WHOLE = { from: "1970-01-01", to: "9998-12-31" };

describe("the partition of a store log event", () => {
  test("an event under withOperationPrivacy(true) is private, one outside it is shared", () => {
    appendLogEvent(env.vault, {
      timestamp: "2026-06-01T09:00:00Z",
      eventType: "note",
      body: { text: "a shared day" },
    });
    withOperationPrivacy(true, () => {
      appendLogEvent(env.vault, {
        timestamp: "2026-06-02T09:00:00Z",
        eventType: "note",
        body: { text: "a private day" },
      });
    });
    const report = readStoreLogEventsReport(WHOLE, { vault: env.vault });
    expect(report).not.toBeNull();
    expect(report?.unreadable).toEqual([]);
    expect(report?.events.map((e) => [e.entry.body["text"], e.partition])).toEqual([
      ["a shared day", "shared"],
      ["a private day", "private"],
    ]);
  });

  test("an unswitched vault reads null", () => {
    const plain = makeStoreEnv("osb-log-unswitched-");
    try {
      expect(readStoreLogEventsReport(WHOLE, { vault: plain.vault })).toBeNull();
      expect(readStoreLogEvents(WHOLE, { vault: plain.vault })).toBeNull();
    } finally {
      plain.cleanup();
    }
  });
});
