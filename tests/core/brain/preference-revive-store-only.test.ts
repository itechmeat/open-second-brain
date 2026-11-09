/**
 * Preference lifecycle writes on a switched machine: a slug brought back
 * carries none of the retired life's metadata (as the fresh page an
 * unswitched machine writes beside the retired one), and a retire stays in
 * the partition the fold holds the preference in.
 */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import {
  moveToRetired,
  storePreferenceMeta,
  writePreference,
} from "../../../src/core/brain/preference.ts";
import {
  rewriteStorePreference,
  storePreferencePages,
} from "../../../src/core/brain/preference-page-write.ts";
import { buildTimelineIndex } from "../../../src/core/brain/temporal/build-index.ts";
import { reportMergeChain, setMergedInto } from "../../../src/core/brain/page-meta/page-id.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { PREFERENCE_SET_KIND } from "../../../src/core/store/constants.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { DEVICE_SWITCHED_KIND } from "../../../src/core/store/store-only.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const input = {
  slug: "again",
  topic: "t",
  principle: "principle again",
  created_at: "2026-11-01T00:00:00Z",
  unconfirmed_until: "2026-11-30T00:00:00Z",
  status: "confirmed" as const,
  evidenced_by: [],
};

test("a create over a retired fold entry starts with no retire metadata", () => {
  env = makeStoreEnv("osb-pref-revive-", { dualWrite: false });
  appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
    partition: "shared",
    stream: "settings",
    kind: DEVICE_SWITCHED_KIND,
    agent: "o2b",
    body: { authority: "human", vault_id: null, device: "dev-a" },
  });
  const written = writePreference(env.vault, input, { authority: "agent" });
  moveToRetired(env.vault, written.path, "stale-no-evidence", {
    now: new Date("2026-11-07T12:00:00Z"),
    retired_by: "@t",
    superseded_by: "pref-other",
  });
  writePreference(env.vault, input, { authority: "agent" });
  const meta = storePreferenceMeta("again")?.meta ?? {};
  expect(meta["kind"]).toBe("brain-preference");
  for (const field of ["retired_at", "retired_reason", "retired_by", "superseded_by"]) {
    expect(meta[field]).toBeUndefined();
  }
});

test("a create over a retired fold entry carries no field of the old life", () => {
  env = makeStoreEnv("osb-pref-revive-fields-", { dualWrite: false });
  appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
    partition: "shared",
    stream: "settings",
    kind: DEVICE_SWITCHED_KIND,
    agent: "o2b",
    body: { authority: "human", vault_id: null, device: "dev-a" },
  });
  const written = writePreference(
    env.vault,
    { ...input, slug: "old", scope: "work", aliases: ["old-name"] },
    { authority: "agent" },
  );
  moveToRetired(env.vault, written.path, "stale-no-evidence", {
    now: new Date("2026-11-07T12:00:00Z"),
    retired_by: "@t",
  });
  writePreference(env.vault, { ...input, slug: "old" }, { authority: "agent" });
  const meta = storePreferenceMeta("old")?.meta ?? {};
  expect(meta["scope"]).toBeUndefined();
  expect(meta["aliases"]).toBeUndefined();
});

test("an overwrite of a preference the fold holds as private stays in private", () => {
  env = makeStoreEnv("osb-pref-overwrite-private-", { dualWrite: false });
  const store = openStore({ root: env.storeRoot, device: "dev-a" });
  appendRecord(store, {
    partition: "shared",
    stream: "settings",
    kind: DEVICE_SWITCHED_KIND,
    agent: "o2b",
    body: { authority: "human", vault_id: null, device: "dev-a" },
  });
  appendRecord(store, {
    partition: "private",
    stream: "events",
    kind: PREFERENCE_SET_KIND,
    agent: "claude",
    body: {
      authority: "agent",
      preference: "pref-held",
      fields: { ...input, slug: undefined, id: "pref-held", kind: "brain-preference" },
    },
  });
  writePreference(
    env.vault,
    { ...input, slug: "held", principle: "reworded" },
    { authority: "agent", overwrite: true },
  );
  const sets = (partition: "shared" | "private") =>
    readPartition(join(env!.storeRoot, partition))
      .flatMap((shard) => shard.all)
      .filter((r) => r.kind === PREFERENCE_SET_KIND).length;
  expect(sets("shared")).toBe(0);
  expect(sets("private")).toBeGreaterThan(1);
});

