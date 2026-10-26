/**
 * The dead-letter recovery classifier (one-command recovery,
 * t_50794f57). Claims pinned here:
 *
 *  1. The classifier is total over five honest states: `recover` (v2
 *     payload, session still capture-classified, missing items not yet
 *     on disk), `pending` (the session's items sit staged in the
 *     write-approval queue), `re-extract` (no frozen payload to re-run),
 *     `not_recoverable` (unknown lane, unknown session, or a session the
 *     capture boundary now refuses), and `resolved` (every missing key
 *     now exists on disk - the retention rule's fifth state, so a
 *     reconciled row never reads as still-broken).
 *  2. Every actionable state carries the exact copy-paste command;
 *     `not_recoverable` and `resolved` carry none.
 *  3. The recovery plan labels each recorded item `write`, `staged`,
 *     `dedup` or `refused` with the same gates, in the same order, the
 *     commit itself applies.
 *  4. `applyRecovery` re-runs the recorded payload at CURRENT vault
 *     state: already-written items dedup away, nothing stale is
 *     replayed, and the letter survives - nothing in the project deletes
 *     a dead letter.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEAD_LETTER_LANES,
  deadLetterDir,
  deadLetterPath,
  isDeadLetterLane,
  readDeadLetter,
  recordDeadLetter,
  type DeadLetterEnvelopeIdentity,
  type DeadLetterRecord,
} from "../../../src/core/brain/dead-letter.ts";
import {
  DEAD_LETTER_RECOVERY_CATEGORY,
  DeadLetterRecoveryError,
  applyRecovery,
  classifyDeadLetter,
  planRecovery,
} from "../../../src/core/brain/dead-letter-recovery.ts";
import {
  commitExtractedSignals,
  type ExtractedSignalItem,
} from "../../../src/core/brain/extract-signals.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../src/core/brain/config-template.ts";
import { brainConfigPath, brainDirs } from "../../../src/core/brain/paths.ts";
import { importSessionRecall } from "../../../src/core/brain/session-recall.ts";
import { buildReconciliationReport } from "../../../src/core/reconciliation-report.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

const NOW = new Date("2026-08-23T10:15:00Z");
const SESSION = "sess-recover";
const AGENT = "tester";
const V1_FIXTURE_ID = "extract-signals-0123456789ab";

let vault: string;

function item(overrides: Partial<ExtractedSignalItem> = {}): ExtractedSignalItem {
  return {
    topic: "release-notes-style",
    signal: "positive",
    principle: "Name the release theme in the heading, never the ticket id.",
    confidence: 0.9,
    ...overrides,
  };
}

const ENVELOPE: DeadLetterEnvelopeIdentity = Object.freeze({
  lane: "extract-signals",
  step: "extract-signals",
  reference: SESSION,
  target: "Brain/inbox",
});

function report(items: number, missingKeys: ReadonlyArray<string>) {
  return buildReconciliationReport({
    attempted: items,
    found: items - missingKeys.length,
    missing: missingKeys,
  });
}

/** A well-formed schema-2 letter over `items`, naming `missingKeys`. */
function v2Letter(
  items: ReadonlyArray<ExtractedSignalItem>,
  missingKeys: ReadonlyArray<string>,
  reference = SESSION,
): DeadLetterRecord {
  return recordDeadLetter(vault, {
    envelope: { ...ENVELOPE, reference },
    report: report(items.length, missingKeys),
    firstError: "EIO: i/o error",
    now: NOW,
    payload: { items: [...items] },
  });
}

/** Hand-write a record exactly as schema v1 wrote it: payload-less. */
function v1Letter(missingKeys: ReadonlyArray<string>): DeadLetterRecord {
  const body = {
    schema_version: 1,
    id: V1_FIXTURE_ID,
    lane: "extract-signals",
    step: "extract-signals",
    reference: SESSION,
    target: "Brain/inbox",
    attempted: 2,
    found: 1,
    missing: missingKeys,
    outcome: "partial",
    first_error: "disk full",
    recorded_at: "2026-08-23T10:15:00Z",
  };
  mkdirSync(deadLetterDir(vault), { recursive: true });
  writeFileSync(deadLetterPath(vault, V1_FIXTURE_ID), `${JSON.stringify(body, null, 2)}\n`);
  const record = readDeadLetter(vault, V1_FIXTURE_ID);
  if (record === null) throw new Error("the v1 fixture letter did not parse");
  return record;
}

