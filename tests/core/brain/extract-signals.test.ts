/**
 * Model-mined session signals (salience-lifecycle-enrichment, unit 2,
 * t_1dace26d). Claims pinned here:
 *
 *  1. Phase one reads an ALREADY-IMPORTED session and returns a report
 *     carrying exactly one needs-llm-step envelope built on the spine.
 *  2. The prompt mines USER turns only, mirroring the import path's rule,
 *     and the envelope is deterministic for a fixed set of turns.
 *  3. A session with no imported turns, and one whose turns are all
 *     non-user, are refused BY NAME - never reported as an empty mine.
 *  4. A session the capture boundary ignores is refused by name.
 *  5. Phase two refuses an over-cap payload naming the cap and the count.
 *  6. Phase two refuses an under-floor item naming the floor and the value.
 *  7. A conforming payload writes `source_type: auto_extract` signals into
 *     `Brain/inbox/`, and each carries the session provenance.
 *  8. The durability denylist rejects items by name, never silently.
 *  9. Write approval on stages every accepted item into `Brain/pending/`
 *     instead, and writes nothing to the inbox.
 * 10. A repeated payload dedups against the signals already on disk.
 * 11. A write that fails PART WAY through the items is reported as the
 *     partial write it is: the error names the items already on disk and
 *     the one that failed, rather than leaving the caller to discover
 *     them.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTO_EXTRACT_CONFIDENCE_FLOOR,
  AUTO_EXTRACT_PER_SESSION_CAP,
  commitExtractedSignals,
  EXTRACT_SIGNALS_STEP,
  ExtractSignalsError,
  ExtractSignalsWriteError,
  planExtractSignals,
} from "../../../src/core/brain/extract-signals.ts";
import { listDeadLetters } from "../../../src/core/brain/dead-letter.ts";
import { NEEDS_LLM_STEP } from "../../../src/core/brain/llm-step.ts";
import {
  ResponseCheckError,
  SEMANTIC_VIOLATION_CODES,
} from "../../../src/core/brain/response-checks.ts";
import { ResponseShapeError } from "../../../src/core/brain/response-shape.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { importSessionRecall } from "../../../src/core/brain/session-recall.ts";
import type { DedupIndexEntry } from "../../../src/core/brain/dedup-hash.ts";
import { parseSignal } from "../../../src/core/brain/signal.ts";
import { BRAIN_SIGNAL_SOURCE_TYPE } from "../../../src/core/brain/types.ts";
import type { SessionTurn } from "../../../src/core/brain/sessions/types.ts";

let vault: string;
const NOW = new Date("2026-08-22T10:00:00Z");
const SESSION = "sess-alpha";

/**
 * Turns carry DISTINCT timestamps, as a real transcript does: the recall
 * store orders raw turns chronologically and falls back to the record hash
 * only for a tie, so a fixture that stamped one instant on every turn would
 * pin the tie-break rather than the chronology the prompt depends on.
 */
let turnClock = 0;
function turn(id: string, role: SessionTurn["role"], text: string): SessionTurn {
  turnClock += 1;
  const stamp = String(turnClock).padStart(2, "0");
  return { turnId: id, timestamp: `2026-08-22T09:${stamp}:00Z`, role, text };
}

function importTurns(sessionId: string, turns: ReadonlyArray<SessionTurn>): void {
  importSessionRecall(vault, { sessionId, turns, createdAt: NOW.toISOString() });
}

function inboxFiles(): string[] {
  const dir = join(vault, "Brain", "inbox");
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .toSorted()
    : [];
}

function pendingFiles(): string[] {
  const dir = join(vault, "Brain", "pending");
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .toSorted()
    : [];
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topic: "release-notes-style",
    signal: "positive",
    principle: "Name the release theme in the heading, never the ticket id.",
    confidence: 0.9,
    ...overrides,
  };
}

