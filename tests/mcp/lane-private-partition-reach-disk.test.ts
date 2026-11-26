/**
 * Private-partition lane entries are withheld below local reach: a file on
 * disk never answers for a lane entry the store holds (change
 * `lane-private-partition-reach`, the closure round).
 *
 * 1. The reach predicate of a store-only machine falls back to a vault
 *    file only for a lane entry the fold of every partition definitively
 *    does not hold: a frozen predecessor with open fields never answers
 *    for a `private` entry withheld from the caller.
 * 2. The placement judge of a claim source keeps a private verdict when a
 *    reference matches both a shared lane entry and a private vault page.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-entry-store.ts";
import { writeLanePage } from "../../src/core/store/lane-pages.ts";
import { claimSourceIsPrivate } from "../../src/core/store/reference-privacy.ts";
import { readableAtContextReach } from "../../src/mcp/brain/reach-readable.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { REGION } from "./lane-private-partition-reach-writes-fixture.ts";
import { dropPrivateEvents } from "./lane-private-partition-reach-store-fixture.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

function env(): LaneEnv {
  lane = makeLaneEnv("store", "osb-lane-disk-");
  return lane;
}

function context(e: LaneEnv): ServerContext {
  return {
    vault: e.vault,
    vaultOrNull: e.vault,
    configPath: e.env.configPath,
    repoRoot: null,
    agentName: "tester",
    reach: TRANSPORT_REACH.remote,
  } as ServerContext;
}

/** A vault file at `rel` with `frontmatter` (a frozen predecessor, or a vault page). */
function vaultFile(e: LaneEnv, rel: string, frontmatter: string): void {
  const path = join(e.vault, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `---\n${frontmatter}\n---\n\nfrozen body\n`);
}

describe("private-partition lane entries are withheld below local reach: disk fallbacks", () => {
  test("a frozen predecessor never answers for a withheld private lane entry", () => {
    const e = env();
    const hidden = "Brain/decisions/zqdiskhidden.md";
    const open = "Brain/decisions/zqdiskopen.md";
    const gone = "Brain/decisions/zqdiskgone.md";
    writeLanePage(e.vault, join(e.vault, hidden), { title: "zqdisk" }, `body ${REGION}\n`);
    writeLanePage(e.vault, join(e.vault, open), { title: "zqdiskopen" }, "open body\n");
    expect(laneEntryInPrivate(e.vault, join(e.vault, hidden))).toBe(true);
    for (const rel of [hidden, gone]) vaultFile(e, rel, "title: frozen");
    const readable = (rel: string) =>
      withPrivateWithheld(true, () => readableAtContextReach(context(e))(rel));
    expect({ hidden: readable(hidden), open: readable(open), gone: readable(gone) }).toEqual({
      hidden: false,
      open: true,
      gone: true,
    });
    // While the fold of every partition may miss a record no lane path
    // falls back to its file.
    dropPrivateEvents(e);
    expect(readable(gone)).toBe(false);
  });

  test("a claim source matching a shared lane entry and a private vault page stays private", () => {
    const e = env();
    writeLanePage(
      e.vault,
      join(e.vault, "Brain", "sources", "zqdisktwin.md"),
      { title: "zqdisktwin" },
      "shared body\n",
    );
    expect(laneEntryInPrivate(e.vault, join(e.vault, "Brain/sources/zqdisktwin.md"))).toBe(false);
    vaultFile(e, "zqdisktwin.md", "visibility: private");
    vaultFile(e, "zqdiskplain.md", "title: plain");
    expect({
      twin: claimSourceIsPrivate(e.vault, "zqdisktwin", e.env.configPath),
      twin_link: claimSourceIsPrivate(e.vault, "[[zqdisktwin]]", e.env.configPath),
      plain: claimSourceIsPrivate(e.vault, "zqdiskplain", e.env.configPath),
    }).toEqual({ twin: true, twin_link: true, plain: false });
  });
});
