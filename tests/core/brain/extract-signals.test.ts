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
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTO_EXTRACT_CONFIDENCE_FLOOR,
  AUTO_EXTRACT_PER_SESSION_CAP,
  commitExtractedSignals,
  ExtractSignalsError,
  planExtractSignals,
} from "../../../src/core/brain/extract-signals.ts";
import { NEEDS_LLM_STEP } from "../../../src/core/brain/llm-step.ts";
import { ResponseCheckError } from "../../../src/core/brain/response-checks.ts";
import { ResponseShapeError } from "../../../src/core/brain/response-shape.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { importSessionRecall } from "../../../src/core/brain/session-recall.ts";
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
