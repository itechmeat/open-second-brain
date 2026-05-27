import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendApplyEvidence } from "../../src/core/brain/apply-evidence.ts";
import { dream } from "../../src/core/brain/dream.ts";
import { parseLogDay } from "../../src/core/brain/log.ts";
import { mergePreferences } from "../../src/core/brain/merge.ts";
import {
  brainConfigPath,
  brainDirs,
  preferencePath,
  retiredPath,
} from "../../src/core/brain/paths.ts";
import {
  moveToRetired,
  parsePreference,
  parseRetired,
  writePreference,
} from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dream-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-dream-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function seedSignal(opts: {
  topic: string;
  slug: string;
  signal: "positive" | "negative";
  date: string;
  principle?: string;
}): void {
  writeSignal(vault, {
    topic: opts.topic,
    signal: opts.signal,
    agent: "claude",
    principle: opts.principle ?? `Rule for ${opts.topic}`,
    created_at: `${opts.date}T10:00:00Z`,
    date: opts.date,
    slug: opts.slug,
    scope: "writing",
  });
}

function listInboxActive(): string[] {
  const dirs = brainDirs(vault);
  return readdirSync(dirs.inbox).filter((n) => n.endsWith(".md"));
}

function listInboxProcessed(): string[] {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.processed)) return [];
  return readdirSync(dirs.processed).filter((n) => n.endsWith(".md"));
}

function listPreferences(): string[] {
  return readdirSync(brainDirs(vault).preferences).filter((n) => n.endsWith(".md"));
}

function listRetired(): string[] {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.retired)) return [];
  return readdirSync(dirs.retired).filter((n) => n.endsWith(".md"));
}

// ----- Happy path threshold ----------------------------------------------

describe("dream — happy-path threshold (3 same-sign signals)", () => {
  test("creates one unconfirmed preference and moves the signals to processed/", () => {
    seedSignal({ topic: "no-abbrev", slug: "a", signal: "negative", date: "2026-05-14" });
    seedSignal({ topic: "no-abbrev", slug: "b", signal: "negative", date: "2026-05-14" });
    seedSignal({ topic: "no-abbrev", slug: "c", signal: "negative", date: "2026-05-14" });
    expect(listInboxActive()).toHaveLength(3);

    const res = dream(vault, { now: new Date("2026-05-14T20:00:00Z") });
    expect(res.changed).toBe(true);
    expect(res.new_unconfirmed).toEqual(["pref-no-abbrev"]);

    expect(listPreferences()).toEqual(["pref-no-abbrev.md"]);
    expect(listInboxActive()).toEqual([]);
    expect(listInboxProcessed()).toHaveLength(3);

    const pref = parsePreference(preferencePath(vault, "no-abbrev"));
    expect(pref.status).toBe("unconfirmed");
    expect(pref.applied_count).toBe(0);
    expect(pref.violated_count).toBe(0);
    expect(pref.confidence).toBe("low");
    expect(pref.evidenced_by.length).toBe(3);
  });
});

// ----- Contradiction window ------------------------------------------------

describe("dream — mixed-sign within window does not create a preference", () => {
  test("2 negative + 1 positive cancel below threshold; no pref created", () => {
    seedSignal({ topic: "mixed", slug: "a", signal: "negative", date: "2026-05-14" });
    seedSignal({ topic: "mixed", slug: "b", signal: "negative", date: "2026-05-14" });
    seedSignal({ topic: "mixed", slug: "c", signal: "positive", date: "2026-05-14" });

    const res = dream(vault, { now: new Date("2026-05-14T20:00:00Z") });
    // Some bookkeeping still happens (contradiction flag), so we don't
    // assert `changed: false` strictly — but a pref must not appear.
    expect(listPreferences()).toEqual([]);
    expect(res.new_unconfirmed).toEqual([]);
    expect(res.contradictions).toContain("mixed");
  });
});

// ----- Rebuttal ------------------------------------------------------------

