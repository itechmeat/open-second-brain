import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { regenerateActive } from "../../src/core/brain/active.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainActivePath, preferencePath } from "../../src/core/brain/paths.ts";
import {
  moveToRetired,
  writePreference,
} from "../../src/core/brain/preference.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-active-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-active-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function readActive(): string {
  return readFileSync(brainActivePath(vault), "utf8");
}

function seedConfirmed(slug: string, principle: string, confidence: "low" | "medium" | "high"): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-30T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-05-02T00:00:00Z",
    evidenced_by: [],
    applied_count: confidence === "high" ? 10 : 3,
    violated_count: 0,
    last_evidence_at: "2026-05-09T00:00:00Z",
    confidence,
    scope: "writing",
  });
}

function seedQuarantine(slug: string, principle: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-30T00:00:00Z",
    status: "quarantine",
    confirmed_at: "2026-05-02T00:00:00Z",
    evidenced_by: [],
    applied_count: 3,
    violated_count: 5,
    last_evidence_at: "2026-05-09T00:00:00Z",
    confidence: "low",
    scope: "coding",
  });
}

describe("regenerateActive — empty Brain", () => {
  test("produces a file with the Confirmed header and a placeholder line", () => {
    const result = regenerateActive(vault, { now: new Date("2026-05-15T10:00:00Z") });

    expect(existsSync(result.path)).toBe(true);
    expect(result.counts).toEqual({
      confirmed: 0,
      quarantine: 0,
      retired_recent: 0,
      most_applied_30d: 0,
    });

    const body = readActive();
    expect(body).toContain("kind: brain-active");
    expect(body).toContain("generated_at: 2026-05-15T10:00:00Z");
    expect(body).toContain("# Active Brain Preferences");
    expect(body).toContain("## Confirmed (0)");
    expect(body).toContain("_No confirmed preferences yet._");
    expect(body).not.toContain("## Quarantine");
    expect(body).not.toContain("## Recently retired");
  });
});

describe("regenerateActive — content rendering", () => {
  test("renders sections sorted by confidence high→low then id", () => {
    seedConfirmed("zebra", "Lowest-priority alphabetically last rule", "low");
    seedConfirmed("apple", "High-confidence rule", "high");
    seedConfirmed("middle", "Medium-confidence rule", "medium");

    regenerateActive(vault, { now: new Date("2026-05-15T10:00:00Z") });
    const body = readActive();

    const confirmedSection = body.split("## Confirmed")[1] ?? "";
    const appleIdx = confirmedSection.indexOf("pref-apple");
    const middleIdx = confirmedSection.indexOf("pref-middle");
    const zebraIdx = confirmedSection.indexOf("pref-zebra");
    expect(appleIdx).toBeLessThan(middleIdx);
    expect(middleIdx).toBeLessThan(zebraIdx);

    expect(body).toContain("## Confirmed (3)");
    expect(body).toContain("`pref-apple` (scope: writing, confidence: high)");
    expect(body).toContain("`pref-zebra` (scope: writing, confidence: low)");
  });

  test("renders Quarantine section with counters and recovery hint", () => {
    seedQuarantine("flaky-rule", "Probationary rule");
    regenerateActive(vault, { now: new Date("2026-05-15T10:00:00Z") });
    const body = readActive();
    expect(body).toContain("## Quarantine (1)");
    expect(body).toContain("applied: 3 / violated: 5");
    expect(body).toContain("scope: coding");
    expect(body).toContain("Probationary rule");
    expect(body).toContain("One further `violated` evidence event retires the rule");
  });

  test("renders Recently retired sorted by retired_at desc, capped at 3", () => {
    seedConfirmed("oldest", "P1", "low");
    seedConfirmed("middle-r", "P2", "low");
    seedConfirmed("newest", "P3", "low");
    seedConfirmed("fourth", "P4", "low");
    moveToRetired(vault, preferencePath(vault, "oldest"), "stale-no-evidence", {
      now: new Date("2026-05-01T00:00:00Z"),
      retired_by: "[[Brain/log/2026-05-01]]",
    });
    moveToRetired(vault, preferencePath(vault, "middle-r"), "rebutted", {
      now: new Date("2026-05-10T00:00:00Z"),
      retired_by: "[[Brain/log/2026-05-10]]",
    });
    moveToRetired(vault, preferencePath(vault, "newest"), "user-rejected", {
      now: new Date("2026-05-12T00:00:00Z"),
      retired_by: "[[Brain/log/2026-05-12]]",
    });
    moveToRetired(vault, preferencePath(vault, "fourth"), "quarantine-violated", {
      now: new Date("2026-05-14T00:00:00Z"),
      retired_by: "[[Brain/log/2026-05-14]]",
    });

    regenerateActive(vault, { now: new Date("2026-05-15T10:00:00Z") });
    const body = readActive();
    expect(body).toContain("## Recently retired (last 3)");
    // Capped at 3 → "oldest" is omitted.
    expect(body).not.toContain("ret-oldest");
    // The other three appear in desc-by-retired_at order.
    const fourthIdx = body.indexOf("ret-fourth");
    const newestIdx = body.indexOf("ret-newest");
    const middleIdx = body.indexOf("ret-middle-r");
    expect(fourthIdx).toBeLessThan(newestIdx);
    expect(newestIdx).toBeLessThan(middleIdx);
    expect(body).toContain("ret-fourth` — quarantine-violated on 2026-05-14");
  });
});

