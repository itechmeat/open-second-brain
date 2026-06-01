import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyRecurrenceEvidence,
  getRecurrenceEntry,
  listRecurrenceEntries,
  purgeRecurrenceSource,
} from "../../../src/core/brain/recurrence.ts";

let vault: string;

beforeEach(() => {
  vault = join(tmpdir(), `o2b-recurrence-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(vault, { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("recurrence support ledger", () => {
  test("same-scope duplicate learns increment support instead of creating duplicates", () => {
    applyRecurrenceEvidence(vault, {
      contentHash: "h-alpha",
      scope: "project-a",
      sourceId: "src-1",
      action: "learn",
      at: "2026-06-01T10:00:00Z",
    });
    applyRecurrenceEvidence(vault, {
      contentHash: "h-alpha",
      scope: "project-a",
      sourceId: "src-2",
      action: "learn",
      at: "2026-06-01T10:01:00Z",
    });

    const all = listRecurrenceEntries(vault);
    expect(all).toHaveLength(1);
    expect(all[0]?.supportCount).toBe(2);
    expect(all[0]?.recurrenceCount).toBe(1);
  });

  test("cross-scope recurrence increases recurrence evidence and commitment", () => {
    for (const input of [
      { scope: "project-a", sourceId: "src-1" },
      { scope: "project-b", sourceId: "src-2" },
      { scope: "project-c", sourceId: "src-3" },
      { scope: "project-c", sourceId: "src-4" },
      { scope: "project-a", sourceId: "src-5" },
    ]) {
      applyRecurrenceEvidence(vault, {
        contentHash: "h-beta",
        scope: input.scope,
        sourceId: input.sourceId,
        action: "learn",
      });
    }

    const entry = getRecurrenceEntry(vault, "h-beta");
    expect(entry).not.toBeNull();
    expect(entry?.supportCount).toBe(5);
    expect(entry?.recurrenceCount).toBe(3);
    expect(entry?.commitment).toBe("decided");
  });

  test("reference-counted forget and source purge retire only after support is gone", () => {
    applyRecurrenceEvidence(vault, {
      contentHash: "h-gamma",
      scope: "project-a",
      sourceId: "src-1",
      action: "learn",
    });
    applyRecurrenceEvidence(vault, {
      contentHash: "h-gamma",
      scope: "project-a",
      sourceId: "src-1",
      action: "learn",
    });
    applyRecurrenceEvidence(vault, {
      contentHash: "h-gamma",
      scope: "project-b",
      sourceId: "src-2",
      action: "learn",
    });

    applyRecurrenceEvidence(vault, {
      contentHash: "h-gamma",
      scope: "project-a",
      sourceId: "src-1",
      action: "forget",
    });

    let entry = getRecurrenceEntry(vault, "h-gamma");
    expect(entry?.supportCount).toBe(2);

    purgeRecurrenceSource(vault, "src-1");
    entry = getRecurrenceEntry(vault, "h-gamma");
    expect(entry?.supportCount).toBe(1);

    applyRecurrenceEvidence(vault, {
      contentHash: "h-gamma",
      scope: "project-b",
      sourceId: "src-2",
      action: "forget",
    });
    entry = getRecurrenceEntry(vault, "h-gamma");
    expect(entry).toBeNull();
  });
});
