/**
 * Report snapshots + deterministic delta (t_00eece5d): one run emits
 * the human-readable report AND a machine-diffable JSON snapshot
 * under `Brain/reports/<surface>/<date>.json` (schema
 * `o2b.report-snapshot.v1`), so the next run can answer "what changed
 * since last time" without re-deriving. The diff keys on stable
 * identities - array order never produces spurious changes - and the
 * reader is fail-soft: a torn prior snapshot reads as none.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureReportDelta,
  diffReportPayloads,
  loadLatestReportSnapshot,
  REPORT_SNAPSHOT_SCHEMA_VERSION,
  reportSnapshotsEnabled,
  writeReportSnapshot,
} from "../../../src/core/brain/report-snapshot.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-report-snap-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  delete process.env["OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS"];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env["OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS"];
});

describe("diffReportPayloads", () => {
  test("keyed diff is insensitive to array order", () => {
    const before = { retired: [{ id: "pref-a" }, { id: "pref-b" }], counts: { events: 3 } };
    const after = { retired: [{ id: "pref-b" }, { id: "pref-a" }], counts: { events: 3 } };
    const delta = diffReportPayloads(before, after);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(delta.changed).toEqual([]);
  });

  test("added, removed, and changed paths are reported precisely", () => {
    const before = {
      retired: [{ id: "pref-a", reason: "stale" }],
      topics: ["alpha", "beta"],
      counts: { events: 3 },
    };
    const after = {
      retired: [{ id: "pref-a", reason: "contradiction" }],
      topics: ["alpha", "gamma"],
      counts: { events: 5 },
    };
    const delta = diffReportPayloads(before, after);
    expect(delta.added).toContain("topics[gamma]");
    expect(delta.removed).toContain("topics[beta]");
    const changedPaths = delta.changed.map((c) => c.path);
    expect(changedPaths).toContain("retired/pref-a/reason");
    expect(changedPaths).toContain("counts/events");
    const events = delta.changed.find((c) => c.path === "counts/events")!;
    expect(events.before).toBe("3");
    expect(events.after).toBe("5");
  });
});

describe("snapshot persistence", () => {
  test("write + load round trip", () => {
    writeReportSnapshot(vault, "digest", "2026-06-04", { counts: { events: 2 } });
    const loaded = loadLatestReportSnapshot(vault, "digest", "2026-06-05");
    expect(loaded).not.toBeNull();
    expect(loaded!.date).toBe("2026-06-04");
    expect((loaded!.payload as { counts: { events: number } }).counts.events).toBe(2);
    const raw = JSON.parse(
      readFileSync(join(vault, "Brain", "reports", "digest", "2026-06-04.json"), "utf8"),
    );
    expect(raw.schema).toBe(REPORT_SNAPSHOT_SCHEMA_VERSION);
  });

  test("loadLatest picks the newest snapshot strictly before the given date", () => {
    writeReportSnapshot(vault, "digest", "2026-06-01", { v: 1 });
    writeReportSnapshot(vault, "digest", "2026-06-03", { v: 2 });
    writeReportSnapshot(vault, "digest", "2026-06-05", { v: 3 });
    const loaded = loadLatestReportSnapshot(vault, "digest", "2026-06-05");
    expect(loaded!.date).toBe("2026-06-03");
  });

  test("a torn prior snapshot reads as none", () => {
    const dir = join(vault, "Brain", "reports", "digest");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-06-04.json"), "{not json");
    expect(loadLatestReportSnapshot(vault, "digest", "2026-06-05")).toBeNull();
  });
});

describe("captureReportDelta", () => {
  test("first enabled run persists and reports no delta; second reports the change", () => {
    process.env["OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS"] = "true";
    const first = captureReportDelta(vault, "daily", "2026-06-04", { counts: { events: 1 } });
    expect(first).not.toBeNull();
    expect(first!.prior_date).toBeNull();
    expect(first!.changed).toEqual([]);

    const second = captureReportDelta(vault, "daily", "2026-06-05", { counts: { events: 4 } });
    expect(second!.prior_date).toBe("2026-06-04");
    expect(second!.changed.map((c) => c.path)).toContain("counts/events");
  });

  test("disabled flag writes nothing and returns null", () => {
    const out = captureReportDelta(vault, "daily", "2026-06-04", { counts: { events: 1 } });
    expect(out).toBeNull();
    expect(existsSync(join(vault, "Brain", "reports"))).toBe(false);
  });

  test("reportSnapshotsEnabled honors config key and env mirror", () => {
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, `vault: ${vault}\nreport_snapshots_enabled: true\n`);
    expect(reportSnapshotsEnabled(configPath)).toBe(true);
    writeFileSync(configPath, `vault: ${vault}\n`);
    expect(reportSnapshotsEnabled(configPath)).toBe(false);
    process.env["OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS"] = "1";
    expect(reportSnapshotsEnabled(configPath)).toBe(true);
  });
});
