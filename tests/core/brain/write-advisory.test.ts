/**
 * A4 (t_f79b4fe0): write-time conflict advisory seam.
 *
 * `adviseIncomingFeedback` loads confirmed same-scope preferences, runs
 * the pure `adviseOnIncoming` kernel, logs a `write-conflict-advisory`
 * event, and returns the advisory (or null). It never throws into the
 * write path: an advisory-computation failure degrades to a warning and a
 * null result while the surrounding write still succeeds.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { readAllLogEntries } from "../../../src/core/brain/query.ts";
import { routeExtractedFacts } from "../../../src/core/brain/fact-extract.ts";
import type { DedupIndexEntry } from "../../../src/core/brain/dedup-hash.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_PREFERENCE_STATUS } from "../../../src/core/brain/types.ts";
import { adviseIncomingFeedback } from "../../../src/core/brain/write-advisory.ts";

let tmp: string;
let vault: string;

const NOW = new Date("2026-07-18T12:00:00Z");

function confirmPref(slug: string, principle: string, scope?: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle,
    created_at: NOW.toISOString(),
    unconfirmed_until: NOW.toISOString(),
    confirmed_at: NOW.toISOString(),
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: ["[[sig-2026-07-18-seed]]"],
    ...(scope !== undefined ? { scope } : {}),
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-advisory-"));
  vault = join(tmp, "vault");
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("adviseIncomingFeedback", () => {
  test("returns an advisory naming a conflicting confirmed same-scope preference", () => {
    confirmPref("tabs", "always indent source with tabs not spaces", "coding");
    const advisory = adviseIncomingFeedback(vault, {
      principle: "always indent source with tabs not spaces",
      scope: "coding",
      agent: "test-agent",
      now: NOW,
    });
    expect(advisory).not.toBeNull();
    expect(advisory!.scope).toBe("coding");
    expect(advisory!.conflicts.map((c) => c.pref_id)).toEqual(["pref-tabs"]);
    expect(advisory!.conflicts[0]!.jaccard).toBeGreaterThanOrEqual(0.5);
  });

  test("returns null for a non-conflicting incoming principle", () => {
    confirmPref("tabs", "always indent source with tabs not spaces", "coding");
    const advisory = adviseIncomingFeedback(vault, {
      principle: "prefer semantic HTML over generic containers",
      scope: "coding",
      agent: "test-agent",
      now: NOW,
    });
    expect(advisory).toBeNull();
  });

  test("does not fire across scopes", () => {
    confirmPref("tabs", "always indent source with tabs not spaces", "coding");
    const advisory = adviseIncomingFeedback(vault, {
      principle: "always indent source with tabs not spaces",
      scope: "writing",
      agent: "test-agent",
      now: NOW,
    });
    expect(advisory).toBeNull();
  });

  test("logs a write-conflict-advisory event when it fires", () => {
    confirmPref("tabs", "always indent source with tabs not spaces", "coding");
    adviseIncomingFeedback(vault, {
      principle: "always indent source with tabs not spaces",
      scope: "coding",
      agent: "test-agent",
      now: NOW,
    });
    const entries = readAllLogEntries(vault);
    const advisoryEvents = entries.filter(
      (e) => e.eventType === BRAIN_LOG_EVENT_KIND.writeConflictAdvisory,
    );
    expect(advisoryEvents.length).toBe(1);
    const conflicts = advisoryEvents[0]!.body["conflicts"];
    expect(Array.isArray(conflicts)).toBe(true);
    expect((conflicts as ReadonlyArray<string>)[0]).toContain("[[pref-tabs]]");
  });

  test("degrades to a warning (returns null) when the preferences dir is unreadable", () => {
    // Replace the preferences directory with a FILE so readdirSync throws
    // ENOTDIR: the advisory computation must swallow the failure into a
    // warning and return null, never propagate an exception.
    const prefsDir = brainDirs(vault).preferences;
    rmSync(prefsDir, { recursive: true, force: true });
    writeFileSync(prefsDir, "not a directory");
    const advisory = adviseIncomingFeedback(vault, {
      principle: "always indent source with tabs not spaces",
      scope: "coding",
      agent: "test-agent",
      now: NOW,
    });
    expect(advisory).toBeNull();
  });

  test("the extracted-fact path never fires the advisory (no double-fire)", () => {
    // A confirmed preference exists that an extracted fact could resemble,
    // but routeExtractedFacts must NOT compute the advisory - it attaches
    // to the operator-facing feedback path only.
    confirmPref("url", "https://techmeat.dev", "coding");
    routeExtractedFacts(vault, {
      facts: [{ family: "url", text: "https://techmeat.dev", line: 1 }],
      agent: "claude-dev-agent",
      now: NOW,
      sessionRef: "s#1",
      dedup: new Map<string, DedupIndexEntry>(),
    });
    const advisoryEvents = readAllLogEntries(vault).filter(
      (e) => e.eventType === BRAIN_LOG_EVENT_KIND.writeConflictAdvisory,
    );
    expect(advisoryEvents.length).toBe(0);
  });
});
