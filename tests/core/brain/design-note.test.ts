/**
 * One-shot design notes (salience-lifecycle-enrichment, unit 7,
 * t_c87644b4). Claims pinned here:
 *
 *  1. The grounding pass reads all three stores - tensions, decisions,
 *     truth projections - and matches them to the topic.
 *  2. A store with nothing in it is a NAMED empty grounding, never a
 *     failure and never an unexplained absence.
 *  3. Topic filtering is real: an unrelated record does not ground a note.
 *  4. The report carries exactly one needs-llm-step envelope.
 *  5. The cardinality check enforces EXACTLY ONE recommended alternative;
 *     zero and two-plus are both refused, and the refusal states the count.
 *  6. A validated note commits under `Brain/decisions/` with the panel
 *     siblings' filename shape, and a second commit for the same topic and
 *     day is refused rather than silently overwriting.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  commitDesignNote,
  DESIGN_NOTE_STORE,
  designNoteGrounding,
  planDesignNote,
} from "../../../src/core/brain/design-note.ts";
import { recordDecision } from "../../../src/core/brain/decisions/record.ts";
import { NEEDS_LLM_STEP } from "../../../src/core/brain/llm-step.ts";
import { ResponseCheckError } from "../../../src/core/brain/response-checks.ts";
import { ResponseShapeError } from "../../../src/core/brain/response-shape.ts";
import { appendClaimEvent } from "../../../src/core/brain/truth/store.ts";
import { persistTension } from "../../../src/core/brain/tensions.ts";

let vault: string;
const NOW = new Date("2026-08-22T10:00:00Z");
const TOPIC = "vector index storage";

function alternative(name: string, recommended: boolean): Record<string, unknown> {
  return {
    name,
    approach: `Store the index with ${name}.`,
    tradeoffs: `${name} trades write cost for read latency.`,
    recommended,
  };
}

function payload(...flags: ReadonlyArray<boolean>): Record<string, unknown> {
  return {
    title: "Where the vector index lives",
    alternatives: flags.map((recommended, i) => alternative(`option-${i}`, recommended)),
  };
}

/** Materialize one tension whose subject is the topic under study. */
function seedTension(): void {
  persistTension(
    vault,
    {
      aId: "pref-index-inside",
      bId: "pref-index-outside",
      subject: "vector index storage",
      jaccard: 0.7,
      aSign: "positive",
      bSign: "negative",
      aQuote: "Keep the vector index storage inside the vault.",
      bQuote: "Never keep the vector index storage inside the vault.",
      action: "ask_user",
    },
    { agent: "tester", now: NOW },
  );
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-design-note-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("an empty vault grounds the note in a NAMED emptiness, not a failure", () => {
  const grounding = designNoteGrounding(vault, TOPIC);
  expect(grounding.counts).toEqual({ tensions: 0, decisions: 0, truthSlots: 0, conflicts: 0 });
  expect([...grounding.emptyStores].toSorted()).toEqual(
    [DESIGN_NOTE_STORE.decisions, DESIGN_NOTE_STORE.tensions, DESIGN_NOTE_STORE.truth].toSorted(),
  );
  // The report is still produced, with its envelope.
  const report = planDesignNote(vault, TOPIC, { now: NOW, ownerScope: null });
  expect(report.llmStep.status).toBe(NEEDS_LLM_STEP);
  expect(report.grounding.emptyStores.length).toBe(3);
});

test("the grounding pass reads all three stores and matches them to the topic", () => {
  seedTension();
  recordDecision(vault, {
    title: "Vector index storage location",
    chosen: "Keep the index outside the vault",
    assumption: "Sync clients must not replicate a binary index",
    reviewDate: "2027-01-01",
    agent: "tester",
    now: NOW,
  });
  recordDecision(vault, {
    title: "Breakfast cereal ranking",
    chosen: "Muesli",
    assumption: "Nobody asked",
    reviewDate: "2027-01-01",
    agent: "tester",
    now: NOW,
  });
  appendClaimEvent(vault, {
    agent: "tester",
    entity: "vector index",
    aspect: "storage",
    value: "outside the vault",
    source: "[[notes/index.md]]",
    ts: NOW.toISOString(),
  });

  const grounding = designNoteGrounding(vault, TOPIC);
  expect(grounding.counts.tensions).toBeGreaterThanOrEqual(1);
  expect(grounding.decisions.map((d) => d.title)).toEqual(["Vector index storage location"]);
  expect(grounding.counts.truthSlots).toBeGreaterThanOrEqual(1);
  // Every store held something, so nothing is reported empty.
  expect(grounding.emptyStores).toEqual([]);
});

test("a populated store that matches nothing grounds nothing but is not reported empty", () => {
  recordDecision(vault, {
    title: "Breakfast cereal ranking",
    chosen: "Muesli",
    assumption: "Nobody asked",
    reviewDate: "2027-01-01",
    agent: "tester",
    now: NOW,
  });
  const grounding = designNoteGrounding(vault, TOPIC);
  expect(grounding.decisions).toEqual([]);
  expect(grounding.emptyStores).not.toContain(DESIGN_NOTE_STORE.decisions);
});

test("the report carries exactly one envelope, naming the note it will become", () => {
  const report = planDesignNote(vault, TOPIC, { now: NOW, ownerScope: null });
  expect(report.llmStep.step).toBe("design-note");
  expect(report.llmStep.target_path).toBe(report.targetPath);
  expect(report.targetPath).toBe("Brain/decisions/design-2026-08-22-vector-index-storage.md");
  expect(report.llmStep.prompt).toContain(TOPIC);
  expect(report.llmStep.schema_hints.length).toBeGreaterThan(0);
});

test("zero recommended alternatives is refused, and the refusal states the count", () => {
  let caught: unknown;
  try {
    commitDesignNote(vault, TOPIC, payload(false, false), { agent: "tester", now: NOW });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ResponseCheckError);
  expect((caught as Error).message).toContain("exactly one");
  expect((caught as Error).message).toContain("0");
});

test("two recommended alternatives is refused, and the refusal states the count", () => {
  let caught: unknown;
  try {
    commitDesignNote(vault, TOPIC, payload(true, true, false), { agent: "tester", now: NOW });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ResponseCheckError);
  expect((caught as Error).message).toContain("2");
});

test("a malformed alternative is refused by the shape layer", () => {
  expect(() =>
    commitDesignNote(
      vault,
      TOPIC,
      {
        title: "T",
        alternatives: [{ name: "a", approach: "  ", tradeoffs: "t", recommended: true }],
      },
      { agent: "tester", now: NOW },
    ),
  ).toThrow(ResponseShapeError);
});

test("exactly one recommended alternative commits the note under Brain/decisions", () => {
  const res = commitDesignNote(vault, TOPIC, payload(false, true), { agent: "tester", now: NOW });
  expect(res.path).toBe(
    join(vault, "Brain", "decisions", "design-2026-08-22-vector-index-storage.md"),
  );
  expect(existsSync(res.path)).toBe(true);
  const body = readFileSync(res.path, "utf8");
  expect(body).toContain("kind: brain-design-note");
  expect(body).toContain("topic: vector index storage");
  expect(body).toContain("option-1");
  expect(body).toContain("recommended");
});

test("a second note for the same topic and day is refused, never overwritten", () => {
  commitDesignNote(vault, TOPIC, payload(true), { agent: "tester", now: NOW });
  expect(() =>
    commitDesignNote(vault, TOPIC, payload(true), { agent: "tester", now: NOW }),
  ).toThrow(/design-2026-08-22-vector-index-storage/);
});
