import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyRecurrenceEvidence,
  getRecurrenceEntry,
  listRecurrenceEntries,
  purgeRecurrenceSource,
} from "../../../src/core/brain/recurrence.ts";
import { withDeviceId } from "../../helpers/device-id.ts";

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

describe("recurrence-support per-device shards (t_774dea61)", () => {
  test("two devices write two shard files and the reader merges both", () => {
    withDeviceId("a", () =>
      applyRecurrenceEvidence(vault, {
        contentHash: "h-shared",
        scope: "project-a",
        sourceId: "src-a",
        action: "learn",
        at: "2026-06-01T10:00:00Z",
      }),
    );
    withDeviceId("b", () =>
      applyRecurrenceEvidence(vault, {
        contentHash: "h-shared",
        scope: "project-b",
        sourceId: "src-b",
        action: "learn",
        at: "2026-06-01T10:01:00Z",
      }),
    );
    expect(existsSync(join(vault, "Brain", "log", "recurrence-support.a.jsonl"))).toBe(true);
    expect(existsSync(join(vault, "Brain", "log", "recurrence-support.b.jsonl"))).toBe(true);
    expect(existsSync(join(vault, "Brain", "log", "recurrence-support.jsonl"))).toBe(false);

    const entry = getRecurrenceEntry(vault, "h-shared");
    expect(entry).not.toBeNull();
    expect(entry!.supportCount).toBe(2);
  });

  test("a purge on one device removes support learned earlier on another, whatever the shard names", () => {
    // Device b learns from src-shared first; device a purges it a day
    // later. Shard `.a` sorts before `.b`, so a name-order replay ran the
    // purge before the learn and brought the purged source back.
    withDeviceId("b", () =>
      applyRecurrenceEvidence(vault, {
        contentHash: "h1",
        scope: "project-a",
        sourceId: "src-shared",
        action: "learn",
        at: "2026-09-01T10:00:00Z",
      }),
    );
    withDeviceId("a", () => purgeRecurrenceSource(vault, "src-shared", "2026-09-02T10:00:00Z"));

    expect(listRecurrenceEntries(vault)).toEqual([]);
  });
});
