/**
 * Task 5: `findStaleEntries(index, vault, cfg)`.
 *
 * Pure structural staleness: walks `Brain/preferences/`, `Brain/inbox/`,
 * and `Brain/log/` looking for entries older than the per-kind day
 * threshold. The TimelineIndex is consulted for the most-recent event
 * per preference so the staleness anchor is the last actually-observed
 * activity, not the file mtime.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTimelineIndex } from "../../../../src/core/brain/temporal/build-index.ts";
import { findStaleEntries } from "../../../../src/core/brain/temporal/stale-watch.ts";
import { BRAIN_TEMPORAL_DEFAULTS } from "../../../../src/core/brain/policy.ts";

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "o2b-temporal-stale-"));
  mkdirSync(join(dir, "Brain", "log"), { recursive: true });
  mkdirSync(join(dir, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(dir, "Brain", "inbox"), { recursive: true });
  return dir;
}

function writeFileMtime(path: string, content: string, mtimeIso: string): void {
  writeFileSync(path, content);
  const t = new Date(mtimeIso);
  utimesSync(path, t, t);
}

let VAULT: string;
const NOW = new Date("2026-05-25T00:00:00Z");
beforeEach(() => {
  VAULT = makeVault();
});

describe("findStaleEntries", () => {
  test("empty vault returns frozen empty envelope", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const out = findStaleEntries(idx, VAULT, BRAIN_TEMPORAL_DEFAULTS, {
      now: NOW,
    });
    expect(out.stalePreferences.length).toBe(0);
    expect(out.staleSignals.length).toBe(0);
    expect(out.staleLogFiles.length).toBe(0);
    expect(Object.isFrozen(out)).toBe(true);
  });

  test("preference stale when last_evidence_at older than stale_pref_days", () => {
    writeFileSync(
      join(VAULT, "Brain", "preferences", "pref-fresh.md"),
      `---\nid: pref-fresh\nkind: brain-preference\nstatus: confirmed\ncreated_at: 2026-04-01T00:00:00Z\nunconfirmed_until: 2026-04-14T00:00:00Z\ntags: ["brain"]\ntopic: fresh\nprinciple: Fresh\nevidenced_by: []\nconfidence: medium\nlast_evidence_at: 2026-05-20T00:00:00Z\n---\n`,
    );
    writeFileSync(
      join(VAULT, "Brain", "preferences", "pref-stale.md"),
      `---\nid: pref-stale\nkind: brain-preference\nstatus: confirmed\ncreated_at: 2025-12-01T00:00:00Z\nunconfirmed_until: 2025-12-14T00:00:00Z\ntags: ["brain"]\ntopic: stale\nprinciple: Stale\nevidenced_by: []\nconfidence: medium\nlast_evidence_at: 2026-01-01T00:00:00Z\n---\n`,
    );
    const idx = buildTimelineIndex(VAULT, {});
    const out = findStaleEntries(idx, VAULT, BRAIN_TEMPORAL_DEFAULTS, {
      now: NOW,
    });
    expect(out.stalePreferences.length).toBe(1);
    expect(out.stalePreferences[0]!.prefId).toBe("pref-stale");
    expect(out.stalePreferences[0]!.lastSeenAt).toBe("2026-01-01T00:00:00Z");
  });

  test("preference without last_evidence_at uses created_at as staleness anchor", () => {
    writeFileSync(
      join(VAULT, "Brain", "preferences", "pref-old.md"),
      `---\nid: pref-old\nkind: brain-preference\nstatus: unconfirmed\ncreated_at: 2025-10-01T00:00:00Z\nunconfirmed_until: 2025-10-14T00:00:00Z\ntags: ["brain"]\ntopic: old\nprinciple: Old\nevidenced_by: []\nconfidence: low\nlast_evidence_at: null\n---\n`,
    );
    const idx = buildTimelineIndex(VAULT, {});
    const out = findStaleEntries(idx, VAULT, BRAIN_TEMPORAL_DEFAULTS, {
      now: NOW,
    });
    expect(out.stalePreferences.length).toBe(1);
    expect(out.stalePreferences[0]!.lastSeenAt).toBe("2025-10-01T00:00:00Z");
  });

  test("signal stale when created_at older than stale_signal_days", () => {
    writeFileSync(
      join(VAULT, "Brain", "inbox", "sig-2026-03-15-fresh.md"),
      `---\nid: sig-2026-03-15-fresh\nkind: brain-signal\ncreated_at: 2026-05-15T00:00:00Z\ntags: ["brain"]\ntopic: fresh\nsignal: positive\nagent: claude\nprinciple: Fresh rule\n---\n`,
    );
    writeFileSync(
      join(VAULT, "Brain", "inbox", "sig-2026-01-01-stale.md"),
      `---\nid: sig-2026-01-01-stale\nkind: brain-signal\ncreated_at: 2026-01-01T00:00:00Z\ntags: ["brain"]\ntopic: stale\nsignal: positive\nagent: claude\nprinciple: Stale rule\n---\n`,
    );
    const idx = buildTimelineIndex(VAULT, {});
    const out = findStaleEntries(idx, VAULT, BRAIN_TEMPORAL_DEFAULTS, {
      now: NOW,
    });
    expect(out.staleSignals.length).toBe(1);
    expect(out.staleSignals[0]!.signalId).toBe("sig-2026-01-01-stale");
  });

  test("log file stale when mtime older than stale_log_days", () => {
    writeFileMtime(
      join(VAULT, "Brain", "log", "2025-08-01.jsonl"),
      "",
      "2025-08-01T00:00:00Z",
    );
    writeFileMtime(
      join(VAULT, "Brain", "log", "2026-05-20.jsonl"),
      "",
      "2026-05-20T00:00:00Z",
    );
    const idx = buildTimelineIndex(VAULT, {});
    const out = findStaleEntries(idx, VAULT, BRAIN_TEMPORAL_DEFAULTS, {
      now: NOW,
    });
    expect(out.staleLogFiles.length).toBe(1);
    expect(out.staleLogFiles[0]!.path).toContain("2025-08-01.jsonl");
  });

  test("thresholds returned alongside results", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const out = findStaleEntries(idx, VAULT, BRAIN_TEMPORAL_DEFAULTS, {
      now: NOW,
    });
    expect(out.thresholds.stale_pref_days).toBe(90);
    expect(out.thresholds.stale_signal_days).toBe(30);
    expect(out.thresholds.stale_log_days).toBe(180);
  });
});
