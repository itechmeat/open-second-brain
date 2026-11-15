/**
 * Private `apply-evidence` in the dream pass on a switched machine (task
 * 3.18, design "Private evidence"): an event that lands in `private`
 * because its note names a private page never moves a shared preference's
 * status or confidence, which every machine reads from `shared`; it does
 * move a preference that is itself private.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { dream } from "../../../src/core/brain/dream.ts";
import { mergePreferences } from "../../../src/core/brain/merge.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { withOperationPrivacy } from "../../../src/core/store/operation-scope.ts";
import { foldPreferences } from "../../../src/core/store/fold-preferences.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const NOW = new Date("2026-11-10T12:00:00Z");

const prefInput = (slug: string) => ({
  slug,
  topic: slug,
  principle: `principle ${slug}`,
  created_at: "2026-11-01T00:00:00Z",
  unconfirmed_until: "2026-12-30T00:00:00Z",
  status: "unconfirmed" as const,
  evidenced_by: [],
});

/** Evidence whose note names a preference the store cannot resolve: judged private. */
function privateEvidence(e: StoreEnv, slug: string): void {
  appendApplyEvidence(e.vault, {
    pref_id: `pref-${slug}`,
    artifact: "[[notes/work]]",
    agent: "claude",
    result: "applied",
    note: "[[pref-unknown-private]]",
  });
}

/** The fields of `pref-<slug>` as a machine that holds only `shared` folds them. */
function sharedView(e: StoreEnv, slug: string): Record<string, unknown> {
  const records = readPartition(join(e.storeRoot, "shared")).flatMap((shard) => shard.records);
  return { ...foldPreferences(records).preferences.get(`pref-${slug}`)?.fields };
}

describe("private evidence in a dream pass on a switched machine", () => {
  test("does not confirm a shared preference or move its confidence", () => {
    env = makeStoreEnv("osb-dream-private-ev-", { dualWrite: false });
    switchDevice(env.storeRoot);
    writePreference(env.vault, prefInput("tabs"), { authority: "agent" });
    // A twin with no evidence at all: what the shared fields must read like.
    writePreference(env.vault, prefInput("twin"), { authority: "agent" });
    privateEvidence(env, "tabs");
    privateEvidence(env, "tabs");

    const summary = dream(env.vault, { now: NOW });
    expect(summary.confirmed).not.toContain("pref-tabs");
    const judged = (slug: string) => {
      const fields = sharedView(env!, slug);
      return {
        status: fields["status"],
        confirmed_at: fields["confirmed_at"] ?? null,
        confidence: fields["confidence"],
        confidence_value: fields["confidence_value"] ?? null,
        last_evidence_at: fields["last_evidence_at"] ?? null,
      };
    };
    expect(judged("tabs")).toEqual(judged("twin"));
    expect(judged("tabs").status).toBe("unconfirmed");
  });

  test("a shared event next to it still counts", () => {
    env = makeStoreEnv("osb-dream-private-ev-shared-", { dualWrite: false });
    switchDevice(env.storeRoot);
    writePreference(env.vault, prefInput("tabs"), { authority: "agent" });
    privateEvidence(env, "tabs");
    appendApplyEvidence(env.vault, {
      pref_id: "pref-tabs",
      artifact: "[[notes/open]]",
      agent: "claude",
      result: "applied",
    });
    dream(env.vault, { now: NOW });
    expect(sharedView(env, "tabs")["status"]).toBe("confirmed");
  });

  test("settles: the pass after the one that read the evidence changes nothing", () => {
    env = makeStoreEnv("osb-dream-private-ev-settle-", { dualWrite: false });
    switchDevice(env.storeRoot);
    writePreference(env.vault, prefInput("tabs"), { authority: "agent" });
    appendApplyEvidence(env.vault, {
      pref_id: "pref-tabs",
      artifact: "[[notes/open]]",
      agent: "claude",
      result: "applied",
    });
    privateEvidence(env, "tabs");
    dream(env.vault, { now: NOW });
    const shared = () => readPartition(join(env!.storeRoot, "shared")).flatMap((s) => s.records);
    const before = shared().length;
    const again = dream(env.vault, { now: new Date(NOW.getTime() + 60_000) });
    expect(again.changed).toBe(false);
    expect(shared()).toHaveLength(before);
  });

  test("confirms a preference that is itself private", () => {
    env = makeStoreEnv("osb-dream-private-ev-own-", { dualWrite: false });
    switchDevice(env.storeRoot);
    withOperationPrivacy(true, () =>
      writePreference(env!.vault, prefInput("hush"), { authority: "agent" }),
    );
    privateEvidence(env, "hush");
    const summary = dream(env.vault, { now: NOW });
    expect(summary.confirmed).toContain("pref-hush");
  });
});

