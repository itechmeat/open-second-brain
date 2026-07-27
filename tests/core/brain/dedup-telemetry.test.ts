/**
 * Task 17 - the exact-hash ingest dedup counts become observable.
 *
 * The counters already existed and reached a CLI/MCP response, then died
 * one call deep. These tests pin the persisted `ingest_dedup` continuity
 * record, the aggregator that reads a trend back out of it, and the two
 * invariants that make the record trustworthy: an ingest that dedupes
 * nothing writes NO record (a zero row would make a real zero
 * indistinguishable from an absent measurement), and no surface here
 * reports a semantic figure as a drop - the semantic detectors nominate
 * and never drop.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listContinuityRecords } from "../../../src/core/brain/continuity/store.ts";
import {
  emitIngestDedupReport,
  INGEST_DEDUP_RECORD_KIND,
  IngestDedupTelemetryError,
  listIngestDedupReports,
  MAX_TRACKED_DEDUP_SOURCES,
  summarizeIngestDedup,
} from "../../../src/core/brain/dedup-telemetry.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { scanInline } from "../../../src/core/brain/inline-scan.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../src/core/brain/config-template.ts";
import { captureSessionLifecycleEvent } from "../../../src/core/brain/session-lifecycle.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dedup-telemetry-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function storedRecords(): ReadonlyArray<{ payload: Record<string, unknown> }> {
  return listContinuityRecords(vault, { kind: INGEST_DEDUP_RECORD_KIND }) as ReadonlyArray<{
    payload: Record<string, unknown>;
  }>;
}

describe("emitIngestDedupReport", () => {
  test("persists one record carrying the surface and the per-source counts", () => {
    const record = emitIngestDedupReport(vault, {
      surface: "scan_inline",
      sources: [
        { ref: "Daily/2026-07-01.md", exactDeduped: 2 },
        { ref: "Daily/2026-07-02.md", exactDeduped: 1 },
      ],
      createdAt: "2026-07-01T10:00:00.000Z",
    });

    expect(record).not.toBeNull();
    expect(record!.kind).toBe(INGEST_DEDUP_RECORD_KIND);
    expect(record!.payload["surface"]).toBe("scan_inline");
    expect(record!.payload["exact_deduped"]).toBe(3);
    expect(record!.payload["by_source"]).toEqual({
      "Daily/2026-07-01.md": 2,
      "Daily/2026-07-02.md": 1,
    });
    // The source refs are join keys, so the record answers "which source
    // is being re-ingested" without re-reading the payload.
    expect(record!.sourceRefs.map((ref) => ref.id).toSorted()).toEqual([
      "Daily/2026-07-01.md",
      "Daily/2026-07-02.md",
    ]);
  });

  test("writes NO record when nothing was deduped (no zero row)", () => {
    const record = emitIngestDedupReport(vault, {
      surface: "scan_inline",
      sources: [{ ref: "Daily/2026-07-01.md", exactDeduped: 0 }],
      createdAt: "2026-07-01T10:00:00.000Z",
    });
    expect(record).toBeNull();
    expect(storedRecords()).toHaveLength(0);
  });

  test("writes NO record when the ingest saw no sources at all", () => {
    expect(
      emitIngestDedupReport(vault, {
        surface: "session_lifecycle",
        sources: [],
        createdAt: "2026-07-01T10:00:00.000Z",
      }),
    ).toBeNull();
    expect(storedRecords()).toHaveLength(0);
  });

  test("rejects a malformed count by name rather than inventing one", () => {
    expect(() =>
      emitIngestDedupReport(vault, {
        surface: "scan_inline",
        sources: [{ ref: "Daily/a.md", exactDeduped: -1 }],
        createdAt: "2026-07-01T10:00:00.000Z",
      }),
    ).toThrow(IngestDedupTelemetryError);
    expect(() =>
      emitIngestDedupReport(vault, {
        surface: "scan_inline",
        sources: [{ ref: "Daily/a.md", exactDeduped: 1.5 }],
        createdAt: "2026-07-01T10:00:00.000Z",
      }),
    ).toThrow(IngestDedupTelemetryError);
    expect(storedRecords()).toHaveLength(0);
  });

  test("rejects a blank source ref by name", () => {
    expect(() =>
      emitIngestDedupReport(vault, {
        surface: "scan_inline",
        sources: [{ ref: "   ", exactDeduped: 3 }],
        createdAt: "2026-07-01T10:00:00.000Z",
      }),
    ).toThrow(IngestDedupTelemetryError);
  });

  test("rejects an unknown surface by name", () => {
    expect(() =>
      emitIngestDedupReport(vault, {
        // Deliberately outside the surface union: a caller bug must be
        // named, never silently recorded under a made-up label.
        surface: "not_a_surface" as "scan_inline",
        sources: [{ ref: "Daily/a.md", exactDeduped: 1 }],
        createdAt: "2026-07-01T10:00:00.000Z",
      }),
    ).toThrow(IngestDedupTelemetryError);
  });

  test("caps the per-source map and names how many refs it omitted", () => {
    const sources = Array.from({ length: MAX_TRACKED_DEDUP_SOURCES + 3 }, (_unused, index) => ({
      ref: `Daily/note-${String(index).padStart(3, "0")}.md`,
      exactDeduped: index + 1,
    }));
    const record = emitIngestDedupReport(vault, {
      surface: "scan_inline",
      sources,
      createdAt: "2026-07-01T10:00:00.000Z",
    });
    expect(record).not.toBeNull();
    const bySource = record!.payload["by_source"] as Record<string, number>;
    expect(Object.keys(bySource)).toHaveLength(MAX_TRACKED_DEDUP_SOURCES);
    expect(record!.payload["by_source_omitted"]).toBe(3);
    // The total stays exact even though the map is clipped.
    const expectedTotal = sources.reduce((sum, source) => sum + source.exactDeduped, 0);
    expect(record!.payload["exact_deduped"]).toBe(expectedTotal);
  });
});

describe("summarizeIngestDedup", () => {
  test("returns a trend across records plus the re-ingest ranking per source", () => {
    emitIngestDedupReport(vault, {
      surface: "scan_inline",
      sources: [{ ref: "Daily/loud.md", exactDeduped: 4 }],
      createdAt: "2026-07-01T10:00:00.000Z",
    });
    emitIngestDedupReport(vault, {
      surface: "scan_inline",
      sources: [
        { ref: "Daily/loud.md", exactDeduped: 5 },
        { ref: "Daily/quiet.md", exactDeduped: 1 },
      ],
      createdAt: "2026-07-02T10:00:00.000Z",
    });
    emitIngestDedupReport(vault, {
      surface: "session_lifecycle",
      sources: [{ ref: "session-7", exactDeduped: 2 }],
      createdAt: "2026-07-03T10:00:00.000Z",
    });

    const summary = summarizeIngestDedup(vault);
    expect(summary.total_records).toBe(3);
    expect(summary.total_exact_deduped).toBe(12);
    expect(summary.by_surface).toEqual({ scan_inline: 10, session_lifecycle: 2 });
    expect(summary.by_source[0]).toEqual({
      ref: "Daily/loud.md",
      surface: "scan_inline",
      exact_deduped: 9,
      records: 2,
    });
    expect(summary.trend).toEqual([
      { at: "2026-07-01T10:00:00.000Z", surface: "scan_inline", exact_deduped: 4 },
      { at: "2026-07-02T10:00:00.000Z", surface: "scan_inline", exact_deduped: 6 },
      { at: "2026-07-03T10:00:00.000Z", surface: "session_lifecycle", exact_deduped: 2 },
    ]);
  });

  test("filters by surface and by time window", () => {
    emitIngestDedupReport(vault, {
      surface: "scan_inline",
      sources: [{ ref: "Daily/a.md", exactDeduped: 1 }],
      createdAt: "2026-07-01T10:00:00.000Z",
    });
    emitIngestDedupReport(vault, {
      surface: "session_import",
      sources: [{ ref: "session-9", exactDeduped: 3 }],
      createdAt: "2026-07-05T10:00:00.000Z",
    });

    expect(summarizeIngestDedup(vault, { surface: "session_import" }).total_exact_deduped).toBe(3);
    expect(listIngestDedupReports(vault, { since: "2026-07-03T00:00:00.000Z" })).toHaveLength(1);
  });

  test("an empty vault summarises to zeros without inventing a record", () => {
    const summary = summarizeIngestDedup(vault);
    expect(summary.total_records).toBe(0);
    expect(summary.total_exact_deduped).toBe(0);
    expect(summary.by_source).toEqual([]);
    expect(summary.trend).toEqual([]);
  });

  test("reports no semantic figure at all - the semantic layers nominate, never drop", () => {
    emitIngestDedupReport(vault, {
      surface: "scan_inline",
      sources: [{ ref: "Daily/a.md", exactDeduped: 1 }],
      createdAt: "2026-07-01T10:00:00.000Z",
    });
    const summary = summarizeIngestDedup(vault);
    // Every count this surface publishes is explicitly an EXACT-hash
    // count. Nothing here may be read as "semantically dropped".
    for (const key of Object.keys(summary)) {
      expect(key).not.toContain("semantic");
    }
    const payloadKeys = Object.keys(storedRecords()[0]!.payload);
    for (const key of payloadKeys) {
      expect(key).not.toContain("semantic");
    }
    expect(payloadKeys).toContain("exact_deduped");
  });
});

describe("scanInline dedup telemetry", () => {
  function writeMd(rel: string, content: string): void {
    const path = join(vault, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }

  beforeEach(() => {
    atomicWriteFileSync(
      join(brainDirs(vault).brain, "_brain.yaml"),
      `${DEFAULT_BRAIN_CONFIG_YAML}\nnotes:\n  read_paths:\n    - Daily\n`,
    );
  });

  test("a re-scan that dedupes records the file that is being re-ingested", async () => {
    writeMd("Daily/2026-07-01.md", "@osb feedback positive topic=telemetry principle=p\n");
    const first = await scanInline(vault, {
      agent: "tester",
      now: new Date("2026-07-01T10:00:00Z"),
    });
    expect(first.created).toBe(1);
    expect(first.deduped).toBe(0);
    // Nothing deduped -> no record.
    expect(storedRecords()).toHaveLength(0);

    // A second, identical marker in a DIFFERENT file re-ingests the same rule.
    writeMd("Daily/2026-07-02.md", "@osb feedback positive topic=telemetry principle=p\n");
    const second = await scanInline(vault, {
      agent: "tester",
      now: new Date("2026-07-02T10:00:00Z"),
    });
    expect(second.deduped).toBe(1);

    const records = storedRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.payload["surface"]).toBe("scan_inline");
    expect(records[0]!.payload["exact_deduped"]).toBe(1);
    expect(Object.keys(records[0]!.payload["by_source"] as Record<string, number>)).toEqual([
      "Daily/2026-07-02.md",
    ]);
  });

  test("a dry run observes but never writes a record", async () => {
    writeMd("Daily/2026-07-01.md", "@osb feedback positive topic=dry principle=p\n");
    await scanInline(vault, { agent: "tester", now: new Date("2026-07-01T10:00:00Z") });
    writeMd("Daily/2026-07-02.md", "@osb feedback positive topic=dry principle=p\n");
    const dry = await scanInline(vault, {
      agent: "tester",
      dryRun: true,
      now: new Date("2026-07-02T10:00:00Z"),
    });
    expect(dry.deduped).toBe(1);
    expect(storedRecords()).toHaveLength(0);
  });

  test("the scan result shape is unchanged by the new record", async () => {
    writeMd("Daily/2026-07-01.md", "@osb feedback positive topic=shape principle=p\n");
    const result = await scanInline(vault, {
      agent: "tester",
      now: new Date("2026-07-01T10:00:00Z"),
    });
    // The claim under test is that emitting the dedup record does not change
    // the result shape - not that the shape is frozen forever. `facts`,
    // `skills` and `suppressed` were added by the routed marker kinds
    // (signals-that-survive, unit 7); they are counters on the same result,
    // unrelated to this record.
    expect(Object.keys(result).toSorted()).toEqual([
      "created",
      "deduped",
      "errors",
      "facts",
      "filesWithMarkers",
      "found",
      "malformed",
      "scanned",
      "skills",
      "suppressed",
    ]);
  });
});

describe("captureSessionLifecycleEvent dedup telemetry", () => {
  const payload = {
    hook_event_name: "UserPromptSubmit",
    session_id: "session-dedup",
    prompt: '@osb feedback positive topic=lifecycle principle="observe dedup"',
  };

  test("a repeated prompt records the session that is being re-ingested", async () => {
    const first = await captureSessionLifecycleEvent(vault, payload, {
      agent: "tester",
      now: new Date("2026-07-01T10:00:00Z"),
    });
    expect(first.signals_deduped).toBe(0);
    expect(storedRecords()).toHaveLength(0);

    const second = await captureSessionLifecycleEvent(vault, payload, {
      agent: "tester",
      now: new Date("2026-07-01T10:00:01Z"),
    });
    expect(second.signals_deduped).toBe(1);

    const records = storedRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.payload["surface"]).toBe("session_lifecycle");
    expect(records[0]!.payload["exact_deduped"]).toBe(1);
    expect(records[0]!.payload["by_source"]).toEqual({ "session-dedup": 1 });
  });

  test("the lifecycle result keeps its existing counter fields unchanged", async () => {
    await captureSessionLifecycleEvent(vault, payload, {
      agent: "tester",
      now: new Date("2026-07-01T10:00:00Z"),
    });
    const second = await captureSessionLifecycleEvent(vault, payload, {
      agent: "tester",
      now: new Date("2026-07-01T10:00:01Z"),
    });
    expect(second.signals_created).toBe(0);
    expect(second.signals_deduped).toBe(1);
    expect(second.facts_deduped).toBe(0);
    expect(Object.keys(second)).not.toContain("dedup_record_id");
  });

  test("a dry run never writes a record", async () => {
    await captureSessionLifecycleEvent(vault, payload, {
      agent: "tester",
      now: new Date("2026-07-01T10:00:00Z"),
    });
    const dry = await captureSessionLifecycleEvent(vault, payload, {
      agent: "tester",
      dryRun: true,
      now: new Date("2026-07-01T10:00:01Z"),
    });
    expect(dry.signals_deduped).toBe(1);
    expect(storedRecords()).toHaveLength(0);
  });
});
