/**
 * Hygiene below local reach is judged per action (change
 * `lane-reach-residuals`, package 14, design R11; the modified requirement
 * "A write decided from lane state below local reach decides from every
 * partition", its scenarios "A bulk lane verb is refused while a lane
 * holds a private entry" and "Hygiene with no private member runs as
 * before", and "A hygiene apply whose every action is refused leaves no
 * audit record").
 *
 * Each action lists its members on the fold of every partition before its
 * first durable step; a member held in `private` makes that action's error
 * the fixed answer, the other actions proceed, and an apply that applied
 * nothing and met only reach refusals appends no audit record. The cases
 * per action run the applier with a finding built by hand, in the reach
 * scope a remote transport sets, as a plan from a scan would hand it; the
 * refresh, the no-private-member case and the every-action-refused case
 * run through the tool. A page whose `shared` value the caller still
 * reads while its winning record is held in `private` is a raise whose
 * `shared` tombstone this machine has not read
 * (`raiseWithoutTombstone`). Every refused call compares the raw records
 * of both partitions; each case has a local control on its own store.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { applyHygienePlan, type HygieneApplyResult } from "../../src/core/brain/hygiene/apply.ts";
import type { HygieneFinding } from "../../src/core/brain/hygiene/types.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import * as recompile from "../../src/core/brain/recompile.ts";
import { storePreferenceEntry } from "../../src/core/brain/preference-store.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { laneEntryInPrivate, writeLaneText } from "../../src/core/store/lane-pages.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  raiseWithoutTombstone,
  sharedLaneRecord,
} from "./lane-private-partition-reach-store-fixture.ts";
import {
  AGENT,
  REGION,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

const WITHHELD = "this entry cannot be written at this reach";
const NOW = new Date("2026-11-20T10:00:00Z");

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(name: string): LaneEnv {
  const e = makeLaneEnv("store", `osb-lane-hygiene-${name}-`);
  lanes.push(e);
  return e;
}

/** Every record of both partitions, by id, as the store holds them. */
function rawRecords(e: LaneEnv): string {
  const ids = (partition: "shared" | "private") =>
    readPartition(join(e.env.storeRoot, partition))
      .flatMap((shard) => shard.all)
      .map((r) => r.id)
      .toSorted();
  return JSON.stringify({ shared: ids("shared"), private: ids("private") });
}

/** A derived page of `lane` citing `source` under a hash that is not its own (stale or orphaned). */
function derivedPage(e: LaneEnv, rel: string, source: string, body = "derived body"): string {
  const abs = join(e.vault, rel);
  writeLaneText(
    e.vault,
    abs,
    `---\ntitle: Zqhyg\ncreated_at: 2026-11-01T00:00:00Z\n` +
      `source_paths: ["${source}"]\nsource_hashes: ["0000"]\n---\n\n${body}\n`,
  );
  return abs;
}

/** A source note the derived pages cite (present: they read as stale, not orphaned). */
function sourceNote(e: LaneEnv): string {
  mkdirSync(join(e.vault, "Notes"), { recursive: true });
  writeFileSync(join(e.vault, "Notes", "zqhyg-source.md"), "# Source\n\nchanged text\n", "utf8");
  return "Notes/zqhyg-source.md";
}

/**
 * Raise the research page `name` to `private` the way another device's
 * raise arrives before its `shared` tombstone: the caller still reads the
 * stale `shared` value, the winning record is held in `private`.
 */
function raise(e: LaneEnv, lane: string, name: string, abs: string): void {
  raiseWithoutTombstone(e, sharedLaneRecord(e, lane, name), `held ${REGION}`);
  expect(laneEntryInPrivate(e.vault, abs)).toBe(true);
}

/** Another lane holds an entry in `private`. */
function privateElsewhere(e: LaneEnv): void {
  const held = join(e.vault, "Brain/research/zqhyg-held-elsewhere.md");
  writeLaneText(e.vault, held, `---\ntitle: Zqhyg held\n---\n\nheld ${REGION}\n`);
  expect(laneEntryInPrivate(e.vault, held)).toBe(true);
}

