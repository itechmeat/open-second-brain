/**
 * Prompt-prefix metric wiring (Hindsight brain-loop ops, t_d8c1f7d9).
 *
 * The genuine multi-call generation pass in Open Second Brain is the
 * decision panel: every persona step and the synthesis lead with the
 * same `Decision topic:` frame, so the pass is byte-stable by
 * construction. A context-pack consume is a single-call pass over its
 * stable request preamble. Both routes:
 *   - keep the default output byte-identical (no metric, no option), and
 *   - emit exactly one run-level `prompt_prefix` record when opted in.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openPanelSession,
  submitToPanelSession,
} from "../../../src/core/brain/write-session/panel.ts";
import { DEFAULT_PERSONAS } from "../../../src/core/brain/write-session/personas.ts";
import { packContext } from "../../../src/core/brain/context-pack.ts";
import { listMetrics, METRICS_SCHEMA_VERSION } from "../../../src/core/brain/metrics.ts";
import { PROMPT_PREFIX_SURFACE } from "../../../src/core/brain/prompt-prefix.ts";

const NOW = "2026-06-04T10:00:00.000Z";
const TOPIC = "Adopt the new sync engine";
const PERSONA_TEXTS = [
  "Technically feasible with bounded effort.",
  "Strategically sound.",
  "Risk is acceptable.",
  "Users benefit immediately.",
];

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-prefix-metric-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function metricPath(): string {
  return join(vault, "Brain", "metrics", `${PROMPT_PREFIX_SURFACE}.jsonl`);
}

function openPanel() {
  return openPanelSession(vault, { agent: "fixture-agent", topic: TOPIC, now: NOW });
}

/** Drive the four persona steps; returns the synthesis-step envelope. */
function drivePersonas(sessionId: string) {
  let env;
  for (const text of PERSONA_TEXTS) {
    env = submitToPanelSession(vault, { sessionId, text, now: NOW });
  }
  return env!;
}

// ----- byte-identity (the default path is unchanged) -------------------------

test("the persona prompt is byte-identical to the pre-routing literal", () => {
  const env = openPanel();
  const p = DEFAULT_PERSONAS[0]!;
  const expected = `Decision topic: ${TOPIC}\n\nAnswer as the '${p.slug}' panelist (${p.lens}).\n${p.prompt}`;
  expect(env.prompt).toBe(expected);
});

test("the synthesis prompt keeps the shared prefix and synthesis tail", () => {
  const open = openPanel();
  const synth = drivePersonas(open.session_id);
  expect(synth.step).toBe("synthesis");
  const answers = DEFAULT_PERSONAS.map(
    (p, i) => `### ${p.lens} (${p.slug})\n${PERSONA_TEXTS[i]}`,
  ).join("\n\n");
  const expected =
    `Decision topic: ${TOPIC}\n\n` +
    `Every panelist has answered:\n\n${answers}\n\n` +
    "Synthesize the deliberation into a recommendation: state the decision, the strongest supporting argument per lens, the unresolved tensions, and the conditions that would reverse it.";
  expect(synth.prompt).toBe(expected);
});

test("committing a panel without the gate writes no prompt_prefix metric", () => {
  const open = openPanel();
  drivePersonas(open.session_id);
  const committed = submitToPanelSession(vault, {
    sessionId: open.session_id,
    text: "Adopt it under the stated guardrails.",
    now: NOW,
  });
  expect(committed.status).toBe("done");
  expect(existsSync(metricPath())).toBe(false);
});

// ----- opt-in emission -------------------------------------------------------

test("a panel pass with the gate on writes one run-level prompt_prefix record", () => {
  const open = openPanel();
  drivePersonas(open.session_id);
  const committed = submitToPanelSession(vault, {
    sessionId: open.session_id,
    text: "Adopt it under the stated guardrails.",
    now: NOW,
    promptPrefixMetric: true,
  });
  expect(committed.status).toBe("done");

  const lines = readFileSync(metricPath(), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  expect(lines).toHaveLength(1);
  const record = JSON.parse(lines[0]!);
  expect(record.schema).toBe(METRICS_SCHEMA_VERSION);
  expect(record.surface).toBe(PROMPT_PREFIX_SURFACE);
  expect(record.payload.kind).toBe("write_session");
  // Four personas + synthesis, all sharing the same topic prefix.
  expect(record.payload.call_count).toBe(DEFAULT_PERSONAS.length + 1);
  expect(record.payload.stable_count).toBe(DEFAULT_PERSONAS.length + 1);
  expect(record.payload.prefix_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(record.payload.prefix_chars).toBe([...`Decision topic: ${TOPIC}\n\n`].length);
});

test("context-pack default path is byte-identical and writes no metric", () => {
  writeFileSync(
    join(vault, "Brain", "preferences", "pref-x.md"),
    ["---", "id: pref-x", "topic: T", "principle: P", "tier: core", "---", "", "body"].join("\n"),
  );
  const baseline = packContext(vault, { maxTokens: 1000, query: "T" });
  const again = packContext(vault, { maxTokens: 1000, query: "T" });
  expect(again).toEqual(baseline);
  expect(existsSync(metricPath())).toBe(false);
});

test("context-pack with the gate on emits a single-call prompt_prefix pass", () => {
  writeFileSync(
    join(vault, "Brain", "preferences", "pref-x.md"),
    ["---", "id: pref-x", "topic: T", "principle: P", "tier: core", "---", "", "body"].join("\n"),
  );
  const withGate = packContext(vault, { maxTokens: 1000, query: "T", promptPrefix: true });
  const withoutGate = packContext(vault, { maxTokens: 1000, query: "T" });
  // The report itself is unchanged by the opt-in metric.
  expect(withGate).toEqual(withoutGate);

  const records = listMetrics(vault, { surface: PROMPT_PREFIX_SURFACE });
  expect(records).toHaveLength(1);
  expect(records[0]!.payload.kind).toBe("context_pack");
  expect(records[0]!.payload.call_count).toBe(1);
  expect(records[0]!.payload.stable_count).toBe(1);
});
