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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Write a well-formed marker the way a hand edit (or a sync merge) would:
 * raw JSON on disk, not the module's own writer, naming a
 * `materialized_path` the accept sequence never produced.
 */
function handEditedJournal(slug: string, materializedPath: string): string {
  const path = skillAcceptJournalPath(vault, slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schema_version: 1,
        slug,
        id: `prop-${slug}`,
        phase: "materialize",
        started_at: ACCEPTED_AT.toISOString(),
        accepted_existed: false,
        procedure_existed: false,
        materialized_path: materializedPath,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
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
      materializedExisted: false,
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

describe("a hand-edited materialized path is refused at the journal boundary", () => {
  test("a materialized path outside the vault and the skills root refuses recovery by name and is never deleted", () => {
    // The file a planted journal would make the rollback's rmSync remove.
    const outside = join(dirname(vault), "planted-escape.md");
    writeFileSync(outside, "operator file\n", "utf8");
    const journal = handEditedJournal("ghost", outside);
    try {
      // The partitioned read reports the marker as unreadable, naming the
      // field that refused it.
      const state = readSkillAcceptJournals(vault);
      expect(state.entries).toEqual([]);
      expect(state.unreadable.map((u) => u.path)).toEqual([journal]);
      expect(state.unreadable[0]!.detail).toContain("materialized_path");

      // The transaction path refuses through the same named error, and a
      // hand-edited journal is not a recovery input: retained, and the path
      // it named is untouched.
      expect(() => recoverSkillProposalAccepts(vault)).toThrow(SkillAcceptJournalUnreadableError);
      expect(existsSync(journal)).toBe(true);
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("a relative materialized path is refused even when it names a SKILL.md", () => {
    const journal = handEditedJournal("ghost", join("..", "elsewhere", "SKILL.md"));
    const state = readSkillAcceptJournals(vault);
    expect(state.entries).toEqual([]);
    expect(state.unreadable.map((u) => u.path)).toEqual([journal]);
  });

  test("a marker whose target existed still parses - the restore branch owns that refusal at use", () => {
    // On this shape the journal-supplied path reaches only the restore
    // branch, which validates its target itself and refuses by name; the
    // parser stays permissive so the diagnosis surface can still read the
    // marker's other fields.
    const outside = join(dirname(vault), "victim.md");
    const journal = handEditedJournal("ghost", outside);
    // handEditedJournal writes procedure_existed: false, so flip the marker
    // to the restore shape by rewriting it.
    const marker = JSON.parse(readFileSync(journal, "utf8")) as Record<string, unknown>;
    marker["procedure_existed"] = true;
    marker["prior_content_path"] = join(vault, "Brain", "ghost.prior.md");
    writeFileSync(journal, `${JSON.stringify(marker, null, 2)}\n`, "utf8");

    const state = readSkillAcceptJournals(vault);
    expect(state.unreadable).toEqual([]);
    expect(state.entries.map((entry) => entry.slug)).toEqual(["ghost"]);
    expect(state.entries[0]?.materializedPath).toBe(outside);
  });

  test("the designed mature_page rollback under an override skills root still rolls back", () => {
    // A real accept CAN stamp a materialized path outside both the vault and
    // the configured skills root: the caller's override root, which recovery
    // cannot re-derive - the whole reason the field exists. The parse guard
    // admits the module's own materialization shape (an absolute path ending
    // in the skill page file) so this rollback keeps working.
    const externalRoot = mkdtempSync(join(tmpdir(), "o2b-journal-skills-"));
    try {
      const skillDir = join(externalRoot, "some-skill");
      const skillFile = join(skillDir, "SKILL.md");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(skillFile, "half-written\n", "utf8");
      writeSkillAcceptJournal(vault, {
        slug: "ghost",
        id: "prop-ghost",
        phase: "materialize",
        startedAt: ACCEPTED_AT.toISOString(),
        acceptedExisted: false,
        materializedExisted: false,
        materializedPath: skillFile,
      });

      const recovered = recoverSkillProposalAccepts(vault);
      expect(recovered.map((entry) => entry.action)).toEqual(["rolled_back"]);
      expect(existsSync(skillFile)).toBe(false);
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
    }
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
