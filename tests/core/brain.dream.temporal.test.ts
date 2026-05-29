/**
 * Temporal extraction wired into dream promotion (Brain lifecycle
 * suite, Feature 5). When a promoted cluster's source signal carries a
 * formal ISO temporal token, the new preference's bi-temporal
 * valid_from/valid_until fields are filled. Signals without an ISO token
 * promote with no temporal fields (byte-identical to pre-suite).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../src/core/brain/dream.ts";
import { parsePreference } from "../../src/core/brain/preference.ts";
import { preferencePath } from "../../src/core/brain/paths.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dream-temporal-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-dream-temporal-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function seed(topic: string, slug: string, date: string, principle: string): void {
  writeSignal(vault, {
    topic,
    signal: "positive",
    agent: "claude",
    principle,
    created_at: `${date}T10:00:00Z`,
    date,
    slug,
    scope: "writing",
  });
}

const now = new Date("2026-05-29T12:00:00Z");

describe("dream temporal extraction on promotion", () => {
  test("fills valid_from/valid_until from an ISO duration in the signal", () => {
    seed("temporal-topic", "t1", "2026-05-20", "Rule expires P30D");
    seed("temporal-topic", "t2", "2026-05-21", "Rule expires P30D");
    seed("temporal-topic", "t3", "2026-05-22", "Rule expires P30D");

    const summary = dream(vault, { now });
    expect(summary.new_unconfirmed).toContain("pref-temporal-topic");

    const pref = parsePreference(preferencePath(vault, "temporal-topic"));
    expect(pref.valid_from).toBe("2026-05-29T12:00:00Z");
    expect(pref.valid_until).toBe("2026-06-28T12:00:00Z");
  });

  test("promotes without temporal fields when the signal has no ISO token", () => {
    seed("plain-topic", "p1", "2026-05-20", "Prefer the plain approach");
    seed("plain-topic", "p2", "2026-05-21", "Prefer the plain approach");
    seed("plain-topic", "p3", "2026-05-22", "Prefer the plain approach");

    dream(vault, { now });
    const pref = parsePreference(preferencePath(vault, "plain-topic"));
    expect(pref.valid_from).toBeUndefined();
    expect(pref.valid_until).toBeUndefined();
  });
});
