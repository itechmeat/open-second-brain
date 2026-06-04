/**
 * Foresight (t_08a79c81): the Brain's first forward-looking surface.
 * A deterministic fold over recurrence routines (cadence arithmetic
 * projects the next due date) and open commitments / open questions
 * from continuity records - no speculation, every item carries
 * sources, an empty vault folds to an empty envelope.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendContinuityRecord } from "../../../../src/core/brain/continuity/store.ts";
import { applyRecurrenceEvidence } from "../../../../src/core/brain/recurrence.ts";
import {
  buildForesight,
  FORESIGHT_MAX_ITEMS,
  FORESIGHT_SCHEMA_VERSION,
} from "../../../../src/core/brain/temporal/foresight.ts";

const NOW = new Date("2026-06-04T12:00:00Z");

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-foresight-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function seedRoutine(hash: string, dates: string[], scope = "weekly-review"): void {
  for (const [i, date] of dates.entries()) {
    applyRecurrenceEvidence(vault, {
      contentHash: hash,
      scope,
      sourceId: `session-${hash}-${i}`,
      action: "learn",
      at: `${date}T09:00:00Z`,
    });
  }
}

function seedExtract(type: string, text: string, createdAt: string): void {
  appendContinuityRecord(vault, {
    kind: "pre_compact_extract",
    createdAt,
    sourceRefs: [{ id: `sess-${text.slice(0, 8)}`, kind: "session" }],
    payload: { extract_type: type, text },
  });
}

describe("buildForesight", () => {
  test("an empty vault folds to an empty versioned envelope", () => {
    const envelope = buildForesight(vault, { now: NOW });
    expect(envelope.version).toBe(FORESIGHT_SCHEMA_VERSION);
    expect(envelope.upcoming).toEqual([]);
    expect(envelope.horizonDays).toBe(14);
  });

  test("a steady routine projects its next due date inside the horizon", () => {
    seedRoutine("abc123", ["2026-05-14", "2026-05-21", "2026-05-28"]);
    const envelope = buildForesight(vault, { now: NOW });
    const recurring = envelope.upcoming.filter((u) => u.kind === "recurring");
    expect(recurring).toHaveLength(1);
    const item = recurring[0]!;
    expect(item.due).toBe("2026-06-04");
    expect(item.title).toContain("weekly-review");
    expect(item.why).toContain("every ~7d");
    expect(item.sources.length).toBeGreaterThan(0);
  });

  test("a routine due beyond the horizon stays out", () => {
    seedRoutine("xyz789", ["2026-01-01", "2026-03-01", "2026-05-01"], "quarterly-report");
    const envelope = buildForesight(vault, { now: NOW, horizonDays: 14 });
    expect(envelope.upcoming.filter((u) => u.kind === "recurring")).toHaveLength(0);
  });

  test("a single-occurrence routine has no cadence and never projects", () => {
    seedRoutine("solo01", ["2026-06-01"]);
    const envelope = buildForesight(vault, { now: NOW });
    expect(envelope.upcoming.filter((u) => u.kind === "recurring")).toHaveLength(0);
  });

  test("recent open commitments and questions surface; stale ones do not", () => {
    seedExtract("commitment", "Ship the migration guide to the team", "2026-06-01T10:00:00Z");
    seedExtract(
      "open_question",
      "Should activation decay be configurable?",
      "2026-06-02T10:00:00Z",
    );
    seedExtract("commitment", "An ancient promise nobody remembers", "2026-01-01T10:00:00Z");
    seedExtract("decision", "Decisions are not forward-looking", "2026-06-02T10:00:00Z");
    const envelope = buildForesight(vault, { now: NOW });
    const kinds = envelope.upcoming.map((u) => u.kind);
    expect(kinds).toContain("commitment");
    expect(kinds).toContain("open_question");
    expect(envelope.upcoming.find((u) => u.title.includes("ancient"))).toBeUndefined();
    expect(envelope.upcoming.find((u) => u.title.includes("Decisions"))).toBeUndefined();
    const commitment = envelope.upcoming.find((u) => u.kind === "commitment")!;
    expect(commitment.sources.length).toBeGreaterThan(0);
  });

  test("items are bounded and deterministic", () => {
    for (let i = 0; i < FORESIGHT_MAX_ITEMS + 5; i++) {
      seedExtract("commitment", `Commitment number ${i} for the suite`, "2026-06-03T10:00:00Z");
    }
    const a = buildForesight(vault, { now: NOW });
    const b = buildForesight(vault, { now: NOW });
    expect(a.upcoming.length).toBeLessThanOrEqual(FORESIGHT_MAX_ITEMS);
    expect(a).toEqual(b);
  });
});