describe("dream — rebuttal of a confirmed preference", () => {
  test("3 opposite-sign signals retire the confirmed pref with reason: rebutted", () => {
    // Seed an existing confirmed pref with sign-derivation indirectly:
    // we put 3 positive signals so the "active sign" heuristic in dream
    // detects positive, and a single negative will count against it.
    // To simplify, we'll instead seed 3 negative signals to attack a
    // positive preference. We construct the pref by hand.
    writePreference(vault, {
      slug: "positive-rule",
      topic: "positive-rule",
      principle: "Do X (positive rule)",
      created_at: "2026-04-01T00:00:00Z",
      unconfirmed_until: "2026-04-15T00:00:00Z",
      status: "confirmed",
      evidenced_by: [],
      confirmed_at: "2026-04-05T00:00:00Z",
      applied_count: 3,
      violated_count: 0,
      last_evidence_at: "2026-05-10T00:00:00Z",
      confidence: "medium",
    });
    // 3 opposite-sign signals.
    seedSignal({ topic: "positive-rule", slug: "r1", signal: "negative", date: "2026-05-14" });
    seedSignal({ topic: "positive-rule", slug: "r2", signal: "negative", date: "2026-05-14" });
    seedSignal({ topic: "positive-rule", slug: "r3", signal: "negative", date: "2026-05-14" });

    const res = dream(vault, { now: new Date("2026-05-14T20:00:00Z") });

    // The pref should have been retired with reason rebutted.
    expect(listPreferences().some((n) => n === "pref-positive-rule.md")).toBe(false);
    expect(listRetired().some((n) => n === "ret-positive-rule.md")).toBe(true);
    const retired = parseRetired(retiredPath(vault, "positive-rule"));
    expect(retired.retired_reason).toBe("rebutted");
    expect(res.retired.map((r) => r.reason)).toContain("rebutted");
  });
});

// ----- Pin protection: stale-no-evidence ----------------------------------

describe("dream — pinned preference survives stale-no-evidence", () => {
  test("clock past stale_evidence_days does NOT retire a pinned pref", () => {
    writePreference(vault, {
      slug: "pinned-stale",
      topic: "pinned-stale",
      principle: "Pinned rule",
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-01-15T00:00:00Z",
      status: "confirmed",
      evidenced_by: [],
      confirmed_at: "2026-01-05T00:00:00Z",
      applied_count: 5,
      violated_count: 0,
      last_evidence_at: "2026-01-10T00:00:00Z",
      confidence: "medium",
      pinned: true,
    });

    // Default stale_evidence_days = 90; pick a now well past that.
    const res = dream(vault, { now: new Date("2026-08-01T00:00:00Z") });
    expect(listPreferences()).toContain("pref-pinned-stale.md");
    expect(listRetired()).not.toContain("ret-pinned-stale.md");
    expect(res.retired.map((r) => r.id)).not.toContain("ret-pinned-stale");

    // A `retire` event with `blocked: pinned` must have been logged.
    const { entries } = parseLogDay(vault, "2026-08-01");
    const retainEvents = entries.filter(
      (e) =>
        e.eventType === "retire" &&
        typeof e.body["blocked"] === "string" &&
        e.body["blocked"] === "pinned",
    );
    expect(retainEvents.length).toBeGreaterThan(0);
  });
});

// ----- Stale-no-evidence (unpinned) ---------------------------------------

