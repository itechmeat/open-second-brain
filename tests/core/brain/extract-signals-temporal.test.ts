/**
 * Extract date grounding reaches the dream temporal window
 * (near-duplicate-defense, C5). Claims pinned here:
 *
 *  1. An extract payload whose principle carries an ISO interval lands a
 *     signal whose principle keeps the interval verbatim; the extract lane
 *     writes no `valid_from` / `valid_until` of its own.
 *  2. A dream pass over those signals derives `valid_from` and
 *     `valid_until` through the existing temporal extraction - no parser
 *     lives in the extract lane.
 *  3. The envelope tells the caller to write an end-only bound as an
 *     interval, because the dream pass reads a lone ISO date as the day a
 *     rule STARTS: an end bound written as a lone date would invert it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import {
  commitExtractedSignals,
  planExtractSignals,
} from "../../../src/core/brain/extract-signals.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { preferencePath } from "../../../src/core/brain/paths.ts";
import { parsePreference } from "../../../src/core/brain/preference.ts";
import { importSessionRecall } from "../../../src/core/brain/session-recall.ts";
import { parseSignal } from "../../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

const TOPIC = "release-freeze";
const INTERVAL = "2026-10-10/2026-10-20";
const NOW = new Date("2026-10-07T12:00:00Z");

/**
 * Three sessions, one rule each: the dream pass promotes a topic once
 * three signals agree, and one payload may not repeat a topic. The
 * principles differ in wording so the dedup index keeps all three.
 */
const SESSIONS: ReadonlyArray<{ id: string; principle: string }> = [
  { id: "sess-a", principle: `Freeze merges to the release branch during ${INTERVAL}.` },
  { id: "sess-b", principle: `Hold every release-branch merge during ${INTERVAL}.` },
  { id: "sess-c", principle: `Merge nothing into the release branch during ${INTERVAL}.` },
];

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-extract-temporal-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-extract-temporal-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  SESSIONS.forEach((session, index) => {
    importSessionRecall(vault, {
      sessionId: session.id,
      turns: [
        {
          turnId: "t1",
          timestamp: `2026-10-0${index + 1}T09:00:00Z`,
          role: "user",
          text: "No release-branch merges from the 10th to the 20th.",
        },
      ],
      createdAt: NOW.toISOString(),
    });
  });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function commit(session: { id: string; principle: string }) {
  return commitExtractedSignals(
    vault,
    session.id,
    {
      items: [{ topic: TOPIC, signal: "negative", principle: session.principle, confidence: 0.9 }],
    },
    { agent: "tester", now: NOW, writeApprovalEnabled: false },
  );
}

test("an ISO interval in an extracted principle becomes the dream validity window", () => {
  for (const session of SESSIONS) {
    const res = commit(session);
    expect(res.written).toHaveLength(1);
    const signal = parseSignal(res.written[0]!.path);
    expect(signal.principle).toContain(INTERVAL);
    // The extract lane grounds the date in the text and nothing else.
    expect(signal.valid_from).toBeUndefined();
    expect(signal.valid_until).toBeUndefined();
  }

  const summary = dream(vault, { now: NOW });
  expect(summary.new_unconfirmed).toContain(`pref-${TOPIC}`);
  const pref = parsePreference(preferencePath(vault, TOPIC));
  expect(pref.valid_from).toBe("2026-10-10T00:00:00Z");
  expect(pref.valid_until).toBe("2026-10-20T00:00:00Z");
});

test("the envelope asks for an end-only bound as an interval, never a lone date", () => {
  const plan = planExtractSignals(vault, SESSIONS[0]!.id, { now: NOW });
  const head = plan.llmStep.prompt.slice(0, plan.llmStep.prompt.indexOf("\n\n"));
  expect(head).toContain("YYYY-MM-DD/YYYY-MM-DD");
  expect(head).toContain("a lone date reads as the day the rule starts");
});
