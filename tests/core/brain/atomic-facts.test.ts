/**
 * Atomic-fact decomposition (t_cbd22536): deterministic, LLM-free
 * splitting of session/turn text into discrete single-sentence
 * assertions using markdown structure (heading context, list items,
 * sentence boundaries with an abbreviation guard), anchored to
 * canonical entities. Precision discipline mirrors fact-extract:
 * code, quotes, and frontmatter never produce assertions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  anchorEntityForms,
  decomposeAtomicFacts,
  MAX_ASSERTION_CHARS,
  type AtomicEntityLike,
} from "../../../src/core/brain/atomic-facts.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { writeFrontmatterAtomic } from "../../../src/core/vault.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { buildEntityIndex } from "../../../src/core/brain/entities/index-builder.ts";
import { buildAnchorables } from "../../../src/core/brain/fact-extract.ts";
import {
  __clearEntityLexiconCache,
  deriveEntityLexicon,
  resolveEntityLexicon,
  writeEntityLexicon,
} from "../../../src/core/brain/entities/lexicon.ts";

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

/**
 * Recall-quality A2: the store-learned lexicon gates the anchoring forms
 * the same way it gates creation. The only vocabulary in play is what a
 * corpus page teaches the artifact - nothing is hardcoded.
 */
describe("lexicon-gated anchoring (recall-quality A2)", () => {
  let vault: string;
  let configHome: string;
  const NOW = new Date("2026-10-11T12:00:00Z");

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-atomic-lexicon-"));
    configHome = mkdtempSync(join(tmpdir(), "o2b-atomic-lexicon-cfg-"));
    const configPath = join(configHome, "config.yaml");
    atomicWriteFileSync(configPath, `vault: ${vault}\n`);
    bootstrapBrain(vault, { configPath });
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
    __clearEntityLexiconCache();
  });

  /** Write an entity node by hand, bypassing the creation gate. */
  function seedEntityNode(id: string, name: string, aliases: string[]): void {
    const dir = join(brainDirs(vault).entities, "people");
    mkdirSync(dir, { recursive: true });
    writeFrontmatterAtomic(
      join(dir, `${id}.md`),
      {
        kind: "brain-entity",
        entity_id: id,
        category: "people",
        name,
        ...(aliases.length > 0 ? { aliases } : {}),
        status: "active",
        created_at: "2026-10-11T00:00:00Z",
        updated_at: "2026-10-11T00:00:00Z",
        tags: ["brain", "brain/entity"],
      },
      `# ${name}`,
      { overwrite: true },
    );
  }

  /** Teach the lexicon from one corpus page and rebuild the artifact. */
  function seedLexicon(corpus: string): void {
    atomicWriteFileSync(join(vault, "corpus-page.md"), `${corpus}\n`);
    writeEntityLexicon(vault, deriveEntityLexicon(vault, { now: NOW }));
  }

  /** A stored junk-run name with a valid alias, plus the taught artifact. */
  function seedJunkEntityWithValidAlias(): void {
    // The junk name is CASEFUL ("The Of And"): the pinned predicate runs
    // the case-based verdicts for caseful labels only, and an
    // all-lowercase label admits on the structural gate alone. Its
    // normalised form is still "the of and", so the matchable text is
    // unchanged.
    seedEntityNode("ent-people-junk", "The Of And", ["Atlas Prime"]);
    // "Of" appears capitalised once, which makes the corpus caseful while
    // keeping every taught token lowercase-dominant (a learned common word).
    seedLexicon("the of and the Of and.");
  }

  test("anchorEntityForms skips a lexicon-rejected junk form; opt-in only", () => {
    seedJunkEntityWithValidAlias();
    const handle = resolveEntityLexicon(vault);
    expect(handle).not.toBeNull();
    const forms = ["The Of And", "Atlas Prime"];
    const text = "Atlas Prime and the of and were recorded today.";
    expect(anchorEntityForms(text, forms, { lexicon: handle })).toEqual(["atlas prime"]);
    // Without a handle the gate is byte-identical to the pre-lexicon form.
    expect(anchorEntityForms(text, forms)).toEqual(["the of and", "atlas prime"]);
  });

  test("decomposeAtomicFacts anchors junk-named entities only on valid aliases", () => {
    seedJunkEntityWithValidAlias();
    seedEntityNode("ent-people-ada", "Ada", []);
    const entities: ReadonlyArray<AtomicEntityLike> = buildEntityIndex(vault).entities.map((e) => ({
      id: e.id,
      name: e.name,
      aliases: e.aliases,
      status: e.status,
    }));
    const handle = resolveEntityLexicon(vault);
    const out = decomposeAtomicFacts("Atlas Prime met Ada and the of and were recorded today.", {
      entities,
      lexicon: handle,
    });
    const anchored = out.find((a) => a.entities.includes("ent-people-junk"));
    expect(anchored).toBeDefined(); // the valid alias still anchors the node
    expect(anchored!.entities).toContain("ent-people-ada");
    // The junk form alone never anchors its node.
    const junkOnly = decomposeAtomicFacts("the of and were recorded today.", {
      entities,
      lexicon: handle,
    });
    expect(junkOnly.every((a) => !a.entities.includes("ent-people-junk"))).toBe(true);
  });

  test("buildAnchorables keeps the alias forms and drops the junk name form", () => {
    seedJunkEntityWithValidAlias();
    const anchorables = buildAnchorables(vault, buildEntityIndex(vault), "test-agent", NOW);
    expect(anchorables).toHaveLength(1);
    expect(anchorables[0]!.id).toBe("ent-people-junk");
    expect(anchorables[0]!.forms).toEqual(["atlas prime"]);
  });
});
