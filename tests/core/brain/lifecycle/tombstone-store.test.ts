/**
 * Forgetting one record on a switched vault (the single-record lifecycle
 * verbs, design D14): with the frozen legacy tree still on disk and after
 * it left, `tombstone` and `supersede` write the store record only, take
 * the legacy path, the bare id and `store:<id>`, and the record leaves
 * the readers at once. Unswitched, the page is written as before and the
 * same record is dual-written, so a peer that switched already sees it.
 * A target the store does not hold is refused and nothing is written.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { queryByRuleTopic } from "../../../../src/core/brain/query.ts";
import {
  supersede,
  tombstone,
  TombstoneError,
} from "../../../../src/core/brain/lifecycle/tombstone.ts";
import { temporalReplace } from "../../../../src/core/brain/lifecycle/temporal-replace.ts";
import { correct } from "../../../../src/core/brain/lifecycle/correction.ts";
import { preferenceStoreRecords } from "../../../../src/core/brain/preference.ts";
import { storeWrite } from "../../../../src/core/store/store-write.ts";
import { retireSignal } from "../../../../src/core/brain/signal-retire.ts";
import { setExpiration } from "../../../../src/core/brain/expiration-set.ts";
import { writePreference, loadPreference } from "../../../../src/core/brain/preference.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { renderActive } from "../../../../src/core/brain/active.ts";
import { readSignals } from "../../../../src/core/store/read/signals.ts";
import { readLanePage, writeLanePage } from "../../../../src/core/store/lane-pages.ts";
import type { StoreRecord } from "../../../../src/core/store/envelope.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { brainOutsideLog, partitionRecords, switchDevice } from "../store-only/fixtures.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const NOW = new Date("2026-11-21T12:00:00Z");

const signalInput = (slug: string) => ({
  topic: `topic ${slug}`,
  signal: "positive" as const,
  agent: "claude",
  principle: `Principle of ${slug}`,
  created_at: "2026-11-20T10:00:00Z",
  date: "2026-11-20",
  slug,
});

const prefInput = (slug: string) => ({
  slug,
  topic: slug,
  principle: `principle ${slug}`,
  created_at: "2026-11-01T00:00:00Z",
  unconfirmed_until: "2026-11-02T00:00:00Z",
  confirmed_at: "2026-11-02T00:00:00Z",
  status: "confirmed" as const,
  evidenced_by: [],
});

function records(e: StoreEnv, kind?: string): StoreRecord[] {
  return (["shared", "private"] as const)
    .flatMap((p) => partitionRecords(e.storeRoot, p))
    .filter((r) => kind === undefined || r.kind === kind);
}

/** A machine that switched with its frozen legacy tree still on disk. */
function switchedWithTree(): StoreEnv {
  const e = makeStoreEnv("osb-forget-tree-", { dualWrite: true });
  return e;
}

function signalTopic(vault: string, topic: string): string[] {
  return queryByRuleTopic(vault, topic).signals.map((s) => s.id);
}

function signalFrontmatter(vault: string, id: string): Record<string, unknown> | undefined {
  return readSignals({ vault }, { states: "all" }).find((s) => s.id === id)?.frontmatter;
}

describe("a switched machine with the legacy tree still on disk", () => {
  test("tombstone by legacy path writes the store record only and the signal leaves the readers", () => {
    env = switchedWithTree();
    // Captured before the switch: the page and its dual-written record.
    const sig = writeSignal(env.vault, signalInput("forget-me"));
    const kept = writeSignal(env.vault, signalInput("keep-me"));
    switchDevice(env.storeRoot);
    expect(existsSync(sig.path)).toBe(true);
    const pageBefore = readFileSync(sig.path, "utf8");
    const before = brainOutsideLog(env.vault);
    expect(signalTopic(env.vault, "topic forget-me")).toEqual([sig.id]);

    const rel = `Brain/inbox/${sig.id}.md`;
    const res = tombstone({ vault: env.vault, path: rel, reason: "wrong", agent: "t", now: NOW });
    expect(res.changed).toBe(true);
    expect(res.path).toBe(rel);
    // No byte under Brain/ changed: the frozen page still reads as before.
    expect(readFileSync(sig.path, "utf8")).toBe(pageBefore);
    expect(brainOutsideLog(env.vault)).toEqual(before);
    const [state] = records(env, "signal-state");
    expect(state?.body).toMatchObject({
      signal: sig.id,
      fields: { _status: "tombstoned", tombstone_reason: "wrong" },
    });
    expect(signalFrontmatter(env.vault, sig.id)?.["_status"]).toBe("tombstoned");
    expect(signalTopic(env.vault, "topic forget-me")).toEqual([]);
    expect(signalTopic(env.vault, "topic keep-me")).toEqual([kept.id]);
    // Its tombstone event went to the store's log, not the legacy day shard.
    expect(records(env, "log-event").some((r) => r.body["event_type"] === "tombstone")).toBe(true);
    // Idempotent: a second tombstone changes nothing and writes nothing.
    const count = records(env).length;
    expect(tombstone({ vault: env.vault, path: sig.id, reason: "again" }).changed).toBe(false);
    expect(records(env)).toHaveLength(count);
  });

  test("a preference tombstoned by store:<id> leaves the active preferences and the digest", () => {
    env = switchedWithTree();
    writePreference(env.vault, prefInput("tabs-rule"), { authority: "agent" });
    writePreference(env.vault, prefInput("spaces-rule"), { authority: "agent" });
    switchDevice(env.storeRoot);
    const before = brainOutsideLog(env.vault);
    const res = tombstone({ vault: env.vault, path: "store:pref-tabs-rule", reason: "drop it" });
    expect(res.changed).toBe(true);
    expect(res.path).toBe("Brain/preferences/pref-tabs-rule.md");
    expect(brainOutsideLog(env.vault)).toEqual(before);
    expect(loadPreference(env.vault, "spaces-rule")).not.toBeNull();
    const digest = renderActive(env.vault, { now: NOW }).body;
    expect(digest).toContain("spaces-rule");
    expect(digest).not.toContain("tabs-rule");
  });
});