describe("dream — stale-no-evidence retires confirmed pref", () => {
  test("confirmed pref with old last_evidence_at retires", () => {
    writePreference(vault, {
      slug: "stale-rule",
      topic: "stale-rule",
      principle: "Old rule",
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-01-15T00:00:00Z",
      status: "confirmed",
      evidenced_by: [],
      confirmed_at: "2026-01-05T00:00:00Z",
      applied_count: 3,
      violated_count: 0,
      last_evidence_at: "2026-01-10T00:00:00Z",
      confidence: "medium",
    });
    const res = dream(vault, { now: new Date("2026-08-01T00:00:00Z") });
    expect(listPreferences()).not.toContain("pref-stale-rule.md");
    expect(listRetired()).toContain("ret-stale-rule.md");
    expect(res.retired.map((r) => r.reason)).toContain("stale-no-evidence");
  });

  test("superseding a retired topic uses a fresh slug so later retire does not collide", () => {
    writePreference(vault, {
      slug: "evolving-rule",
      topic: "evolving-rule",
      principle: "Old rule",
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-01-15T00:00:00Z",
      status: "confirmed",
      evidenced_by: [],
      confirmed_at: "2026-01-05T00:00:00Z",
      applied_count: 3,
      violated_count: 0,
      last_evidence_at: "2026-01-10T00:00:00Z",
      confidence: "medium",
    });
    moveToRetired(vault, preferencePath(vault, "evolving-rule"), "rebutted", {
      now: new Date("2026-02-01T00:00:00Z"),
      retired_by: "[[Brain/log/2026-02-01]]",
    });

    seedSignal({ topic: "evolving-rule", slug: "a", signal: "negative", date: "2026-05-14" });
    seedSignal({ topic: "evolving-rule", slug: "b", signal: "negative", date: "2026-05-14" });
    seedSignal({ topic: "evolving-rule", slug: "c", signal: "negative", date: "2026-05-14" });

    const created = dream(vault, { now: new Date("2026-05-14T20:00:00Z") });
    expect(created.new_unconfirmed).toEqual(["pref-evolving-rule-2"]);
    expect(listPreferences()).toContain("pref-evolving-rule-2.md");
    expect(listRetired()).toContain("ret-evolving-rule.md");

    const retired = dream(vault, { now: new Date("2026-06-15T00:00:00Z") });
    expect(retired.retired).toContainEqual({
      id: "ret-evolving-rule-2",
      reason: "expired-unconfirmed",
    });
    expect(listPreferences()).not.toContain("pref-evolving-rule-2.md");
    expect(listRetired()).toEqual(
      expect.arrayContaining(["ret-evolving-rule.md", "ret-evolving-rule-2.md"]),
    );
  });
});

// ----- Expired-unconfirmed --------------------------------------------------

describe("dream — expired-unconfirmed retires unconfirmed pref past window", () => {
  test("now > unconfirmed_until triggers retire", () => {
    writePreference(vault, {
      slug: "expiring",
      topic: "expiring",
      principle: "Trial rule",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-10T00:00:00Z",
      status: "unconfirmed",
      evidenced_by: [],
    });
    const res = dream(vault, { now: new Date("2026-05-14T00:00:00Z") });
    expect(listPreferences()).not.toContain("pref-expiring.md");
    expect(listRetired()).toContain("ret-expiring.md");
    const retired = parseRetired(retiredPath(vault, "expiring"));
    expect(retired.retired_reason).toBe("expired-unconfirmed");
    expect(res.retired.map((r) => r.reason)).toContain("expired-unconfirmed");
  });
});

// ----- Promotion ----------------------------------------------------------

describe("dream — unconfirmed → confirmed promotion on first applied evidence", () => {
  test("first applied apply-evidence flips status and stamps confirmed_at", () => {
    writePreference(vault, {
      slug: "promote-me",
      topic: "promote-me",
      principle: "Trial rule",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "unconfirmed",
      evidenced_by: [],
    });
    // Drop an apply-evidence log entry.
    appendApplyEvidence(
      vault,
      {
        pref_id: "promote-me",
        artifact: "[[x]]",
        result: "applied",
        agent: "claude",
      },
      { now: new Date("2026-05-05T10:00:00Z") },
    );

    const res = dream(vault, { now: new Date("2026-05-06T00:00:00Z") });
    expect(res.confirmed).toContain("pref-promote-me");

    const pref = parsePreference(preferencePath(vault, "promote-me"));
    expect(pref.status).toBe("confirmed");
    expect(pref.confirmed_at).toBe("2026-05-05T10:00:00Z");
    expect(pref.applied_count).toBe(1);
    expect(pref.violated_count).toBe(0);
    expect(pref.last_evidence_at).toBe("2026-05-05T10:00:00Z");
  });

  test("preserves evidence counts folded by brain merge", () => {
    writePreference(vault, {
      slug: "keep",
      topic: "merge-evidence",
      principle: "Keep this merged preference",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: ["[[sig-keep]]"],
    });
    writePreference(vault, {
      slug: "drop",
      topic: "merge-evidence",
      principle: "Drop this merged preference",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: ["[[sig-drop]]"],
    });
    appendApplyEvidence(
      vault,
      { pref_id: "keep", artifact: "[[k1]]", result: "applied", agent: "claude" },
      { now: new Date("2026-05-03T10:00:00Z") },
    );
    appendApplyEvidence(
      vault,
      { pref_id: "keep", artifact: "[[k2]]", result: "applied", agent: "claude" },
      { now: new Date("2026-05-03T11:00:00Z") },
    );
    appendApplyEvidence(
      vault,
      { pref_id: "drop", artifact: "[[d1]]", result: "applied", agent: "claude" },
      { now: new Date("2026-05-04T10:00:00Z") },
    );
    appendApplyEvidence(
      vault,
      { pref_id: "drop", artifact: "[[d2]]", result: "violated", agent: "claude" },
      { now: new Date("2026-05-05T10:00:00Z") },
    );

    dream(vault, { now: new Date("2026-05-06T00:00:00Z") });
    mergePreferences(vault, "pref-keep", "pref-drop", {
      now: new Date("2026-05-07T00:00:00Z"),
      agentName: "test-agent",
    });

    dream(vault, { now: new Date("2026-05-08T00:00:00Z") });
    const pref = parsePreference(preferencePath(vault, "keep"));
    expect(pref.applied_count).toBe(3);
    expect(pref.violated_count).toBe(1);
    expect(pref.last_evidence_at).toBe("2026-05-05T10:00:00Z");
  });
});