describe("regenerateActive — idempotency", () => {
  test("second call with identical state does not rewrite the file", () => {
    seedConfirmed("stable", "Stable rule", "medium");
    const firstNow = new Date("2026-05-15T10:00:00Z");
    const first = regenerateActive(vault, { now: firstNow });
    expect(first.changed).toBe(true);
    const mtimeBefore = statSync(first.path).mtimeMs;

    // Sleep a tick so mtime would shift if a rewrite happens. (1ms is
    // below the granularity of some filesystems; we don't depend on
    // wall-clock delta — we depend on `changed: false` and on the
    // mtime not advancing across the call.)
    const secondNow = new Date("2026-05-15T11:00:00Z");
    const second = regenerateActive(vault, { now: secondNow });
    expect(second.changed).toBe(false);
    const mtimeAfter = statSync(second.path).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  test("body changes when a new pref appears", () => {
    seedConfirmed("a", "Rule A", "medium");
    regenerateActive(vault, { now: new Date("2026-05-15T10:00:00Z") });

    seedConfirmed("b", "Rule B", "medium");
    const result = regenerateActive(vault, { now: new Date("2026-05-15T11:00:00Z") });
    expect(result.changed).toBe(true);
    const body = readActive();
    expect(body).toContain("pref-a");
    expect(body).toContain("pref-b");
  });
});

describe("regenerateActive — corruption tolerance", () => {
  test("a corrupted preference file is omitted from the render, not fatal", () => {
    seedConfirmed("healthy", "Healthy rule", "high");
    // Drop a broken file directly into preferences/.
    atomicWriteFileSync(preferencePath(vault, "corrupted"), "not valid frontmatter\n");

    const result = regenerateActive(vault, { now: new Date("2026-05-15T10:00:00Z") });
    expect(result.counts.confirmed).toBe(1);
    const body = readActive();
    expect(body).toContain("pref-healthy");
    expect(body).not.toContain("pref-corrupted");
  });
});

// ── Most-applied (30d) section — v0.10.10 ──────────────────────────────────

import { appendLogEvent } from "../../src/core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../src/core/brain/types.ts";

function seedAppliedEvidence(
  prefId: string,
  timestamp: string,
  artifact: string = "[[src/test.ts]]",
): void {
  appendLogEvent(vault, {
    timestamp,
    eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
    body: {
      preference: `[[${prefId}]]`,
      artifact,
      agent: "tester",
      result: "applied",
    },
  });
}

describe("regenerateActive — Most-applied (30d) section", () => {
  test("section absent when no apply-evidence events lie inside the window", () => {
    seedConfirmed("a", "Rule A", "medium");
    const result = regenerateActive(vault, { now: new Date("2026-05-20T00:00:00Z") });
    const body = readActive();
    expect(body).not.toContain("## Most-applied");
    expect(result.counts.most_applied_30d).toBe(0);
  });

  test("renders the section and includes scope + applied_30d count", () => {
    seedConfirmed("a", "Rule A", "medium");
    seedAppliedEvidence("pref-a", "2026-05-15T10:00:00Z");
    seedAppliedEvidence("pref-a", "2026-05-16T10:00:00Z");
    const result = regenerateActive(vault, { now: new Date("2026-05-20T00:00:00Z") });
    const body = readActive();
    expect(body).toContain("## Most-applied (30d) (1)");
    expect(body).toContain("`pref-a` (scope: writing, applied_30d: 2)");
    expect(body).toContain("Rule A");
    expect(result.counts.most_applied_30d).toBe(1);
  });

  test("section appears between Confirmed and Quarantine", () => {
    seedConfirmed("a", "Confirmed rule", "high");
    seedQuarantine("q", "Quarantined rule");
    seedAppliedEvidence("pref-a", "2026-05-15T10:00:00Z");
    regenerateActive(vault, { now: new Date("2026-05-20T00:00:00Z") });
    const body = readActive();
    const confirmedIdx = body.indexOf("## Confirmed");
    const mostAppliedIdx = body.indexOf("## Most-applied");
    const quarantineIdx = body.indexOf("## Quarantine");
    expect(confirmedIdx).toBeGreaterThan(-1);
    expect(mostAppliedIdx).toBeGreaterThan(confirmedIdx);
    expect(quarantineIdx).toBeGreaterThan(mostAppliedIdx);
  });

  test("idempotent rerender with no log change leaves the file untouched", () => {
    seedConfirmed("a", "Rule A", "medium");
    seedAppliedEvidence("pref-a", "2026-05-15T10:00:00Z");
    const first = regenerateActive(vault, { now: new Date("2026-05-20T00:00:00Z") });
    const mtimeBefore = statSync(first.path).mtimeMs;
    // Bump `now` so the frontmatter timestamp would differ if a write
    // happened. The body must be identical, so `changed: false`.
    const second = regenerateActive(vault, { now: new Date("2026-05-20T00:30:00Z") });
    expect(second.changed).toBe(false);
    const mtimeAfter = statSync(second.path).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});
