/**
 * Private-partition lane entries are withheld below local reach: the
 * skill-accept recovery (change `lane-private-partition-reach`, the
 * closure round). A caller below local reach sees the fold of `shared`
 * only, so a private proposal's journal would read as committed (its
 * pending copy "absent") and its rollback removals would find nothing.
 * Such a caller leaves that journal for a local caller: it never reads,
 * clears or answers from it, and a local recovery afterwards still finds
 * the journal and resolves it as the released version did.
 *
 * The machine under test keeps its lane pages in the store. A scope that
 * withholds private entries is the caller below local reach; the plain
 * call is the local caller.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { procedurePath } from "../../src/core/brain/paths.ts";
import { skillProposalAcceptedPath, skillProposalPendingPath } from "../../src/core/brain/paths.ts";
import {
  readSkillAcceptJournals,
  writeSkillAcceptJournal,
  type SkillAcceptPhase,
} from "../../src/core/brain/skill-accept-journal.ts";
import {
  acceptSkillProposal,
  recoverSkillProposalAccepts,
} from "../../src/core/brain/skill-proposals.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-entry-store.ts";
import { lanePageExists, writeLanePage } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { REGION } from "./lane-private-partition-reach-writes-fixture.ts";
import { dropPrivateEvents } from "./lane-private-partition-reach-store-fixture.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

const NOW = new Date("2026-11-20T10:00:00Z");
const HIDDEN = "zqrecoverhidden";
const SHARED = "zqrecovershared";

function env(): LaneEnv {
  lane = makeLaneEnv("store", "osb-lane-recover-");
  return lane;
}

/** A pending proposal page for `slug`; private when `body` carries a private region. */
function writeProposal(vault: string, slug: string, body: string): void {
  writeLanePage(
    vault,
    skillProposalPendingPath(vault, slug),
    {
      schema_version: 1,
      kind: "brain-skill-proposal",
      id: `prop-${slug}`,
      slug,
      status: "pending",
      pattern_kind: "repeated_action",
      version: "1",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    },
    `# ${slug}\n\n${body}\n`,
  );
}

/**
 * The state a local accept of the private proposal leaves when it stops
 * after writing its archive and its procedure, at `phase`: the pending
 * copy, the accepted copy and the procedure are all private, and the
 * journal is stamped.
 */
function interruptedPrivateAccept(e: LaneEnv, phase: SkillAcceptPhase): void {
  const { vault } = e;
  writeProposal(vault, HIDDEN, `zqrecoverbody ${REGION}`);
  writeLanePage(
    vault,
    skillProposalAcceptedPath(vault, HIDDEN),
    { kind: "brain-skill-proposal", id: `prop-${HIDDEN}`, slug: HIDDEN, status: "accepted" },
    `# ${HIDDEN}\n\nzqrecoverbody ${REGION}\n`,
  );
  writeLanePage(
    vault,
    procedurePath(vault, HIDDEN),
    { kind: "brain-procedure", id: `proc-${HIDDEN}` },
    `# ${HIDDEN}\n\nzqrecoverbody ${REGION}\n`,
  );
  writeSkillAcceptJournal(vault, {
    slug: HIDDEN,
    id: `prop-${HIDDEN}`,
    phase,
    startedAt: NOW.toISOString(),
    acceptedExisted: false,
    materializedExisted: false,
    materializedPath: procedurePath(vault, HIDDEN),
  });
  for (const path of [
    skillProposalPendingPath(vault, HIDDEN),
    skillProposalAcceptedPath(vault, HIDDEN),
    procedurePath(vault, HIDDEN),
  ]) {
    expect(laneEntryInPrivate(vault, path)).toBe(true);
  }
}

/** The slugs of the journals this machine holds. */
function journals(vault: string): string[] {
  return readSkillAcceptJournals(vault).entries.map((entry) => entry.slug);
}