// ----- Confidence formula -------------------------------------------------

describe("dream — confidence formula at boundaries", () => {
  // We exercise the formula indirectly: seed evidence, run dream, read
  // pref.confidence. Default config (from policy.ts):
  //   low_max_applied: 2, stale_evidence_days: 90,
  //   medium_min: 0.40, high_min: 0.75.
  function setupForConfidence(
    slug: string,
    applied: number,
    violated: number,
    fresh: boolean,
  ): void {
    writePreference(vault, {
      slug,
      topic: slug,
      principle: "rule",
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-12-31T00:00:00Z",
      status: "unconfirmed",
      evidenced_by: [],
    });
    // Generate apply-evidence entries spread over days. The most
    // recent one drives `last_evidence_at`. "fresh" anchors near
    // `now` so freshness ≈ 1.0; "stale" puts evidence ~78 days back
    // so the freshness multiplier collapses confidence_value.
    const baseDate = fresh ? "2026-05-14" : "2026-01-01";
    for (let i = 0; i < applied; i++) {
      const d = new Date(`${baseDate}T10:00:0${i % 10}Z`);
      appendApplyEvidence(
        vault,
        { pref_id: slug, artifact: `[[a${i}]]`, result: "applied", agent: "claude" },
        { now: d },
      );
    }
    for (let i = 0; i < violated; i++) {
      const d = new Date(`${baseDate}T11:00:0${i % 10}Z`);
      appendApplyEvidence(
        vault,
        { pref_id: slug, artifact: `[[v${i}]]`, result: "violated", agent: "claude" },
        { now: d },
      );
    }
  }

  test("applied=0 → low", () => {
    setupForConfidence("c-zero", 0, 0, true);
    dream(vault, { now: new Date("2026-05-15T00:00:00Z") });
    // No evidence at all means no refresh; the original `low` default
    // remains.
    const p = parsePreference(preferencePath(vault, "c-zero"));
    expect(p.confidence).toBe("low");
  });

  test("applied=2 (== low_max_applied) → low", () => {
    setupForConfidence("c-low-boundary", 2, 0, true);
    dream(vault, { now: new Date("2026-05-15T00:00:00Z") });
    const p = parsePreference(preferencePath(vault, "c-low-boundary"));
    expect(p.confidence).toBe("low");
  });

  test("applied=3, violated=0, fresh → medium", () => {
    setupForConfidence("c-medium", 3, 0, true);
    dream(vault, { now: new Date("2026-05-15T00:00:00Z") });
    const p = parsePreference(preferencePath(vault, "c-medium"));
    expect(p.confidence).toBe("medium");
  });

  test("applied=10, violated=0, fresh → medium (Wilson ≈ 0.72, below high_min)", () => {
    setupForConfidence("c-medium-10", 10, 0, true);
    dream(vault, { now: new Date("2026-05-15T00:00:00Z") });
    const p = parsePreference(preferencePath(vault, "c-medium-10"));
    expect(p.confidence).toBe("medium");
  });

  test("applied=20, violated=0, fresh → high (Wilson ≈ 0.84, crosses high_min)", () => {
    setupForConfidence("c-high", 20, 0, true);
    dream(vault, { now: new Date("2026-05-15T00:00:00Z") });
    const p = parsePreference(preferencePath(vault, "c-high"));
    expect(p.confidence).toBe("high");
  });

  test("applied=10, violated>=applied → low", () => {
    setupForConfidence("c-violated", 10, 10, true);
    dream(vault, { now: new Date("2026-05-15T00:00:00Z") });
    const p = parsePreference(preferencePath(vault, "c-violated"));
    expect(p.confidence).toBe("low");
  });

  test("applied=10, violated=0, stale → low (freshness collapses the numeric value)", () => {
    setupForConfidence("c-stale", 10, 0, false);
    // Now is well beyond the freshness boundary but BEFORE the
    // stale_evidence_days retire boundary (90 days). 2026-03-20 sits
    // 78 days after the seeded evidence; freshness ≈ 0.13 multiplied
    // by Wilson ≈ 0.72 yields value ≈ 0.10 — squarely in the low band.
    dream(vault, { now: new Date("2026-03-20T00:00:00Z") });
    const p = parsePreference(preferencePath(vault, "c-stale"));
    expect(p.confidence).toBe("low");
  });
});