beforeEach(() => {
  turnClock = 0;
  vault = mkdtempSync(join(tmpdir(), "o2b-extract-signals-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  importTurns(SESSION, [
    turn("t1", "user", "Always name the release theme in the heading."),
    turn("t2", "assistant", "Understood - I will use the theme."),
    turn("t3", "user", "And never abbreviate the module names."),
  ]);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("phase one carries exactly one spine envelope over the user turns", () => {
  const plan = planExtractSignals(vault, SESSION, { now: NOW });
  expect(plan.sessionId).toBe(SESSION);
  expect(plan.turnsScanned).toBe(3);
  expect(plan.turnsMined.map((t) => t.turnId)).toEqual(["t1", "t3"]);
  expect(plan.llmStep.status).toBe(NEEDS_LLM_STEP);
  expect(plan.llmStep.prompt).toContain("Always name the release theme");
  // The assistant turn is not mining material.
  expect(plan.llmStep.prompt).not.toContain("Understood - I will use the theme");
  expect(plan.llmStep.schema_hints.length).toBeGreaterThan(0);
  expect(plan.llmStep.target_path).toBe("Brain/inbox");
  expect(plan.cap).toBe(AUTO_EXTRACT_PER_SESSION_CAP);
  expect(plan.confidenceFloor).toBe(AUTO_EXTRACT_CONFIDENCE_FLOOR);
});

test("the envelope is deterministic for a fixed set of turns", () => {
  const first = planExtractSignals(vault, SESSION, { now: NOW });
  const second = planExtractSignals(vault, SESSION, { now: NOW });
  expect(second.llmStep).toEqual(first.llmStep);
});

test("a session with no imported turns is refused by name", () => {
  expect(() => planExtractSignals(vault, "sess-missing", { now: NOW })).toThrow(
    ExtractSignalsError,
  );
  expect(() => planExtractSignals(vault, "sess-missing", { now: NOW })).toThrow(/sess-missing/);
});

test("a session whose turns are all non-user is refused by name", () => {
  importTurns("sess-quiet", [turn("q1", "assistant", "Only I spoke here.")]);
  expect(() => planExtractSignals(vault, "sess-quiet", { now: NOW })).toThrow(/user/);
});

test("a session the capture boundary ignores is refused by name", () => {
  bootstrapBrain(vault);
  const path = brainConfigPath(vault);
  atomicWriteFileSync(
    path,
    `${readFileSync(path, "utf8")}\nsessions:\n  ignore_patterns:\n    - "cron-*"\n`,
  );
  importTurns("cron-nightly", [turn("c1", "user", "Nightly cron chatter.")]);
  expect(() => planExtractSignals(vault, "cron-nightly", { now: NOW })).toThrow(/cron-nightly/);
  expect(() => planExtractSignals(vault, "cron-nightly", { now: NOW })).toThrow(/ignore/);
});

test("an over-cap payload is refused naming the cap and the count", () => {
  const overCap = AUTO_EXTRACT_PER_SESSION_CAP + 1;
  const items = Array.from({ length: overCap }, (_v, i) => item({ topic: `topic-${i}` }));
  let caught: unknown;
  try {
    commitExtractedSignals(vault, SESSION, { items }, { agent: "tester", now: NOW });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ResponseCheckError);
  expect((caught as Error).message).toContain(String(AUTO_EXTRACT_PER_SESSION_CAP));
  expect((caught as Error).message).toContain(String(overCap));
  expect(inboxFiles()).toEqual([]);
});

test("an under-floor item is refused naming the floor and the value", () => {
  const low = 0.11;
  let caught: unknown;
  try {
    commitExtractedSignals(
      vault,
      SESSION,
      { items: [item({ confidence: low })] },
      { agent: "tester", now: NOW },
    );
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ResponseCheckError);
  expect((caught as Error).message).toContain(String(AUTO_EXTRACT_CONFIDENCE_FLOOR));
  expect((caught as Error).message).toContain(String(low));
  expect(inboxFiles()).toEqual([]);
});

test("a structurally malformed payload is refused by the shape layer", () => {
  expect(() =>
    commitExtractedSignals(
      vault,
      SESSION,
      { items: [{ topic: "t", signal: "sideways", principle: "p", confidence: 0.9 }] },
      { agent: "tester", now: NOW },
    ),
  ).toThrow(ResponseShapeError);
  expect(inboxFiles()).toEqual([]);
});

test("a conforming payload writes auto_extract signals into the inbox", () => {
  const res = commitExtractedSignals(
    vault,
    SESSION,
    {
      items: [item(), item({ topic: "module-names", principle: "Never abbreviate module names." })],
    },
    { agent: "tester", now: NOW },
  );
  expect(res.written.length).toBe(2);
  expect(res.staged).toBe(0);
  const files = inboxFiles();
  expect(files.length).toBe(2);
  const body = readFileSync(join(vault, "Brain", "inbox", files[0]!), "utf8");
  expect(body).toContain(`source_type: ${BRAIN_SIGNAL_SOURCE_TYPE.autoExtract}`);
  expect(body).toContain(`session_ref: ${SESSION}`);
});

test("the durability denylist rejects an item by name rather than dropping it", () => {
  const res = commitExtractedSignals(
    vault,
    SESSION,
    { items: [item(), item({ topic: "noise", principle: "temporary scratch note" })] },
    {
      agent: "tester",
      now: NOW,
      durabilityDenylist: [/scratch/],
    },
  );
  expect(res.written.length).toBe(1);
  expect(res.rejected.map((r) => r.topic)).toEqual(["noise"]);
  expect(res.rejected[0]!.reason.length).toBeGreaterThan(0);
});

test("write approval on stages every item into pending and writes no inbox file", () => {
  const res = commitExtractedSignals(
    vault,
    SESSION,
    { items: [item()] },
    { agent: "tester", now: NOW, writeApprovalEnabled: true },
  );
  expect(res.staged).toBe(1);
  expect(pendingFiles().length).toBe(1);
  expect(inboxFiles()).toEqual([]);
});

test("a repeated payload dedups against the signals already on disk", () => {
  const payload = { items: [item()] };
  commitExtractedSignals(vault, SESSION, payload, { agent: "tester", now: NOW });
  const second = commitExtractedSignals(vault, SESSION, payload, { agent: "tester", now: NOW });
  expect(second.written.length).toBe(0);
  expect(second.deduped).toBe(1);
  expect(inboxFiles().length).toBe(1);
});

test("a mid-loop write failure names what is already on disk and what failed", () => {
  // The failing write is a real one, not a stub: `topic` becomes the
  // signal's slug and a colon is not a legal filename character, so the
  // second item cannot be written after the first already has been.
  const items = [item(), item({ topic: "module:names", principle: "Never abbreviate a module." })];
  let caught: unknown;
  try {
    commitExtractedSignals(vault, SESSION, { items }, { agent: "tester", now: NOW });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ExtractSignalsWriteError);
  const err = caught as ExtractSignalsWriteError;
  expect(err.topic).toBe("module:names");
  expect(err.written.map((w) => w.topic)).toEqual(["release-notes-style"]);
  expect(err.remaining).toBe(1);
  // The accounting is in the message too, for a caller that only logs it.
  expect(err.message).toContain(err.written[0]!.id);
  // The first item stayed on disk: this is a partial write, and saying so
  // is the whole point.
  expect(inboxFiles().length).toBe(1);
});

test("the new source_type round-trips and an unknown member is still refused", () => {
  const res = commitExtractedSignals(
    vault,
    SESSION,
    { items: [item()] },
    { agent: "tester", now: NOW },
  );
  const parsed = parseSignal(res.written[0]!.path);
  expect(parsed.source_type).toBe(BRAIN_SIGNAL_SOURCE_TYPE.autoExtract);
  // The vocabulary is still closed: the parser refuses a member nobody
  // declared, and names the whole legal set rather than a stale subset.
  const path = res.written[0]!.path;
  atomicWriteFileSync(
    path,
    readFileSync(path, "utf8").replace("source_type: auto_extract", "source_type: sideways"),
  );
  expect(() => parseSignal(path)).toThrow(/auto_extract/);
  expect(() => parseSignal(path)).toThrow(/sideways/);
});

// ----- Write accounting and the durable dead letter (unit E) ---------------
//
// 12. Every commit reports its write accounting in the wave's shared
//     reconciliation vocabulary - attempted / found / missing, the missing
//     keys NAMED - on the success path and on the refusal alike.
// 13. A commit that lands nothing does not read as a success: the accounting
//     says found 0, names every unwritten item, and carries the first real
//     error.
// 14. A partial write leaves a DURABLE dead letter naming the unwritten
//     items, so a caller that drops the response is not the only record of
//     it - and the error says where that record landed.

test("a completed commit reports its accounting in the shared vocabulary", () => {
  const res = commitExtractedSignals(
    vault,
    SESSION,
    { items: [item(), item({ topic: "no-abbrev", principle: "Never abbreviate a module name." })] },
    { agent: "tester", now: NOW },
  );
  expect(res.reconciliation).toEqual({ attempted: 2, found: 2, missing: [] });
  expect(listDeadLetters(vault)).toEqual([]);
});

test("a deduped or gate-rejected item is not counted as an attempted write", () => {
  // Both are deliberate skips the result already names; folding them into
  // `missing` would report a refusal the lane made as a loss it suffered.
  const res = commitExtractedSignals(
    vault,
    SESSION,
    { items: [item(), item({ topic: "noise", principle: "temporary scratch note" })] },
    { agent: "tester", now: NOW, durabilityDenylist: [/scratch/] },
  );
  expect(res.reconciliation).toEqual({ attempted: 1, found: 1, missing: [] });
  expect(res.durabilityRejected).toBe(1);
});

test("a mid-loop write failure reports attempted, written and missing plus the first error", () => {
  const items = [item(), item({ topic: "module:names", principle: "Never abbreviate a module." })];
  let caught: unknown;
  try {
    commitExtractedSignals(vault, SESSION, { items }, { agent: "tester", now: NOW });
  } catch (err) {
    caught = err;
  }
  const err = caught as ExtractSignalsWriteError;
  expect(err).toBeInstanceOf(ExtractSignalsWriteError);
  expect(err.reconciliation.attempted).toBe(2);
  expect(err.reconciliation.found).toBe(1);
  expect(err.reconciliation.missing).toEqual(["items[1]:module:names"]);
  expect(err.firstError).toBeDefined();
});

test("a commit that lands nothing never reads as a success", () => {
  // The FIRST item fails, so nothing at all reaches disk.
  const items = [item({ topic: "module:names" }), item({ topic: "no-abbrev" })];
  let caught: unknown;
  try {
    commitExtractedSignals(vault, SESSION, { items }, { agent: "tester", now: NOW });
  } catch (err) {
    caught = err;
  }
  const err = caught as ExtractSignalsWriteError;
  expect(err).toBeInstanceOf(ExtractSignalsWriteError);
  expect(err.reconciliation.found).toBe(0);
  expect(err.reconciliation.attempted).toBe(2);
  expect(err.reconciliation.missing).toEqual(["items[0]:module:names", "items[1]:no-abbrev"]);
  expect(inboxFiles()).toEqual([]);
});

test("a partial write leaves a durable dead letter naming the unwritten items", () => {
  const items = [item(), item({ topic: "module:names", principle: "Never abbreviate a module." })];
  let caught: unknown;
  try {
    commitExtractedSignals(vault, SESSION, { items }, { agent: "tester", now: NOW });
  } catch (err) {
    caught = err;
  }
  const err = caught as ExtractSignalsWriteError;
  const letters = listDeadLetters(vault);
  expect(letters).toHaveLength(1);
  const letter = letters[0]!;
  expect(letter.lane).toBe("extract-signals");
  expect(letter.step).toBe(EXTRACT_SIGNALS_STEP);
  expect(letter.reference).toBe(SESSION);
  expect(letter.attempted).toBe(2);
  expect(letter.found).toBe(1);
  expect(letter.missing).toEqual(["items[1]:module:names"]);
  expect(letter.outcome).toBe("partial");
  expect(letter.first_error.length).toBeGreaterThan(0);
  // The response says where the durable record is, so a caller that keeps
  // the response can go straight to it.
  expect(err.deadLetter.recorded).toBe(true);
  if (err.deadLetter.recorded) expect(err.message).toContain(err.deadLetter.id);
});

// ----- Turn timestamps in the envelope (near-duplicate-defense, C1) --------
//
// 15. A mined turn carries the stored turn timestamp verbatim, and the
//     transcript line shows it as `[turnId @ <timestamp>] text`.
// 16. A turn stored without a timestamp renders `[turnId] text`; the plan's
//     clock is never substituted for the missing value.

test("a mined turn carries the stored timestamp verbatim into its transcript line", () => {
  const plan = planExtractSignals(vault, SESSION, { now: NOW });
  expect(plan.turnsMined.map((t) => t.timestamp)).toEqual([
    "2026-08-22T09:01:00Z",
    "2026-08-22T09:03:00Z",
  ]);
  expect(plan.llmStep.prompt).toContain(
    "[t1 @ 2026-08-22T09:01:00Z] Always name the release theme in the heading.",
  );
  expect(plan.llmStep.prompt).toContain(
    "[t3 @ 2026-08-22T09:03:00Z] And never abbreviate the module names.",
  );
  // Assistant turns stay out, timestamp or not.
  expect(plan.llmStep.prompt).not.toContain("[t2");
});

test("a turn without a stored timestamp renders bare and never borrows the clock", () => {
  importTurns("sess-undated", [
    { turnId: "u1", timestamp: "", role: "user", text: "Keep the changelog terse." },
  ]);
  const plan = planExtractSignals(vault, "sess-undated", { now: NOW });
  expect(plan.turnsMined.map((t) => t.timestamp)).toEqual([""]);
  expect(plan.llmStep.prompt).toContain("[u1] Keep the changelog terse.");
  expect(plan.llmStep.prompt).not.toContain("[u1 @");
  expect(plan.llmStep.prompt).not.toContain(NOW.toISOString());
});

// ----- Hygiene rules in the envelope (near-duplicate-defense, C2) ----------
//
// 17. The instruction carries five language-neutral rules: time bounds as
//     ISO dates or intervals, conversational mechanics skipped, one rule
//     per item, conditions kept, restatements dropped.
// 18. The rules name categories, never example words: the instruction and
//     the schema hints quote no phrase and stay ASCII, so no language's
//     vocabulary is baked into the kernel.

/** The instruction half of the prompt, everything before the transcript. */
function instruction(prompt: string): string {
  return prompt.slice(0, prompt.indexOf("\n\n"));
}

test("the envelope instruction carries the five hygiene rules", () => {
  const plan = planExtractSignals(vault, SESSION, { now: NOW });
  const head = instruction(plan.llmStep.prompt);
  expect(head).toContain("ISO 8601 date or interval");
  expect(head).toContain("timestamp of the turn");
  expect(head).toContain("conversational mechanics");
  expect(head).toContain("one rule per item");
  expect(head).toContain("condition");
  expect(head).toContain("restatement");
  expect(plan.llmStep.schema_hints.join("\n")).toContain("ISO 8601");
});

test("the hygiene rules name categories and quote no example words", () => {
  const plan = planExtractSignals(vault, SESSION, { now: NOW });
  const head = instruction(plan.llmStep.prompt);
  const hints = plan.llmStep.schema_hints.filter((hint) => !hint.startsWith("payload:"));
  for (const text of [head, ...hints]) {
    expect(text).not.toMatch(/"/);
    expect(text).toMatch(/^[\x20-\x7e]*$/);
  }
});

// ----- Duplicate-topic refusal (near-duplicate-defense, C3) -----------------
//
// 19. Two items sharing a `topic` refuse the payload whole under the
//     cross-item code, and the message names both indices and the topic.
// 20. The refusal lands before any write and before any item is hashed for
//     dedup, so a refused payload leaves the vault and the index untouched.

/** A dedup index that counts every keyed read; one read follows every hash. */
class CountingDedup extends Map<string, DedupIndexEntry> {
  lookups = 0;
  override has(key: string): boolean {
    this.lookups += 1;
    return super.has(key);
  }
  override get(key: string): DedupIndexEntry | undefined {
    this.lookups += 1;
    return super.get(key);
  }
}

test("a payload that repeats a topic is refused whole, naming both indices", () => {
  const dedup = new CountingDedup();
  const items = [
    item(),
    item({ topic: "module-names", principle: "Never abbreviate module names." }),
    item({ principle: "Put the release theme in the heading." }),
  ];
  let caught: unknown;
  try {
    commitExtractedSignals(vault, SESSION, { items }, { agent: "tester", now: NOW, dedup });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ResponseCheckError);
  const err = caught as ResponseCheckError;
  expect(err.code).toBe(SEMANTIC_VIOLATION_CODES.crossItem);
  expect(err.message).toContain('items[0] and items[2] share topic "release-notes-style"');
  expect(dedup.lookups).toBe(0);
  expect(dedup.size).toBe(0);
  expect(inboxFiles()).toEqual([]);
});

test("distinct topics pass the duplicate-topic rule", () => {
  const res = commitExtractedSignals(
    vault,
    SESSION,
    { items: [item(), item({ topic: "module-names", principle: "Never abbreviate modules." })] },
    { agent: "tester", now: NOW },
  );
  expect(res.written.map((w) => w.topic)).toEqual(["release-notes-style", "module-names"]);
});