describe("a merge on a switched machine", () => {
  test("keeps a private use of the drop out of shared, in the copies and in the sums", () => {
    env = makeStoreEnv("osb-merge-private-ev-", { dualWrite: false });
    switchDevice(env.storeRoot);
    writePreference(
      env.vault,
      { ...prefInput("keep"), topic: "shared-topic", status: "confirmed" },
      { authority: "agent" },
    );
    writePreference(
      env.vault,
      { ...prefInput("drop"), topic: "shared-topic", status: "confirmed" },
      { authority: "agent" },
    );
    appendApplyEvidence(env.vault, {
      pref_id: "pref-drop",
      artifact: "[[notes/open]]",
      agent: "claude",
      result: "applied",
    });
    privateEvidence(env, "drop");
    mergePreferences(env.vault, "pref-keep", "pref-drop", { bypassEntityGuard: true });
    const shared = readPartition(join(env.storeRoot, "shared")).flatMap((s) => s.records);
    expect(JSON.stringify(shared)).not.toContain("notes/work");
    const merge = shared.find(
      (r) => r.kind === "log-event" && (r.body["event_type"] as string) === "merge",
    );
    expect(JSON.stringify(merge?.body)).toContain("1 (was 0, 1)");
    // The shared use still counts for the keep on a machine that holds only shared.
    const keepEvidence = shared.filter(
      (r) => r.kind === "preference-evidence" && r.body["preference"] === "pref-keep",
    );
    expect(keepEvidence.map((r) => r.body["artifact"])).toEqual(["[[notes/open]]"]);
  });
});

describe("a merge retried after its copies partly landed", () => {
  test("counts a copied use once", () => {
    env = makeStoreEnv("osb-merge-retry-", { dualWrite: false });
    switchDevice(env.storeRoot);
    for (const slug of ["keep", "drop"]) {
      writePreference(
        env.vault,
        { ...prefInput(slug), topic: "shared-topic", status: "confirmed" },
        { authority: "agent" },
      );
    }
    appendApplyEvidence(env.vault, {
      pref_id: "pref-drop",
      artifact: "[[notes/open]]",
      agent: "claude",
      result: "applied",
    });
    const shared = () => readPartition(join(env!.storeRoot, "shared")).flatMap((s) => s.records);
    const source = shared().find(
      (r) => r.kind === "preference-evidence" && r.body["preference"] === "pref-drop",
    )!;
    // The copy an earlier run wrote before it stopped.
    appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "events",
      kind: "preference-evidence",
      agent: "merge",
      body: {
        preference: "pref-keep",
        result: "applied",
        artifact: "[[notes/open]]",
        merged_from: source.id,
      },
    });
    const plan = mergePreferences(env.vault, "pref-keep", "pref-drop", { bypassEntityGuard: true });
    expect(plan.applied_sum).toBe(1);
    const merge = shared().find(
      (r) => r.kind === "log-event" && (r.body["event_type"] as string) === "merge",
    );
    expect(JSON.stringify(merge?.body)).toContain("1 (was 1, 0)");
  });
});

describe("a merge into a private keep", () => {
  test("counts the shared drop's private use, which the keep now holds", () => {
    env = makeStoreEnv("osb-merge-private-keep-", { dualWrite: false });
    switchDevice(env.storeRoot);
    withOperationPrivacy(true, () =>
      writePreference(
        env!.vault,
        { ...prefInput("keep"), topic: "shared-topic", status: "confirmed" },
        { authority: "agent" },
      ),
    );
    writePreference(
      env.vault,
      { ...prefInput("drop"), topic: "shared-topic", status: "confirmed" },
      { authority: "agent" },
    );
    appendApplyEvidence(env.vault, {
      pref_id: "pref-drop",
      artifact: "[[notes/open]]",
      agent: "claude",
      result: "applied",
    });
    privateEvidence(env, "drop");
    const plan = mergePreferences(env.vault, "pref-keep", "pref-drop", { bypassEntityGuard: true });
    expect(plan.applied_sum).toBe(2);
  });
});