function finding(
  action: HygieneFinding["proposed_action"],
  targets: ReadonlyArray<string>,
  evidence: Record<string, unknown> = {},
): HygieneFinding {
  return Object.freeze({
    id: `zqhyg-${action}`,
    detector: "freshness",
    severity: "action",
    title: "hand-built finding",
    targets: Object.freeze([...targets]),
    proposed_action: action,
    evidence: Object.freeze(evidence),
  });
}

/** The applier, below local reach when `remote`, at local reach otherwise. */
function applyAt(
  e: LaneEnv,
  remote: boolean,
  findings: ReadonlyArray<HygieneFinding>,
): Promise<HygieneApplyResult> {
  return withPrivateWithheld(remote, () =>
    applyHygienePlan(
      e.vault,
      { selected: findings, excluded_review: [], unknown_ids: [] },
      { agent: AGENT, now: NOW, configPath: e.env.configPath },
    ),
  );
}

function pref(slug: string, principle: string): Parameters<typeof writePreference>[1] {
  return {
    slug,
    topic: "zqhyg-topic",
    principle,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 0,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.8,
    pinned: false,
  };
}

const SUMMARY_BODY =
  "The quarterly report covers revenue growth across every region, the hiring plan " +
  "for the platform team, and the migration of the billing service to the new cluster.";

/** An ingest summary page under `Brain/sources/`. */
function summaryPage(e: LaneEnv, name: string, created: string, extra = ""): string {
  const rel = `Brain/sources/${name}.md`;
  writeLaneText(
    e.vault,
    join(e.vault, rel),
    `---\nkind: brain-source\ntitle: ${name}\ncreated_at: ${created}\n---\n\n${SUMMARY_BODY}${extra}\n`,
  );
  return rel;
}

interface ActionCase {
  readonly name: string;
  /** Seeds the store; answers the finding, and whether a member is held in `private`. */
  readonly seed: (e: LaneEnv) => HygieneFinding;
}

const ACTIONS: ReadonlyArray<ActionCase> = [
  {
    name: "archive",
    seed: (e) => {
      const abs = derivedPage(e, "Brain/research/zqhyg-archive.md", "Notes/zqhyg-gone.md");
      raise(e, "research", "zqhyg-archive", abs);
      return finding("archive", [abs]);
    },
  },
  {
    name: "forget",
    seed: (e) => {
      const abs = derivedPage(e, "Brain/research/zqhyg-forget.md", "Notes/zqhyg-gone.md");
      raise(e, "research", "zqhyg-forget", abs);
      return finding("forget", [abs]);
    },
  },
  {
    name: "recompile",
    seed: (e) => {
      const abs = derivedPage(e, "Brain/research/zqhyg-recompile.md", sourceNote(e));
      raise(e, "research", "zqhyg-recompile", abs);
      return finding("recompile", [abs]);
    },
  },
  {
    name: "merge",
    seed: (e) => {
      writePreference(e.vault, pref("zqhyg-keep", "Prefer the zqhyg way"));
      writePreference(e.vault, pref("zqhyg-drop", `Prefer the zqhyg way ${REGION}`));
      expect(storePreferenceEntry("zqhyg-drop", e.env.configPath)?.private).toBe(true);
      return finding("merge", ["pref-zqhyg-keep", "pref-zqhyg-drop"]);
    },
  },
  {
    name: "supersede",
    seed: (e) => {
      const res = upsertEntity(e.vault, {
        category: "person",
        name: "Zqhyg Person",
        agent: AGENT,
        now: NOW,
        body: `# Zqhyg Person\n\n${REGION}`,
      });
      expect(laneEntryInPrivate(e.vault, res.entity.path)).toBe(true);
      return finding("supersede", ["zqhyg person#role"], { resolver: { winner_value: "lead" } });
    },
  },
  {
    name: "retire with retarget",
    seed: (e) => {
      const copy = summaryPage(e, "zqhyg-copy", "2026-11-01T00:00:00Z");
      const canonical = summaryPage(e, "zqhyg-canonical", "2026-11-02T00:00:00Z");
      // A preference held in `private` links the copy: the retirement
      // would rewrite that link.
      writePreference(e.vault, pref("zqhyg-linker", `See [[zqhyg-copy]] ${REGION}`));
      expect(storePreferenceEntry("zqhyg-linker", e.env.configPath)?.private).toBe(true);
      return finding("retire", [copy, canonical], { canonical });
    },
  },
  {
    name: "a duplicate group",
    seed: (e) => {
      const older = summaryPage(e, "zqhyg-older", "2026-11-01T00:00:00Z");
      const newer = summaryPage(e, "zqhyg-newer", "2026-11-02T00:00:00Z");
      // On the whole fold the group has a third member, held in `private`.
      const held = summaryPage(e, "zqhyg-held", "2026-11-03T00:00:00Z", ` ${REGION}`);
      expect(laneEntryInPrivate(e.vault, join(e.vault, held))).toBe(true);
      return finding("retire", [older, newer], { canonical: newer });
    },
  },
];

