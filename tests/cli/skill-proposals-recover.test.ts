/**
 * `o2b brain skill-proposals recover` - the surface that was missing
 * (no-dead-ends, phase 3, item 1).
 *
 * `recoverSkillProposalAccepts` shipped with the accept transaction and
 * was exported to nothing: no CLI verb, no MCP operation. An operator
 * whose accept crashed had a recovery function they could not run. These
 * tests pin the verb, and pin that both refusals it can meet name the
 * exact file on stderr rather than leaving an errno to trace.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { skillAcceptJournalPath, skillProposalPendingPath } from "../../src/core/brain/paths.ts";
import {
  learnSkillProposals,
  listPendingSkillProposals,
  skillAcceptLockPath,
} from "../../src/core/brain/skill-proposals.ts";
import { writeSkillAcceptJournal } from "../../src/core/brain/skill-accept-journal.ts";
import { _resetHeldLocksForTests } from "../../src/core/brain/sync-lockfile.ts";
import { runCli } from "../helpers/run-cli.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-recover-cli-"));
});

afterEach(() => {
  _resetHeldLocksForTests();
  rmSync(vault, { recursive: true, force: true });
});

const LEARNED_AT = new Date("2026-06-01T09:00:00.000Z");

function seedAndLearn(): string {
  for (let i = 0; i < 3; i++) {
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: `2026-05-20T08:1${i}:00Z`,
      sourceRefs: [{ id: `src-rotate-keys-${i}` }],
      payload: { action: "rotate_keys", summary: `did rotate_keys run ${i}` },
    });
  }
  learnSkillProposals(vault, { now: LEARNED_AT, minSupport: 3 });
  const target = listPendingSkillProposals(vault).find((p) => p.patternKind === "repeated_action");
  if (!target) throw new Error("test setup: no repeated_action draft was created");
  return target.slug;
}

function corruptJournal(slug: string): string {
  const path = skillAcceptJournalPath(vault, slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{ this is not json", "utf8");
  return path;
}

describe("o2b brain skill-proposals recover", () => {
  test("with nothing outstanding it reports zero and exits clean", async () => {
    const r = await runCli(["brain", "skill-proposals", "recover", "--vault", vault]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("0 sequence(s) resolved, 0 unreadable marker(s) discarded");
  });

  test("it resolves the sequence a crash abandoned", async () => {
    const slug = seedAndLearn();
    writeSkillAcceptJournal(vault, {
      slug,
      id: `prop-${slug}`,
      phase: "archive",
      startedAt: LEARNED_AT.toISOString(),
      acceptedExisted: false,
      procedureExisted: false,
    });

    const r = await runCli(["brain", "skill-proposals", "recover", "--vault", vault]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("1 sequence(s) resolved");
    expect(r.stdout).toContain(`rolled_back ${slug}`);
    // Rolled back to the draft, which is still reviewable.
    expect(existsSync(skillProposalPendingPath(vault, slug))).toBe(true);
  });

  test("an unreadable marker refuses on stderr, naming that exact file", async () => {
    const journal = corruptJournal("ghost");
    const r = await runCli(["brain", "skill-proposals", "recover", "--vault", vault]);
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain(journal);
    expect(r.stderr).toContain("o2b brain skill-proposals recover --discard-unreadable");
    // A refusal never removes what it refuses to interpret.
    expect(existsSync(journal)).toBe(true);
  });

  test("--discard-unreadable clears it and names what it removed", async () => {
    const journal = corruptJournal("ghost");
    const r = await runCli([
      "brain",
      "skill-proposals",
      "recover",
      "--vault",
      vault,
      "--discard-unreadable",
    ]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(`discarded ${journal}`);
    expect(existsSync(journal)).toBe(false);
  });

  test("accepting is blocked by the marker and unblocked once it is discarded", async () => {
    const slug = seedAndLearn();
    const journal = corruptJournal("ghost");

    const blocked = await runCli(["brain", "skill-proposals", "accept", slug, "--vault", vault]);
    expect(blocked.returncode).toBe(1);
    expect(blocked.stderr).toContain(journal);
    expect(blocked.stderr).toContain("o2b brain skill-proposals recover --discard-unreadable");

    await runCli(["brain", "skill-proposals", "recover", "--vault", vault, "--discard-unreadable"]);
    const accepted = await runCli(["brain", "skill-proposals", "accept", slug, "--vault", vault]);
    expect(accepted.returncode).toBe(0);
    expect(accepted.stdout).toContain(`accepted prop-${slug}`);
  });

  test("a lock a crash left behind refuses by file, and is never broken", async () => {
    const lock = skillAcceptLockPath(vault);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "999999\n2026-06-01T09:59:00.000Z\n", "utf8");

    const r = await runCli(["brain", "skill-proposals", "recover", "--vault", vault]);
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain(lock);
    expect(r.stderr).toContain("o2b brain doctor");
    expect(existsSync(lock)).toBe(true);
  });

  test("--json carries the same result as a machine payload", async () => {
    const journal = corruptJournal("ghost");
    const r = await runCli([
      "brain",
      "skill-proposals",
      "recover",
      "--vault",
      vault,
      "--discard-unreadable",
      "--json",
    ]);
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(payload["discarded"]).toEqual([journal]);
    expect(payload["recovered"]).toEqual([]);
    expect(payload["total"]).toBe(0);
  });
});
