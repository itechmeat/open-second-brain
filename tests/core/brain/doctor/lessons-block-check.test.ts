/**
 * The lessons-block doctor check (t_1e952e43, task C3).
 *
 * A failSoft, read-only check over the managed lessons blocks of the
 * agent rules files. One finding per candidate file, in a closed state
 * vocabulary shared with the writer's own drift vocabulary plus the
 * named `stale-lessons` extension:
 *
 *   - a block still carrying a lesson whose approval went stale is the
 *     `stale-lessons` finding with the refresh command;
 *   - a block behind the canonical body (a new lesson qualified, or the
 *     block holds content nothing qualifies for any more) is `drifted`;
 *   - a file whose approvals name it but which carries no block is
 *     `absent` - creation is approve's write, so the remedy names
 *     approve, never refresh;
 *   - a current block is silent.
 *
 * The check never mutates a byte and never throws: a damaged approvals
 * ledger folds into one warning naming the file and the recovery, and a
 * per-file surprise folds into that file's warning.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeContentHash } from "../../../../src/core/brain/content-hash.ts";
import {
  LESSONS_APPROVALS_FILE,
  lessonsApprovalsPath,
  planLessonsBlock,
  recordLessonApproval,
} from "../../../../src/core/brain/lessons-promotion.ts";
import {
  LESSONS_BLOCK_MANAGED_FILES,
  LESSONS_BLOCK_STATE,
  lessonsBlockCheck,
  lessonsBlockStates,
} from "../../../../src/core/brain/doctor/lessons-block-check.ts";
import { AGENT_INSTRUCTION_FILES } from "../../../../src/core/brain/writeback-contract.ts";
import type {
  DoctorCheckContext,
  DoctorFindings,
} from "../../../../src/core/brain/doctor/check.ts";
import { appendLogEvent } from "../../../../src/core/brain/log.ts";
import { writePreference } from "../../../../src/core/brain/preference.ts";
import { writeVaultIdentity } from "../../../../src/core/brain/vault-identity.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../../src/core/brain/types.ts";
import { RULES_BLOCK_ID, writeRulesBlock } from "../../../../src/core/install/rules-block.ts";

const PRINCIPLE = "Always run the full test suite before merging";
const SCOPE_ENV = "OPEN_SECOND_BRAIN_LESSONS_PROMOTION_SCOPES";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-doctor-lessons-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n", "utf8");
  writeVaultIdentity(vault);
  process.env[SCOPE_ENV] = "backend";
});

afterEach(() => {
  if (process.env[SCOPE_ENV] === "backend") delete process.env[SCOPE_ENV];
  rmSync(tmp, { recursive: true, force: true });
});

/** Seed one confirmed, high-confidence preference with two applied events. */
function seedLesson(slug: string, principle: string = PRINCIPLE): string {
  writePreference(vault, {
    slug,
    topic: slug,
    principle,
    scope: "backend",
    created_at: "2026-05-01T00:00:00Z",
    confirmed_at: "2026-05-02T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: "confirmed",
    evidenced_by: ["[[sig-1]]"],
    applied_count: 2,
    violated_count: 0,
    last_evidence_at: "2026-05-10T00:00:00Z",
    confidence: "high",
  } as Parameters<typeof writePreference>[1]);
  const artifacts = ["[[a.ts]]", "[[b.ts]]"]; // distinct outcomes: corroboration 2
  for (const [i, stamp] of ["2026-05-09T00:00:00Z", "2026-05-10T00:00:00Z"].entries()) {
    appendLogEvent(
      vault,
      {
        timestamp: stamp,
        eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
        body: {
          preference: `[[pref-${slug}]]`,
          artifact: artifacts[i] as string,
          agent: "t",
          result: "applied",
        },
      },
      { deviceId: "" },
    );
  }
  return `pref-${slug}`;
}

function approveFor(prefId: string, file: string, principle: string = PRINCIPLE): void {
  recordLessonApproval(vault, {
    prefId,
    decision: "approved",
    decidedAt: "2026-05-15T00:00:00Z",
    decidedBy: "yes-flag",
    approvedContentHash: computeContentHash(principle, "backend"),
    targets: [file],
    blockId: RULES_BLOCK_ID.lessons,
    lastPromotedAt: null,
  });
}

