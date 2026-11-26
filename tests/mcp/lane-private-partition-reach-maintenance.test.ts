/**
 * Private-partition lane entries are withheld below local reach: the
 * write-side rule (change `lane-private-partition-reach`, the second
 * closure round). A tool that reads lane state to decide a write decides
 * from the fold of every partition; below local reach the machine's own
 * maintenance (a default page, a dedup, a dismissal list, a journal's
 * existence flags) runs as the released version ran it, and a write the
 * caller addresses to an entry is judged before its first durable step.
 *
 * Each case is a reviewer's sequence on a store-only machine: the call
 * below local reach is the remote server, the same call at local reach is
 * the control.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

import { bridgePairKey } from "../../src/core/brain/link-graph/bridge-discovery.ts";
import { attentionFlowsDir } from "../../src/core/brain/paths.ts";
import {
  procedurePath,
  skillProposalAcceptedPath,
  skillProposalPendingPath,
} from "../../src/core/brain/paths.ts";
import * as journalModule from "../../src/core/brain/skill-accept-journal.ts";
import { readSkillAcceptJournals } from "../../src/core/brain/skill-accept-journal.ts";
import { LANE_ENTRY_WITHHELD_MESSAGE } from "../../src/core/store/lane-reach-guard.ts";
import {
  laneEntryInPrivate,
  lanePageExists,
  readLaneText,
  writeLanePage,
} from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { dropPrivateEvents } from "./lane-private-partition-reach-store-fixture.ts";
import {
  REGION,
  call,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";
import {
  learnRejectedName,
  raiseBridgeArtifacts,
  seedBridgeIndex,
  writeProposal,
} from "./lane-private-partition-reach-maintenance-fixture.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

const SLUG = "zqmaintslug";

function env(): LaneEnv {
  lane = makeLaneEnv("store", "osb-lane-maint-");
  return lane;
}

/** Whether each page of the proposal `slug` is there, read at local reach. */
function pages(vault: string, slug: string): Record<string, boolean> {
  return {
    pending: lanePageExists(vault, skillProposalPendingPath(vault, slug)),
    accepted: lanePageExists(vault, skillProposalAcceptedPath(vault, slug)),
    procedure: lanePageExists(vault, procedurePath(vault, slug)),
  };
}

const journals = (vault: string): string[] =>
  readSkillAcceptJournals(vault).entries.map((entry) => entry.slug);

describe("a skill accept below local reach decides from the whole fold", () => {
  for (const reach of ["remote", "local"] as const) {
    test(`an accept whose archive lands in private is compensated whole (${reach})`, async () => {
      const e = env();
      const { vault } = e;
      writeProposal(vault, SLUG, "zqmaintbody shared");
      // The procedure the accept would materialize is already there.
      writeLanePage(
        vault,
        procedurePath(vault, SLUG),
        { kind: "brain-procedure", id: `proc-${SLUG}` },
        "# held\n",
      );
      const s = reach === "remote" ? server(e) : localServer(e);
      const answer = await call(s, "brain_skill_proposals", {
        operation: "accept",
        slug: SLUG,
        note: `zqmaintnote ${REGION}`,
      });
      expect(answer).toContain("error");
      expect(answer).not.toContain("zqmaintnote");
      // Nothing is stranded: the archive the accept wrote is gone, the
      // pending draft and the earlier procedure stay, no journal is left.
      expect(pages(vault, SLUG)).toEqual({ pending: true, accepted: false, procedure: true });
      expect(journals(vault)).toEqual([]);
    });
  }

  for (const held of ["procedure", "accepted"] as const) {
    const target = held === "procedure" ? "a procedure" : "an archive";
    test(`an accept onto ${target} held in private is refused before any journal`, async () => {
      const e = env();
      const { vault } = e;
      writeProposal(vault, SLUG, "zqmaintbody shared");
      const path =
        held === "procedure" ? procedurePath(vault, SLUG) : skillProposalAcceptedPath(vault, SLUG);
      writeLanePage(
        vault,
        path,
        { kind: held === "procedure" ? "brain-procedure" : "brain-skill-proposal" },
        `# held\n\nzqmaintheld ${REGION}\n`,
      );
      expect(laneEntryInPrivate(vault, path)).toBe(true);
      // A spy that forwards every argument to the real writer.
      const spy = spyOn(journalModule, "writeSkillAcceptJournal");
      let answer: string;
      let written: unknown[];
      try {
        answer = await call(server(e), "brain_skill_proposals", {
          operation: "accept",
          slug: SLUG,
        });
        written = spy.mock.calls.map((args) => args[1]);
      } finally {
        spy.mockRestore();
      }
      expect(JSON.parse(answer)).toEqual({ error: LANE_ENTRY_WITHHELD_MESSAGE });
      // No journal was stamped from a narrowed read of the target.
      expect(written).toEqual([]);
      expect(journals(vault)).toEqual([]);
      expect(lanePageExists(vault, path)).toBe(true);
      expect(lanePageExists(vault, skillProposalPendingPath(vault, SLUG))).toBe(true);
    });
  }
});

