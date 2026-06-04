/**
 * Atomic-fact decomposition (t_cbd22536): deterministic, LLM-free
 * splitting of session/turn text into discrete single-sentence
 * assertions using markdown structure (heading context, list items,
 * sentence boundaries with an abbreviation guard), anchored to
 * canonical entities. Precision discipline mirrors fact-extract:
 * code, quotes, and frontmatter never produce assertions.
 */

import { describe, expect, test } from "bun:test";

import {
  decomposeAtomicFacts,
  MAX_ASSERTION_CHARS,
  type AtomicEntityLike,
} from "../../../src/core/brain/atomic-facts.ts";

const ENTITIES: ReadonlyArray<AtomicEntityLike> = [
  { id: "ent-people-alice-mason", name: "Alice Mason", aliases: ["Alice"], status: "active" },
  { id: "ent-project-atlas", name: "Atlas", aliases: [], status: "active" },
];

describe("decomposeAtomicFacts", () => {
  test("empty and whitespace input decompose to nothing", () => {
    expect(decomposeAtomicFacts("")).toEqual([]);
    expect(decomposeAtomicFacts("   \n\n  ")).toEqual([]);
  });

  test("list items become individual assertions under their heading path", () => {
    const text = [
      "# Standup",
      "",
      "## Decisions",
      "",
      "- Alice Mason approves the deploy window for Atlas",
      "- The rollback plan stays unchanged for this release",
    ].join("\n");
    const out = decomposeAtomicFacts(text, { entities: ENTITIES });
    expect(out).toHaveLength(2);
    expect(out[0]!.text).toBe("Alice Mason approves the deploy window for Atlas");
    expect(out[0]!.headingPath).toEqual(["Standup", "Decisions"]);
    expect(out[0]!.kind).toBe("list_item");
    expect(out[0]!.entities).toEqual(["ent-people-alice-mason", "ent-project-atlas"]);
    expect(out[1]!.entities).toEqual([]);
  });

  test("prose paragraphs split into sentences", () => {
    const text =
      "The deploy window moved to Friday evening. Alice signed off on the change. " +
      "Nothing else in the runbook changed.";
    const out = decomposeAtomicFacts(text, { entities: ENTITIES });
    expect(out.map((a) => a.text)).toEqual([
      "The deploy window moved to Friday evening.",
      "Alice signed off on the change.",
      "Nothing else in the runbook changed.",
    ]);
    expect(out[1]!.entities).toEqual(["ent-people-alice-mason"]);
    expect(out[0]!.kind).toBe("sentence");
  });

  test("abbreviations and version numbers never split sentences", () => {
    const text =
      "The fix shipped in v0.42.0 e.g. the activation store now sweeps correctly. " +
      "Costs dropped to 3.5 USD per month.";
    const out = decomposeAtomicFacts(text);
    expect(out).toHaveLength(2);
    expect(out[0]!.text).toContain("e.g. the activation store");
    expect(out[1]!.text).toBe("Costs dropped to 3.5 USD per month.");
  });

  test("code blocks, inline code, quotes, and frontmatter are never assertions", () => {
    const text = [
      "---",
      "kind: note",
      "---",
      "",
      "> Quoted claim that must not extract.",
      "",
      "```",
      "Alice Mason inside a code fence.",
      "```",
      "",
      "Real statement about the `deploy` script behavior here.",
    ].join("\n");
    const out = decomposeAtomicFacts(text, { entities: ENTITIES });
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("Real statement about the script behavior here.");
    expect(out[0]!.entities).toEqual([]);
  });

  test("tiny fragments are dropped", () => {
    const out = decomposeAtomicFacts("Ok. Yes. The migration window opens on Monday morning.");
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("The migration window opens on Monday morning.");
  });

  test("line numbers point into the original input", () => {
    const text = [
      "# H",
      "",
      "First sentence lives here today.",
      "",
      "- A list item assertion",
    ].join("\n");
    const out = decomposeAtomicFacts(text);
    expect(out[0]!.line).toBe(3);
    expect(out[1]!.line).toBe(5);
  });

  test("assertions are capped in length", () => {
    const long = `The plan ${"very ".repeat(120)}long sentence about the rollout.`;
    const out = decomposeAtomicFacts(long);
    expect(out[0]!.text.length).toBeLessThanOrEqual(MAX_ASSERTION_CHARS);
  });

  test("deterministic: same input, deeply equal output", () => {
    const text = "# T\n\n- Alpha decided beta yesterday evening\n\nGamma follows delta now.";
    expect(decomposeAtomicFacts(text, { entities: ENTITIES })).toEqual(
      decomposeAtomicFacts(text, { entities: ENTITIES }),
    );
  });

  test("heading path resets correctly across sibling sections", () => {
    const text = [
      "# Root",
      "## A",
      "Statement under section A goes here.",
      "## B",
      "Statement under section B goes here.",
    ].join("\n");
    const out = decomposeAtomicFacts(text);
    expect(out[0]!.headingPath).toEqual(["Root", "A"]);
    expect(out[1]!.headingPath).toEqual(["Root", "B"]);
  });

  test("archived entities never anchor", () => {
    const out = decomposeAtomicFacts("Alice Mason approved the change for the team.", {
      entities: [{ ...ENTITIES[0]!, status: "archived" }],
    });
    expect(out[0]!.entities).toEqual([]);
  });
});
