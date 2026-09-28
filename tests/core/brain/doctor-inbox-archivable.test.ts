/**
 * `inbox-archivable` (issue #195): the doctor names how many inbox signals
 * can no longer become candidates, and points at the dream pass that
 * archives them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DIAGNOSTIC_SIGNALS } from "../../../src/core/brain/diagnostics.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { dream } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

const NOW = new Date("2026-06-30T12:00:00Z");
const CODE = "inbox-archivable";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-doctor-archivable-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function sig(topic: string, createdAt: string): void {
  writeSignal(vault, {
    topic,
    signal: "positive",
    agent: "claude",
    principle: `Principle for ${topic}`,
    created_at: createdAt,
    date: createdAt.slice(0, 10),
    slug: topic,
  });
}

function finding() {
  return runDoctor(vault, { now: NOW }).warnings.find((w) => w.code === CODE);
}

describe("inbox-archivable", () => {
  test("reports the inbox size and the archivable count", () => {
    sig("fresh", "2026-06-25T10:00:00Z");
    sig("old-one", "2026-05-01T10:00:00Z");
    sig("old-two", "2026-05-02T10:00:00Z");
    const w = finding();
    expect(w).toBeDefined();
    expect(w!.message).toContain("3 signal");
    expect(w!.message).toContain("2 of them");
    expect(DIAGNOSTIC_SIGNALS.get(CODE)?.nextCommand).toBe("o2b brain dream");
  });

  test("is silent when every inbox signal is inside the window", () => {
    sig("fresh", "2026-06-25T10:00:00Z");
    expect(finding()).toBeUndefined();
  });

  test("is silent after the dream pass archived them", () => {
    sig("old-one", "2026-05-01T10:00:00Z");
    expect(finding()).toBeDefined();
    dream(vault, { now: NOW });
    expect(finding()).toBeUndefined();
  });

  test("is silent when the archive is switched off", () => {
    sig("old-one", "2026-05-01T10:00:00Z");
    const path = brainConfigPath(vault);
    atomicWriteFileSync(
      path,
      readFileSync(path, "utf8").replace(
        /^ {2}contradiction_window_days: 14$/m,
        "  contradiction_window_days: 14\n  archive_stale_signals: false",
      ),
    );
    expect(finding()).toBeUndefined();
  });
});
