import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import {
  preferencePath,
  processedSignalPath,
  signalPath,
} from "../../src/core/brain/paths.ts";
import {
  moveToRetired,
  writePreference,
} from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { buildRetentionReview } from "../../src/core/brain/retention.ts";
import { BRAIN_RETIRED_REASON } from "../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-retention-"));
  mkdirSync(vault, { recursive: true });
  bootstrapBrain(vault, {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("buildRetentionReview", () => {
  test("recommends keep/prune without mutating artifacts", () => {
    writePreference(vault, {
      slug: "useful-rule",
      topic: "useful-rule",
      principle: "keep useful retired rules visible",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      confirmed_at: "2026-05-08T00:00:00Z",
      status: "confirmed",
      evidenced_by: [],
      applied_count: 3,
      violated_count: 0,
      last_evidence_at: "2026-05-20T00:00:00Z",
    });
    const retired = moveToRetired(
      vault,
      preferencePath(vault, "useful-rule"),
      BRAIN_RETIRED_REASON.staleNoEvidence,
      {
        now: new Date("2026-05-21T00:00:00Z"),
        retired_by: "test",
        evidenceApplied: [],
        evidenceViolated: [],
      },
    );

    writeSignal(vault, {
      topic: "discarded-signal",
      signal: "negative",
      agent: "test",
      principle: "old one-off signal",
      created_at: "2026-04-01T00:00:00Z",
      date: "2026-04-01",
      slug: "discarded-signal",
    });
    const activeSignal = signalPath(vault, "2026-04-01", "discarded-signal");
    const processedSignal = processedSignalPath(
      vault,
      "2026-04-01",
      "discarded-signal",
    );
    renameSync(activeSignal, processedSignal);

    const report = buildRetentionReview(vault, {
      now: new Date("2026-05-28T00:00:00Z"),
    });

    expect(report.summary.keep).toBe(1);
    expect(report.summary.prune).toBe(1);
    expect(report.recommendations).toEqual([
      expect.objectContaining({ id: "ret-useful-rule", action: "keep" }),
      expect.objectContaining({
        id: "sig-2026-04-01-discarded-signal",
        action: "prune",
      }),
    ]);
    expect(existsSync(retired.path)).toBe(true);
    expect(existsSync(processedSignal)).toBe(true);
  });
});