/** Whether each page of the private proposal is there, read at local reach. */
function hiddenPages(vault: string): Record<string, boolean> {
  return {
    pending: lanePageExists(vault, skillProposalPendingPath(vault, HIDDEN)),
    accepted: lanePageExists(vault, skillProposalAcceptedPath(vault, HIDDEN)),
    procedure: lanePageExists(vault, procedurePath(vault, HIDDEN)),
  };
}

const ALL_THERE = { pending: true, accepted: true, procedure: true };
const ROLLED_BACK = { pending: true, accepted: false, procedure: false };

describe("private-partition lane entries are withheld below local reach: skill-accept recovery", () => {
  for (const phase of ["commit", "materialize"] as const) {
    test(`a private accept stopped at '${phase}' is left for a local recovery, which rolls it back`, () => {
      const e = env();
      const { vault } = e;
      interruptedPrivateAccept(e, phase);

      const remote = withPrivateWithheld(true, () => recoverSkillProposalAccepts(vault));
      expect(JSON.stringify(remote)).not.toContain(HIDDEN);
      expect(remote).toEqual([]);
      // The journal and every page are untouched.
      expect(journals(vault)).toEqual([HIDDEN]);
      expect(hiddenPages(vault)).toEqual(ALL_THERE);

      // The local recovery finds its journal and rolls back, as before.
      expect(recoverSkillProposalAccepts(vault)).toEqual([{ slug: HIDDEN, action: "rolled_back" }]);
      expect(journals(vault)).toEqual([]);
      expect(hiddenPages(vault)).toEqual(ROLLED_BACK);
    });
  }

  test("a remote accept of an unrelated shared proposal works and leaves the private journal", () => {
    const e = env();
    const { vault } = e;
    interruptedPrivateAccept(e, "commit");
    writeProposal(vault, SHARED, "zqrecovershared body");
    expect(laneEntryInPrivate(vault, skillProposalPendingPath(vault, SHARED))).toBe(false);

    const accepted = withPrivateWithheld(true, () =>
      acceptSkillProposal(vault, SHARED, { now: NOW }),
    );
    expect(accepted.status).toBe("accepted");
    expect(JSON.stringify(accepted)).not.toContain(HIDDEN);
    expect(lanePageExists(vault, skillProposalAcceptedPath(vault, SHARED))).toBe(true);
    expect(lanePageExists(vault, skillProposalPendingPath(vault, SHARED))).toBe(false);
    expect(journals(vault)).toEqual([HIDDEN]);
    expect(hiddenPages(vault)).toEqual(ALL_THERE);

    expect(recoverSkillProposalAccepts(vault)).toEqual([{ slug: HIDDEN, action: "rolled_back" }]);
    expect(hiddenPages(vault)).toEqual(ROLLED_BACK);
  });

  test("a shared journal is still resolved below local reach, judged by the whole fold", () => {
    const e = env();
    const { vault } = e;
    writeProposal(vault, SHARED, "zqrecovershared body");
    writeSkillAcceptJournal(vault, {
      slug: SHARED,
      id: `prop-${SHARED}`,
      phase: "commit",
      startedAt: NOW.toISOString(),
      acceptedExisted: false,
      materializedExisted: false,
    });
    const remote = withPrivateWithheld(true, () => recoverSkillProposalAccepts(vault));
    expect(remote).toEqual([{ slug: SHARED, action: "rolled_back" }]);
    expect(journals(vault)).toEqual([]);
    expect(lanePageExists(vault, skillProposalPendingPath(vault, SHARED))).toBe(true);
  });

  test("while the whole fold is incomplete no journal is read, cleared or named below local reach", () => {
    const e = env();
    const { vault } = e;
    interruptedPrivateAccept(e, "commit");
    dropPrivateEvents(e);
    const remote = withPrivateWithheld(true, () => recoverSkillProposalAccepts(vault));
    expect(remote).toEqual([]);
    expect(journals(vault)).toEqual([HIDDEN]);
  });
});
