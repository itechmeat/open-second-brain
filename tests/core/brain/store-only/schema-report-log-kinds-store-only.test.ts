/**
 * The schema report's log event-kind usage on a switched vault with no
 * `Brain/` tree. The log is `log-event` records of the store there; the
 * scan read only the legacy day files, so every kind read as unused and
 * every declared custom kind drew an `unused-declaration` finding.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { appendLogEvent } from "../../../../src/core/brain/log.ts";
import { buildSchemaReport } from "../../../../src/core/brain/schema-report.ts";
import { withPrivateWithheld } from "../../../../src/core/store/caller-reach.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

test("log event kinds are counted from the store on a vault with no Brain/", () => {
  env = makeStoreEnv("osb-schema-log-", { legacyTree: false });
  for (const at of ["2026-11-18T10:00:00Z", "2026-11-19T11:00:00Z"]) {
    appendLogEvent(env.vault, {
      timestamp: at,
      eventType: "note",
      body: { agent: "@tester", text: "hello" },
    });
  }
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);

  const report = buildSchemaReport(env.vault);
  expect(report.usage.log_event_kinds).toContainEqual({ token: "note", count: 2 });
  expect(report.findings.filter((f) => f.kind === "unreadable-artifact")).toEqual([]);
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);
});

test("a caller below local reach is not counted the private partition's log events", () => {
  env = makeStoreEnv("osb-schema-log-private-", { legacyTree: false });
  appendLogEvent(env.vault, {
    timestamp: "2026-11-18T10:00:00Z",
    eventType: "note",
    body: { agent: "@tester", text: "shared" },
  });
  appendLogEvent(
    env.vault,
    {
      timestamp: "2026-11-18T11:00:00Z",
      eventType: "pin",
      body: { agent: "@tester", text: "private" },
    },
    { storePrivate: true },
  );
  const local = buildSchemaReport(env.vault).usage.log_event_kinds;
  expect(local).toContainEqual({ token: "pin", count: 1 });
  const remote = withPrivateWithheld(true, () => buildSchemaReport(env!.vault)).usage
    .log_event_kinds;
  expect(remote).toEqual([{ token: "note", count: 1 }]);
});
