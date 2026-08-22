/**
 * Needs-llm-step envelope spine (salience-lifecycle-enrichment, unit 0).
 *
 * Three shapes already speak this grammar - the durable write-session
 * envelope, the diarization step, the rollup envelope - and until now none
 * of them named it. The spine names it once. What this suite pins:
 *
 *  1. The spine field set is exactly `status`, `step`, `prompt`,
 *     `schema_hints`, `target_path`: the intersection of the three, and
 *     nothing beyond it. A field only two of them carry is not spine.
 *  2. `buildNeedsLlmStep` stamps the status literal itself, so no
 *     construction site can spell it a fourth way - including a fields
 *     object that carries a `status` of its own at runtime.
 *  3. The built envelope is frozen and owns its hint list: the array the
 *     caller passed cannot mutate the envelope afterwards.
 *  4. Key order of the built object is `status` first, then the caller's
 *     fields in declaration order - the serialized shape the CLI and MCP
 *     surfaces already emit for these envelopes.
 *  5. A blank step, prompt, or target_path is refused by name; an empty
 *     hint list is legal (a step can genuinely carry no hints).
 *  6. Adoption is type-level and additive: the diarization step and the
 *     rollup envelope ARE the spine, and the durable `WriteSessionEnvelope`
 *     still carries every spine field with the same names and types.
 *  7. Adoption changed no bytes: a rollup envelope serializes exactly as it
 *     did before the spine landed, key order included, and the diarization
 *     step's key order is unchanged.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { diarize } from "../../../src/core/brain/diarization.ts";
import { upsertEntity } from "../../../src/core/brain/entities/registry.ts";
import {
  buildNeedsLlmStep,
  LlmStepError,
  NEEDS_LLM_STEP,
  NEEDS_LLM_STEP_KEYS,
  type LlmStepFields,
  type NeedsLlmStep,
} from "../../../src/core/brain/llm-step.ts";
import { planRollupLadder } from "../../../src/core/brain/rollup-ladder.ts";
import type { WriteSessionEnvelope } from "../../../src/core/brain/write-session/types.ts";

const RUN_ID = "dream-2026-07-19-100000";
const NOW = new Date("2026-07-19T10:00:00Z");

/**
 * The rollup envelope exactly as it serialized before the spine existed,
 * captured from the ladder on the parent commit. Byte-for-byte, key order
 * included - this envelope crosses the CLI and MCP boundaries as JSON.
 */
const ROLLUP_ENVELOPE_JSON_BEFORE_SPINE =
  '{"status":"needs-llm-step","step":"rollup:fact","tier":"fact","produces":"rollup",' +
  '"prompt":"Consolidate the 5 new fact items since the last rollup into one rollup-tier ' +
  'summary note. Cite the items you fold in; submit the full note.",' +
  '"schema_hints":["frontmatter: required YAML block with at least a `kind` key",' +
  '"tier: rollup (the rollup\'s tier weight)"],' +
  '"target_path":"Brain/rollups/rollup-rollup-dream-2026-07-19-100000.md"}';

/** Compile-time pin: anything passed here carries the whole spine. */
function acceptsSpine(_envelope: NeedsLlmStep): void {}
/** Compile-time pin: anything passed here carries the spine's payload fields. */
function acceptsSpineFields(_fields: LlmStepFields): void {}

function fired() {
  const plan = planRollupLadder({
    factCount: 5,
    ledger: null,
    thresholds: { fact: 5, identity: 2 },
    runId: RUN_ID,
  });
  return plan.entries[0]!.envelope;
}

test("the spine field set is the intersection of the shapes that already speak the grammar", () => {
  expect([...NEEDS_LLM_STEP_KEYS]).toEqual([
    "status",
    "step",
    "prompt",
    "schema_hints",
    "target_path",
  ]);
  const built = buildNeedsLlmStep({
    step: "s",
    prompt: "p",
    schema_hints: [],
    target_path: "Brain/x.md",
  });
  // The constant cannot drift from the builder's own output.
  expect(Object.keys(built)).toEqual([...NEEDS_LLM_STEP_KEYS]);
});

test("the builder stamps the status literal and freezes what it returns", () => {
  const built = buildNeedsLlmStep({
    step: "profile-prose",
    prompt: "Write the prose.",
    schema_hints: ["body: replace only the marker"],
    target_path: "Brain/profiles/ent-person-ada.md",
  });
  expect(built.status).toBe(NEEDS_LLM_STEP);
  expect(NEEDS_LLM_STEP).toBe("needs-llm-step");
  expect(Object.isFrozen(built)).toBe(true);
  expect(Object.isFrozen(built.schema_hints)).toBe(true);
});