function switchedNoTree(): StoreEnv {
  return makeStoreEnv("osb-forget-notree-", { dualWrite: true });
}

describe("a switched machine whose legacy tree left the vault", () => {
  test("tombstone takes the legacy path, the bare id and store:<id>", () => {
    env = switchedNoTree();
    const a = writeSignal(env.vault, signalInput("by-path"));
    const b = writeSignal(env.vault, signalInput("by-id"));
    const c = writeSignal(env.vault, signalInput("by-store"));
    switchDevice(env.storeRoot);
    rmSync(join(env.vault, "Brain"), { recursive: true, force: true });

    tombstone({ vault: env.vault, path: `Brain/inbox/${a.id}.md`, reason: "r" });
    tombstone({ vault: env.vault, path: b.id, reason: "r" });
    tombstone({ vault: env.vault, path: `store:${c.id}`, reason: "r" });
    expect(existsSync(join(env.vault, "Brain"))).toBe(false);
    for (const id of [a.id, b.id, c.id]) {
      expect(signalFrontmatter(env.vault, id)?.["_status"]).toBe("tombstoned");
    }
    expect(signalTopic(env.vault, "topic by-id")).toEqual([]);
  });

  test("supersede links the successor on the store record", () => {
    env = switchedNoTree();
    const a = writeSignal(env.vault, signalInput("old-fact"));
    const b = writeSignal(env.vault, signalInput("new-fact"));
    switchDevice(env.storeRoot);
    rmSync(join(env.vault, "Brain"), { recursive: true, force: true });
    const res = supersede({ vault: env.vault, predecessor: a.id, successor: b.id });
    expect(res.state.supersededBy).toBe(`[[${b.id}]]`);
    expect(signalFrontmatter(env.vault, a.id)).toMatchObject({
      _status: "tombstoned",
      superseded_by: `[[${b.id}]]`,
    });
  });

  test("temporal-replace closes and opens the two store records at one instant", () => {
    env = switchedNoTree();
    const a = writeSignal(env.vault, signalInput("fact-before"));
    const b = writeSignal(env.vault, signalInput("fact-after"));
    switchDevice(env.storeRoot);
    rmSync(join(env.vault, "Brain"), { recursive: true, force: true });
    const res = temporalReplace({
      vault: env.vault,
      predecessor: a.id,
      successor: `store:${b.id}`,
      at: "2026-11-21",
    });
    expect(res.at).toBe("2026-11-21");
    expect(signalFrontmatter(env.vault, a.id)).toMatchObject({
      valid_until: "2026-11-21",
      superseded_by: `[[${b.id}]]`,
    });
    expect(signalFrontmatter(env.vault, b.id)?.["valid_from"]).toBe("2026-11-21");
    expect(existsSync(join(env.vault, "Brain"))).toBe(false);
  });

  test("a lane entry is tombstoned by its path and by its name", () => {
    env = switchedNoTree();
    switchDevice(env.storeRoot);
    rmSync(join(env.vault, "Brain"), { recursive: true, force: true });
    const page = join(env.vault, "Brain", "dead-ends", "de-flaky-retry.md");
    writeLanePage(env.vault, page, { kind: "brain-dead-end", id: "de-flaky-retry" }, "Body.\n");
    tombstone({ vault: env.vault, path: "de-flaky-retry", reason: "solved" });
    expect(readLanePage(env.vault, page)?.frontmatter["_status"]).toBe("tombstoned");
    expect(existsSync(page)).toBe(false);
  });

  test("correct --apply closes the store record's validity, writing no page", () => {
    env = switchedNoTree();
    const a = writeSignal(env.vault, signalInput("corrected-fact"));
    switchDevice(env.storeRoot);
    rmSync(join(env.vault, "Brain"), { recursive: true, force: true });
    const res = correct({
      vault: env.vault,
      target: `store:${a.id}`,
      windowEnd: "2026-11-21",
      dryRun: false,
      now: NOW,
    });
    expect(res.retirements.map((r) => [r.path, r.endState, r.changed])).toEqual([
      [`Brain/inbox/${a.id}.md`, "validity_close", true],
    ]);
    expect(signalFrontmatter(env.vault, a.id)?.["valid_until"]).toBe("2026-11-21");
    expect(existsSync(join(env.vault, "Brain"))).toBe(false);
    const flat = writeSignal(env.vault, signalInput("flatly-wrong"));
    correct({ vault: env.vault, target: flat.id, flatlyWrong: true, dryRun: false, now: NOW });
    expect(signalFrontmatter(env.vault, flat.id)?.["_status"]).toBe("tombstoned");
  });

  test("a tombstone a human decision outranks is refused, never answered as done", () => {
    env = switchedNoTree();
    switchDevice(env.storeRoot);
    rmSync(join(env.vault, "Brain"), { recursive: true, force: true });
    writePreference(env.vault, prefInput("human-rule"), { authority: "agent" });
    // A human decided this preference's status (the operator's own shell).
    storeWrite(
      () =>
        preferenceStoreRecords("pref-human-rule", { status: "confirmed" }, "human", false, [
          "status",
        ]) ?? [],
      { vault: env!.vault },
    );
    // This process is no operator shell: the tombstone is an agent's. It is
    // refused before any record is appended (no inert record is left).
    const count = records(env).length;
    expect(() => tombstone({ vault: env!.vault, path: "pref-human-rule", reason: "r" })).toThrow(
      /would not be applied/,
    );
    expect(records(env)).toHaveLength(count);
    expect(loadPreference(env.vault, "human-rule")).not.toBeNull();
  });

  test("retire and expire, addressed by id, take store:<id> and the page path too", () => {
    env = switchedNoTree();
    const a = writeSignal(env.vault, signalInput("retire-by-store"));
    const b = writeSignal(env.vault, signalInput("expire-by-path"));
    switchDevice(env.storeRoot);
    rmSync(join(env.vault, "Brain"), { recursive: true, force: true });
    retireSignal(env.vault, `store:${a.id}`, { reason: "old", now: NOW });
    expect(
      readSignals({ vault: env.vault }, { states: "all" }).find((s) => s.id === a.id)?.state,
    ).toBe("retired");
    setExpiration(env.vault, `Brain/inbox/${b.id}.md`, "2026-12-01");
    expect(signalFrontmatter(env.vault, b.id)?.["expiration_date"]).toBe("2026-12-01");
    expect(existsSync(join(env.vault, "Brain"))).toBe(false);
  });

  test("a target the store does not hold is refused and nothing is written", () => {
    env = switchedNoTree();
    writeSignal(env.vault, signalInput("present"));
    switchDevice(env.storeRoot);
    rmSync(join(env.vault, "Brain"), { recursive: true, force: true });
    const count = records(env).length;
    for (const ref of [
      "sig-2026-11-20-absent",
      "Brain/inbox/sig-2026-11-20-absent.md",
      "store:sig-x",
    ]) {
      expect(() => tombstone({ vault: env!.vault, path: ref, reason: "r" })).toThrow(
        TombstoneError,
      );
    }
    expect(records(env)).toHaveLength(count);
  });
});

describe("an unswitched machine", () => {
  test("tombstone writes the page and dual-writes the store record; the bare id resolves too", () => {
    env = makeStoreEnv("osb-forget-legacy-", { dualWrite: true });
    const sig = writeSignal(env.vault, signalInput("legacy-forget"));
    const res = tombstone({ vault: env.vault, path: sig.id, reason: "wrong" });
    expect(res.path).toBe(`Brain/inbox/${sig.id}.md`);
    expect(readFileSync(sig.path, "utf8")).toContain("_status: tombstoned");
    const [state] = records(env, "signal-state");
    expect(state?.body).toMatchObject({ signal: sig.id, fields: { _status: "tombstoned" } });
    expect(signalTopic(env.vault, "topic legacy-forget")).toEqual([]);
  });
});