/** Import one session whose single user turn is mining material. */
function importFixtureSession(sessionId = SESSION): void {
  importSessionRecall(vault, {
    sessionId,
    turns: [
      {
        turnId: "t1",
        timestamp: "2026-08-22T09:01:00Z",
        role: "user",
        text: "Always name the release theme in the heading.",
      },
    ],
    createdAt: "2026-08-22T10:00:00Z",
  });
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dead-letter-recovery-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  importFixtureSession();
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("the recovery classifier", () => {
  test("a v2 letter with undelivered missing items classifies recover, with the exact command", () => {
    const letter = v2Letter([item(), item({ topic: "module-names" })], ["items[1]:module-names"]);
    const c = classifyDeadLetter(vault, letter);
    expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.recover);
    expect(c.command).toBe(`o2b brain dead-letters recover ${letter.id} --apply --yes`);
    expect(c.reason).toContain("not yet on disk");
  });

  test("a letter whose missing items all exist on disk classifies resolved, with no command", () => {
    // The items were written after the failure: a successful commit over
    // the same payload puts both signals in the inbox.
    const items = [item(), item({ topic: "module-names" })];
    commitExtractedSignals(vault, SESSION, { items }, { agent: AGENT, now: NOW });
    const letter = v2Letter(items, ["items[0]:release-notes-style", "items[1]:module-names"]);
    const c = classifyDeadLetter(vault, letter);
    expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.resolved);
    expect(c.command).toBeNull();
  });

  test("a v1 letter whose missing items exist on disk classifies resolved too", () => {
    // Retention keeps reconciled v1 rows on disk; the classifier
    // re-measures them by topic, the only identity a payload-less letter
    // names.
    const items = [item(), item({ topic: "module-names" })];
    commitExtractedSignals(vault, SESSION, { items }, { agent: AGENT, now: NOW });
    const letter = v1Letter(["items[0]:release-notes-style", "items[1]:module-names"]);
    const c = classifyDeadLetter(vault, letter);
    expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.resolved);
    expect(c.command).toBeNull();
  });

  test("a session whose items sit staged in the write-approval queue classifies pending", () => {
    // Write approval was on when the commit ran: the item that LANDED is
    // staged in Brain/pending/ carrying the session_ref, and the letter's
    // remaining item is undelivered. The queue - not a re-run - is the
    // exit.
    const staged = commitExtractedSignals(
      vault,
      SESSION,
      { items: [item()] },
      { agent: AGENT, now: NOW, writeApprovalEnabled: true },
    );
    expect(staged.staged).toBe(1);
    const letter = v2Letter([item(), item({ topic: "module-names" })], ["items[1]:module-names"]);
    const c = classifyDeadLetter(vault, letter);
    expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.pending);
    expect(c.command).toBe(`o2b brain pending apply ${staged.written[0]?.id}`);
    expect(c.reason).toContain("write-approval queue");
  });

  test("a v1 letter classifies re-extract and names the extraction command", () => {
    const letter = v1Letter(["items[1]:module-names"]);
    const c = classifyDeadLetter(vault, letter);
    expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.reExtract);
    expect(c.command).toBe(`o2b brain extract-signals ${SESSION}`);
  });

  test("a v2 letter that carries no payload classifies re-extract", () => {
    const letter = recordDeadLetter(vault, {
      envelope: ENVELOPE,
      report: report(2, ["items[1]:module-names"]),
      firstError: "disk full",
      now: NOW,
    });
    expect(letter.schema_version).toBe(2);
    const c = classifyDeadLetter(vault, letter);
    expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.reExtract);
    expect(c.command).toBe(`o2b brain extract-signals ${SESSION}`);
  });

  test("a session unknown to the import ledger classifies not_recoverable", () => {
    const letter = v2Letter([item()], ["items[0]:release-notes-style"], "sess-nowhere");
    const c = classifyDeadLetter(vault, letter);
    expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.notRecoverable);
    expect(c.command).toBeNull();
    expect(c.reason).toContain("sess-nowhere");
  });

  test("a session the capture boundary now refuses classifies not_recoverable", () => {
    // Seed the vault config exactly as `brain init` writes it, then
    // append an ignore pattern that matches the session, so the boundary
    // read below parses a real config rather than a minimal fragment.
    mkdirSync(brainDirs(vault).brain, { recursive: true });
    atomicWriteFileSync(
      brainConfigPath(vault),
      `${DEFAULT_BRAIN_CONFIG_YAML}\nsessions:\n  ignore_patterns:\n    - "${SESSION}"\n`,
    );
    const letter = v2Letter([item()], ["items[0]:release-notes-style"]);
    const c = classifyDeadLetter(vault, letter);
    expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.notRecoverable);
    expect(c.command).toBeNull();
    expect(c.reason).toContain(SESSION);
  });

  test("a record whose lane is unknown to this build classifies not_recoverable by name", () => {
    mkdirSync(deadLetterDir(vault), { recursive: true });
    const id = "time-machine-0123456789ab";
    const body = {
      schema_version: 2,
      id,
      lane: "time-machine",
      step: "time-machine",
      reference: SESSION,
      target: "Brain/inbox",
      attempted: 1,
      found: 0,
      missing: ["items[0]:x"],
      outcome: "partial",
      first_error: "disk full",
      recorded_at: "2026-08-23T10:15:00Z",
      payload: { items: [item()] },
    };
    writeFileSync(deadLetterPath(vault, id), `${JSON.stringify(body, null, 2)}\n`);
    const letter = readDeadLetter(vault, id);
    if (letter === null) throw new Error("the unknown-lane fixture letter did not parse");
    const c = classifyDeadLetter(vault, letter);
    expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.notRecoverable);
    expect(c.command).toBeNull();
    expect(c.reason).toContain("time-machine");
  });

  test("a payload that no longer passes the lane's own validation classifies re-extract", () => {
    // An item below the confidence floor refuses the whole payload at
    // commit time, so a letter frozen with one cannot be re-run verbatim.
    const letter = recordDeadLetter(vault, {
      envelope: ENVELOPE,
      report: report(1, ["items[0]:shaky"]),
      firstError: "disk full",
      now: NOW,
      payload: {
        items: [{ topic: "shaky", signal: "positive", principle: "Try harder.", confidence: 0.2 }],
      },
    });
    const c = classifyDeadLetter(vault, letter);
    expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.reExtract);
  });
});

