/**
 * Signal lifecycle and preference page writers once switched (task 2.10,
 * design D14 item 5): expirations, the `authored_at` backfill, the
 * approval lane, merges, merge pointers, lint consolidation and the page
 * writers of the memory importers write store records only, and nothing
 * under `Brain/` outside `Brain/log/` and `Brain/logs/` changes (the log
 * and its ledgers move with another package). Unswitched, the same calls keep the legacy
 * tree and dual-write the same records.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { setExpiration } from "../../../src/core/brain/expiration-set.ts";
import { planAuthoredAtBackfill } from "../../../src/core/brain/authored-at-backfill.ts";
import { mergeChainDanglingCheck } from "../../../src/core/brain/doctor/merge-chain-check.ts";
import type { DoctorIssue } from "../../../src/core/brain/types.ts";
import { retargetWikilinks } from "../../../src/core/brain/page-dedup.ts";
import { lintConsolidate } from "../../../src/core/brain/lint-consolidate.ts";
import { mergePreferences } from "../../../src/core/brain/merge.ts";
import { resolveCanonicalId, setMergedInto } from "../../../src/core/brain/page-meta/page-id.ts";
import {
  applyPending,
  listPending,
  rejectPending,
  stagePendingSignal,
} from "../../../src/core/brain/pending.ts";
import { loadPreference, writePreference } from "../../../src/core/brain/preference.ts";
import { writePreferencePageText } from "../../../src/core/brain/preference-page-write.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { appendEditHistory, readEditHistory } from "../../../src/core/brain/health/edit-history.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { routeSignalState } from "../../../src/core/brain/signal-state.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { SIGNAL_STATE_KIND } from "../../../src/core/store/fold-signals.ts";
import { readPreferences } from "../../../src/core/store/read/preferences.ts";
import { readSignals } from "../../../src/core/store/read/signals.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import {
  brainOutsideLog,
  ledgerRows,
  partitionRecords,
  switchDevice,
} from "./store-only/fixtures.ts";

let env: StoreEnv | undefined;

afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function switchedEnv(): StoreEnv {
  const e = makeStoreEnv("osb-wp1-lifecycle-", { dualWrite: false });
  switchDevice(e.storeRoot);
  return e;
}

function records(e: StoreEnv, kind: string): StoreRecord[] {
  return (["shared", "private"] as const)
    .flatMap((p) => partitionRecords(e.storeRoot, p))
    .filter((r) => r.kind === kind);
}

const signalInput = (slug: string, extra: Record<string, unknown> = {}) => ({
  topic: slug,
  signal: "positive" as const,
  agent: "claude",
  principle: `Principle of ${slug}`,
  created_at: "2026-11-06T10:00:00Z",
  date: "2026-11-06",
  slug,
  ...extra,
});

const prefInput = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  topic: "shared-topic",
  principle: `principle ${slug}`,
  created_at: "2026-11-01T00:00:00Z",
  unconfirmed_until: "2026-11-30T00:00:00Z",
  status: "confirmed" as const,
  evidenced_by: [],
  ...extra,
});

describe("signal lifecycle once switched", () => {
  test("an expiration on a signal and a preference is a record of the field", () => {
    env = switchedEnv();
    const { id } = writeSignal(env.vault, signalInput("expire"));
    writePreference(env.vault, prefInput("expire"), { authority: "agent" });
    const before = brainOutsideLog(env.vault);
    expect(setExpiration(env.vault, id, "2026-12-31").changed).toBe(true);
    expect(setExpiration(env.vault, id, "2026-12-31").changed).toBe(false);
    expect(setExpiration(env.vault, "pref-expire", "2026-12-01").changed).toBe(true);
    expect(setExpiration(env.vault, "pref-expire", "none").changed).toBe(true);
    expect(brainOutsideLog(env.vault)).toEqual(before);
    const [signal] = readSignals({ vault: env.vault });
    expect(signal?.frontmatter["expiration_date"]).toBe("2026-12-31");
    expect(readPreferences({ vault: env.vault })[0]?.fields["expiration_date"]).toBeNull();
  });

  test("the authored_at backfill writes the field as a signal-state record", () => {
    env = switchedEnv();
    const { id } = writeSignal(
      env.vault,
      signalInput("session", { source_type: "session", valid_from: "2026-11-05T08:00:00Z" }),
    );
    const before = brainOutsideLog(env.vault);
    const dry = planAuthoredAtBackfill(env.vault);
    expect(dry.candidates.map((c) => c.authoredAt)).toEqual(["2026-11-05T08:00:00Z"]);
    expect(records(env, SIGNAL_STATE_KIND)).toEqual([]);
    expect(planAuthoredAtBackfill(env.vault, { apply: true }).updated).toBe(1);
    expect(planAuthoredAtBackfill(env.vault, { apply: true }).updated).toBe(0);
    expect(brainOutsideLog(env.vault)).toEqual(before);
    const [signal] = readSignals({ vault: env.vault });
    expect(signal).toMatchObject({ id, state: "active" });
    expect(signal?.frontmatter["authored_at"]).toBe("2026-11-05T08:00:00Z");
  });

  test("the backfill names the page a consumed or expired signal sits at", () => {
    env = switchedEnv();
    const session = (slug: string) =>
      signalInput(slug, { source_type: "session", valid_from: "2026-11-05T08:00:00Z" });
    const consumed = writeSignal(env.vault, session("eaten")).id;
    const expired = writeSignal(env.vault, session("lapsed")).id;
    for (const [id, state] of [
      [consumed, "consumed"],
      [expired, "expired"],
    ] as const) {
      routeSignalState({
        vault: env.vault,
        id,
        state,
        authority: "agent",
        legacy: () => undefined,
      });
    }
    const paths = planAuthoredAtBackfill(env.vault).candidates.map((c) => c.path);
    expect(paths.toSorted()).toEqual(
      [
        join(env.vault, "Brain", "inbox", "processed", `${consumed}.md`),
        join(env.vault, "Brain", "inbox", `${expired}.md`),
      ].toSorted(),
    );
  });

  test("staged signals are listed from the fold, approved and rejected as records", () => {
    env = switchedEnv();
    const a = stagePendingSignal(env.vault, signalInput("approve-me"));
    const b = stagePendingSignal(env.vault, signalInput("reject-me"));
    const before = brainOutsideLog(env.vault);
    expect(listPending(env.vault).map((e) => e.id)).toEqual([a.id, b.id]);
    applyPending(env.vault, a.id);
    rejectPending(env.vault, b.id, "not a rule");
    expect(brainOutsideLog(env.vault)).toEqual(before);
    expect(listPending(env.vault)).toEqual([]);
    const states = readSignals({ vault: env.vault }, { states: "all" }).map((s) => [s.id, s.state]);
    expect(states).toEqual([
      [a.id, "active"],
      [b.id, "rejected"],
    ]);
    expect(() => applyPending(env!.vault, b.id)).toThrow();
  });
});

describe("preference page writers once switched", () => {
  test("a merge rewrites keep and retires drop as records", () => {
    env = switchedEnv();
    writePreference(env.vault, prefInput("keep"), { authority: "agent" });
    writePreference(env.vault, prefInput("drop"), { authority: "agent" });
    const before = brainOutsideLog(env.vault);
    mergePreferences(env.vault, "pref-keep", "pref-drop", { bypassEntityGuard: true });
    expect(brainOutsideLog(env.vault)).toEqual(before);
    expect(readPreferences({ vault: env.vault }).map((p) => p.id)).toEqual(["pref-keep"]);
    expect(loadPreference(env.vault, "drop")).toBeNull();
  });

  test("a merge retried after its retire step failed copies the evidence once", () => {
    env = switchedEnv();
    writePreference(env.vault, prefInput("keep"), { authority: "agent" });
    writePreference(env.vault, prefInput("drop"), { authority: "agent" });
    for (const artifact of ["[[notes/a]]", "[[notes/b]]"]) {
      appendApplyEvidence(env.vault, {
        pref_id: "pref-drop",
        artifact,
        agent: "claude",
        result: "applied",
      });
    }
    mergePreferences(env.vault, "pref-keep", "pref-drop", { bypassEntityGuard: true });
    // The state a merge leaves when its retire step fails: the keep holds
    // the copied evidence and the drop is still active.
    appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "events",
      kind: "preference-set",
      agent: "test",
      body: { authority: "human", preference: "pref-drop", fields: { status: "confirmed" } },
    });
    expect(loadPreference(env.vault, "drop")).not.toBeNull();
    mergePreferences(env.vault, "pref-keep", "pref-drop", { bypassEntityGuard: true });
    const keep = readPreferences({ vault: env.vault }).find((p) => p.id === "pref-keep");
    expect(keep?.counters.applied_count).toBe(2);
  });

  test("merge pointers and lint consolidation read and write the fold", () => {
    env = switchedEnv();
    writePreference(env.vault, prefInput("a", { principle: "see [[pref-b]] first" }), {
      authority: "agent",
    });
    writePreference(env.vault, prefInput("b"), { authority: "agent" });
    writePreference(env.vault, prefInput("c"), { authority: "agent" });
    const before = brainOutsideLog(env.vault);
    expect(setMergedInto(env.vault, "pref-b", "pref-c").changed).toBe(true);
    expect(resolveCanonicalId(env.vault, "pref-b")).toBe("pref-c");
    expect(() => setMergedInto(env!.vault, "pref-c", "pref-b")).toThrow(/resolves/);
    // The canonical lives in the fold, with no page file: not dangling.
    const issues: DoctorIssue[] = [];
    mergeChainDanglingCheck.run(
      { vault: env.vault } as unknown as Parameters<typeof mergeChainDanglingCheck.run>[0],
      { issues, uncertain: [] },
    );
    expect(issues).toEqual([]);
    const report = lintConsolidate(env.vault, { apply: true });
    expect(report.fixes.map((f) => [f.from, f.to])).toEqual([["pref-b", "pref-c"]]);
    expect(report.filesWritten).toBe(1);
    expect(brainOutsideLog(env.vault)).toEqual(before);
    expect(loadPreference(env.vault, "a")?.principle).toBe("see [[pref-c]] first");
  });

  test("the merge-chain check reads the store of the doctor's explicit config", () => {
    env = switchedEnv();
    writePreference(env.vault, prefInput("b"), { authority: "agent" });
    writePreference(env.vault, prefInput("c"), { authority: "agent" });
    expect(setMergedInto(env.vault, "pref-b", "pref-c").changed).toBe(true);
    writePreference(env.vault, prefInput("c-gone"), { authority: "agent" });
    expect(setMergedInto(env.vault, "pref-c", "pref-c-gone").changed).toBe(true);
    // The canonical is forgotten: the pointer to it now dangles.
    appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "events",
      kind: "preference-remove",
      agent: "test",
      body: { authority: "human", preference: "pref-c-gone" },
    });
    // Only the explicit config names this machine's device.
    delete process.env["O2B_DEVICE_ID"];
    const explicit = join(env.parent, "explicit.yaml");
    writeFileSync(explicit, `vault: ${env.vault}\ndevice_id: dev-a\n`);
    const issues: DoctorIssue[] = [];
    mergeChainDanglingCheck.run(
      { vault: env.vault, configPath: explicit } as unknown as Parameters<
        typeof mergeChainDanglingCheck.run
      >[0],
      { issues, uncertain: [] },
    );
    expect(issues.map((i) => i.target)).toEqual(["pref-c-gone"]);
  });

  test("an imported page text and its edit history are records only", () => {
    env = switchedEnv();
    const before = brainOutsideLog(env.vault);
    writePreferencePageText(
      env.vault,
      "imported",
      [
        "---",
        "kind: brain-preference",
        "id: pref-imported",
        "created_at: 2026-11-01T00:00:00Z",
        "unconfirmed_until: 2026-11-30T00:00:00Z",
        "tags: [brain/preference]",
        "topic: imported",
        "_status: confirmed",
        "principle: Imported rule",
        "pinned: false",
        "_confidence_value: 0.25",
        "---",
        "",
      ].join("\n"),
    );
    const entry = {
      revision: 1,
      field: "principle",
      before: null,
      after: "x",
      ts: "t",
      agent: "a",
    };
    expect(appendEditHistory(env.vault, "imported", [entry])).toBe(1);
    expect(appendEditHistory(env.vault, "imported", [entry])).toBe(0);
    expect(readEditHistory(env.vault, "imported")).toEqual([entry]);
    expect(brainOutsideLog(env.vault)).toEqual(before);
    const [pref] = readPreferences({ vault: env.vault });
    expect(pref?.fields).toMatchObject({
      principle: "Imported rule",
      pinned: false,
      confidence_value: 0.25,
    });
  });
});

describe("lint consolidation once switched", () => {
  test("a merged link in a preference's prose is reported and repaired", () => {
    env = switchedEnv();
    writePreference(env.vault, prefInput("b"), { authority: "agent" });
    writePreference(env.vault, prefInput("c"), { authority: "agent" });
    writePreferencePageText(
      env.vault,
      "prose",
      [
        "---",
        "kind: brain-preference",
        "id: pref-prose",
        "topic: prose",
        "principle: plain",
        "_status: confirmed",
        "created_at: 2026-11-01T00:00:00Z",
        "unconfirmed_until: 2026-11-30T00:00:00Z",
        "_evidenced_by: []",
        "tags: [brain, brain/preference, brain/topic/prose]",
        "---",
        "",
        "Read [[pref-b]] before this one.",
        "",
      ].join("\n"),
    );
    setMergedInto(env.vault, "pref-b", "pref-c");
    const report = lintConsolidate(env.vault, { apply: true });
    expect(report.fixes.map((f) => [f.from, f.to])).toContainEqual(["pref-b", "pref-c"]);
    const prose = readPreferences({ vault: env.vault }).find((p) => p.id === "pref-prose");
    expect(JSON.stringify(prose?.fields)).toContain("[[pref-c]]");
  });
});

describe("a wikilink retarget once switched", () => {
  test("a counting pass reports the store's pages the applying pass rewrites, and writes nothing", () => {
    env = switchedEnv();
    writePreference(env.vault, prefInput("linker", { principle: "see [[old-note]] first" }), {
      authority: "agent",
    });
    const retarget = [{ from: "old-note", to: "new-note" }];
    const before = partitionRecords(env.storeRoot, "shared").length;
    const counted = retargetWikilinks(env.vault, retarget, { apply: false });
    expect(counted.matched).toEqual(["Brain/preferences/pref-linker.md"]);
    expect(partitionRecords(env.storeRoot, "shared")).toHaveLength(before);
    const applied = retargetWikilinks(env.vault, retarget, { apply: true });
    expect(applied.matched).toEqual(counted.matched);
    expect(applied.rewritten).toEqual(["Brain/preferences/pref-linker.md"]);
  });
});

describe("an edit-history append once switched", () => {
  test("lands in one partition: private when any of its rows is", () => {
    env = switchedEnv();
    writePreference(env.vault, prefInput("edited"), { authority: "agent" });
    const row = (field: string, after: string) => ({
      revision: 2,
      field,
      before: null,
      after,
      ts: "t",
      agent: "a",
    });
    appendEditHistory(env.vault, "edited", [
      row("scope", "coding"),
      row("principle", "see <private>the secret</private>"),
    ]);
    expect(ledgerRows(env.storeRoot, "shared", "edit-history")).toEqual([]);
    expect(ledgerRows(env.storeRoot, "private", "edit-history")).toHaveLength(2);
  });
});

describe("unswitched machines keep the legacy tree", () => {
  test("an approve moves the page and dual-writes its signal-state record", () => {
    env = makeStoreEnv("osb-wp1-lifecycle-legacy-");
    const { id } = stagePendingSignal(env.vault, signalInput("legacy-approve"));
    applyPending(env.vault, id);
    expect(existsSync(join(env.vault, "Brain", "inbox", `${id}.md`))).toBe(true);
    expect(records(env, SIGNAL_STATE_KIND).map((r) => r.body["state"])).toEqual(["approved"]);
  });

  test("an expiration of a private preference and its log event stay out of shared", () => {
    env = makeStoreEnv("osb-wp1-lifecycle-legacy-private-");
    writePreference(env.vault, prefInput("secret", { visibility: ["private"] }), {
      authority: "agent",
    });
    const sharedBefore = partitionRecords(env.storeRoot, "shared").length;
    expect(setExpiration(env.vault, "pref-secret", "2026-12-01").changed).toBe(true);
    const added = partitionRecords(env.storeRoot, "shared").slice(sharedBefore);
    expect(added.filter((r) => JSON.stringify(r.body).includes("secret"))).toEqual([]);
    const privateRecords = partitionRecords(env.storeRoot, "private").map((r) => r.kind);
    expect(privateRecords).toContain("log-event");
  });

  test("an expiration rewrites the page and dual-writes the field", () => {
    env = makeStoreEnv("osb-wp1-lifecycle-legacy-");
    const { id, path } = writeSignal(env.vault, signalInput("legacy-expire"));
    setExpiration(env.vault, id, "2026-12-31");
    expect(readFileSync(path, "utf8")).toContain("expiration_date: 2026-12-31");
    expect(records(env, SIGNAL_STATE_KIND).map((r) => r.body["fields"])).toEqual([
      { expiration_date: "2026-12-31" },
    ]);
  });
});