// ----- Idempotency -------------------------------------------------------

describe("dream — idempotency and determinism", () => {
  test("two consecutive runs with no new input: second run returns changed=false and writes no log entry", () => {
    seedSignal({ topic: "idem", slug: "a", signal: "negative", date: "2026-05-14" });
    seedSignal({ topic: "idem", slug: "b", signal: "negative", date: "2026-05-14" });
    seedSignal({ topic: "idem", slug: "c", signal: "negative", date: "2026-05-14" });

    const first = dream(vault, { now: new Date("2026-05-14T20:00:00Z") });
    expect(first.changed).toBe(true);

    const logBefore = readFileSync(join(brainDirs(vault).log, "2026-05-14.md"), "utf8");

    // Second run on a fresh `now` so the run_id would be different.
    const second = dream(vault, { now: new Date("2026-05-14T20:01:00Z") });
    expect(second.changed).toBe(false);

    const logAfter = readFileSync(join(brainDirs(vault).log, "2026-05-14.md"), "utf8");
    expect(logAfter).toBe(logBefore);
  });

  test("determinism: same vault state + same --now → byte-identical preference files", () => {
    seedSignal({ topic: "det", slug: "a", signal: "negative", date: "2026-05-14" });
    seedSignal({ topic: "det", slug: "b", signal: "negative", date: "2026-05-14" });
    seedSignal({ topic: "det", slug: "c", signal: "negative", date: "2026-05-14" });

    const now = new Date("2026-05-14T20:00:00Z");
    dream(vault, { now });
    const prefBytes1 = readFileSync(preferencePath(vault, "det"), "utf8");

    // Run dream again at the same now; since nothing else changed and
    // the pref already exists, the second run should be a no-op and
    // the bytes must match exactly.
    dream(vault, { now });
    const prefBytes2 = readFileSync(preferencePath(vault, "det"), "utf8");
    expect(prefBytes2).toBe(prefBytes1);
  });
});

// ----- Corrupted frontmatter tolerance ------------------------------------

describe("dream — corrupted frontmatter tolerance", () => {
  test("valid signals processed; corrupted file produces skip-corrupted-frontmatter and does NOT abort", () => {
    const dirs = brainDirs(vault);
    seedSignal({ topic: "okay", slug: "a", signal: "negative", date: "2026-05-14" });
    seedSignal({ topic: "okay", slug: "b", signal: "negative", date: "2026-05-14" });
    seedSignal({ topic: "okay", slug: "c", signal: "negative", date: "2026-05-14" });
    // Plant a corrupt signal file.
    writeFileSync(
      join(dirs.inbox, "sig-2026-05-14-broken.md"),
      "---\nbroken: yaml\nno-required-fields: true\n---\n\nbody\n",
    );

    const res = dream(vault, { now: new Date("2026-05-14T20:00:00Z") });
    expect(res.changed).toBe(true);
    // The valid topic still got its preference.
    expect(listPreferences()).toContain("pref-okay.md");

    const { entries } = parseLogDay(vault, "2026-05-14");
    const skips = entries.filter((e) => e.eventType === "skip-corrupted-frontmatter");
    expect(skips.length).toBeGreaterThan(0);
    expect(String(skips[0]!.body["path"])).toContain("sig-2026-05-14-broken.md");
  });
});

