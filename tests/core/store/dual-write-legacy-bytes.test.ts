/**
 * Dual writes leave the legacy files byte-identical (task 1.11): the same
 * writer sequence run into two fresh vaults, one with the flag off and one
 * with it on, produces the same bytes in every file under `Brain/`. Both
 * runs share one fixed clock, so only ids a run mints itself can differ,
 * and those are masked.
 *
 * Everything lives under one named temp parent, removed in teardown, with
 * its own HOME, state base and store root.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import {
  appendPinnedContext,
  clearPinnedContext,
  writePinnedContext,
} from "../../../src/core/brain/pinned.ts";
import { moveToRetired, writePreference } from "../../../src/core/brain/preference.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { appendClaimEvent } from "../../../src/core/brain/truth/store.ts";
import { appendAuditRecord } from "../../../src/core/reliability/audit.ts";
import { STORE_DUAL_WRITE_ENV, STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { initStore } from "../../../src/core/store/store-init.ts";

const ENV_KEYS = [
  STORE_DUAL_WRITE_ENV,
  STORE_ROOT_ENV,
  "O2B_DEVICE_ID",
  "HOME",
  "XDG_STATE_HOME",
  "LOCALAPPDATA",
] as const;

const NOW = new Date("2026-11-06T10:00:00Z");

let parent: string;
let storeRoot: string;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  parent = mkdtempSync(join(tmpdir(), "osb-dual-write-bytes-"));
  storeRoot = join(parent, "store");
  process.env["HOME"] = join(parent, "home");
  process.env["XDG_STATE_HOME"] = join(parent, "state");
  process.env["LOCALAPPDATA"] = join(parent, "state");
  process.env[STORE_ROOT_ENV] = storeRoot;
  process.env["O2B_DEVICE_ID"] = "dev-a";
  initStore({ root: storeRoot });
  setSystemTime(NOW);
});

afterEach(() => {
  setSystemTime();
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Every legacy writer the trial taps, in one fixed sequence. */
function runWriters(vault: string): void {
  writeSignal(vault, {
    topic: "bytes",
    signal: "positive",
    agent: "claude",
    principle: "Keep the legacy bytes",
    created_at: "2026-11-06T10:00:00Z",
    date: "2026-11-06",
    slug: "bytes",
    scope: "coding",
    raw: "the user said so",
  });
  appendLogEvent(vault, {
    timestamp: "2026-11-06T10:01:00Z",
    eventType: "note",
    agent: "claude",
    body: { text: "a milestone" },
  });
  writePinnedContext(vault, "first");
  appendPinnedContext(vault, "second");
  clearPinnedContext(vault);
  const pref = writePreference(vault, {
    slug: "bytes",
    topic: "bytes",
    principle: "principle bytes",
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-30T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-05-02T00:00:00Z",
    evidenced_by: [],
    confidence: "high",
  }).path;
  appendApplyEvidence(vault, {
    pref_id: "pref-bytes",
    artifact: "[[some-note]]",
    result: "applied",
    agent: "claude",
  });
  moveToRetired(vault, pref, "user-rejected", { now: NOW, retired_by: "[[operator]]" });
  appendAuditRecord(join(vault, "Brain", "log", "hygiene"), {
    timestamp: "2026-11-06T10:02:00Z",
    actor: "claude",
    action: "apply",
    target: "note",
    ok: true,
  });
  appendClaimEvent(vault, {
    ts: "2026-11-06T10:03:00Z",
    agent: "claude",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Google",
    source: "https://example.com/about",
  });
}

/** Ids a run mints itself: ULIDs, UUIDs and the 32-hex vault id. */
const RUN_LOCAL_ID_RE =
  /\b[0-9A-HJKMNP-TV-Z]{26}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{32}\b/gi;

function brainFiles(vault: string): Map<string, string> {
  const root = join(vault, "Brain");
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = relative(root, full).split("\\").join("/");
        out.set(rel, readFileSync(full, "latin1").replace(RUN_LOCAL_ID_RE, "<id>"));
      }
    }
  };
  walk(root);
  return out;
}

function runInFreshVault(name: string, flag: boolean): Map<string, string> {
  if (flag) process.env[STORE_DUAL_WRITE_ENV] = "1";
  else delete process.env[STORE_DUAL_WRITE_ENV];
  // One vault name in both runs: the manual records it.
  const vault = join(parent, name, "vault");
  mkdirSync(vault, { recursive: true });
  bootstrapBrain(vault);
  runWriters(vault);
  return brainFiles(vault);
}

describe("the legacy files with the flag off and on", () => {
  test("are byte-identical under Brain/, and only the run with the flag on fills the store", () => {
    const off = runInFreshVault("off", false);
    const recordsAfterOff = readPartition(join(storeRoot, "shared")).length;
    const on = runInFreshVault("on", true);
    expect(recordsAfterOff).toBe(0);
    expect(readPartition(join(storeRoot, "shared")).length).toBeGreaterThan(0);

    expect([...on.keys()].toSorted()).toEqual([...off.keys()].toSorted());
    // Non-vacuous: the writers really wrote into each tree.
    expect(off.size).toBeGreaterThan(5);
    for (const [rel, bytes] of off) expect(on.get(rel), rel).toBe(bytes);
  });
});