describe("a hygiene action with a member held in private, below local reach", () => {
  for (const { name, seed } of ACTIONS) {
    test(`${name}: the action is refused with the fixed answer and nothing is written`, async () => {
      const e = env(name.replaceAll(" ", "-"));
      const refused = seed(e);
      const before = rawRecords(e);

      const result = await applyAt(e, true, [refused]);

      expect({ applied: result.applied, errors: result.errors }).toEqual({
        applied: [],
        errors: [{ finding_id: refused.id, message: WITHHELD }],
      });
      expect(rawRecords(e)).toEqual(before);
    });

    test(`${name}: a local caller is not refused`, async () => {
      const e = env(`${name.replaceAll(" ", "-")}-local`);
      const result = await applyAt(e, false, [seed(e)]);
      expect(result.errors.map((row) => row.message)).not.toContain(WITHHELD);
    });
  }

  test("the other actions of the call proceed", async () => {
    const e = env("mixed");
    const refused = ACTIONS[0]!.seed(e);
    const fine = derivedPage(e, "Brain/research/zqhyg-fine.md", "Notes/zqhyg-gone.md");
    const result = await applyAt(e, true, [refused, { ...finding("archive", [fine]), id: "f2" }]);
    expect(result.errors).toEqual([{ finding_id: refused.id, message: WITHHELD }]);
    expect(result.applied.map((row) => row.finding_id)).toEqual(["f2"]);
  });
});

/** The ids of the retire findings a document-dedup scan at `s`'s reach answers. */
async function retireIds(s: ReturnType<typeof server>): Promise<string[]> {
  const scan = await callJson(s, "brain_hygiene", { mode: "scan", detectors: ["document-dedup"] });
  expect(scan["error"]).toBeUndefined();
  return (scan["findings"] as ReadonlyArray<{ id: string; proposed_action: string }>)
    .filter((f) => f.proposed_action === "retire")
    .map((f) => f.id);
}

/** The ids of the recompile findings a scan at `s`'s reach answers. */
async function recompileIds(s: ReturnType<typeof server>): Promise<string[]> {
  const scan = await callJson(s, "brain_hygiene", { mode: "scan", detectors: ["freshness"] });
  expect(scan["error"]).toBeUndefined();
  return (scan["findings"] as ReadonlyArray<{ id: string; proposed_action: string }>)
    .filter((f) => f.proposed_action === "recompile")
    .map((f) => f.id);
}

