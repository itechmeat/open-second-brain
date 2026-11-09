/**
 * Test helper: write the store records the view renders from (confirmed
 * preferences, Brain notes and decisions as log events) the way the
 * phase 1 dual writes write them.
 */
import { appendRecord } from "../../../../src/core/store/appender.ts";
import type { StorePartition } from "../../../../src/core/store/constants.ts";
import type { StoreHandle } from "../../../../src/core/store/store-open.ts";

export function seedPreference(
  store: StoreHandle,
  ms: number,
  id: string,
  fields: Record<string, unknown>,
  partition: StorePartition = "shared",
  authority: "human" | "agent" = "agent",
): void {
  appendRecord(
    store,
    {
      partition,
      stream: "events",
      kind: "preference-set",
      agent: "seed",
      body: { authority, preference: id, fields },
    },
    { now: () => ms },
  );
}

export function seedLogEvent(
  store: StoreHandle,
  ms: number,
  eventType: string,
  body: Record<string, unknown>,
  partition: StorePartition = "shared",
): void {
  appendRecord(
    store,
    {
      partition,
      stream: "log",
      kind: "log-event",
      agent: "seed",
      body: { timestamp: new Date(ms).toISOString(), event_type: eventType, body },
    },
    { now: () => ms },
  );
}

export function seedSetting(store: StoreHandle, ms: number, key: string, value: unknown): void {
  appendRecord(
    store,
    {
      partition: "shared",
      stream: "settings",
      kind: "setting-set",
      agent: "seed",
      body: { authority: "human", key, value },
    },
    { now: () => ms },
  );
}
