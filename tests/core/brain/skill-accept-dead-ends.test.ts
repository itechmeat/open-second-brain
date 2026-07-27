/**
 * The two operational dead ends the accept transaction created
 * (no-dead-ends, phase 3, item 1).
 *
 * The write-ahead journal and the vault-wide accept lock each made the
 * accept sequence crash-safe, and each introduced a state an operator
 * could not leave:
 *
 *   1. a journal file the parser cannot read blocks EVERY future accept,
 *      because the sweep runs before anything else and reports an
 *      unreadable marker by throwing;
 *   2. a lock a crash left behind refuses every future accept, and
 *      nothing breaks it - correctly, because a live writer cannot be
 *      told from a dead one.
 *
 * Neither refusal named a way out. These tests pin that both now do, and
 * that the one which CAN be resolved mechanically actually is.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import {
  skillAcceptJournalPath,
  skillProposalAcceptedPath,
} from "../../../src/core/brain/paths.ts";
import {
  acceptSkillProposal,
  discardUnreadableSkillAcceptJournals,
  learnSkillProposals,
  listPendingSkillProposals,
  recoverSkillProposalAccepts,
  skillAcceptLockPath,
  SkillAcceptLockedError,
} from "../../../src/core/brain/skill-proposals.ts";
import {
  readSkillAcceptJournals,
  SkillAcceptJournalUnreadableError,
  writeSkillAcceptJournal,
} from "../../../src/core/brain/skill-accept-journal.ts";
import { _resetHeldLocksForTests } from "../../../src/core/brain/sync-lockfile.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-skill-dead-end-"));
});

afterEach(() => {
  _resetHeldLocksForTests();
  rmSync(vault, { recursive: true, force: true });
});

const ACCEPTED_AT = new Date("2026-06-01T10:00:00.000Z");
const LEARNED_AT = new Date("2026-06-01T09:00:00.000Z");

/** Seed three records of one repeated action; returns the drafted slug. */
function seedAndLearn(action: string): string {
  for (let i = 0; i < 3; i++) {
    const mm = String(10 + i).padStart(2, "0");
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: `2026-05-20T08:${mm}:00Z`,
      sourceRefs: [{ id: `src-${action.replaceAll("_", "-")}-${i}` }],
      payload: { action, summary: `did ${action} run ${i}` },
    });
  }
  learnSkillProposals(vault, { now: LEARNED_AT, minSupport: 3 });
  const target = listPendingSkillProposals(vault).find((p) => p.patternKind === "repeated_action");
  if (!target) throw new Error("test setup: no repeated_action draft was created");
  return target.slug;
}

/** Put a file the journal parser cannot read at `slug`'s marker path. */
function corruptJournal(slug: string): string {
  const path = skillAcceptJournalPath(vault, slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{ this is not json", "utf8");
  return path;
}

/** Leave a lock on disk the way a hard crash does. */
function stampAcceptLock(): string {
  const path = skillAcceptLockPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "999999\n2026-06-01T09:59:00.000Z\n", "utf8");
  return path;
}

describe("an unreadable accept journal names the command that clears it", () => {
  test("the accept path refuses by name, naming the file and the exit", () => {
    const slug = seedAndLearn("rotate_keys");
    const journal = corruptJournal("some-other-slug");

    let thrown: unknown = null;
    try {
      acceptSkillProposal(vault, slug, { now: ACCEPTED_AT });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SkillAcceptJournalUnreadableError);
    const err = thrown as SkillAcceptJournalUnreadableError;
    expect(err.path).toBe(journal);
    expect(err.message).toContain(journal);
    expect(err.message).toContain("o2b brain skill-proposals recover --discard-unreadable");
  });

  test("the partitioned read reports the unreadable marker instead of throwing", () => {
    const journal = corruptJournal("ghost");
    const state = readSkillAcceptJournals(vault);
    expect(state.entries).toEqual([]);
    expect(state.unreadable.map((u) => u.path)).toEqual([journal]);
    expect(state.unreadable[0]!.detail.length).toBeGreaterThan(0);
  });

  test("discarding the unreadable marker unblocks accepting", () => {
    const slug = seedAndLearn("rotate_keys");
    const journal = corruptJournal("ghost");

    const discarded = discardUnreadableSkillAcceptJournals(vault);
    expect(discarded).toEqual([journal]);
    expect(existsSync(journal)).toBe(false);

    const accepted = acceptSkillProposal(vault, slug, { now: ACCEPTED_AT });
    expect(accepted.status).toBe("accepted");
    expect(existsSync(skillProposalAcceptedPath(vault, slug))).toBe(true);
  });

  test("discarding touches only the markers that cannot be read", () => {
    const slug = seedAndLearn("rotate_keys");
    writeSkillAcceptJournal(vault, {
      slug,
      id: `prop-${slug}`,
      phase: "archive",
      startedAt: ACCEPTED_AT.toISOString(),
      acceptedExisted: false,
      procedureExisted: false,
    });
    const corrupt = corruptJournal("ghost");

    expect(discardUnreadableSkillAcceptJournals(vault)).toEqual([corrupt]);
    // The readable marker survived and is still resolvable.
    const state = readSkillAcceptJournals(vault);
    expect(state.unreadable).toEqual([]);
    expect(state.entries.map((e) => e.slug)).toEqual([slug]);
    expect(recoverSkillProposalAccepts(vault).map((r) => r.slug)).toEqual([slug]);
  });

  test("discarding nothing is not an error and reports nothing", () => {
    expect(discardUnreadableSkillAcceptJournals(vault)).toEqual([]);
  });
});

describe("a lock left by a crash refuses by name and is never broken", () => {
  test("the accept path names the lock file and the command that inspects it", () => {
    const slug = seedAndLearn("rotate_keys");
    const lock = stampAcceptLock();

    let thrown: unknown = null;
    try {
      acceptSkillProposal(vault, slug, { now: ACCEPTED_AT });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SkillAcceptLockedError);
    const err = thrown as SkillAcceptLockedError;
    expect(err.path).toBe(lock);
    expect(err.message).toContain(lock);
    expect(err.message).toContain("o2b brain doctor");
    // Refused, not broken: the file an operator must judge is still there.
    expect(existsSync(lock)).toBe(true);
  });

  test("recovery refuses through the same named error", () => {
    const lock = stampAcceptLock();
    expect(() => recoverSkillProposalAccepts(vault)).toThrow(SkillAcceptLockedError);
    expect(() => discardUnreadableSkillAcceptJournals(vault)).toThrow(SkillAcceptLockedError);
    expect(existsSync(lock)).toBe(true);
  });
});

describe("nothing changes when neither hazard is present", () => {
  test("a clean accept is unaffected and leaves no journal behind", () => {
    const slug = seedAndLearn("rotate_keys");
    const accepted = acceptSkillProposal(vault, slug, { now: ACCEPTED_AT });
    expect(accepted.status).toBe("accepted");
    expect(readSkillAcceptJournals(vault)).toEqual({ entries: [], unreadable: [] });
    expect(existsSync(skillAcceptLockPath(vault))).toBe(false);
  });
});
