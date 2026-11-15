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

/** One topic record, as an agent (or the user) would write it through the topic tools. */
export function seedTopicRecord(
  store: StoreHandle,
  ms: number,
  kind: string,
  topic: string,
  body: Record<string, unknown>,
  options: {
    readonly authority?: "human" | "agent" | "model";
    readonly agent?: string;
    readonly partition?: StorePartition;
  } = {},
): string {
  return appendRecord(
    store,
    {
      partition: options.partition ?? "shared",
      stream: "topics",
      kind,
      agent: options.agent ?? "seed",
      topic,
      body: { authority: options.authority ?? "agent", ...body },
    },
    { now: () => ms },
  ).record.id;
}

/** One lane entry (a research report, a source summary), as the store-only lane writers write it. */
export function seedLaneEntry(
  store: StoreHandle,
  ms: number,
  lane: string,
  entry: string,
  fields: Record<string, unknown>,
  text: string,
): void {
  appendRecord(
    store,
    {
      partition: "shared",
      stream: "events",
      kind: "lane-entry",
      agent: "seed",
      body: { authority: "agent", lane, entry, fields, text },
    },
    { now: () => ms },
  );
}

/** The tombstone of a lane entry. */
export function seedLaneRemove(store: StoreHandle, ms: number, lane: string, entry: string): void {
  appendRecord(
    store,
    {
      partition: "shared",
      stream: "events",
      kind: "lane-entry-remove",
      agent: "seed",
      body: { authority: "human", lane, entry },
    },
    { now: () => ms },
  );
}