test("the envelope owns its hint list: mutating the caller's array cannot reach it", () => {
  const hints = ["body: replace only the marker"];
  const built = buildNeedsLlmStep({
    step: "profile-prose",
    prompt: "Write the prose.",
    schema_hints: hints,
    target_path: "Brain/profiles/ent-person-ada.md",
  });
  hints.push("smuggled");
  expect(built.schema_hints).toEqual(["body: replace only the marker"]);
});

test("status leads the key order and the caller's extra fields keep their place", () => {
  const built = buildNeedsLlmStep({
    step: "rollup:fact",
    tier: "fact",
    produces: "rollup",
    prompt: "Consolidate.",
    schema_hints: ["tier: rollup"],
    target_path: "Brain/rollups/r.md",
  });
  expect(Object.keys(built)).toEqual([
    "status",
    "step",
    "tier",
    "produces",
    "prompt",
    "schema_hints",
    "target_path",
  ]);
});

test("a runtime status on the caller's fields cannot displace the stamped literal", () => {
  // The type forbids this; a payload assembled at runtime - a spread of a
  // wider record, a parsed object - does not go through the type.
  const hostile = {
    status: "done",
    step: "profile-prose",
    prompt: "Write the prose.",
    schema_hints: ["a hint"],
    target_path: "Brain/profiles/p.md",
  } as unknown as LlmStepFields;
  const built = buildNeedsLlmStep(hostile);
  expect(built.status).toBe(NEEDS_LLM_STEP);
  // And it does not reappear later in the object either.
  expect(Object.keys(built)).toEqual([...NEEDS_LLM_STEP_KEYS]);
});

test("a blank step, prompt, or target path is refused by name", () => {
  const base = {
    step: "profile-prose",
    prompt: "Write the prose.",
    schema_hints: ["a hint"],
    target_path: "Brain/profiles/p.md",
  };
  expect(() => buildNeedsLlmStep({ ...base, step: "  " })).toThrow(LlmStepError);
  expect(() => buildNeedsLlmStep({ ...base, step: "  " })).toThrow(/step/);
  expect(() => buildNeedsLlmStep({ ...base, prompt: "" })).toThrow(/prompt/);
  expect(() => buildNeedsLlmStep({ ...base, target_path: "\t" })).toThrow(/target_path/);
  // A step with nothing to hint at is legal.
  expect(buildNeedsLlmStep({ ...base, schema_hints: [] }).schema_hints).toEqual([]);
});

test("the rollup envelope is the spine, and serializes as it did before adoption", () => {
  const envelope = fired();
  acceptsSpine(envelope);
  acceptsSpineFields(envelope);
  expect(JSON.stringify(envelope)).toBe(ROLLUP_ENVELOPE_JSON_BEFORE_SPINE);
  for (const key of NEEDS_LLM_STEP_KEYS) expect(Object.hasOwn(envelope, key)).toBe(true);
});

test("the durable write-session envelope still carries every spine field", () => {
  const envelope: WriteSessionEnvelope = {
    status: "needs-llm-step",
    session_id: "ws-1",
    kind: "artifact",
    step: "artifact",
    prompt: "Write the note.",
    schema_hints: ["frontmatter: kind"],
    errors: [],
    attempts_left: 3,
    expires_at: "2026-07-20T10:00:00Z",
    target_path: "Brain/notes/n.md",
    existing: null,
  };
  // The superset keeps its own fields; only the spine payload is shared,
  // because its `status` widens to the full session-status union.
  acceptsSpineFields(envelope);
  for (const key of NEEDS_LLM_STEP_KEYS) expect(Object.hasOwn(envelope, key)).toBe(true);
});

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-llm-step-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  upsertEntity(vault, {
    category: "person",
    name: "Ada Lovelace",
    agent: "test",
    now: NOW,
    body: "Ada Lovelace designed an early programming method.",
  });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("the diarization step is the spine, with its key order unchanged", () => {
  const report = diarize(vault, { query: "Ada Lovelace" }, { now: NOW });
  acceptsSpine(report.llmStep);
  expect(Object.keys(report.llmStep)).toEqual([
    "status",
    "step",
    "prompt",
    "schema_hints",
    "target_path",
  ]);
  expect(report.llmStep.status).toBe(NEEDS_LLM_STEP);
});
