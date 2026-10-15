/**
 * Tests for the live-counts console collector (session-mining-economy,
 * t_15ebcfc1). We exercise:
 *   - an empty vault: frozen, deterministic payload with telemetry
 *     ABSENT (not zero), empty most-recalled, a fixed 30-day zero
 *     histogram, and report snapshots reported as "disabled"
 *   - the telemetry summary is the `summarizeRecallTelemetry` passthrough
 *   - most-recalled ranks by recall count and joins the id/path identity
 *     the records themselves carry (including an artifact referenced by
 *     id only in one record and by id+path in another)
 *   - most-recalled is capped at the named limit with a deterministic
 *     tie-break
 *   - the written-per-day histogram buckets continuity records inside
 *     the named 30-day window and leaves out-of-window writes out
 *   - report snapshots read per-surface latest dates when the feature is
 *     enabled (a torn snapshot file is skipped), and read as "disabled"
 *     when it is off
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendContinuityRecord,
  appendContinuitySourceInvalidation,
} from "../../../src/core/brain/continuity/store.ts";
import {
  collectExplorerConsole,
  EXPLORER_CONSOLE_MOST_RECALLED_LIMIT,
  EXPLORER_CONSOLE_WINDOW_DAYS,
} from "../../../src/core/brain/explorer-console.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import {
  emitRecallTelemetry,
  RECALL_CHANNEL,
  summarizeRecallTelemetry,
} from "../../../src/core/brain/recall-telemetry.ts";
import { writeReportSnapshot } from "../../../src/core/brain/report-snapshot.ts";

const NOW = new Date("2026-05-20T12:00:00.000Z");
const ENV_KEY = "OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS";

let vault: string;
let previousEnv: string | undefined;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-explorer-console-"));
  previousEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (previousEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previousEnv;
  rmSync(vault, { recursive: true, force: true });
});

/** One recall-telemetry record with a fixed timestamp and artifacts. */
function emit(
  createdAt: string,
  artifacts: ReadonlyArray<{ readonly id: string; readonly path?: string }>,
  overrides: { readonly mode?: "search" | "query"; readonly channel?: "cli" | "mcp" } = {},
): void {
  emitRecallTelemetry(vault, {
    createdAt,
    host: "unit-test",
    channel: overrides.channel ?? RECALL_CHANNEL.cli,
    mode: overrides.mode ?? "search",
    status: "ok",
    durationMs: 5,
    resultCount: artifacts.length,
    topArtifacts: artifacts.map((artifact) => ({ ...artifact })),
  });
}

/**
 * A path-only artifact, exactly as the reader grammar accepts it
 * (`readArtifacts` narrows each entry to id-or-path): the emit input
 * type requires an id, so this record is written at the store level.
 */
function emitPathOnlyArtifact(createdAt: string, path: string): void {
  appendContinuityRecord(vault, {
    kind: "recall_telemetry",
    createdAt,
    sourceRefs: [{ id: path }],
    payload: { host: "unit-test", top_artifacts: [{ path }] },
  });
}

