/**
 * Task Q1 (t_a3d1adb0): inline `[Source: <name>, YYYY-MM-DD]` citation
 * promotion into the temporal timeline as dated provenance events.
 *
 * Acceptance coverage:
 *   - a well-formed marker produces a dated provenance event on the
 *     timeline (event dated at the citation date, not scan time);
 *   - re-scanning does not duplicate (dedup on normalized name + date
 *     against already-logged source events);
 *   - malformed markers (bad date shape, missing comma) are reported
 *     explicitly and skipped;
 *   - notes without markers produce no events;
 *   - parsing is purely structural (no natural-language date parsing).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../../src/core/brain/policy.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { buildTimelineIndex } from "../../../../src/core/brain/temporal/build-index.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../../src/core/brain/types.ts";
import {
  normalizeCitationName,
  parseCitations,
  scanCitations,
} from "../../../../src/core/brain/temporal/citations.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-citations-"));
  const dirs = brainDirs(tmp);
  for (const d of [dirs.brain, dirs.log]) mkdirSync(d, { recursive: true });
  atomicWriteFileSync(
    join(dirs.brain, "_brain.yaml"),
    `${DEFAULT_BRAIN_CONFIG_YAML}\nnotes:\n  read_paths:\n    - Notes\n`,
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeMd(rel: string, content: string): void {
  const path = join(tmp, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function sourceCitationEvents(vault: string) {
  // Wide window: promoted events are stamped at the citation date, which
  // for historical sources predates the timeline's default 1970 lower
  // bound, so the verification window opens earlier.
  const idx = buildTimelineIndex(vault, { since: "1000-01-01", until: "2999-01-01" });
  return idx.events.filter((e) => e.kind === BRAIN_LOG_EVENT_KIND.sourceCitation);
}

describe("parseCitations (pure structural parser)", () => {
  test("extracts a well-formed marker with name and ISO date", () => {
    const res = parseCitations("Body text. [Source: Kant Critique, 1781-05-01] more.\n");
    expect(res.markers).toHaveLength(1);
    expect(res.markers[0]!.name).toBe("Kant Critique");
    expect(res.markers[0]!.date).toBe("1781-05-01");
    expect(res.markers[0]!.line).toBe(1);
    expect(res.malformed).toHaveLength(0);
  });

  test("reports a missing-comma marker as malformed and skips it", () => {
    const res = parseCitations("[Source: NoComma 2026-01-01]\n");
    expect(res.markers).toHaveLength(0);
    expect(res.malformed).toHaveLength(1);
    expect(res.malformed[0]!.reason).toMatch(/comma|date/i);
  });

  test("reports a bad-date-shape marker as malformed and skips it", () => {
    const res = parseCitations("[Source: Foo, 2026-1-1]\n[Source: Bar, 2026-13-40]\n");
    expect(res.markers).toHaveLength(0);
    expect(res.malformed).toHaveLength(2);
  });

  test("handles multiple markers across lines with correct line numbers", () => {
    const res = parseCitations("line one\n[Source: A, 2020-01-02]\n\n[Source: B, 2021-03-04]\n");
    expect(res.markers.map((m) => [m.name, m.date, m.line])).toEqual([
      ["A", "2020-01-02", 2],
      ["B", "2021-03-04", 4],
    ]);
  });

  test("notes without markers produce nothing", () => {
    const res = parseCitations("Just prose, no markers here.\n");
    expect(res.markers).toHaveLength(0);
    expect(res.malformed).toHaveLength(0);
  });

  test("date parsing is structural, not natural-language", () => {
    // A localized month name must NOT be recognised as a date.
    const res = parseCitations("[Source: Foo, May 1 2026]\n");
    expect(res.markers).toHaveLength(0);
    expect(res.malformed).toHaveLength(1);
  });
});

describe("normalizeCitationName", () => {
  test("folds case and collapses whitespace for dedup", () => {
    expect(normalizeCitationName("  Kant   Critique ")).toBe(
      normalizeCitationName("kant critique"),
    );
  });
});

describe("scanCitations promotion", () => {
  test("a well-formed marker becomes a dated provenance event on the timeline", () => {
    writeMd("Notes/a.md", "Claim. [Source: Origin of Species, 1859-11-24]\n");
    const res = scanCitations(tmp, { agent: "tester" });
    expect(res.found).toBe(1);
    expect(res.promoted).toBe(1);
    expect(res.deduped).toBe(0);

    const events = sourceCitationEvents(tmp);
    expect(events).toHaveLength(1);
    // Dated at the citation date, not the scan time.
    expect(events[0]!.at).toBe("1859-11-24T00:00:00Z");
    expect(events[0]!.source.path).toContain("1859-11-24");
  });

  test("re-scanning does not duplicate (dedup on normalized name + date)", () => {
    writeMd("Notes/a.md", "[Source: Origin of Species, 1859-11-24]\n");
    scanCitations(tmp, { agent: "tester" });
    const second = scanCitations(tmp, { agent: "tester" });
    expect(second.promoted).toBe(0);
    expect(second.deduped).toBe(1);
    expect(sourceCitationEvents(tmp)).toHaveLength(1);
  });

  test("normalized-name variants dedup against an already-logged event", () => {
    writeMd("Notes/a.md", "[Source: Origin of Species, 1859-11-24]\n");
    writeMd("Notes/b.md", "[Source:   origin  of   species , 1859-11-24]\n");
    const res = scanCitations(tmp, { agent: "tester" });
    expect(res.found).toBe(2);
    expect(res.promoted).toBe(1);
    expect(res.deduped).toBe(1);
    expect(sourceCitationEvents(tmp)).toHaveLength(1);
  });

  test("malformed markers are reported explicitly and skipped", () => {
    writeMd("Notes/a.md", "[Source: Bad, 2026-13-40]\n[Source: NoComma 2026-01-01]\n");
    const res = scanCitations(tmp, { agent: "tester" });
    expect(res.promoted).toBe(0);
    expect(res.malformed).toBe(2);
    expect(res.malformedMarkers).toHaveLength(2);
    expect(sourceCitationEvents(tmp)).toHaveLength(0);
  });

  test("notes without markers produce no events", () => {
    writeMd("Notes/a.md", "No provenance markers at all.\n");
    const res = scanCitations(tmp, { agent: "tester" });
    expect(res.found).toBe(0);
    expect(res.promoted).toBe(0);
    expect(sourceCitationEvents(tmp)).toHaveLength(0);
  });

  test("dry run reports promotions without writing events", () => {
    writeMd("Notes/a.md", "[Source: Origin, 1859-11-24]\n");
    const res = scanCitations(tmp, { agent: "tester", dryRun: true });
    expect(res.promoted).toBe(1);
    expect(sourceCitationEvents(tmp)).toHaveLength(0);
  });

  test("distinct dates for one source promote separate events", () => {
    writeMd("Notes/a.md", "[Source: Journal, 2020-01-01]\n[Source: Journal, 2021-01-01]\n");
    const res = scanCitations(tmp, { agent: "tester" });
    expect(res.promoted).toBe(2);
    expect(sourceCitationEvents(tmp)).toHaveLength(2);
  });
});