// ----- Dry run ------------------------------------------------------------

describe("dream — dryRun mode", () => {
  test("dryRun=true: summary planned but no files mutated", () => {
    seedSignal({ topic: "dry", slug: "a", signal: "negative", date: "2026-05-14" });
    seedSignal({ topic: "dry", slug: "b", signal: "negative", date: "2026-05-14" });
    seedSignal({ topic: "dry", slug: "c", signal: "negative", date: "2026-05-14" });

    const beforeInbox = listInboxActive().toSorted();
    const beforePrefs = listPreferences().toSorted();
    const beforeLog = existsSync(join(brainDirs(vault).log, "2026-05-14.md"));

    const res = dream(vault, {
      now: new Date("2026-05-14T20:00:00Z"),
      dryRun: true,
    });
    expect(res.changed).toBe(true);
    expect(res.new_unconfirmed).toEqual(["pref-dry"]);
    expect(res.moved_to_processed).toHaveLength(3);
    // dry_run flag distinguishes a planned-only return from a real run.
    expect(res.dry_run).toBe(true);
    // No log path on dry-run: the run never wrote to log/.
    expect(res.log_path).toBeUndefined();

    // Nothing actually changed on disk.
    expect(listInboxActive().toSorted()).toEqual(beforeInbox);
    expect(listPreferences().toSorted()).toEqual(beforePrefs);
    expect(existsSync(join(brainDirs(vault).log, "2026-05-14.md"))).toBe(beforeLog);
  });
});

// ----- Empty vault edge case ---------------------------------------------

describe("dream — empty Brain (no signals, no prefs)", () => {
  test("returns changed=false with no log entry and no snapshot", () => {
    const res = dream(vault, { now: new Date("2026-05-14T20:00:00Z") });
    expect(res.changed).toBe(false);
    expect(res.snapshot_path).toBeUndefined();
    expect(existsSync(join(brainDirs(vault).log, "2026-05-14.md"))).toBe(false);
    // Brain config still in place from bootstrap.
    expect(existsSync(brainConfigPath(vault))).toBe(true);
  });
});

// ----- Quarantine ---------------------------------------------------------
//
// Default brain config (`policy.ts`): low_max_applied = 2. The entry
// condition is `violated_count ≥ applied_count AND applied_count >
// low_max_applied`, so the smallest fixture needs applied ≥ 3 with
// violated ≥ applied. We seed evidence directly through the log.

describe("dream — quarantine entry", () => {
  test("confirmed pref crosses violated≥applied with applied>low_max → quarantine", () => {
    writePreference(vault, {
      slug: "quarantine-target",
      topic: "quarantine-target",
      principle: "Trial rule",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 0,
      violated_count: 0,
      last_evidence_at: null,
      confidence: "low",
    });
    // 3 applied + 3 violated → entry condition met (applied=3 > 2 and violated=3 ≥ applied=3).
    for (let i = 0; i < 3; i++) {
      appendApplyEvidence(
        vault,
        { pref_id: "quarantine-target", artifact: "[[a]]", result: "applied", agent: "claude" },
        { now: new Date(`2026-05-0${i + 3}T10:00:00Z`) },
      );
    }
    for (let i = 0; i < 3; i++) {
      appendApplyEvidence(
        vault,
        { pref_id: "quarantine-target", artifact: "[[b]]", result: "violated", agent: "claude" },
        { now: new Date(`2026-05-0${i + 6}T10:00:00Z`) },
      );
    }

    const res = dream(vault, { now: new Date("2026-05-10T00:00:00Z") });
    expect(res.changed).toBe(true);

    const pref = parsePreference(preferencePath(vault, "quarantine-target"));
    expect(pref.status).toBe("quarantine");
    expect(pref.applied_count).toBe(3);
    expect(pref.violated_count).toBe(3);
    // The pref stays in preferences/, NOT retired.
    expect(listPreferences()).toContain("pref-quarantine-target.md");
    expect(listRetired()).not.toContain("ret-quarantine-target.md");
  });

  test("low_max_applied gating — applied=2 with violated=2 stays confirmed", () => {
    writePreference(vault, {
      slug: "below-threshold",
      topic: "below-threshold",
      principle: "Trial rule",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 0,
      violated_count: 0,
      last_evidence_at: null,
      confidence: "low",
    });
    for (let i = 0; i < 2; i++) {
      appendApplyEvidence(
        vault,
        { pref_id: "below-threshold", artifact: "[[a]]", result: "applied", agent: "claude" },
        { now: new Date(`2026-05-0${i + 3}T10:00:00Z`) },
      );
      appendApplyEvidence(
        vault,
        { pref_id: "below-threshold", artifact: "[[b]]", result: "violated", agent: "claude" },
        { now: new Date(`2026-05-0${i + 5}T10:00:00Z`) },
      );
    }

    dream(vault, { now: new Date("2026-05-10T00:00:00Z") });
    const pref = parsePreference(preferencePath(vault, "below-threshold"));
    expect(pref.status).toBe("confirmed");
  });
});