describe("hygiene through the tool below local reach", () => {
  test("an apply with no private member runs as before while another lane holds one", async () => {
    const e = env("no-member");
    derivedPage(e, "Brain/research/zqhyg-stale.md", sourceNote(e));
    privateElsewhere(e);
    const ids = await recompileIds(server(e));
    expect(ids.length).toBe(1);

    const answer = await callJson(server(e), "brain_hygiene", { mode: "apply", ids });

    expect({ changed: answer["changed"], errors: answer["errors"] }).toEqual({
      changed: 1,
      errors: [],
    });
  });

  test("an apply whose every action is refused appends no audit record", async () => {
    const e = env("all-refused");
    summaryPage(e, "zqhyg-older", "2026-11-01T00:00:00Z");
    summaryPage(e, "zqhyg-newer", "2026-11-02T00:00:00Z");
    // The group the caller's scan forms lacks this member, held in `private`.
    summaryPage(e, "zqhyg-held", "2026-11-03T00:00:00Z", ` ${REGION}`);
    const ids = await retireIds(server(e));
    expect(ids.length).toBe(1);
    const before = rawRecords(e);

    const answer = await callJson(server(e), "brain_hygiene", {
      mode: "apply",
      detectors: ["document-dedup"],
      ids,
    });

    expect({ changed: answer["changed"], errors: answer["errors"] }).toEqual({
      changed: 0,
      errors: [{ finding_id: ids[0], message: WITHHELD }],
    });
    expect(JSON.stringify(answer)).not.toContain("zqhyg-held");
    expect(rawRecords(e)).toEqual(before);
  });

  test("the same group at local reach is not refused", async () => {
    const e = env("all-refused-local");
    summaryPage(e, "zqhyg-older", "2026-11-01T00:00:00Z");
    summaryPage(e, "zqhyg-newer", "2026-11-02T00:00:00Z");
    summaryPage(e, "zqhyg-held", "2026-11-03T00:00:00Z", ` ${REGION}`);
    const ids = await retireIds(localServer(e));
    expect(ids.length).toBe(1);
    const answer = await callJson(localServer(e), "brain_hygiene", {
      mode: "apply",
      detectors: ["document-dedup"],
      ids,
    });
    expect(answer["matched"]).toBe(1);
    expect(JSON.stringify(answer["errors"])).not.toContain(WITHHELD);
  });

  test("a refresh refuses an entry raised after its plan was read and archives the other", async () => {
    const e = env("refresh");
    const held = derivedPage(e, "Brain/research/zqhyg-held.md", "Notes/zqhyg-gone.md");
    derivedPage(e, "Brain/research/zqhyg-free.md", "Notes/zqhyg-gone.md");
    // The raise arrives after the caller's plan was read and narrowed (the
    // plan still lists the page), while the first entry's members are
    // listed: from then on the page's winning record is held in `private`.
    const plan = recompile.planRecompile;
    let reads = 0;
    const spy = spyOn(recompile, "planRecompile").mockImplementation((vault, options) => {
      const read = plan(vault, options);
      reads += 1;
      if (reads === 2) {
        spy.mockRestore();
        raise(e, "research", "zqhyg-held", held);
      }
      return read;
    });
    const heldRecords = () =>
      JSON.stringify(e.laneRecords().filter((r) => String(r.body["entry"]).includes("held")));

    try {
      const answer = await callJson(server(e), "brain_hygiene", { mode: "refresh" });
      const before = heldRecords();
      expect({
        plan: (answer["plan"] as ReadonlyArray<unknown>).length,
        archived: (answer["archived"] as string[]).map((page) => page.includes("zqhyg-free")),
        errors: (answer["errors"] as ReadonlyArray<{ message: string }>).map((r) => r.message),
      }).toEqual({ plan: 2, archived: [true], errors: [WITHHELD] });
      expect(heldRecords()).toEqual(before);
      expect(laneEntryInPrivate(e.vault, held)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("a local refresh archives both", async () => {
    const e = env("refresh-local");
    derivedPage(e, "Brain/research/zqhyg-held.md", "Notes/zqhyg-gone.md");
    derivedPage(e, "Brain/research/zqhyg-free.md", "Notes/zqhyg-gone.md");
    const answer = await callJson(localServer(e), "brain_hygiene", { mode: "refresh" });
    expect({ archived: (answer["archived"] as string[]).length, errors: answer["errors"] }).toEqual(
      { archived: 2, errors: [] },
    );
  });
});
