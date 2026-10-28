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
import { computeDedupHash } from "../../../src/core/brain/dedup-hash.ts";
import { redactRawOutput } from "../../../src/core/redactor.ts";
import { DURABILITY_DENYLIST_ENV_KEY } from "../../../src/core/brain/gates/durability.ts";
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

/**
 * A schema-2 letter frozen the way the extractor now freezes one: each
 * item's free-text fields redacted, the RAW text's dedup hash stored
 * beside it (`dead-letter.test.ts` pins the freeze itself; the tests
 * below pin what recovery reads out of that shape).
 */
function frozenLetter(
  items: ReadonlyArray<ExtractedSignalItem>,
  missingKeys: ReadonlyArray<string>,
): DeadLetterRecord {
  return recordDeadLetter(vault, {
    envelope: ENVELOPE,
    report: report(items.length, missingKeys),
    firstError: "EIO: i/o error",
    now: NOW,
    payload: {
      items: items.map((entry) => {
        const scope = entry.scope?.trim();
        return {
          topic: entry.topic,
          signal: entry.signal,
          principle: redactRawOutput(entry.principle),
          confidence: entry.confidence,
          ...(scope !== undefined && scope !== "" ? { scope: redactRawOutput(scope) } : {}),
          dedup_hash: computeDedupHash({
            topic: entry.topic,
            signal: entry.signal,
            principle: entry.principle,
            ...(scope !== undefined && scope !== "" ? { scope } : {}),
          }),
        };
      }),
    },
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

  test("a frozen item's stored hash is the raw identity: the same content delivered later reads as delivered", () => {
    // The freeze redacts the frozen principle, so a hash recomputed from
    // the frozen fields is NOT the identity the original delivery would
    // have carried. The raw-text hash stored beside the item is: a later
    // delivery of the same raw content - here by another session, which
    // the session-scoped topic measure deliberately cannot see - is
    // recognised, and the letter reads resolved instead of promising a
    // re-run that would only duplicate what is already on disk.
    const raw = "Use token password=hunter2secret when scraping.";
    const letter = frozenLetter(
      [item({ topic: "scraping-auth", principle: raw })],
      ["items[0]:scraping-auth"],
    );
    commitExtractedSignals(
      vault,
      "sess-other-delivery",
      { items: [item({ topic: "scraping-auth", principle: raw })] },
      { agent: AGENT, now: NOW },
    );
    const c = classifyDeadLetter(vault, letter);
    expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.resolved);
    expect(c.command).toBeNull();
  });

  test("a v2 item the session re-delivered by re-extracting reads as delivered", () => {
    // The operator mined the session again (the `re-extract` route the
    // write error names) and the model REWORDED the principle: the exact
    // content hash never matches, and reading the item undelivered made
    // the apply replay the stale wording as a second release-theme signal
    // on the same session. The topic is the delivery evidence a v1 letter
    // always had; a v2 item counts it too.
    commitExtractedSignals(
      vault,
      SESSION,
      {
        items: [
          item({ topic: "release-theme", principle: "Lead every release note with the theme." }),
        ],
      },
      { agent: AGENT, now: NOW },
    );
    const letter = v2Letter(
      [item({ topic: "release-theme", principle: "Name the release theme in the heading." })],
      ["items[0]:release-theme"],
    );
    const c = classifyDeadLetter(vault, letter);
    expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.resolved);
    expect(c.command).toBeNull();
    // ...and the apply writes nothing - the stale wording is not replayed.
    const inbox = join(vault, "Brain", "inbox");
    const before = existsSync(inbox) ? readdirSync(inbox).length : 0;
    expect(() => applyRecovery(vault, letter, { agent: AGENT, now: NOW })).toThrow(
      DeadLetterRecoveryError,
    );
    expect(existsSync(inbox) ? readdirSync(inbox).length : 0).toBe(before);
  });

  test("a re-extracted item is left out of the plan and the apply, not replayed as a duplicate", () => {
    // Same delivery shape as above, with a second item still missing: the
    // re-extracted one is delivered (by topic) and must not be handed
    // back to the commit - its frozen wording would land as a SECOND
    // release-theme page - while the genuinely missing one still writes.
    commitExtractedSignals(
      vault,
      SESSION,
      {
        items: [
          item({ topic: "release-theme", principle: "Lead every release note with the theme." }),
        ],
      },
      { agent: AGENT, now: NOW },
    );
    const letter = v2Letter(
      [
        item({ topic: "release-theme", principle: "Name the release theme in the heading." }),
        item({ topic: "module-names" }),
      ],
      ["items[0]:release-theme", "items[1]:module-names"],
    );
    expect(classifyDeadLetter(vault, letter).category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.recover);
    const plan = planRecovery(vault, letter);
    expect(plan.items.map((i) => i.topic)).toEqual(["module-names"]);
    const res = applyRecovery(vault, letter, { agent: AGENT, now: NOW });
    expect(res.written.map((w) => w.topic)).toEqual(["module-names"]);
    const pages = readdirSync(join(vault, "Brain", "inbox"));
    expect(pages.filter((p) => p.includes("release-theme"))).toHaveLength(1);
  });

  test("a letter whose undelivered items the durability gate refuses classifies not_recoverable", () => {
    // A denylisted item never reaches disk, so the dedup index never
    // shows it delivered: the letter used to read `recover` forever and
    // every apply reported success over zero writes. The classifier runs
    // the same gate over the undelivered items and names the state
    // honestly instead.
    const letter = v2Letter(
      [item({ topic: "scratch-pad", principle: "temporary scratch note" })],
      ["items[0]:scratch-pad"],
    );
    process.env[DURABILITY_DENYLIST_ENV_KEY] = "scratch";
    try {
      const c = classifyDeadLetter(vault, letter);
      expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.notRecoverable);
      expect(c.reason).toContain("durability");
      expect(c.reason).toContain("denylisted");
      expect(c.command).toBeNull();
      expect(() => planRecovery(vault, letter)).toThrow(DeadLetterRecoveryError);
      expect(() => applyRecovery(vault, letter, { agent: AGENT, now: NOW })).toThrow(
        DeadLetterRecoveryError,
      );
    } finally {
      delete process.env[DURABILITY_DENYLIST_ENV_KEY];
    }
  });

  test("a letter with one refused and one writable item stays recover - the writable one still writes", () => {
    // The refusal answer is for letters whose EVERY undelivered item is
    // refused; a mixed letter keeps the recover exit, and the apply
    // writes the writable item and names the refused one.
    const letter = v2Letter(
      [
        item({ topic: "module-names" }),
        item({ topic: "scratch-pad", principle: "temporary scratch note" }),
      ],
      ["items[0]:module-names", "items[1]:scratch-pad"],
    );
    process.env[DURABILITY_DENYLIST_ENV_KEY] = "scratch";
    try {
      expect(classifyDeadLetter(vault, letter).category).toBe(
        DEAD_LETTER_RECOVERY_CATEGORY.recover,
      );
      const res = applyRecovery(vault, letter, { agent: AGENT, now: NOW });
      expect(res.written.map((w) => w.topic)).toEqual(["module-names"]);
      expect(res.durabilityRejected).toBe(1);
      expect(res.rejected[0]?.reason).toContain("denylisted");
    } finally {
      delete process.env[DURABILITY_DENYLIST_ENV_KEY];
    }
  });

  test("a missing key the frozen payload cannot resolve classifies not_recoverable, by name", () => {
    // The key names an index the payload does not carry: a hand-edited,
    // truncated or foreign letter. Counting the key undelivered would
    // classify `recover`, and the apply would then re-run an empty plan
    // and report success over a write that never happened.
    const letter = v2Letter([item()], ["items[3]:release-notes-style"]);
    const c = classifyDeadLetter(vault, letter);
    expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.notRecoverable);
    expect(c.reason).toContain("items[3]:release-notes-style");
    expect(c.command).toBeNull();
  });

  test("a missing key naming another item's topic classifies not_recoverable too", () => {
    // The index exists, but the key's topic is not that item's own: the
    // letter does not vouch for the item, so replaying it would be a
    // guess at which content was lost.
    const letter = v2Letter([item()], ["items[0]:module-names"]);
    const c = classifyDeadLetter(vault, letter);
    expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.notRecoverable);
    expect(c.reason).toContain("items[0]:module-names");
  });

  test("a repeated missing key is a hand-edit and refuses, never double-counts", () => {
    // The commit's own report builder refuses duplicate keys, so a
    // letter with a repeated key on disk is a hand-edit - exactly the
    // input this module must not guess over. The same key twice used to
    // count its item twice: a letter with one real missing item read
    // resolved (both "keys" on disk), and the apply handed the commit
    // the same item twice. The refusal names the repetition as the
    // cause - the key names a real item, it just names it twice - on
    // the classifier and on the plan and apply that lean on it.
    const letter = v2Letter(
      [item(), item({ topic: "module-names" })],
      ["items[0]:release-notes-style"],
    );
    const path = deadLetterPath(vault, letter.id);
    const body = JSON.parse(readFileSync(path, "utf8")) as { missing: string[] };
    body.missing = ["items[0]:release-notes-style", "items[0]:release-notes-style"];
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
    const handEdited = readDeadLetter(vault, letter.id);
    if (handEdited === null) throw new Error("the hand-edited fixture letter did not parse");
    const c = classifyDeadLetter(vault, handEdited);
    expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.notRecoverable);
    expect(c.reason).toContain("items[0]:release-notes-style");
    expect(c.reason).toContain("repeats an earlier key");
    expect(() => planRecovery(vault, handEdited)).toThrow(DeadLetterRecoveryError);
    expect(() => planRecovery(vault, handEdited)).toThrow(/repeats an earlier key/);
    expect(() => applyRecovery(vault, handEdited, { agent: AGENT, now: NOW })).toThrow(
      DeadLetterRecoveryError,
    );
    expect(() => applyRecovery(vault, handEdited, { agent: AGENT, now: NOW })).toThrow(
      /repeats an earlier key/,
    );
  });

  test("a zero-padded respelling of a missing key is the same hand-edit", () => {
    // items[00]:a parses to the same item as items[0]:a; an exact string
    // compare let the pair through and the v1 topic count read a
    // half-delivered letter resolved (both "keys" answered by the one
    // topic on disk). The keys compare in canonical form.
    commitExtractedSignals(vault, SESSION, { items: [item()] }, { agent: AGENT, now: NOW });
    const letter = v1Letter(["items[0]:release-notes-style", "items[1]:module-names"]);
    const path = deadLetterPath(vault, letter.id);
    const body = JSON.parse(readFileSync(path, "utf8")) as { missing: string[] };
    body.missing = ["items[0]:release-notes-style", "items[00]:release-notes-style"];
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
    const handEdited = readDeadLetter(vault, letter.id);
    if (handEdited === null) throw new Error("the hand-edited fixture letter did not parse");
    const c = classifyDeadLetter(vault, handEdited);
    expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.notRecoverable);
    expect(c.reason).toContain("repeats an earlier key");
  });

  test("one signal page answers one v1 key, not every key naming its topic", () => {
    // Two keys may name one topic - two payload items on one subject, a
    // shape a real commit can produce, or a hand-edit. One page on disk
    // answers ONE of them; counting the topic once per key read a
    // half-delivered letter resolved.
    commitExtractedSignals(vault, SESSION, { items: [item()] }, { agent: AGENT, now: NOW });
    const letter = v1Letter(["items[0]:release-notes-style", "items[1]:release-notes-style"]);
    const c = classifyDeadLetter(vault, letter);
    expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.reExtract);
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
  test("each MISSING item is labelled with the verdict the commit's own gates produce", () => {
    // `release-notes-style` landed before the failure and is not in the
    // letter's missing set, so the plan - the preview of exactly what
    // the apply would re-run - never labels it: replaying a delivered
    // item would resurrect it even if an operator removed it later.
    // `module-names` is missing and writable (write), `scratch-pad`
    // fails the denylist (refused).
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
      ["module-names", "write"],
      ["scratch-pad", "refused"],
    ]);
    expect(plan.items[1]?.reason).toContain("denylisted");
  });

  test("with write approval on, a writable item plans as staged", () => {
    const letter = v2Letter([item()], ["items[0]:release-notes-style"]);
    const plan = planRecovery(vault, letter, { writeApprovalEnabled: true });
    expect(plan.items[0]?.verdict).toBe("staged");
  });

  test("a plan refuses a missing key the payload cannot resolve", () => {
    // A plan over an unresolvable key set would list no items - a
    // forecast of nothing, one refusal away from an apply that reports
    // success over it.
    const letter = v2Letter([item()], ["items[2]:release-notes-style"]);
    expect(() => planRecovery(vault, letter)).toThrow(DeadLetterRecoveryError);
    expect(() => planRecovery(vault, letter)).toThrow(/items\[2\]:release-notes-style/);
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

  test("the apply re-runs only the missing items, never the delivered ones", () => {
    // Item 0 landed before the failure, so the letter's missing set
    // names item 1 alone. The operator then removes the delivered
    // signal; the letter stays recoverable (its MISSING item is not on
    // disk), and the re-run must resurrect nothing but that missing
    // item - replaying the removed one is the stale replay the module
    // promises can never happen.
    const commit = commitExtractedSignals(
      vault,
      SESSION,
      { items: [item()] },
      { agent: AGENT, now: NOW },
    );
    expect(commit.written).toHaveLength(1);
    const deliveredPath = join(vault, commit.written[0]!.path);
    const letter = v2Letter([item(), item({ topic: "module-names" })], ["items[1]:module-names"]);
    rmSync(deliveredPath, { force: true });
    expect(existsSync(deliveredPath)).toBe(false);
    expect(classifyDeadLetter(vault, letter).category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.recover);

    // The plan previews exactly the apply's input: the missing item.
    const plan = planRecovery(vault, letter);
    expect(plan.items.map((i) => i.topic)).toEqual(["module-names"]);

    const res = applyRecovery(vault, letter, { agent: AGENT, now: NOW });
    expect(res.written.map((w) => w.topic)).toEqual(["module-names"]);
    expect(existsSync(deliveredPath)).toBe(false);
  });

  test("a v1 letter is not resolved by another session's signal sharing the topic", () => {
    // The topic is the only identity a payload-less letter names, but
    // the delivery it asks about is THIS session's: a same-topic signal
    // committed by a different session confirms nothing about what this
    // session's commit delivered, and counting it would read a real
    // partial write as resolved.
    const other = commitExtractedSignals(
      vault,
      "sess-other-session",
      { items: [item({ topic: "module-names" })] },
      { agent: AGENT, now: NOW },
    );
    expect(other.written).toHaveLength(1);
    const letter = v1Letter(["items[0]:module-names"]);
    const c = classifyDeadLetter(vault, letter);
    expect(c.category).not.toBe(DEAD_LETTER_RECOVERY_CATEGORY.resolved);
    // A payload-less letter whose own session delivered nothing re-extracts.
    expect(c.category).toBe(DEAD_LETTER_RECOVERY_CATEGORY.reExtract);
  });

  test("apply refuses a letter that is not recoverable, naming the category", () => {
    const letter = v1Letter(["items[1]:module-names"]);
    expect(() => applyRecovery(vault, letter, { agent: AGENT, now: NOW })).toThrow(
      DeadLetterRecoveryError,
    );
    expect(() => applyRecovery(vault, letter, { agent: AGENT, now: NOW })).toThrow(/re-extract/);
  });

  test("a refusal carries the classification's own command, so the row stays actionable", () => {
    // A pending letter refuses both the plan and the apply; the refusal
    // names the exact command the classifier computed for the state, the
    // same copy-paste row the listing renders - an operator holding the
    // error alone should not have to re-derive the exit.
    const staged = commitExtractedSignals(
      vault,
      SESSION,
      { items: [item()] },
      { agent: AGENT, now: NOW, writeApprovalEnabled: true },
    );
    const letter = v2Letter([item(), item({ topic: "module-names" })], ["items[1]:module-names"]);
    const stagedId = staged.written[0]?.id ?? "never";
    expect(classifyDeadLetter(vault, letter).command).toBe(`o2b brain pending apply ${stagedId}`);
    expect(() => planRecovery(vault, letter)).toThrow(DeadLetterRecoveryError);
    expect(() => planRecovery(vault, letter)).toThrow(/o2b brain pending apply/);
    expect(() => planRecovery(vault, letter)).toThrow(new RegExp(stagedId));
    expect(() => applyRecovery(vault, letter, { agent: AGENT, now: NOW })).toThrow(
      DeadLetterRecoveryError,
    );
    expect(() => applyRecovery(vault, letter, { agent: AGENT, now: NOW })).toThrow(
      /o2b brain pending apply/,
    );
  });

  test("nothing in the apply deletes the letter", () => {
    const letter = v2Letter([item()], ["items[0]:release-notes-style"]);
    applyRecovery(vault, letter, { agent: AGENT, now: NOW });
    expect(readDeadLetter(vault, letter.id)).not.toBeNull();
  });

  test("an apply refuses a missing key the payload cannot resolve instead of writing nothing", () => {
    // The exact success-over-nothing shape: an unresolvable key set used
    // to classify `recover`, the apply re-ran an empty plan, and the
    // commit returned cleanly - a green exit over a write that never
    // happened. The refusal keeps the row's truth on the record.
    const letter = v2Letter([item()], ["items[1]:release-notes-style"]);
    expect(() => applyRecovery(vault, letter, { agent: AGENT, now: NOW })).toThrow(
      DeadLetterRecoveryError,
    );
    expect(() => applyRecovery(vault, letter, { agent: AGENT, now: NOW })).toThrow(
      /items\[1\]:release-notes-style/,
    );
    // Nothing was written under the letter's session either.
    expect(existsSync(join(vault, "Brain", "inbox"))).toBe(false);
  });
});

describe("the lane guard", () => {
  test("the lane union has exactly the member this build recovers", () => {
    expect(DEAD_LETTER_LANES).toEqual(["extract-signals"]);
    expect(isDeadLetterLane("extract-signals")).toBe(true);
    expect(isDeadLetterLane("time-machine")).toBe(false);
  });
});