describe("dream — quarantine → retired (quarantine-violated)", () => {
  test("new violated event on quarantine pref retires it", () => {
    // Seed an already-quarantined pref directly: writePreference
    // accepts the new status. applied=3, violated=3 is the persisted
    // snapshot. Then add one more violated event in the log so
    // dream sees violated > rec.pref.violated_count.
    writePreference(vault, {
      slug: "to-retire",
      topic: "to-retire",
      principle: "Probationary rule",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "quarantine",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 3,
      violated_count: 3,
      last_evidence_at: "2026-05-08T00:00:00Z",
      confidence: "low",
    });
    // Mirror those counters in the log so the recompute matches the
    // persisted snapshot, then add the trigger event.
    for (let i = 0; i < 3; i++) {
      appendApplyEvidence(
        vault,
        { pref_id: "to-retire", artifact: "[[a]]", result: "applied", agent: "claude" },
        { now: new Date(`2026-05-0${i + 3}T10:00:00Z`) },
      );
      appendApplyEvidence(
        vault,
        { pref_id: "to-retire", artifact: "[[b]]", result: "violated", agent: "claude" },
        { now: new Date(`2026-05-0${i + 6}T10:00:00Z`) },
      );
    }
    appendApplyEvidence(
      vault,
      { pref_id: "to-retire", artifact: "[[c]]", result: "violated", agent: "claude" },
      { now: new Date("2026-05-09T10:00:00Z") },
    );

    const res = dream(vault, { now: new Date("2026-05-10T00:00:00Z") });
    expect(res.changed).toBe(true);
    expect(listPreferences()).not.toContain("pref-to-retire.md");
    expect(listRetired()).toContain("ret-to-retire.md");

    const retired = parseRetired(retiredPath(vault, "to-retire"));
    expect(retired.retired_reason).toBe("quarantine-violated");
    expect(res.retired.map((r) => r.reason)).toContain("quarantine-violated");
  });

  test("pinned quarantine pref logs retain-pinned instead of retiring", () => {
    writePreference(vault, {
      slug: "pinned-quar",
      topic: "pinned-quar",
      principle: "Pinned rule",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "quarantine",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 3,
      violated_count: 3,
      last_evidence_at: "2026-05-08T00:00:00Z",
      confidence: "low",
      pinned: true,
    });
    for (let i = 0; i < 3; i++) {
      appendApplyEvidence(
        vault,
        { pref_id: "pinned-quar", artifact: "[[a]]", result: "applied", agent: "claude" },
        { now: new Date(`2026-05-0${i + 3}T10:00:00Z`) },
      );
      appendApplyEvidence(
        vault,
        { pref_id: "pinned-quar", artifact: "[[b]]", result: "violated", agent: "claude" },
        { now: new Date(`2026-05-0${i + 6}T10:00:00Z`) },
      );
    }
    appendApplyEvidence(
      vault,
      { pref_id: "pinned-quar", artifact: "[[c]]", result: "violated", agent: "claude" },
      { now: new Date("2026-05-09T10:00:00Z") },
    );

    dream(vault, { now: new Date("2026-05-10T00:00:00Z") });
    expect(listPreferences()).toContain("pref-pinned-quar.md");
    expect(listRetired()).not.toContain("ret-pinned-quar.md");
    const log = parseLogDay(vault, "2026-05-10");
    const blocked = log.entries.find(
      (e) =>
        e.eventType === "retire" &&
        e.body["preference"] === "[[pref-pinned-quar|Pinned rule]]" &&
        e.body["blocked"] === "pinned",
    );
    expect(blocked).toBeDefined();
    expect(blocked!.body["reason"]).toBe("quarantine-violated");
  });
});