describe("skill-proposal learning below local reach dedups against the whole fold", () => {
  for (const reach of ["remote", "local"] as const) {
    test(`a name a person rejected in private is not drafted again (${reach})`, async () => {
      const e = env();
      const { answer, resurfaced, rejectedId } = await learnRejectedName(
        e,
        reach === "remote" ? server(e) : localServer(e),
      );
      expect(resurfaced).toEqual([]);
      if (reach === "remote") expect(answer).not.toContain(rejectedId);
    });
  }
});

describe("bridge discovery below local reach keeps the dismissals and the artifact", () => {
  for (const reach of ["remote", "local"] as const) {
    test(
      reach === "remote"
        ? "discover works on a private artifact and a dismissal that meets a private list is refused (remote)"
        : "discover and dismiss work on a private artifact and dismissal list (local)",
      async () => {
        const e = env();
        const { vault } = e;
        const { privatePair, openPair } = await seedBridgeIndex(e);
        const local = localServer(e);
        // The operator's dismissal of a pair and the artifact of a local
        // discover, both held in `private`.
        await callJson(local, "brain_bridges", {
          operation: "dismiss",
          source: privatePair[0],
          target: privatePair[1],
        });
        await callJson(local, "brain_bridges", { operation: "discover", min_similarity: 0.1 });
        const { proposals, dismissed } = raiseBridgeArtifacts(vault);

        const s = reach === "remote" ? server(e) : localServer(e);
        const out = await callJson(s, "brain_bridges", {
          operation: "discover",
          min_similarity: 0.1,
        });
        expect(out["error"]).toBeUndefined();
        if (reach === "remote") {
          // Below local reach a dismissal is refused while the list is held in
          // `private`: the same answer for the dismissed pair and for the
          // absent one, and the private records stay as they were.
          const privateBefore = JSON.stringify(e.laneRecords("private"));
          const absent = await callJson(s, "brain_bridges", {
            operation: "dismiss",
            source: openPair[0],
            target: openPair[1],
          });
          const dismissedAgain = await callJson(s, "brain_bridges", {
            operation: "dismiss",
            source: privatePair[0],
            target: privatePair[1],
          });
          expect(JSON.stringify(e.laneRecords("private"))).toBe(privateBefore);
          expect(absent).toEqual({ error: LANE_ENTRY_WITHHELD_MESSAGE });
          expect(dismissedAgain).toEqual(absent);
        } else {
          const added = await callJson(s, "brain_bridges", {
            operation: "dismiss",
            source: openPair[0],
            target: openPair[1],
          });
          expect(added["error"]).toBeUndefined();
          // The list holds both dismissals.
          const list = JSON.parse(readLaneText(vault, dismissed) ?? "{}") as { pairs?: string[] };
          expect(list.pairs).toEqual([bridgePairKey(...privatePair), bridgePairKey(...openPair)]);
        }
        // Read at local reach: the dismissed pair is not proposed again.
        const artifact = readLaneText(vault, proposals) ?? "";
        const rows = artifact.split("\n").filter((line) => line.startsWith("| [["));
        expect(rows.length).toBeGreaterThan(0);
        expect(
          rows.filter((r) => r.includes(privatePair[0]) && r.includes(privatePair[1])),
        ).toEqual([]);
      },
    );
  }
});

describe("the default attention flow is seeded from the whole fold", () => {
  const flowArgs = { view: "attention_flows", operation: "list" };

  test("a private default flow does not make a remote list throw", async () => {
    const e = env();
    const { vault } = e;
    const defaultPath = join(attentionFlowsDir(vault), "open-loops.md");
    writeLanePage(
      vault,
      defaultPath,
      {
        kind: "brain-attention-flow",
        id: "open-loops",
        title: "zqmaintflow",
        actions: ["open_proposals"],
      },
      `# flow\n\n${REGION}\n`,
    );
    expect(laneEntryInPrivate(vault, defaultPath)).toBe(true);
    const remote = await call(server(e), "brain_analytics", flowArgs);
    expect(JSON.parse(remote)["error"]).toBeUndefined();
    expect(remote).not.toContain("zqmaintflow");
    const local = await call(localServer(e), "brain_analytics", flowArgs);
    expect(local).toContain("zqmaintflow");
  });

  test("an incomplete fold makes no remote list throw and seeds nothing over it", async () => {
    const e = env();
    const { vault } = e;
    const defaultPath = join(attentionFlowsDir(vault), "open-loops.md");
    await call(localServer(e), "brain_analytics", flowArgs);
    expect(lanePageExists(vault, defaultPath)).toBe(true);
    // Some entry is held in `private`, and its shard is then gone.
    writeProposal(vault, "zqmaintother", `held ${REGION}`);
    dropPrivateEvents(e);
    const before = e.laneRecords("shared").length;
    const remote = await call(server(e), "brain_analytics", flowArgs);
    expect(JSON.parse(remote)["error"]).toBeUndefined();
    // No default page is seeded while the fold may miss the one there.
    expect(e.laneRecords("shared").length).toBe(before);
  });
});