describe("collectExplorerConsole", () => {
  test("empty vault: frozen, deterministic, telemetry absent not zero, disabled snapshots", () => {
    const payload = collectExplorerConsole(vault, { now: NOW });
    const again = collectExplorerConsole(vault, { now: NOW });
    // Deterministic given opts.now, and frozen like collectExplorerData.
    expect(JSON.stringify(payload)).toBe(JSON.stringify(again));
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.most_recalled)).toBe(true);
    expect(Object.isFrozen(payload.written_per_day)).toBe(true);
    expect(payload.schema_version).toBe(1);
    expect(payload.generated_at).toBe("2026-05-20T12:00:00.000Z");
    expect(payload.telemetry.total).toBe(0);
    expect(payload.telemetry.by_channel).toEqual({});
    expect(payload.most_recalled).toEqual([]);
    expect(payload.report_snapshots).toEqual({ status: "disabled" });
  });

  test("telemetry summary is the summarizeRecallTelemetry passthrough", () => {
    emit("2026-05-20T15:00:00.000Z", [{ id: "pref-a" }, { id: "pref-b" }]);
    emit("2026-05-20T15:01:00.000Z", [], { mode: "query", channel: RECALL_CHANNEL.mcp });
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T15:02:00.000Z",
      host: "unit-test",
      channel: RECALL_CHANNEL.cli,
      mode: "search",
      status: "empty",
      durationMs: 3,
      resultCount: 0,
      gaps: ["no_matching_context"],
    });
    const payload = collectExplorerConsole(vault, { now: NOW });
    expect(payload.telemetry).toEqual(summarizeRecallTelemetry(vault));
    expect(payload.telemetry.total).toBe(3);
    expect(payload.telemetry.by_channel).toEqual({ cli: 2, mcp: 1 });
  });

  test("most-recalled ranks by count and joins id and path identities", () => {
    const pathA = join(vault, "Brain", "preferences", "pref-a.md");
    // pref-a is referenced by id+path twice, so it tops the list; the
    // id-only/pref-b and id-only/pref-c singles tie below it. A fourth
    // artifact is referenced by PATH only.
    emit("2026-05-20T15:00:00.000Z", [{ id: "pref-a", path: pathA }, { id: "pref-b" }]);
    emit("2026-05-20T16:00:00.000Z", [{ id: "pref-a", path: pathA }]);
    emit("2026-05-20T16:30:00.000Z", [{ id: "pref-c" }]);
    emitPathOnlyArtifact("2026-05-20T17:00:00.000Z", join(vault, "Daily", "2026-05-20.md"));

    const { most_recalled } = collectExplorerConsole(vault, { now: NOW });
    expect(most_recalled[0]).toEqual({
      id: "pref-a",
      path: pathA,
      access_count: 2,
      last_access_at: "2026-05-20T16:00:00.000Z",
    });
    // The path-only artifact keeps its identity: id absent, path named.
    const pathOnly = most_recalled.find((entry) => entry.id === null);
    expect(pathOnly).toBeDefined();
    expect(pathOnly!.path).toBe(join(vault, "Daily", "2026-05-20.md"));
    expect(pathOnly!.access_count).toBe(1);
    expect(most_recalled.length).toBe(4);
  });

  test("most-recalled is capped at the named limit with a deterministic tie-break", () => {
    expect(EXPLORER_CONSOLE_MOST_RECALLED_LIMIT).toBe(10);
    const artifacts = Array.from({ length: 12 }, (_, i) => ({
      id: `pref-${String(i + 1).padStart(2, "0")}`,
    }));
    emit("2026-05-20T15:00:00.000Z", artifacts);
    const { most_recalled } = collectExplorerConsole(vault, { now: NOW });
    expect(most_recalled.length).toBe(EXPLORER_CONSOLE_MOST_RECALLED_LIMIT);
    // Equal counts break ties by ascending id, so the cap names the
    // same entries on every GET.
    expect(most_recalled.map((entry) => entry.id)).toEqual(
      artifacts.slice(0, EXPLORER_CONSOLE_MOST_RECALLED_LIMIT).map((artifact) => artifact.id),
    );
  });

  test("written-per-day histogram buckets the 30-day window from continuity createdAt", () => {
    expect(EXPLORER_CONSOLE_WINDOW_DAYS).toBe(30);
    emit("2026-05-20T09:00:00.000Z", [{ id: "pref-a" }]);
    emit("2026-05-05T09:00:00.000Z", [{ id: "pref-a" }]);
    // Outside the window: more than 30 days before NOW.
    emit("2026-04-01T09:00:00.000Z", [{ id: "pref-a" }]);
    // A non-telemetry continuity record counts too: every append is a
    // write event.
    appendContinuitySourceInvalidation(vault, {
      createdAt: "2026-05-20T10:00:00.000Z",
      source: { id: "pref-a" },
      reason: "unit-test",
    });

    const { written_per_day, window_since, window_until } = collectExplorerConsole(vault, {
      now: NOW,
    });
    expect(written_per_day.length).toBe(EXPLORER_CONSOLE_WINDOW_DAYS);
    expect(written_per_day[0]!.date).toBe("2026-04-21");
    expect(written_per_day[written_per_day.length - 1]!.date).toBe("2026-05-20");
    expect(window_since).toBe("2026-04-21T00:00:00.000Z");
    expect(window_until).toBe("2026-05-20T23:59:59.999Z");
    const byDate = new Map(written_per_day.map((bucket) => [bucket.date, bucket.count]));
    expect(byDate.get("2026-05-20")).toBe(2);
    expect(byDate.get("2026-05-05")).toBe(1);
    expect(byDate.get("2026-04-01")).toBeUndefined();
    // Zero days are reported as zero, so the axis is fixed.
    expect(byDate.get("2026-05-06")).toBe(0);
  });

  test("report snapshots read as disabled while the feature is off, even with files on disk", () => {
    mkdirSync(brainDirs(vault).brain, { recursive: true });
    writeReportSnapshot(vault, "daily", "2026-05-19", { kept: true });
    const { report_snapshots } = collectExplorerConsole(vault, { now: NOW });
    expect(report_snapshots).toEqual({ status: "disabled" });
  });

  test("report snapshots surface the latest valid date per surface when enabled", () => {
    process.env[ENV_KEY] = "true";
    mkdirSync(brainDirs(vault).brain, { recursive: true });
    writeReportSnapshot(vault, "daily", "2026-05-18", { day: 18 });
    writeReportSnapshot(vault, "daily", "2026-05-19", { day: 19 });
    writeReportSnapshot(vault, "weekly", "2026-05-12", { week: 20 });
    // A torn snapshot file must not become the latest date.
    writeFileSync(join(brainDirs(vault).brain, "reports", "daily", "2026-05-20.json"), "{torn");

    const { report_snapshots } = collectExplorerConsole(vault, { now: NOW });
    expect(report_snapshots.status).toBe("ok");
    if (report_snapshots.status !== "ok") return;
    expect(report_snapshots.surfaces).toEqual([
      { surface: "daily", latest_date: "2026-05-19" },
      { surface: "weekly", latest_date: "2026-05-12" },
    ]);
  });
});