describe("dream — outdated evidence retires with superseded-by-context", () => {
  test("single outdated event retires a confirmed pref", () => {
    writePreference(vault, {
      slug: "context-shift",
      topic: "context-shift",
      principle: "Recoverable rule",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 4,
      violated_count: 0,
      last_evidence_at: "2026-05-08T00:00:00Z",
      confidence: "medium",
    });
    appendApplyEvidence(
      vault,
      { pref_id: "context-shift", artifact: "[[x]]", result: "outdated", agent: "claude" },
      { now: new Date("2026-05-09T10:00:00Z") },
    );

    const res = dream(vault, { now: new Date("2026-05-10T00:00:00Z") });
    expect(res.changed).toBe(true);
    expect(listPreferences()).not.toContain("pref-context-shift.md");
    expect(listRetired()).toContain("ret-context-shift.md");
    const retired = parseRetired(retiredPath(vault, "context-shift"));
    expect(retired.retired_reason).toBe("superseded-by-context");
    expect(res.retired.map((r) => r.reason)).toContain("superseded-by-context");
  });

  test("pinned pref also retires on outdated — pin doesn't protect against context shifts", () => {
    writePreference(vault, {
      slug: "pinned-outdated",
      topic: "pinned-outdated",
      principle: "Pinned rule",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 3,
      violated_count: 0,
      last_evidence_at: "2026-05-08T00:00:00Z",
      confidence: "medium",
      pinned: true,
    });
    appendApplyEvidence(
      vault,
      { pref_id: "pinned-outdated", artifact: "[[x]]", result: "outdated", agent: "claude" },
      { now: new Date("2026-05-09T10:00:00Z") },
    );

    const res = dream(vault, { now: new Date("2026-05-10T00:00:00Z") });
    expect(res.changed).toBe(true);
    expect(listPreferences()).not.toContain("pref-pinned-outdated.md");
    expect(listRetired()).toContain("ret-pinned-outdated.md");
  });
});

describe("dream — quarantine → confirmed (recovery)", () => {
  test("applied > violated returns quarantine pref to confirmed", () => {
    writePreference(vault, {
      slug: "recover",
      topic: "recover",
      principle: "Recoverable rule",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "quarantine",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 3,
      violated_count: 3,
      last_evidence_at: "2026-05-08T00:00:00Z",
      confidence: "low",
    });
    for (let i = 0; i < 3; i++) {
      appendApplyEvidence(
        vault,
        { pref_id: "recover", artifact: "[[a]]", result: "applied", agent: "claude" },
        { now: new Date(`2026-05-0${i + 3}T10:00:00Z`) },
      );
      appendApplyEvidence(
        vault,
        { pref_id: "recover", artifact: "[[b]]", result: "violated", agent: "claude" },
        { now: new Date(`2026-05-0${i + 6}T10:00:00Z`) },
      );
    }
    // Two fresh applied events flip the balance: applied=5 > violated=3.
    appendApplyEvidence(
      vault,
      { pref_id: "recover", artifact: "[[c]]", result: "applied", agent: "claude" },
      { now: new Date("2026-05-09T10:00:00Z") },
    );
    appendApplyEvidence(
      vault,
      { pref_id: "recover", artifact: "[[d]]", result: "applied", agent: "claude" },
      { now: new Date("2026-05-09T11:00:00Z") },
    );

    dream(vault, { now: new Date("2026-05-10T00:00:00Z") });
    const pref = parsePreference(preferencePath(vault, "recover"));
    expect(pref.status).toBe("confirmed");
    expect(pref.applied_count).toBe(5);
    expect(pref.violated_count).toBe(3);
    expect(listRetired()).not.toContain("ret-recover.md");
  });
});
