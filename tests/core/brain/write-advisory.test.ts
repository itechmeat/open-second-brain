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
import {
  adviseOnIncoming,
  type PreferenceForContradiction,
} from "../../../src/core/brain/health/contradiction.ts";
import { NEAR_DUPLICATE_MIN_TOKENS } from "../../../src/core/brain/near-duplicate.ts";
import { BRAIN_HEALTH_DEFAULTS } from "../../../src/core/brain/policy.ts";
import { createRouteScope, ROUTE_STAGE } from "../../../src/core/route-scope.ts";

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
    // Capture stderr so we can assert the degradation is VISIBLE, not a
    // silently-swallowed failure.
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write;
    try {
      const advisory = adviseIncomingFeedback(vault, {
        principle: "always indent source with tabs not spaces",
        scope: "coding",
        agent: "test-agent",
        now: NOW,
      });
      expect(advisory).toBeNull();
      expect(captured).toContain("write-conflict advisory computation failed");
    } finally {
      process.stderr.write = originalStderrWrite;
    }
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

/** A confirmed `coding` preference as `adviseOnIncoming` reads it. */
function codingPref(id: string, principle: string): PreferenceForContradiction {
  return {
    id,
    principle,
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    scope: "coding",
    evidenced_by: [],
  };
}

/**
 * The advisory scores through the shared near-duplicate kernel. Its output
 * and its log line stay what they were, the threshold still comes from the
 * operator-configurable health default, and the one allowed change is that
 * a principle under the kernel's minimum token count no longer advises.
 */
describe("adviseIncomingFeedback - scored through the shared kernel", () => {
  const PRINCIPLE = "always indent source with tabs not spaces";

  test("the advisory and its log line are byte-identical to the shipped shape", () => {
    confirmPref("tabs", PRINCIPLE, "coding");
    const advisory = adviseIncomingFeedback(vault, {
      principle: PRINCIPLE,
      scope: "coding",
      agent: "test-agent",
      now: NOW,
    });
    expect(advisory).toEqual({
      scope: "coding",
      conflicts: [{ pref_id: "pref-tabs", jaccard: 1 }],
    });
    const events = readAllLogEntries(vault).filter(
      (e) => e.eventType === BRAIN_LOG_EVENT_KIND.writeConflictAdvisory,
    );
    expect(events.map((e) => e.body)).toEqual([
      {
        scope: "coding",
        conflicts: ["[[pref-tabs]] jaccard=1.000"],
        agent: "test-agent",
        origin_channel: "unset",
      },
    ]);
  });

  test("an unscoped principle compares against the unscoped bucket only", () => {
    confirmPref("tabs", PRINCIPLE);
    confirmPref("scoped", PRINCIPLE, "coding");
    const advisory = adviseIncomingFeedback(vault, { principle: PRINCIPLE, agent: "a", now: NOW });
    expect(advisory).toEqual({ scope: null, conflicts: [{ pref_id: "pref-tabs", jaccard: 1 }] });
  });

  test("the threshold is the health default, inclusive", () => {
    const threshold = BRAIN_HEALTH_DEFAULTS.contradiction_jaccard;
    expect(threshold).toBe(0.5);
    // 4 shared tokens over an 8-token union is exactly 0.5.
    const at = adviseOnIncoming("alpha bravo charlie delta echo foxtrot", "coding", [
      codingPref("pref-at", "alpha bravo charlie delta golf hotel"),
      // 3 shared over 9 is below the bar.
      codingPref("pref-below", "alpha bravo charlie golf hotel india"),
    ]);
    expect(at).toEqual({ scope: "coding", conflicts: [{ prefId: "pref-at", jaccard: 0.5 }] });
  });

  test("a principle under the kernel's minimum token count no longer advises", () => {
    const short = "use tabs always";
    expect(short.split(" ").length).toBeLessThan(NEAR_DUPLICATE_MIN_TOKENS);
    confirmPref("short", short, "coding");
    const advisory = adviseIncomingFeedback(vault, {
      principle: short,
      scope: "coding",
      agent: "test-agent",
      now: NOW,
    });
    expect(advisory).toBeNull();
    expect(
      readAllLogEntries(vault).filter(
        (e) => e.eventType === BRAIN_LOG_EVENT_KIND.writeConflictAdvisory,
      ),
    ).toEqual([]);
  });
});

describe("adviseIncomingFeedback - stage timing", () => {
  test("a feedback advisory records near_duplicate_lookup in the open route scope", async () => {
    confirmPref("tabs", "always indent source with tabs not spaces", "coding");
    const scope = createRouteScope();
    await scope.run(async () =>
      adviseIncomingFeedback(vault, {
        principle: "always indent source with tabs not spaces",
        scope: "coding",
        agent: "test-agent",
        now: NOW,
      }),
    );
    const stage = scope.stages()?.find((s) => s.name === ROUTE_STAGE.nearDuplicateLookup);
    expect(stage).toBeDefined();
    expect(Number.isFinite(stage!.ms)).toBe(true);
    expect(stage!.ms).toBeGreaterThanOrEqual(0);
  });

  test("with no scope open the advisory is unchanged", () => {
    confirmPref("tabs", "always indent source with tabs not spaces", "coding");
    const advisory = adviseIncomingFeedback(vault, {
      principle: "always indent source with tabs not spaces",
      scope: "coding",
      agent: "test-agent",
      now: NOW,
    });
    expect(advisory).toEqual({
      scope: "coding",
      conflicts: [{ pref_id: "pref-tabs", jaccard: 1 }],
    });
  });
});
