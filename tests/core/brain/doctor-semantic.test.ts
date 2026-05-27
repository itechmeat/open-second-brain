/**
 * Doctor integration of the semantic-health detectors (F6, Task 8).
 *
 * runDoctor calls the contradiction / concept-gap / stale-claim
 * detectors best-effort, merges their findings into the warning stream
 * with dedicated codes, and attaches a semantic_health report. The
 * doctor stays non-mutating.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import {
  BRAIN_PREFERENCE_STATUS,
  BRAIN_SIGNAL_SIGN,
  type BrainSignalSign,
} from "../../../src/core/brain/types.ts";

const NOW = new Date("2026-05-27T00:00:00Z");
let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-doctor-semantic-"));
  const d = brainDirs(vault);
  for (const dir of [d.brain, d.inbox, d.processed, d.preferences, d.retired, d.log]) {
    mkdirSync(dir, { recursive: true });
  }
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function sig(slug: string, sign: BrainSignalSign, principle: string): string {
  return writeSignal(vault, {
    topic: "indentation",
    signal: sign,
    agent: "tester",
    principle,
    created_at: "2026-05-01T00:00:00Z",
    date: "2026-05-01",
    slug,
  }).id;
}

function confirmedPref(
  slug: string,
  topic: string,
  principle: string,
  evidenced_by: ReadonlyArray<string>,
): void {
  writePreference(
    vault,
    {
      slug,
      topic,
      principle,
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      confirmed_at: "2026-05-08T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by,
    },
    { overwrite: true },
  );
}

describe("runDoctor semantic health", () => {
  test("flags contradictory confirmed preferences and escalates the verdict", () => {
    const pos = sig("tabs-pos", BRAIN_SIGNAL_SIGN.positive, "use tabs");
    const neg = sig("tabs-neg", BRAIN_SIGNAL_SIGN.negative, "use spaces");
    confirmedPref("tabs-rule", "tabs-rule", "always indent source with tabs not spaces", [
      `[[${pos}]]`,
    ]);
    confirmedPref("spaces-rule", "spaces-rule", "never indent source with tabs always spaces", [
      `[[${neg}]]`,
    ]);

    const result = runDoctor(vault, { now: NOW });
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("contradictory-preferences");
    expect(result.semantic_health?.verdict).toBe("investigate");
    expect(result.semantic_health?.contradictions.length).toBe(1);
  });

  test("a coherent vault produces no semantic warnings and a clean verdict", () => {
    const pos = sig("tdd-pos", BRAIN_SIGNAL_SIGN.positive, "write tests early");
    confirmedPref(
      "tdd-rule",
      "testing-discipline",
      "write unit tests before merging code",
      [`[[${pos}]]`],
    );

    const result = runDoctor(vault, { now: NOW });
    const semanticCodes = result.warnings
      .map((w) => w.code)
      .filter((c) => ["contradictory-preferences", "concept-gap", "stale-claim"].includes(c));
    expect(semanticCodes).toEqual([]);
    expect(result.semantic_health?.verdict).toBe("clean");
  });

  test("does not throw on a vault and always returns a semantic_health report", () => {
    expect(() => runDoctor(vault, { now: NOW })).not.toThrow();
    expect(runDoctor(vault, { now: NOW }).semantic_health).toBeDefined();
  });
});
