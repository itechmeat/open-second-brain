/**
 * Dual-written records whose text carries a `<private>` region, or the
 * placeholder a stripped region leaves, go to `private` only: a Brain log
 * event, a signal, a preference, a preference-evidence record and a ledger
 * row that would otherwise go to `private` only when this machine holds it.
 *
 * Every test runs against its own temp HOME, state base, vault and store
 * root under one named parent, removed in teardown.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { appendBrainNote } from "../../../src/core/brain/note.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { appendClaimEvent } from "../../../src/core/brain/truth/store.ts";
import {
  PREFERENCE_EVIDENCE_KIND,
  PREFERENCE_SET_KIND,
  SIGNAL_KIND,
  STORE_DUAL_WRITE_ENV,
  STORE_ROOT_ENV,
} from "../../../src/core/store/constants.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { initStore } from "../../../src/core/store/store-init.ts";

const ENV_KEYS = [
  STORE_DUAL_WRITE_ENV,
  STORE_ROOT_ENV,
  "O2B_DEVICE_ID",
  "HOME",
  "XDG_STATE_HOME",
  "LOCALAPPDATA",
  "OPEN_SECOND_BRAIN_CONFIG",
] as const;

let parent: string;
let vault: string;
let storeRoot: string;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  parent = mkdtempSync(join(tmpdir(), "osb-private-regions-"));
  vault = join(parent, "vault");
  storeRoot = join(parent, "store");
  mkdirSync(vault, { recursive: true });
  bootstrapBrain(vault);
  process.env["HOME"] = join(parent, "home");
  process.env["XDG_STATE_HOME"] = join(parent, "state");
  process.env["LOCALAPPDATA"] = join(parent, "state");
  process.env[STORE_ROOT_ENV] = storeRoot;
  process.env["O2B_DEVICE_ID"] = "dev-a";
  process.env[STORE_DUAL_WRITE_ENV] = "1";
  initStore({ root: storeRoot });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function records(partition: "shared" | "private"): StoreRecord[] {
  return readPartition(join(storeRoot, partition)).flatMap((s) => s.records);
}

function logEvents(partition: "shared" | "private"): StoreRecord[] {
  return readPartition(join(storeRoot, partition))
    .filter((s) => s.rel.startsWith("log/"))
    .flatMap((s) => s.records);
}

function ofKind(partition: "shared" | "private", kind: string): StoreRecord[] {
  return records(partition).filter((r) => r.kind === kind);
}

function ledgerRows(partition: "shared" | "private", ledger: string): StoreRecord[] {
  return readPartition(join(storeRoot, partition))
    .filter((s) => s.rel.startsWith(`ledgers/${ledger}/`))
    .flatMap((s) => s.records);
}

function seedPreference(slug: string, extra: Record<string, unknown> = {}): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `principle ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-30T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-05-02T00:00:00Z",
    evidenced_by: [],
    confidence: "high",
    ...extra,
  });
}

describe("log events", () => {
  test("a note whose text had a <private> region goes to private only", () => {
    appendBrainNote({
      vault,
      text: "met <private>the landlord about the lease</private> today",
      agent: "claude",
    });
    expect(logEvents("shared")).toEqual([]);
    expect(logEvents("private").length).toBe(1);
  });

  test("an event whose body carries an unstripped <private> region goes to private only", () => {
    appendLogEvent(vault, {
      timestamp: "2026-11-06T10:01:00Z",
      eventType: "note",
      agent: "claude",
      body: { text: "keep <private>this</private> local" },
    });
    expect(logEvents("shared")).toEqual([]);
    expect(logEvents("private").length).toBe(1);
  });

  test("an event with no region and no private reference still goes to shared", () => {
    appendBrainNote({ vault, text: "a plain milestone", agent: "claude" });
    expect(logEvents("shared").length).toBe(1);
    expect(logEvents("private")).toEqual([]);
  });

  test("on a machine without the private partition the event is refused, not shared", () => {
    rmSync(join(storeRoot, "private"), { recursive: true, force: true });
    appendBrainNote({ vault, text: "a <private>secret</private> note", agent: "claude" });
    expect(logEvents("shared")).toEqual([]);
  });
});

describe("other dual-written records", () => {
  test("a signal whose principle carries a <private> region goes to private only", () => {
    writeSignal(vault, {
      topic: "lease",
      signal: "positive",
      agent: "claude",
      principle: "Ask <private>the landlord</private> before renewing",
      created_at: "2026-11-06T10:00:00Z",
      date: "2026-11-06",
      slug: "lease",
    });
    expect(ofKind("shared", SIGNAL_KIND)).toEqual([]);
    expect(ofKind("private", SIGNAL_KIND).length).toBe(1);
  });

  test("a preference whose principle carries a <private> region goes to private only", () => {
    seedPreference("lease", { principle: "Ask <private>the landlord</private> first" });
    expect(ofKind("shared", PREFERENCE_SET_KIND)).toEqual([]);
    expect(ofKind("private", PREFERENCE_SET_KIND).length).toBeGreaterThan(0);
  });

  test("evidence whose artifact carries a <private> region goes to private only", () => {
    seedPreference("open");
    appendApplyEvidence(vault, {
      pref_id: "pref-open",
      artifact: "draft <private>for the landlord</private>",
      result: "applied",
      agent: "claude",
    });
    expect(ofKind("shared", PREFERENCE_EVIDENCE_KIND)).toEqual([]);
    expect(ofKind("private", PREFERENCE_EVIDENCE_KIND).length).toBe(1);
  });

  test("evidence whose artifact names a private page follows its log event to private", () => {
    seedPreference("open");
    const path = join(vault, "Notes/secret.md");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "---\nvisibility: [private]\n---\nbody\n");
    appendApplyEvidence(vault, {
      pref_id: "pref-open",
      artifact: "[[Notes/secret]]",
      result: "applied",
      agent: "claude",
    });
    expect(logEvents("private").length).toBe(1);
    expect(ofKind("shared", PREFERENCE_EVIDENCE_KIND)).toEqual([]);
    expect(ofKind("private", PREFERENCE_EVIDENCE_KIND).length).toBe(1);
  });

  test("a claim whose value carries a <private> region is refused, not shared, on a machine without private", () => {
    rmSync(join(storeRoot, "private"), { recursive: true, force: true });
    appendClaimEvent(vault, {
      ts: "2026-06-01T10:00:00Z",
      agent: "claude",
      entity: "Alice Mason",
      aspect: "address",
      value: "<private>12 Elm Street</private>",
      source: "https://example.com/directory",
    });
    expect(ledgerRows("shared", "truth-claims")).toEqual([]);
  });
});
