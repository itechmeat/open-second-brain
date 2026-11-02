/**
 * Tests for `src/core/brain/lessons-promotion.ts` (t_1e952e43).
 *
 * Drives the operator-approved lesson promotion kernel:
 *   - the exact qualification conjunction (preference-derived, confirmed,
 *     high confidence, preferred tier, enabled scope, fresh approval) with
 *     every non-member carrying exactly one named blocked reason;
 *   - the deterministic, timestamp-free block body render;
 *   - the approvals ledger in the derived store (round-trip, upsert,
 *     named refusals, never under `Brain/`);
 *   - the three new log event kinds appending through the shared chain;
 *   - the writer-routing assertion: the kernel writes rules files only
 *     through the shared rules-block writer, never through `node:fs`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LESSONS_APPROVALS_FILE,
  LESSON_PROMOTION_BLOCKED,
  LESSONS_PROMOTION_SCOPES_CONFIG_KEY,
  lessonPromotionCandidates,
  lessonsApprovalsPath,
  markLessonPromoted,
  readLessonApprovals,
  recordLessonApproval,
  renderLessonsBlockBody,
  lessonIdsInBlockBody,
  type LessonApprovalRow,
  type LessonPromotionCandidate,
} from "../../../src/core/brain/lessons-promotion.ts";
import { LESSON_TIER, type LessonEntry } from "../../../src/core/brain/lessons.ts";
import { computeContentHash } from "../../../src/core/brain/content-hash.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { listLogDates, readLogDay } from "../../../src/core/brain/log-jsonl.ts";
import { resolveLessonsPromotionScopes } from "../../../src/core/brain/policy/blocks/lessons.ts";
import {
  DEFAULT_BEGIN_MARKER,
  DEFAULT_END_MARKER,
} from "../../../src/core/install/managed-block.ts";
import { RULES_BLOCK_ID, RULES_BLOCK_MARKERS } from "../../../src/core/install/rules-block.ts";
import {
  missingWritebackGateClauses,
  WRITEBACK_CONTRACT_REQUIREMENTS,
} from "../../../src/core/brain/writeback-contract.ts";
import type { BrainPreference } from "../../../src/core/brain/types.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_PREFERENCE_STATUS } from "../../../src/core/brain/types.ts";

// ----- Fixtures -------------------------------------------------------------

const NOW = new Date("2026-05-20T12:00:00Z");

function buildPref(id: string, overrides: Partial<BrainPreference> = {}): BrainPreference {
  return {
    kind: "brain-preference",
    id,
    created_at: "2026-01-01T00:00:00Z",
    confirmed_at: "2026-01-02T00:00:00Z",
    unconfirmed_until: "2026-01-08T00:00:00Z",
    tags: [],
    topic: id.replace(/^pref-/, ""),
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    principle: `principle for ${id}`,
    scope: "backend",
    evidenced_by: [],
    applied_count: 3,
    violated_count: 0,
    last_evidence_at: "2026-05-01T00:00:00Z",
    confidence: "high",
    confidence_value: 0.9,
    pinned: false,
    ...overrides,
  };
}

function buildLesson(id: string, overrides: Partial<LessonEntry> = {}): LessonEntry {
  return {
    id,
    kind: "preference",
    title: `principle for ${id}`,
    scope: "backend",
    tier: LESSON_TIER.preferred,
    signedScore: 1.5,
    positiveMass: 1.5,
    negativeMass: 0,
    corroboration: 2,
    stance: null,
    lastOutcomeAt: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

function buildRow(prefId: string, overrides: Partial<LessonApprovalRow> = {}): LessonApprovalRow {
  return {
    prefId,
    decision: "approved",
    decidedAt: "2026-05-10T00:00:00Z",
    decidedBy: "yes-flag",
    approvedContentHash: computeContentHash(`principle for ${prefId}`, "backend"),
    targets: ["AGENTS.md"],
    blockId: RULES_BLOCK_ID.lessons,
    lastPromotedAt: null,
    ...overrides,
  };
}

function promoteCase(prefId: string): {
  pref: BrainPreference;
  lesson: LessonEntry;
  row: LessonApprovalRow;
} {
  return {
    pref: buildPref(prefId),
    lesson: buildLesson(prefId),
    row: buildRow(prefId),
  };
}

// ----- Qualification --------------------------------------------------------

describe("lessonPromotionCandidates", () => {
  test("the exact conjunction promotes, with the pinned candidate shape", () => {
    const { pref, lesson, row } = promoteCase("pref-fresh");
    const result = lessonPromotionCandidates([pref], [lesson], [row], {
      enabledScopes: ["backend"],
    });
    expect(result.promotable.length).toBe(1);
    const candidate: LessonPromotionCandidate = result.promotable[0]!;
    expect(candidate.prefId).toBe("pref-fresh");
    expect(candidate.principle).toBe("principle for pref-fresh");
    expect(candidate.scope).toBe("backend");
    expect(candidate.tier).toBe(LESSON_TIER.preferred);
    expect(candidate.confidence).toBe("high");
    expect(candidate.contentHash).toBe(computeContentHash("principle for pref-fresh", "backend"));
    expect(result.blocked).toEqual([]);
  });

  test("an unconfirmed or quarantined preference is blocked unconfirmed", () => {
    const { pref, lesson, row } = promoteCase("pref-un");
    for (const status of [
      BRAIN_PREFERENCE_STATUS.unconfirmed,
      BRAIN_PREFERENCE_STATUS.quarantine,
    ]) {
      const result = lessonPromotionCandidates([{ ...pref, status }], [lesson], [row], {
        enabledScopes: ["backend"],
      });
      expect(result.promotable).toEqual([]);
      expect(result.blocked).toEqual([
        { prefId: "pref-un", reason: LESSON_PROMOTION_BLOCKED.unconfirmed },
      ]);
    }
  });

  test("a preference without a scope, or outside the enabled scopes, is blocked scope_not_enabled", () => {
    const { pref, lesson, row } = promoteCase("pref-scope");
    for (const scope of [undefined, "frontend"]) {
      const result = lessonPromotionCandidates(
        [scope === undefined ? { ...pref, scope: undefined } : { ...pref, scope }],
        [scope === undefined ? { ...lesson, scope: null } : lesson],
        [row],
        { enabledScopes: ["backend"] },
      );
      expect(result.promotable).toEqual([]);
      expect(result.blocked).toEqual([
        { prefId: "pref-scope", reason: LESSON_PROMOTION_BLOCKED.scopeNotEnabled },
      ]);
    }
  });

  test("a medium- or low-confidence preference is blocked low_confidence", () => {
    const { pref, lesson, row } = promoteCase("pref-conf");
    for (const confidence of ["medium", "low"] as const) {
      const result = lessonPromotionCandidates([{ ...pref, confidence }], [lesson], [row], {
        enabledScopes: ["backend"],
      });
      expect(result.promotable).toEqual([]);
      expect(result.blocked).toEqual([
        { prefId: "pref-conf", reason: LESSON_PROMOTION_BLOCKED.lowConfidence },
      ]);
    }
  });

  test("a non-preferred tier, or a preference with no lesson yet, is blocked tier_not_preferred", () => {
    const { pref, lesson, row } = promoteCase("pref-tier");
    for (const tier of [LESSON_TIER.tentative, LESSON_TIER.contested, LESSON_TIER.avoid]) {
      const result = lessonPromotionCandidates([pref], [{ ...lesson, tier }], [row], {
        enabledScopes: ["backend"],
      });
      expect(result.promotable).toEqual([]);
      expect(result.blocked).toEqual([
        { prefId: "pref-tier", reason: LESSON_PROMOTION_BLOCKED.tierNotPreferred },
      ]);
    }
    // No lesson entry at all: the preference has not earned the tier.
    const noLesson = lessonPromotionCandidates([pref], [], [row], { enabledScopes: ["backend"] });
    expect(noLesson.promotable).toEqual([]);
    expect(noLesson.blocked).toEqual([
      { prefId: "pref-tier", reason: LESSON_PROMOTION_BLOCKED.tierNotPreferred },
    ]);
  });

  test("a preference with no approval row is blocked not_approved", () => {
    const { pref, lesson } = promoteCase("pref-norow");
    const result = lessonPromotionCandidates([pref], [lesson], [], {
      enabledScopes: ["backend"],
    });
    expect(result.promotable).toEqual([]);
    expect(result.blocked).toEqual([
      { prefId: "pref-norow", reason: LESSON_PROMOTION_BLOCKED.notApproved },
    ]);
  });

  test("a stale approval (content-hash mismatch) drops the lesson and reports stale_approval", () => {
    const { pref, lesson, row } = promoteCase("pref-stale");
    const drifted = lessonPromotionCandidates(
      [{ ...pref, principle: "principle for pref-stale, amended" }],
      [{ ...lesson, title: "principle for pref-stale, amended" }],
      [row],
      { enabledScopes: ["backend"] },
    );
    expect(drifted.promotable).toEqual([]);
    expect(drifted.blocked).toEqual([
      { prefId: "pref-stale", reason: LESSON_PROMOTION_BLOCKED.staleApproval },
    ]);
  });

  test("a denied row blocks by name, dominates the report, and suppresses a stale approval", () => {
    const { pref, lesson, row } = promoteCase("pref-denied");
    const denied = lessonPromotionCandidates([pref], [lesson], [{ ...row, decision: "denied" }], {
      enabledScopes: ["backend"],
    });
    expect(denied.promotable).toEqual([]);
    expect(denied.blocked).toEqual([
      { prefId: "pref-denied", reason: LESSON_PROMOTION_BLOCKED.denied },
    ]);
    // The operator's will dominates the report even beside other gates.
    const deniedAndUnconfirmed = lessonPromotionCandidates(
      [{ ...pref, status: BRAIN_PREFERENCE_STATUS.unconfirmed }],
      [lesson],
      [{ ...row, decision: "denied" }],
      { enabledScopes: ["backend"] },
    );
    expect(deniedAndUnconfirmed.blocked).toEqual([
      { prefId: "pref-denied", reason: LESSON_PROMOTION_BLOCKED.denied },
    ]);
  });

  test("every input preference is classified exactly once, with a closed-set reason", () => {
    const fresh = promoteCase("pref-a");
    const staleRow = buildRow("pref-b", {
      approvedContentHash: "stale-hash-value-that-matches-nothing",
    });
    const prefs = [fresh.pref, buildPref("pref-b"), buildPref("pref-c")];
    const lessons = [
      fresh.lesson,
      buildLesson("pref-b", { tier: LESSON_TIER.tentative }),
      buildLesson("pref-c"),
    ];
    const approvals = [fresh.row, staleRow];
    const result = lessonPromotionCandidates(prefs, lessons, approvals, {
      enabledScopes: ["backend"],
    });
    expect(result.promotable.map((c) => c.prefId)).toEqual(["pref-a"]);
    expect(result.blocked.map((b) => b.prefId).toSorted()).toEqual(["pref-b", "pref-c"]);
    const members = new Set(Object.values(LESSON_PROMOTION_BLOCKED));
    for (const blocked of result.blocked) {
      expect(members.has(blocked.reason)).toBe(true);
    }
    expect(result.blocked.find((b) => b.prefId === "pref-b")?.reason).toBe(
      LESSON_PROMOTION_BLOCKED.tierNotPreferred,
    );
    expect(result.blocked.find((b) => b.prefId === "pref-c")?.reason).toBe(
      LESSON_PROMOTION_BLOCKED.notApproved,
    );
  });

  test("dead-end lessons never promote: only preference entries match", () => {
    const deadEnd: LessonEntry = buildLesson("de-2026-05-01-fail", {
      kind: "dead-end",
      tier: LESSON_TIER.avoid,
      scope: null,
    });
    const result = lessonPromotionCandidates([], [deadEnd], [], { enabledScopes: ["backend"] });
    expect(result.promotable).toEqual([]);
    expect(result.blocked).toEqual([]);
  });
});

// ----- Render ---------------------------------------------------------------

describe("renderLessonsBlockBody", () => {
  test("identical inputs produce identical bytes", () => {
    const a = promoteCase("pref-x");
    const b = promoteCase("pref-y");
    const input = [a, b].map((c) => ({
      prefId: c.pref.id,
      principle: c.pref.principle,
      scope: c.pref.scope ?? "",
      tier: c.lesson.tier,
      confidence: c.pref.confidence,
      contentHash: c.row.approvedContentHash,
    }));
    expect(renderLessonsBlockBody(input)).toBe(renderLessonsBlockBody(input));
  });

  test("orders by tier, then scope, then id, with no timestamps", () => {
    const candidates: LessonPromotionCandidate[] = [
      {
        prefId: "pref-zeta",
        principle: "zeta rule",
        scope: "backend",
        tier: LESSON_TIER.preferred,
        confidence: "high",
        contentHash: "hash-zeta-000000000000000000000000000000000000000000000000",
      },
      {
        prefId: "pref-alpha",
        principle: "alpha rule",
        scope: "testing",
        tier: LESSON_TIER.preferred,
        confidence: "high",
        contentHash: "hash-alpha-00000000000000000000000000000000000000000000000",
      },
      {
        prefId: "pref-beta",
        principle: "beta rule",
        scope: "backend",
        tier: LESSON_TIER.preferred,
        confidence: "high",
        contentHash: "hash-beta-0000000000000000000000000000000000000000000000000",
      },
    ];
    const body = renderLessonsBlockBody(candidates);
    const lines = body.split("\n").filter((line) => line.startsWith("- `pref-"));
    expect(lines.map((line) => line.match(/`([^`]+)`/)?.[1])).toEqual([
      "pref-beta", // scope backend before testing, id order within scope
      "pref-zeta",
      "pref-alpha",
    ]);
    // No timestamp can appear in a deterministic body.
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("the limit caps the render in order; non-positive or fractional limits refuse by name", () => {
    const candidates: LessonPromotionCandidate[] = ["a", "b", "c"].map((suffix) => ({
      prefId: `pref-${suffix}`,
      principle: `rule ${suffix}`,
      scope: "backend",
      tier: LESSON_TIER.preferred,
      confidence: "high",
      contentHash: `hash-${suffix}`,
    }));
    const capped = renderLessonsBlockBody(candidates, { limit: 2 });
    expect(capped.split("\n").filter((line) => line.startsWith("- `pref-")).length).toBe(2);
    expect(capped).toContain("pref-a");
    expect(capped).toContain("pref-b");
    expect(capped).not.toContain("pref-c");
    for (const limit of [0, -1, 1.5]) {
      expect(() => renderLessonsBlockBody(candidates, { limit })).toThrow(RangeError);
    }
  });

  test("an empty promotable set is a named refusal: removal is the writer's job", () => {
    expect(() => renderLessonsBlockBody([])).toThrow(/remove/i);
  });

  test("multi-line principles collapse to one line", () => {
    const body = renderLessonsBlockBody([
      {
        prefId: "pref-multi",
        principle: "first line\nsecond line",
        scope: "backend",
        tier: LESSON_TIER.preferred,
        confidence: "high",
        contentHash: "hash-multi",
      },
    ]);
    expect(body.split("\n").filter((line) => line.startsWith("- `pref-")).length).toBe(1);
    expect(body).toContain("first line second line");
  });

  test("the lessons body satisfies no usage-block clause and carries no usage marker", () => {
    const body = renderLessonsBlockBody([
      {
        prefId: "pref-ind",
        principle: "an approved rule",
        scope: "backend",
        tier: LESSON_TIER.preferred,
        confidence: "high",
        contentHash: "hash-ind",
      },
    ]);
    // The blocks are independent: the lessons body satisfies none of the
    // usage block's gate clauses, and carries none of its marker spellings.
    expect(missingWritebackGateClauses(body).length).toBe(WRITEBACK_CONTRACT_REQUIREMENTS.length);
    expect(body).not.toContain(DEFAULT_BEGIN_MARKER);
    expect(body).not.toContain(DEFAULT_END_MARKER);
    expect(RULES_BLOCK_MARKERS.lessons.begin).not.toBe(RULES_BLOCK_MARKERS.usage.begin);
  });
});

// ----- Approvals ledger -----------------------------------------------------

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-lessons-promotion-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("lesson approvals ledger", () => {
  test("the ledger lives in the derived store, never under Brain/", () => {
    const path = lessonsApprovalsPath(vault);
    expect(path).toContain(join(".open-second-brain", LESSONS_APPROVALS_FILE));
    expect(path).not.toContain("Brain");
    expect(LESSONS_APPROVALS_FILE).toBe("lessons-approvals.json");
  });

  test("record then read round-trips the row atomically", () => {
    const { row } = promoteCase("pref-ledger");
    recordLessonApproval(vault, row);
    expect(readLessonApprovals(vault)).toEqual([row]);
    const dir = join(vault, ".open-second-brain");
    expect(existsSync(join(dir, LESSONS_APPROVALS_FILE))).toBe(true);
    // Atomic write discipline: no temp leftovers beside the ledger.
    const leftovers = readdirSync(dir).filter((name) => name.startsWith(LESSONS_APPROVALS_FILE));
    expect(leftovers).toEqual([LESSONS_APPROVALS_FILE]);
  });

  test("a second decision for the same id replaces the row (state table, not history)", () => {
    const { row } = promoteCase("pref-twice");
    recordLessonApproval(vault, row);
    recordLessonApproval(vault, buildRow("pref-other"));
    recordLessonApproval(vault, { ...row, decision: "denied", decidedBy: "interactive-yes" });
    const rows = readLessonApprovals(vault);
    expect(rows.length).toBe(2);
    const twice = rows.find((r) => r.prefId === "pref-twice");
    expect(twice?.decision).toBe("denied");
    expect(twice?.decidedBy).toBe("interactive-yes");
  });

  test("reads are sorted by pref id, so identical states are byte-identical files", () => {
    recordLessonApproval(vault, buildRow("pref-z"));
    recordLessonApproval(vault, buildRow("pref-a"));
    const rows = readLessonApprovals(vault);
    expect(rows.map((r) => r.prefId)).toEqual(["pref-a", "pref-z"]);
    const bytes = readFileSync(lessonsApprovalsPath(vault), "utf8");
    expect(bytes.indexOf("pref-a")).toBeGreaterThan(-1);
    expect(bytes.indexOf("pref-a")).toBeLessThan(bytes.indexOf("pref-z"));
  });

  test("a missing ledger reads as empty", () => {
    expect(readLessonApprovals(vault)).toEqual([]);
  });

  test("corrupt JSON, an unknown schema version and a damaged row refuse by name", () => {
    const { row } = promoteCase("pref-corrupt");
    recordLessonApproval(vault, row);
    const path = lessonsApprovalsPath(vault);
    const original = readFileSync(path, "utf8");
    const patterns: ReadonlyArray<RegExp> = [/corrupted/, /schema_version/, /decision/];
    const mutations: ReadonlyArray<string> = [
      original.replace("{", "{broken"),
      original.replace('"schema_version": 1', '"schema_version": 99'),
      original.replace('"decision": "approved"', '"decision": "maybe"'),
    ];
    for (let i = 0; i < mutations.length; i++) {
      writeFileSync(path, mutations[i]!);
      let message = "";
      try {
        readLessonApprovals(vault);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(`${i}: matched: ${patterns[i]!.test(message)}`).toBe(`${i}: matched: true`);
      expect(message).toContain(path);
    }
    // The ledger survives untouched for the operator to repair by hand.
    writeFileSync(path, original);
    expect(readLessonApprovals(vault).length).toBe(1);
  });

  test("markLessonPromoted stamps the row, and a missing row refuses by name", () => {
    const { row } = promoteCase("pref-promoted");
    recordLessonApproval(vault, row);
    markLessonPromoted(vault, "pref-promoted", NOW);
    const rows = readLessonApprovals(vault);
    expect(rows[0]?.lastPromotedAt).toBe("2026-05-20T12:00:00Z");
    expect(() => markLessonPromoted(vault, "pref-absent", NOW)).toThrow(/pref-absent/);
  });
});

// ----- Config resolution ----------------------------------------------------

describe("resolveLessonsPromotionScopes", () => {
  const ENV_KEY = "OPEN_SECOND_BRAIN_LESSONS_PROMOTION_SCOPES";
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  test("the pinned config key is exported from the kernel", () => {
    expect(LESSONS_PROMOTION_SCOPES_CONFIG_KEY).toBe("lessons.promotion.scopes");
  });

  test("absent-or-empty resolves to a named count of zero (promotion disabled)", () => {
    const resolution = resolveLessonsPromotionScopes();
    expect(resolution.scopes).toEqual([]);
    expect(resolution.count).toBe(0);
    expect(resolution.origin).toBe("absent");
  });

  test("the env twin wins and parses a comma-separated list", () => {
    process.env[ENV_KEY] = "backend, testing ,, frontend";
    const resolution = resolveLessonsPromotionScopes();
    expect(resolution.scopes).toEqual(["backend", "testing", "frontend"]);
    expect(resolution.count).toBe(3);
    expect(resolution.origin).toBe("env");
  });

  test("a bracket-shaped value is malformed and resolves disabled", () => {
    process.env[ENV_KEY] = "[backend, testing]";
    const resolution = resolveLessonsPromotionScopes();
    expect(resolution.count).toBe(0);
    expect(resolution.origin).toBe("absent");
  });
});

// ----- Log event kinds ------------------------------------------------------

describe("lessons log event kinds", () => {
  test("the three kinds append through the shared chain and read back", () => {
    const kinds = [
      BRAIN_LOG_EVENT_KIND.lessonsApproved,
      BRAIN_LOG_EVENT_KIND.lessonsDenied,
      BRAIN_LOG_EVENT_KIND.lessonsPromoted,
    ];
    for (const kind of kinds) {
      appendLogEvent(
        vault,
        {
          eventType: kind,
          timestamp: "2026-05-20T12:00:00Z",
          agent: "test-agent",
          body: { pref: "[[pref-x]]" },
        },
        { deviceId: "" },
      );
    }
    const dates = listLogDates(vault);
    expect(dates.length).toBe(1);
    const day = readLogDay(vault, dates[0]!);
    expect(day.entries.map((e) => e.eventType)).toEqual(kinds);
  });

  test("the kind spellings are pinned", () => {
    expect(BRAIN_LOG_EVENT_KIND.lessonsApproved).toBe("lessons-approved");
    expect(BRAIN_LOG_EVENT_KIND.lessonsDenied).toBe("lessons-denied");
    expect(BRAIN_LOG_EVENT_KIND.lessonsPromoted).toBe("lessons-promoted");
  });
});

// ----- Writer routing -------------------------------------------------------

describe("writer routing", () => {
  test("the kernel never imports node:fs write functions; rules writes ride the K1 writer", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "..", "src", "core", "brain", "lessons-promotion.ts"),
      "utf8",
    );
    expect(source).toMatch(/from "node:fs"/);
    // Read-only fs names only; every write-shaped name is absent.
    for (const banned of [
      "writeFileSync",
      "appendFileSync",
      "writeSync",
      "openSync",
      "renameSync",
      "unlinkSync",
      "rmSync",
      "insertManagedBlock",
    ]) {
      expect(`${banned}: ${new RegExp(`\\b${banned}\\b`).test(source)}`).toBe(`${banned}: false`);
    }
    expect(source).toContain("atomicWriteFileSync");
  });
});

// ----- Block body ids (t_1e952e43 C3: the doctor and the verb read back
// which lessons a managed block carries; the parser lives beside the
// render so the format coupling stays in one module) ------------------------

describe("lessonIdsInBlockBody", () => {
  test("extracts the pref ids a rendered body carries, in render order", () => {
    const prefs = [buildPref("pref-b"), buildPref("pref-a")];
    const lessons = [buildLesson("pref-b"), buildLesson("pref-a")];
    const rows = [buildRow("pref-b"), buildRow("pref-a")];
    const { promotable } = lessonPromotionCandidates(prefs, lessons, rows, {
      enabledScopes: ["backend"],
    });
    const body = renderLessonsBlockBody(promotable, { limit: 20 });
    // Same scope and tier, so the render order is the id order.
    expect(lessonIdsInBlockBody(body)).toEqual(["pref-a", "pref-b"]);
  });

  test("a body with no lesson lines yields no ids", () => {
    expect(lessonIdsInBlockBody("# house rules\n")).toEqual([]);
    expect(lessonIdsInBlockBody("- not a lesson line\n- `unterminated\n")).toEqual([]);
  });
});
