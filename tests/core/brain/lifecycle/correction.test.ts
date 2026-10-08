/**
 * The correct-verb sweep core (truth-correctable-time-aware, Task 16).
 *
 * One verb corrects one record: discovery gathers the affected set
 * within the caller's reach (the claim-graph closure over
 * `whatReplaced`/`whatContests`, a match-only wikilink mention scan,
 * and the same-entity/aspect truth-ledger claims), a dry run writes
 * nothing and returns that blast-radius report, and the applied run
 * retires the target through the correction end-state policy, retargets
 * mentions with per-write failure carry, appends ledger correction
 * events under the corrected record's own source (same-source value
 * change reads as self-correction in the fold, never a conflict), and
 * emits bundle-correlated receipts with
 * `correction_bundle:<bundleId>` in `evidence_triggers`.
 *
 * Pinned too: replay converges (no double retirement, receipts report
 * `appended: false`, a closed window stays closed), Brain/log and
 * receipt lines are never rewritten, a target outside the caller's
 * reach is refused as missing before anything is written, and every
 * write passes the vault-identity guard.
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

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { appendLogEvent } from "../../../../src/core/brain/log.ts";
import { CorrectionError, correct } from "../../../../src/core/brain/lifecycle/correction.ts";
import { parseFrontmatter } from "../../../../src/core/vault.ts";
import { appendClaimEvent, readClaimEvents } from "../../../../src/core/brain/truth/store.ts";
import { computeTruthStateWithConflicts } from "../../../../src/core/brain/truth/conflicts.ts";
import { readDecisionChangeReceipts } from "../../../../src/core/brain/decisions/receipts.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

const NOW = new Date("2026-06-15T12:00:00Z");
const CORRECTION_TS = "2026-06-15T12:00:00Z";
const TARGET = "Brain/preferences/pref-old.md";
const TARGET_SOURCE = "[[Brain/preferences/pref-old.md]]";

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-correction-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-correction-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Seed the target record, its successor, a mentioning page and one claim. */
function seedTarget(): void {
  mkdirSync(brainDirs(vault).preferences, { recursive: true });
  writeFileSync(
    join(vault, TARGET),
    [
      "---",
      "kind: brain-preference",
      "id: pref-old",
      "_status: confirmed",
      "created_at: 2026-05-01T00:00:00Z",
      "unconfirmed_until: 2026-05-01T00:00:00Z",
      "_confirmed_at: 2026-05-01T00:00:00Z",
      "_evidenced_by: []",
      "tags: [brain, brain/preference]",
      "topic: deploy-timeout",
      "principle: Deploy timeout stays at thirty seconds.",
      "pinned: false",
      "---",
      "",
      "The rule body for the deploy timeout.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(vault, "Brain/preferences/pref-new.md"),
    [
      "---",
      "kind: brain-preference",
      "id: pref-new",
      "_status: confirmed",
      "created_at: 2026-06-10T00:00:00Z",
      "unconfirmed_until: 2026-06-10T00:00:00Z",
      "_confirmed_at: 2026-06-10T00:00:00Z",
      "_evidenced_by: []",
      "tags: [brain, brain/preference]",
      "topic: deploy-timeout",
      "principle: Deploy timeout is two minutes.",
      "pinned: false",
      "---",
      "",
      "The corrected rule body.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(vault, "Brain/preferences/pref-other.md"),
    [
      "---",
      "kind: brain-preference",
      "id: pref-other",
      "_status: confirmed",
      "created_at: 2026-05-01T00:00:00Z",
      "unconfirmed_until: 2026-05-01T00:00:00Z",
      "tags: [brain, brain/preference]",
      "topic: unrelated",
      "principle: Mentions [[pref-old]] in prose.",
      "pinned: false",
      "---",
      "",
      "See [[pref-old]] for the old rule.",
      "",
    ].join("\n"),
  );
  appendClaimEvent(
    vault,
    {
      ts: "2026-05-02T00:00:00Z",
      agent: "tester",
      entity: "deploy timeout",
      aspect: "limit",
      value: "30s",
      source: TARGET_SOURCE,
    },
    { configPath },
  );
}

/** The target's frontmatter after a run. */
function targetMeta(): Record<string, unknown> {
  return parseFrontmatter(join(vault, TARGET))[0] as Record<string, unknown>;
}

function logFiles(): string[] {
  const dir = join(vault, "Brain", "log");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .toSorted()
    .map((name) => join(dir, name));
}

const WITHHELD_MENTION = "Brain/private/hidden-mention.md";

/** Seed a page outside the test caller's reach that mentions the target. */
function seedWithheldMention(): string {
  mkdirSync(join(vault, "Brain", "private"), { recursive: true });
  writeFileSync(
    join(vault, WITHHELD_MENTION),
    [
      "---",
      "kind: note",
      "id: hidden-mention",
      "---",
      "",
      "Hidden context: see [[pref-old]].",
      "",
    ].join("\n"),
  );
  return readFileSync(join(vault, WITHHELD_MENTION), "utf8");
}

/** Everything except the withheld page: the test caller's readable set. */
function readableExceptWithheld(rel: string): boolean {
  return rel !== WITHHELD_MENTION;
}

describe("dry run", () => {
  test("writes nothing and returns the blast-radius report", () => {
    seedTarget();
    const before = readFileSync(join(vault, TARGET), "utf8");
    const mentionBefore = readFileSync(join(vault, "Brain/preferences/pref-other.md"), "utf8");
    const eventsBefore = readClaimEvents(vault).events.length;

    const res = correct({
      vault,
      configPath,
      target: TARGET,
      value: "two minutes",
      successor: "pref-new",
      reason: "the timeout changed",
      now: NOW,
      agent: "tester",
    });

    expect(res.dryRun).toBe(true);
    expect(res.blastRadius.target).toBe(TARGET);
    // The closure reads the graph as it stands: the target carries no
    // successor pointer yet, so nothing has replaced it at discovery time.
    expect(res.blastRadius.replacedBy).toBeNull();
    expect(res.blastRadius.mentions).toContain("Brain/preferences/pref-other.md");
    expect(res.blastRadius.claims.map((c) => c.value)).toContain("30s");
    expect(res.retarget.rewritten).toEqual([]);
    expect(res.ledger).toEqual([]);
    expect(res.retirements).toEqual([]);
    expect(res.receipts).toEqual([]);
    expect(readFileSync(join(vault, TARGET), "utf8")).toBe(before);
    expect(readFileSync(join(vault, "Brain/preferences/pref-other.md"), "utf8")).toBe(
      mentionBefore,
    );
    expect(readClaimEvents(vault).events.length).toBe(eventsBefore);
  });
});

describe("reach-bounded retargeting", () => {
  test("a restricted dry run names no out-of-reach page anywhere in the retarget report", () => {
    seedTarget();
    const withheldBefore = seedWithheldMention();

    const res = correct({
      vault,
      configPath,
      target: TARGET,
      successor: "pref-new",
      reason: "the timeout changed",
      now: NOW,
      agent: "tester",
      readable: readableExceptWithheld,
    });

    expect(res.dryRun).toBe(true);
    expect(res.blastRadius.mentions).not.toContain(WITHHELD_MENTION);
    expect(res.retarget.matched).not.toContain(WITHHELD_MENTION);
    expect(res.retarget.failed.map((f) => f.path)).not.toContain(WITHHELD_MENTION);
    // The withheld path is not disclosed under any other key either.
    expect(JSON.stringify(res)).not.toContain("hidden-mention");
    expect(readFileSync(join(vault, WITHHELD_MENTION), "utf8")).toBe(withheldBefore);
  });

  test("a restricted applied run leaves out-of-reach pages unwritten and unnamed", () => {
    seedTarget();
    const withheldBefore = seedWithheldMention();

    const res = correct({
      vault,
      configPath,
      target: TARGET,
      value: "two minutes",
      successor: "pref-new",
      reason: "the timeout changed",
      dryRun: false,
      now: NOW,
      agent: "tester",
      readable: readableExceptWithheld,
    });

    expect(res.retarget.matched).not.toContain(WITHHELD_MENTION);
    expect(res.retarget.rewritten).not.toContain(WITHHELD_MENTION);
    expect(res.retarget.failed.map((f) => f.path)).not.toContain(WITHHELD_MENTION);
    expect(JSON.stringify(res)).not.toContain("hidden-mention");
    // No content injection into the withheld page: its bytes are unchanged.
    expect(readFileSync(join(vault, WITHHELD_MENTION), "utf8")).toBe(withheldBefore);
    // In-reach mentions are still retargeted.
    expect(res.retarget.rewritten).toContain("Brain/preferences/pref-other.md");
  });
});

describe("claims reach gate", () => {
  test("slot claims sourced to readable extension-bearing paths stay in the blast radius", () => {
    seedTarget();
    // A second claim in the target's own slot, sourced to the readable
    // mentioning page with the extension-bearing spelling every other
    // caller hands the readable predicate (claim-graph node paths,
    // mention-scan paths).
    appendClaimEvent(
      vault,
      {
        ts: "2026-05-03T00:00:00Z",
        agent: "tester",
        entity: "deploy timeout",
        aspect: "limit",
        value: "45s",
        source: "[[Brain/preferences/pref-other.md]]",
      },
      { configPath },
    );
    // And one sourced to a page the caller may not read.
    const withheldSource = "Brain/private/hidden-source.md";
    mkdirSync(join(vault, "Brain", "private"), { recursive: true });
    writeFileSync(
      join(vault, withheldSource),
      ["---", "kind: note", "id: hidden-source", "---", "", "Hidden.", ""].join("\n"),
    );
    appendClaimEvent(
      vault,
      {
        ts: "2026-05-04T00:00:00Z",
        agent: "tester",
        entity: "deploy timeout",
        aspect: "limit",
        value: "15s",
        source: `[[${withheldSource}]]`,
      },
      { configPath },
    );

    const res = correct({
      vault,
      configPath,
      target: TARGET,
      successor: "pref-new",
      reason: "the timeout changed",
      now: NOW,
      agent: "tester",
      // The predicate answers the extension-bearing spellings the other
      // callers pass, so a claim's source must arrive in that shape.
      readable: (rel) => rel.endsWith(".md") && rel !== withheldSource,
    });

    const values = res.blastRadius.claims.map((c) => c.value);
    expect(values).toContain("30s"); // the target's own claim
    expect(values).toContain("45s"); // readable, extension-bearing source
    expect(values).not.toContain("15s"); // withheld source stays out
  });

  test("a same-named page in another folder is never the target, reach gate or not", () => {
    seedTarget();
    // A second page sharing the target's basename but not its folder,
    // seeded with a claim in the target's own slot. A basename fold of
    // the source matched it as the target's own event, so its claim
    // entered the blast radius without passing the reach gate and its
    // source could stand in for the target's on an applied correction.
    const impostor = "Brain/private/pref-old.md";
    mkdirSync(join(vault, "Brain", "private"), { recursive: true });
    writeFileSync(
      join(vault, impostor),
      ["---", "kind: note", "id: pref-old", "---", "", "An unrelated page.", ""].join("\n"),
    );
    appendClaimEvent(
      vault,
      {
        ts: "2026-05-05T00:00:00Z",
        agent: "tester",
        entity: "deploy timeout",
        aspect: "limit",
        value: "impostor",
        source: `[[${impostor}]]`,
      },
      { configPath },
    );

    const res = correct({
      vault,
      configPath,
      target: TARGET,
      successor: "pref-new",
      reason: "the timeout changed",
      now: NOW,
      agent: "tester",
      readable: (rel) => rel.endsWith(".md") && rel !== impostor,
    });

    // The impostor is not the target and is withheld: neither its claim
    // nor any slot attribution of the target's own claim may name it.
    const values = res.blastRadius.claims.map((c) => c.value);
    expect(values).toContain("30s"); // the target's own claim
    expect(values).not.toContain("impostor");
    for (const claimRow of res.blastRadius.claims) {
      expect(claimRow.source).not.toContain(impostor);
    }
  });
});

describe("applied run", () => {
  test("validity-close retires the target and retargets mentions", () => {
    seedTarget();
    const res = correct({
      vault,
      configPath,
      target: TARGET,
      value: "two minutes",
      successor: "pref-new",
      reason: "the timeout changed",
      dryRun: false,
      now: NOW,
      agent: "tester",
    });

    expect(res.dryRun).toBe(false);
    const retirement = res.retirements[0]!;
    expect(retirement.endState).toBe("validity_close");
    expect(retirement.reasonCode).toBe("supersede");
    expect(retirement.validUntil).toBe(CORRECTION_TS);
    expect(retirement.changed).toBe(true);

    const meta = targetMeta();
    expect(meta["_status"]).toBe("confirmed");
    expect(meta["valid_until"]).toBe(CORRECTION_TS);
    expect(meta["superseded_by"]).toBe("[[pref-new]]");

    expect(res.retarget.rewritten).toContain("Brain/preferences/pref-other.md");
    expect(readFileSync(join(vault, "Brain/preferences/pref-other.md"), "utf8")).toContain(
      "[[pref-new]]",
    );
  });

  test("a flatly-wrong correction tombstones with a null window end", () => {
    seedTarget();
    const res = correct({
      vault,
      configPath,
      target: TARGET,
      value: "the number was never thirty seconds",
      successor: "pref-new",
      flatlyWrong: true,
      reason: "fabricated figure",
      dryRun: false,
      now: NOW,
      agent: "tester",
    });

    const retirement = res.retirements[0]!;
    expect(retirement.endState).toBe("tombstone");
    expect(retirement.reasonCode).toBe("tombstone");
    expect(retirement.validUntil).toBeNull();
    expect(targetMeta()["_status"]).toBe("tombstoned");
  });

  test("ledger correction events keep the corrected record's source and never conflict", () => {
    seedTarget();
    const res = correct({
      vault,
      configPath,
      target: TARGET,
      value: "two minutes",
      successor: "pref-new",
      reason: "the timeout changed",
      dryRun: false,
      now: NOW,
      agent: "tester",
    });

    expect(res.ledger).toEqual([
      { entity: "deploy timeout", aspect: "limit", value: "two minutes", source: TARGET_SOURCE },
    ]);
    const events = readClaimEvents(vault).events;
    const corrected = events.find((e) => e.value === "two minutes");
    expect(corrected).toBeDefined();
    expect(corrected!.source).toBe(TARGET_SOURCE);
    expect(corrected!.entity).toBe("deploy timeout");
    expect(corrected!.aspect).toBe("limit");
    expect(corrected!.validFrom).toBe(CORRECTION_TS);

    // Same-source value change reads as self-correction in the fold:
    // the slot carries no conflict after the sweep.
    const state = computeTruthStateWithConflicts(events);
    expect(state.conflicts).toEqual([]);
  });

  test("receipts carry the bundle id in evidence_triggers", () => {
    seedTarget();
    const res = correct({
      vault,
      configPath,
      target: TARGET,
      value: "two minutes",
      successor: "pref-new",
      reason: "the timeout changed",
      dryRun: false,
      now: NOW,
      agent: "tester",
    });

    const trigger = `correction_bundle:${res.bundleId}`;
    expect(trigger.startsWith("correction_bundle:")).toBe(true);
    const receipts = readDecisionChangeReceipts(vault).receipts;
    const bundled = receipts.filter((r) => r.evidence_triggers.includes(trigger));
    expect(bundled.length).toBeGreaterThanOrEqual(1);
    const retirement = bundled.find((r) => r.subject === TARGET);
    expect(retirement).toBeDefined();
    expect(retirement!.reason_code).toBe("supersede");
    expect(retirement!.before).toBe("status:confirmed");
    expect(retirement!.after).toBe(`validity_close until ${CORRECTION_TS}`);
  });

  test("Brain/log lines are never rewritten, even when they mention the target", () => {
    seedTarget();
    appendLogEvent(vault, {
      timestamp: "2026-06-01T00:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
      body: { preference: "[[pref-old]]", agent: "tester" },
    });
    const logBefore = logFiles()
      .map((f) => readFileSync(f, "utf8"))
      .join("");

    correct({
      vault,
      configPath,
      target: TARGET,
      value: "two minutes",
      successor: "pref-new",
      reason: "the timeout changed",
      dryRun: false,
      now: NOW,
      agent: "tester",
    });

    const logAfter = logFiles()
      .map((f) => readFileSync(f, "utf8"))
      .join("");
    expect(logAfter).toContain("[[pref-old]]");
    // The pre-existing testimony is byte-identical; the sweep may only append.
    expect(logAfter.startsWith(logBefore)).toBe(true);
  });

  test("every target a caller may not read is refused as missing before anything is written", () => {
    seedTarget();
    const before = readFileSync(join(vault, TARGET), "utf8");
    expect(() =>
      correct({
        vault,
        configPath,
        target: TARGET,
        value: "two minutes",
        successor: "pref-new",
        reason: "the timeout changed",
        now: NOW,
        agent: "tester",
        readable: (rel) => rel !== TARGET,
      }),
    ).toThrow(CorrectionError);
    expect(readFileSync(join(vault, TARGET), "utf8")).toBe(before);
  });

  test("a receipt-ask failure is reported, not fatal: the retirement lands and the sweep succeeds", () => {
    seedTarget();
    // The receipt shard's path is shadowed by a directory, so every
    // decision-change receipt ask throws (the file cannot be appended
    // to) - the same accountability-log hiccup the tombstone
    // pre-receipt's fail-soft discipline in this sweep anticipates.
    mkdirSync(join(vault, "Brain", "truth", "decision-change.jsonl"), { recursive: true });

    const res = correct({
      vault,
      configPath,
      target: TARGET,
      value: "two minutes",
      successor: "pref-new",
      reason: "the timeout changed",
      dryRun: false,
      now: NOW,
      agent: "tester",
    });

    // The applied sweep completed: the retirement is on the record, the
    // mentions are retargeted and the ledger correction event landed.
    expect(targetMeta()["valid_until"]).toBe(CORRECTION_TS);
    expect(targetMeta()["superseded_by"]).toBe("[[pref-new]]");
    expect(res.retirements[0]!.changed).toBe(true);
    expect(res.retarget.rewritten).toContain("Brain/preferences/pref-other.md");
    expect(res.ledger).toHaveLength(1);
    // The failed asks are reported as not appended, never thrown.
    expect(res.receipts.length).toBeGreaterThan(0);
    expect(res.receipts.every((r) => r.appended === false)).toBe(true);
  });

  test("a target naming no file is refused", () => {
    seedTarget();
    expect(() =>
      correct({
        vault,
        configPath,
        target: "Brain/preferences/pref-absent.md",
        value: "two minutes",
        reason: "the timeout changed",
        now: NOW,
        agent: "tester",
      }),
    ).toThrow(CorrectionError);
  });
});

describe("successor input", () => {
  test("a successor that normalizes to empty is refused on a dry run", () => {
    seedTarget();
    // `|||` normalizes to the empty id (pipe-stripped), as does a fence
    // with only an alias; either would otherwise flow into the pointer
    // and retarget writes as a malformed `[[]]`.
    for (const successor of ["|||", "[[|alias]]"]) {
      expect(() =>
        correct({
          vault,
          configPath,
          target: TARGET,
          successor,
          reason: "the timeout changed",
          now: NOW,
          agent: "tester",
        }),
      ).toThrow(CorrectionError);
    }
  });

  test("a successor that normalizes to empty is refused on an applied run and writes nothing", () => {
    seedTarget();
    const before = readFileSync(join(vault, TARGET), "utf8");
    const eventsBefore = readClaimEvents(vault).events.length;
    expect(() =>
      correct({
        vault,
        configPath,
        target: TARGET,
        value: "two minutes",
        successor: "|||",
        reason: "the timeout changed",
        dryRun: false,
        now: NOW,
        agent: "tester",
      }),
    ).toThrow(CorrectionError);
    // The refusal precedes every write: no malformed superseded_by
    // pointer, no ledger correction event.
    expect(readFileSync(join(vault, TARGET), "utf8")).toBe(before);
    expect(readClaimEvents(vault).events.length).toBe(eventsBefore);
  });
});

describe("replay convergence", () => {
  test("a flatly-wrong replay over an already-closed window is a named refusal, not an internal error", () => {
    // First sweep validity-closes the target at the correction instant.
    seedTarget();
    correct({
      vault,
      configPath,
      target: TARGET,
      value: "two minutes",
      successor: "pref-new",
      reason: "the timeout changed",
      dryRun: false,
      now: NOW,
      agent: "tester",
    });
    const metaAfterFirst = targetMeta();
    const eventsAfterFirst = readClaimEvents(vault).events;

    // The replay flips the end-state policy to tombstone, so the record
    // does not read as already-retired; the ledger correction then
    // resolves its open until-bound from the record's own frontmatter -
    // the close this very sweep wrote - and the window inverts. The
    // replay has converged, so the sweep must refuse by name rather
    // than let the store's internal-class refusal escape mid-replay.
    let refused: unknown;
    try {
      correct({
        vault,
        configPath,
        target: TARGET,
        value: "the number was never thirty seconds",
        flatlyWrong: true,
        reason: "fabricated figure",
        dryRun: false,
        now: new Date("2026-06-16T12:00:00Z"),
        agent: "tester",
      });
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(CorrectionError);
    expect((refused as Error).name).toBe("CorrectionError");
    expect((refused as Error).message).toContain("already validity-closed");
    expect((refused as Error).message).toContain(CORRECTION_TS);

    // The refusal is strict: the retirement write never ran, so the
    // record keeps its closed window and confirmed status, and the
    // ledger carries no correction event from the aborted replay.
    const metaAfterSecond = targetMeta();
    expect(metaAfterSecond["valid_until"]).toBe(metaAfterFirst["valid_until"]);
    expect(metaAfterSecond["_status"]).toBe("confirmed");
    expect(metaAfterSecond["superseded_by"]).toBe(metaAfterFirst["superseded_by"]);
    const eventsAfterSecond = readClaimEvents(vault).events;
    expect(
      eventsAfterSecond.filter((e) => e.value === "the number was never thirty seconds"),
    ).toHaveLength(0);
    expect(eventsAfterSecond.length).toBe(eventsAfterFirst.length);
  });

  test("a second run retires nothing, re-appends nothing and reports appended receipts", () => {
    seedTarget();
    const first = correct({
      vault,
      configPath,
      target: TARGET,
      value: "two minutes",
      successor: "pref-new",
      reason: "the timeout changed",
      dryRun: false,
      now: NOW,
      agent: "tester",
    });
    const metaAfterFirst = targetMeta();
    const eventsAfterFirst = readClaimEvents(vault).events;

    const second = correct({
      vault,
      configPath,
      target: TARGET,
      value: "two minutes",
      successor: "pref-new",
      reason: "the timeout changed",
      dryRun: false,
      now: new Date("2026-06-16T12:00:00Z"),
      agent: "tester",
    });

    expect(second.retirements[0]!.changed).toBe(false);
    // The closed window stays closed at the original instant.
    expect(targetMeta()["valid_until"]).toBe(metaAfterFirst["valid_until"]);
    // The ledger keeps one correction event: a re-assertion is not a new fact.
    const eventsAfterSecond = readClaimEvents(vault).events;
    expect(
      eventsAfterSecond.filter((e) => e.value === "two minutes" && e.source === TARGET_SOURCE)
        .length,
    ).toBe(eventsAfterFirst.filter((e) => e.value === "two minutes").length);
    // The receipts report the replay as appended: false.
    expect(second.receipts.every((r) => r.appended === false)).toBe(true);
    expect(first.receipts.length).toBeGreaterThan(0);
  });
});

describe("tombstone receipts", () => {
  test("a fresh flatly-wrong run without a successor emits exactly one retirement receipt carrying the bundle trigger", () => {
    seedTarget();
    const res = correct({
      vault,
      configPath,
      target: TARGET,
      value: "the number was never thirty seconds",
      flatlyWrong: true,
      reason: "fabricated figure",
      dryRun: false,
      now: NOW,
      agent: "tester",
    });

    const receipts = readDecisionChangeReceipts(vault).receipts.filter((r) => r.subject === TARGET);
    // The shared tombstone writer's own receipt and the sweep's bundle
    // receipt are the SAME retirement: one receipt lands, and it carries
    // the bundle trigger no other writer could have supplied.
    expect(receipts.length).toBe(1);
    expect(receipts[0]!.evidence_triggers).toContain(`correction_bundle:${res.bundleId}`);
    expect(receipts[0]!.after).toBe("status:tombstoned");
    expect(receipts[0]!.before).toBe("status:confirmed");
    const retirementReceipt = res.receipts.find((r) => r.subject === TARGET);
    expect(retirementReceipt!.appended).toBe(true);
  });

  test("a fresh flatly-wrong run with a successor emits exactly one retirement receipt carrying the bundle trigger", () => {
    seedTarget();
    const res = correct({
      vault,
      configPath,
      target: TARGET,
      value: "the number was never thirty seconds",
      successor: "pref-new",
      flatlyWrong: true,
      reason: "fabricated figure",
      dryRun: false,
      now: NOW,
      agent: "tester",
    });

    const receipts = readDecisionChangeReceipts(vault).receipts.filter((r) => r.subject === TARGET);
    expect(receipts.length).toBe(1);
    expect(receipts[0]!.evidence_triggers).toContain(`correction_bundle:${res.bundleId}`);
    // The pointer spelling matches the retirement's superseded_by pointer.
    expect(receipts[0]!.after).toBe("status:tombstoned superseded_by:[[pref-new]]");
  });

  test("an applied flatly-wrong replay reports the retirement and its receipt as not appended", () => {
    seedTarget();
    correct({
      vault,
      configPath,
      target: TARGET,
      value: "the number was never thirty seconds",
      flatlyWrong: true,
      reason: "fabricated figure",
      dryRun: false,
      now: NOW,
      agent: "tester",
    });
    const receiptsAfterFirst = readDecisionChangeReceipts(vault).receipts.filter(
      (r) => r.subject === TARGET,
    );

    const second = correct({
      vault,
      configPath,
      target: TARGET,
      value: "the number was never thirty seconds",
      flatlyWrong: true,
      reason: "fabricated figure",
      dryRun: false,
      now: new Date("2026-06-16T12:00:00Z"),
      agent: "tester",
    });

    expect(second.retirements[0]!.changed).toBe(false);
    // The replay reports the retirement receipt as not appended, instead
    // of minting a fresh no-change receipt under a mutated idempotency key.
    expect(second.receipts.length).toBeGreaterThan(0);
    expect(second.receipts.some((r) => r.subject === TARGET)).toBe(true);
    expect(second.receipts.every((r) => r.appended === false)).toBe(true);
    const receiptsAfterSecond = readDecisionChangeReceipts(vault).receipts.filter(
      (r) => r.subject === TARGET,
    );
    expect(receiptsAfterSecond.length).toBe(receiptsAfterFirst.length);
  });
});

describe("optional inputs", () => {
  test("a correction with no corrected value appends nothing to the ledger", () => {
    seedTarget();
    const res = correct({
      vault,
      configPath,
      target: TARGET,
      successor: "pref-new",
      reason: "the timeout changed",
      dryRun: false,
      now: NOW,
      agent: "tester",
    });
    expect(res.ledger).toEqual([]);
    expect(res.retirements[0]!.endState).toBe("validity_close");
  });

  test("an explicit window end closes validity there instead of at the correction instant", () => {
    seedTarget();
    const res = correct({
      vault,
      configPath,
      target: TARGET,
      successor: "pref-new",
      windowEnd: "2026-07-01T00:00:00Z",
      reason: "the timeout changed",
      dryRun: false,
      now: NOW,
      agent: "tester",
    });
    expect(res.retirements[0]!.validUntil).toBe("2026-07-01T00:00:00Z");
    expect(targetMeta()["valid_until"]).toBe("2026-07-01T00:00:00Z");
  });

  test("a malformed window end is refused before anything is written", () => {
    seedTarget();
    const before = readFileSync(join(vault, TARGET), "utf8");
    const eventsBefore = readClaimEvents(vault).events.length;
    // The shapes the ledger append boundary refuses: relative phrases,
    // offset-bearing datetimes, empty strings.
    for (const bad of ["next tuesday", "2026-07-01T00:00:00+02:00", ""]) {
      expect(() =>
        correct({
          vault,
          configPath,
          target: TARGET,
          windowEnd: bad,
          reason: "the timeout changed",
          dryRun: false,
          now: NOW,
          agent: "tester",
        }),
      ).toThrow(CorrectionError);
    }
    expect(readFileSync(join(vault, TARGET), "utf8")).toBe(before);
    expect(readClaimEvents(vault).events.length).toBe(eventsBefore);
  });

  test("a bare ISO date window end is accepted, matching the ledger grammar", () => {
    seedTarget();
    const res = correct({
      vault,
      configPath,
      target: TARGET,
      successor: "pref-new",
      windowEnd: "2026-07-01",
      reason: "the timeout changed",
      dryRun: false,
      now: NOW,
      agent: "tester",
    });
    expect(res.retirements[0]!.validUntil).toBe("2026-07-01");
    expect(targetMeta()["valid_until"]).toBe("2026-07-01");
  });
});