/**
 * Approve `prefId` for AGENTS.md and write the block a refresh would
 * render right now - the same derivation the check grades against, so
 * the fixture block is current by construction.
 */
function approveAndWrite(prefId: string, principle: string = PRINCIPLE): void {
  writeFileSync(join(vault, "AGENTS.md"), "# house rules\n");
  approveFor(prefId, "AGENTS.md", principle);
  const plan = planLessonsBlock(vault, "AGENTS.md");
  if (plan.body === null) throw new Error(`fixture: nothing qualified for ${prefId}`);
  writeRulesBlock(join(vault, "AGENTS.md"), RULES_BLOCK_ID.lessons, plan.body, {});
}

const NOW = new Date("2026-05-20T00:00:00Z");

function fixtureContext(): DoctorCheckContext {
  return {
    vault,
    now: NOW,
    config: undefined,
    dbPath: undefined,
    configPath: undefined,
    knownBasenames: new Set(),
    idIndex: new Map(),
    preferences: [],
    logs: [],
  };
}

function runCheck(): DoctorFindings {
  const out: DoctorFindings = { issues: [], uncertain: [] };
  lessonsBlockCheck.run(fixtureContext(), out);
  return out;
}

describe("lessons-block doctor check", () => {
  test("a block carrying a stale lesson is the named stale-lessons finding with the refresh command", () => {
    const prefId = seedLesson("doctor-stale");
    approveAndWrite(prefId);
    // The operator amends the approved text; the pinned hash goes stale.
    const prefPath = join(vault, "Brain", "preferences", `${prefId}.md`);
    writeFileSync(
      prefPath,
      readFileSync(prefPath, "utf8").replace(PRINCIPLE, `${PRINCIPLE}, amended`),
    );

    const out = runCheck();
    expect(out.issues.length).toBe(1);
    expect(out.issues[0]?.severity).toBe("warning");
    expect(out.issues[0]?.code).toBe("lessons-block-stale-lessons");
    expect(out.issues[0]?.path).toBe("AGENTS.md");
    expect(out.issues[0]?.message).toContain("refresh-blocks");
    expect(out.issues[0]?.message).toContain(prefId);
  });

  test("a current block is silent", () => {
    const prefId = seedLesson("doctor-current");
    approveAndWrite(prefId);
    const out = runCheck();
    expect(out.issues).toEqual([]);
    expect(out.uncertain).toEqual([]);
  });

  test("a block behind the canonical body is drifted", () => {
    const first = seedLesson("doctor-drift-a");
    approveAndWrite(first);
    // A second lesson qualifies but the block was never refreshed.
    const second = seedLesson("doctor-drift-b", "Write the failing test first");
    approveFor(second, "AGENTS.md", "Write the failing test first");

    const out = runCheck();
    expect(out.issues.length).toBe(1);
    expect(out.issues[0]?.code).toBe("lessons-block-drifted");
    expect(out.issues[0]?.path).toBe("AGENTS.md");
    expect(out.issues[0]?.message).toContain("refresh-blocks");
  });

  test("approvals naming a file that carries no block report absent and name approve", () => {
    const prefId = seedLesson("doctor-absent");
    approveFor(prefId, "AGENTS.md");
    expect(existsSync(join(vault, "AGENTS.md"))).toBe(false);

    const out = runCheck();
    expect(out.issues.length).toBe(1);
    expect(out.issues[0]?.code).toBe("lessons-block-absent");
    expect(out.issues[0]?.path).toBe("AGENTS.md");
    expect(out.issues[0]?.message).toContain("approve");
    expect(out.issues[0]?.message).not.toContain("refresh-blocks");
  });

  test("a vault with approvals but no managed files and no approvals is silent", () => {
    seedLesson("doctor-quiet");
    expect(runCheck().issues).toEqual([]);
  });

  test("the check never mutates a byte", () => {
    const prefId = seedLesson("doctor-frozen");
    approveAndWrite(prefId);
    const prefPath = join(vault, "Brain", "preferences", `${prefId}.md`);
    writeFileSync(prefPath, readFileSync(prefPath, "utf8").replace(PRINCIPLE, `${PRINCIPLE} v2`));
    const rulesBefore = readFileSync(join(vault, "AGENTS.md"), "utf8");
    const ledgerBefore = readFileSync(lessonsApprovalsPath(vault), "utf8");
    runCheck();
    runCheck();
    expect(readFileSync(join(vault, "AGENTS.md"), "utf8")).toBe(rulesBefore);
    expect(readFileSync(lessonsApprovalsPath(vault), "utf8")).toBe(ledgerBefore);
  });

  test("a damaged approvals ledger is one warning, not a throw", () => {
    seedLesson("doctor-corrupt");
    mkdirSync(dirname(lessonsApprovalsPath(vault)), { recursive: true });
    writeFileSync(lessonsApprovalsPath(vault), "{ not json at all");
    const out = runCheck();
    expect(out.issues.length).toBe(1);
    expect(out.issues[0]?.severity).toBe("warning");
    expect(out.issues[0]?.message).toContain(LESSONS_APPROVALS_FILE);
  });

  test("the per-file states cover the closed four-state vocabulary", () => {
    const prefId = seedLesson("doctor-states");
    approveAndWrite(prefId);
    approveFor("pref-states-claude", "CLAUDE.md");
    expect(existsSync(join(vault, "CLAUDE.md"))).toBe(false);

    const states = lessonsBlockStates(vault, { now: NOW });
    const byFile = new Map(states.map((row) => [row.file, row.state]));
    expect(byFile.get("AGENTS.md")).toBe(LESSONS_BLOCK_STATE.current);
    // CLAUDE.md is named by an approval but carries no block.
    expect(byFile.get("CLAUDE.md")).toBe(LESSONS_BLOCK_STATE.absent);

    const prefPath = join(vault, "Brain", "preferences", `${prefId}.md`);
    writeFileSync(prefPath, readFileSync(prefPath, "utf8").replace(PRINCIPLE, `${PRINCIPLE} v3`));
    const stale = lessonsBlockStates(vault, { now: NOW });
    expect(stale.find((row) => row.file === "AGENTS.md")?.state).toBe(
      LESSONS_BLOCK_STATE.staleLessons,
    );
  });

  test("ledger targets off the fixed instruction-file list never touch a path", () => {
    // The ledger is machine state in the derived store; a planted or
    // damaged row naming a traversing path must not be joined onto the
    // vault root and lstat'ed. Off-list targets are skipped, not graded.
    const prefId = seedLesson("doctor-offlist");
    recordLessonApproval(vault, {
      prefId,
      decision: "approved",
      decidedAt: "2026-05-15T00:00:00Z",
      decidedBy: "yes-flag",
      approvedContentHash: computeContentHash(PRINCIPLE, "backend"),
      targets: ["../../escape.md"],
      blockId: RULES_BLOCK_ID.lessons,
      lastPromotedAt: null,
    });

    const out = runCheck();
    expect(out.issues).toEqual([]);
    expect(out.uncertain).toEqual([]);
    expect(lessonsBlockStates(vault, { now: NOW })).toEqual([]);
    // Nothing outside the vault was touched: the escape target resolves
    // above tmp, where no AGENTS.md-like surface exists to grade.
    expect(existsSync(join(tmp, "escape.md"))).toBe(false);
  });

  test("the block plan carries the named-drop surface the verbs report", () => {
    const prefId = seedLesson("doctor-drops");
    approveAndWrite(prefId);
    const plan = planLessonsBlock(vault, "AGENTS.md");
    expect(plan.droppedIds).toEqual([]);
  });

  test("the doctor-local instruction-file list stays pinned to the contract list", () => {
    // The check restates the fixed list because a static import of
    // AGENT_INSTRUCTION_FILES would close the doctor import cycle; this
    // pin is what keeps the copy from drifting when the list grows.
    expect([...LESSONS_BLOCK_MANAGED_FILES]).toEqual([...AGENT_INSTRUCTION_FILES]);
  });
});