describe("the recovery plan", () => {
  test("each item is labelled with the verdict the commit's own gates produce", () => {
    // `release-notes-style` is already on disk (dedup), `module-names` is
    // not (write), `scratch-pad` fails the denylist (refused).
    commitExtractedSignals(vault, SESSION, { items: [item()] }, { agent: AGENT, now: NOW });
    const letter = v2Letter(
      [
        item(),
        item({ topic: "module-names" }),
        item({ topic: "scratch-pad", principle: "temporary scratch note" }),
      ],
      ["items[1]:module-names", "items[2]:scratch-pad"],
    );
    const plan = planRecovery(vault, letter, { durabilityDenylist: [/scratch/] });
    expect(plan.classification.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.recover);
    expect(plan.items.map((i) => [i.topic, i.verdict])).toEqual([
      ["release-notes-style", "dedup"],
      ["module-names", "write"],
      ["scratch-pad", "refused"],
    ]);
    expect(plan.items[2]?.reason).toContain("denylisted");
  });

  test("with write approval on, a writable item plans as staged", () => {
    const letter = v2Letter([item()], ["items[0]:release-notes-style"]);
    const plan = planRecovery(vault, letter, { writeApprovalEnabled: true });
    expect(plan.items[0]?.verdict).toBe("staged");
  });
});

describe("the apply", () => {
  test("apply re-runs the payload at current state; already-written items dedup away", () => {
    // `release-notes-style` landed before the recovery; the letter still
    // names both items missing, because the commit that failed part way
    // never wrote the second one.
    commitExtractedSignals(vault, SESSION, { items: [item()] }, { agent: AGENT, now: NOW });
    const letter = v2Letter(
      [item(), item({ topic: "module-names" })],
      ["items[0]:release-notes-style", "items[1]:module-names"],
    );
    expect(classifyDeadLetter(vault, letter).category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.recover);
    const res = applyRecovery(vault, letter, { agent: AGENT, now: NOW });
    expect(res.written.map((w) => w.topic)).toEqual(["module-names"]);
    expect(res.deduped).toBe(1);
  });

  test("apply refuses a letter that is not recoverable, naming the category", () => {
    const letter = v1Letter(["items[1]:module-names"]);
    expect(() => applyRecovery(vault, letter, { agent: AGENT, now: NOW })).toThrow(
      DeadLetterRecoveryError,
    );
    expect(() => applyRecovery(vault, letter, { agent: AGENT, now: NOW })).toThrow(/re-extract/);
  });

  test("nothing in the apply deletes the letter", () => {
    const letter = v2Letter([item()], ["items[0]:release-notes-style"]);
    applyRecovery(vault, letter, { agent: AGENT, now: NOW });
    expect(readDeadLetter(vault, letter.id)).not.toBeNull();
  });
});

describe("the lane guard", () => {
  test("the lane union has exactly the member this build recovers", () => {
    expect(DEAD_LETTER_LANES).toEqual(["extract-signals"]);
    expect(isDeadLetterLane("extract-signals")).toBe(true);
    expect(isDeadLetterLane("time-machine")).toBe(false);
  });
});