test("a preference the fold holds as private keeps its retire in private", () => {
  env = makeStoreEnv("osb-pref-retire-private-", { dualWrite: false });
  const store = openStore({ root: env.storeRoot, device: "dev-a" });
  appendRecord(store, {
    partition: "shared",
    stream: "settings",
    kind: DEVICE_SWITCHED_KIND,
    agent: "o2b",
    body: { authority: "human", vault_id: null, device: "dev-a" },
  });
  const written = writePreference(env.vault, { ...input, slug: "held" }, { authority: "agent" });
  // A later record of the same preference sits in `private/` with no
  // `private:` field: the entity is private by partition alone.
  appendRecord(store, {
    partition: "private",
    stream: "events",
    kind: PREFERENCE_SET_KIND,
    agent: "claude",
    body: { authority: "agent", preference: "pref-held", fields: { scope: "work" } },
  });
  moveToRetired(env.vault, written.path, "stale-no-evidence", {
    now: new Date("2026-11-07T12:00:00Z"),
    retired_by: "@t",
  });
  const retires = (partition: "shared" | "private") =>
    readPartition(join(env!.storeRoot, partition))
      .flatMap((shard) => shard.all)
      .filter(
        (r) =>
          r.kind === PREFERENCE_SET_KIND &&
          (r.body["fields"] as Record<string, unknown>)["status"] === "retired",
      ).length;
  expect(retires("shared")).toBe(0);
  expect(retires("private")).toBeGreaterThan(0);
});

test("a page rewrite that drops a field clears it in the fold", () => {
  env = makeStoreEnv("osb-pref-rewrite-drop-", { dualWrite: false });
  appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
    partition: "shared",
    stream: "settings",
    kind: DEVICE_SWITCHED_KIND,
    agent: "o2b",
    body: { authority: "human", vault_id: null, device: "dev-a" },
  });
  writePreference(env.vault, { ...input, slug: "drop", scope: "work" }, { authority: "agent" });
  const page = storePreferencePages(env.vault).find((p) => p.slug === "drop")!;
  expect(page.meta["scope"]).toBe("work");
  const { scope: _scope, ...next } = page.meta;
  expect(rewriteStorePreference(env.vault, page, next)).toBe(true);
  expect(storePreferenceMeta("drop")?.meta["scope"]).toBeUndefined();
});

test("the timeline shows a retire the fold holds", () => {
  env = makeStoreEnv("osb-timeline-retire-", { dualWrite: false });
  appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
    partition: "shared",
    stream: "settings",
    kind: DEVICE_SWITCHED_KIND,
    agent: "o2b",
    body: { authority: "human", vault_id: null, device: "dev-a" },
  });
  const written = writePreference(env.vault, { ...input, slug: "gone" }, { authority: "agent" });
  moveToRetired(env.vault, written.path, "stale-no-evidence", {
    now: new Date(Date.now() - 3_600_000),
    retired_by: "@t",
  });
  const retires = buildTimelineIndex(env.vault, {}).events.filter((e) => e.kind === "retire");
  expect(retires.map((e) => [e.prefId, e.source.path])).toEqual([
    ["ret-gone", "Brain/retired/ret-gone.md"],
  ]);
});

test("a merge pointer to a live preference is resolved, and pref-x never points at ret-x", () => {
  env = makeStoreEnv("osb-merge-chain-store-", { dualWrite: false });
  appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
    partition: "shared",
    stream: "settings",
    kind: DEVICE_SWITCHED_KIND,
    agent: "o2b",
    body: { authority: "human", vault_id: null, device: "dev-a" },
  });
  writePreference(env.vault, { ...input, slug: "keep" }, { authority: "agent" });
  writePreference(env.vault, { ...input, slug: "drop" }, { authority: "agent" });
  setMergedInto(env.vault, "pref-drop", "pref-keep");
  expect(reportMergeChain(env.vault, "pref-drop").outcome).toBe("resolved");
  expect(reportMergeChain(env.vault, "pref-missing").outcome).toBe("dangling");
  expect(() => setMergedInto(env!.vault, "pref-keep", "ret-keep")).toThrow(/one preference/);
});
