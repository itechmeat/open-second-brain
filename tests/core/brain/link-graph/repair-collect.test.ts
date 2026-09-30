/**
 * Candidate collection for the repair lane (G1, t_6832aac6). Candidates are
 * drawn from structural signals only - explicit textual references and session
 * continuity - never from a similarity model, and never for an edge that
 * already exists.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { appendContinuityRecord } from "../../../../src/core/brain/continuity/store.ts";
import {
  EXPLICIT_REFERENCE_CONFIDENCE,
  IDENTITY_STRENGTH,
  collectRepairCandidates,
  collectRepairCandidatesWithRefusals,
} from "../../../../src/core/brain/link-graph/repair-lane.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-repair-collect-"));
  bootstrapBrain(vault);
  mkdirSync(join(vault, "Notes"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(rel: string, body: string): void {
  const abs = join(vault, "Brain", "preferences", rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

/** Preference frontmatter declaring one shared alias, for collision cases. */
function aliasedPref(topic: string): string {
  return [
    "---",
    "kind: preference",
    `topic: ${topic}`,
    "status: confirmed",
    "principle: shared alias",
    "aliases: [downstream]",
    "---",
    "",
    "Body.",
  ].join("\n");
}

function writeNote(rel: string, title: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    ["---", "kind: brain-note", `title: ${title}`, "---", "", body, ""].join("\n"),
    "utf8",
  );
}

describe("collectRepairCandidates explicit references", () => {
  test("a note that names another note's title without linking it yields an explicit candidate", () => {
    writeNote("Notes/alpha.md", "Alpha", "This note discusses Beta in depth.");
    writeNote("Notes/beta.md", "Beta", "standalone");

    const candidates = collectRepairCandidates(vault);
    const explicit = candidates.find(
      (c) => c.strength === IDENTITY_STRENGTH.explicitReference && c.target.includes("beta"),
    );
    expect(explicit).toBeDefined();
    expect(explicit!.source).toContain("alpha");
  });

  test("a generic short title does not mass-generate explicit-reference candidates", () => {
    // "AI" is a two-letter title that recurs in prose across the vault. Below
    // MIN_EXPLICIT_REFERENCE_TITLE_LENGTH it must not seed 0.9-confidence edges.
    writeNote("Notes/essay.md", "Essay", "This whole essay is about AI and its many uses.");
    writeNote("Notes/ai.md", "AI", "standalone");

    const candidates = collectRepairCandidates(vault);
    expect(
      candidates.some(
        (c) => c.strength === IDENTITY_STRENGTH.explicitReference && c.target.includes("ai"),
      ),
    ).toBe(false);
  });

  test("an already-linked reference is not re-proposed", () => {
    writeNote("Notes/alpha.md", "Alpha", "See [[Notes/beta.md]] and Beta again.");
    writeNote("Notes/beta.md", "Beta", "standalone");

    const candidates = collectRepairCandidates(vault);
    expect(candidates.some((c) => c.source.includes("alpha") && c.target.includes("beta"))).toBe(
      false,
    );
  });
});

describe("collectRepairCandidates session continuity", () => {
  test("two notes co-referenced in one session event yield a continuity candidate", () => {
    writeNote("Notes/gamma.md", "Gamma", "standalone");
    writeNote("Notes/delta.md", "Delta", "standalone");
    appendContinuityRecord(vault, {
      kind: "recall_telemetry",
      createdAt: "2026-06-13T12:00:00Z",
      sourceRefs: [
        { id: "a", path: "Notes/gamma.md" },
        { id: "b", path: "Notes/delta.md" },
      ],
      payload: { host: "test" },
    });

    const candidates = collectRepairCandidates(vault);
    const continuity = candidates.find((c) => c.strength === IDENTITY_STRENGTH.sessionContinuity);
    expect(continuity).toBeDefined();
    expect(
      [continuity!.source, continuity!.target].every(
        (p) => p.includes("gamma") || p.includes("delta"),
      ),
    ).toBe(true);
  });
});

describe("collectRepairCandidatesWithRefusals - corpus-wide unique-match binding", () => {
  test("a title carried by two pages refuses the mention instead of binding to both", () => {
    writeNote("Notes/one.md", "Alpha", "Platform notes");
    writeNote("Notes/two.md", "Alpha", "More platform notes");
    writeNote("Notes/three.md", "Reader", "Reads Alpha every day.");

    const { candidates, refusals } = collectRepairCandidatesWithRefusals(vault);
    const bound = candidates.filter(
      (c) => c.strength === IDENTITY_STRENGTH.explicitReference && c.source.includes("three"),
    );
    expect(bound).toEqual([]);
    expect(refusals.map((r) => [r.source, r.target, r.action])).toEqual([
      [expect.stringContaining("three"), expect.stringContaining("one"), "skip-ambiguous"],
      [expect.stringContaining("three"), expect.stringContaining("two"), "skip-ambiguous"],
    ]);
    expect(refusals.every((r) => r.reason.includes("Alpha"))).toBe(true);
  });

  test("a source sharing the ambiguous title refuses only the other carrier, never itself", () => {
    writeNote("Notes/one.md", "Alpha", "Alpha is also documented elsewhere.");
    writeNote("Notes/two.md", "Alpha", "standalone");

    const { candidates, refusals } = collectRepairCandidatesWithRefusals(vault);
    expect(candidates).toEqual([]);
    expect(refusals.map((r) => [r.source, r.target])).toEqual([
      [expect.stringContaining("one"), expect.stringContaining("two")],
    ]);
  });

  test("a uniquely carried title still binds exactly one page", () => {
    writeNote("Notes/one.md", "Alpha", "standalone");
    writeNote("Notes/two.md", "Beta", "Mentions Alpha once.");

    const { candidates, refusals } = collectRepairCandidatesWithRefusals(vault);
    const bound = candidates.find(
      (c) => c.strength === IDENTITY_STRENGTH.explicitReference && c.source.includes("two"),
    );
    expect(bound).toBeDefined();
    expect(bound!.target).toContain("one");
    expect(bound!.confidence).toBe(EXPLICIT_REFERENCE_CONFIDENCE);
    expect(refusals).toEqual([]);
  });

  test("an alias mention proposes the same explicit candidate a title mention would", () => {
    writePref(
      "pref-second-order.md",
      [
        "---",
        "kind: preference",
        "topic: second-order",
        "status: confirmed",
        "principle: thinking ahead",
        "aliases: [downstream]",
        "---",
        "",
        "Body.",
      ].join("\n"),
    );
    writeNote("Notes/report.md", "Quarterly", "We follow the downstream effect.");

    const { candidates, refusals } = collectRepairCandidatesWithRefusals(vault);
    const bound = candidates.find(
      (c) => c.strength === IDENTITY_STRENGTH.explicitReference && c.source.includes("report"),
    );
    expect(bound).toBeDefined();
    expect(bound!.target).toContain("pref-second-order");
    expect(bound!.confidence).toBe(EXPLICIT_REFERENCE_CONFIDENCE);
    expect(bound!.reason).toContain("downstream");
    expect(refusals).toEqual([]);
  });

  test("an alias claimed by two pages binds to the alias index's first-wins page", () => {
    // buildAliasIndex resolves a colliding alias first-wins by sorted
    // canonical id (its documented contract), so the collector receives
    // exactly one carrier and binds to it.
    writePref("pref-left.md", aliasedPref("left"));
    writePref("pref-right.md", aliasedPref("right"));
    writeNote("Notes/report.md", "Quarterly", "We follow the downstream effect.");

    const { candidates, refusals } = collectRepairCandidatesWithRefusals(vault);
    expect(refusals).toEqual([]);
    const bound = candidates.filter(
      (c) => c.strength === IDENTITY_STRENGTH.explicitReference && c.source.includes("report"),
    );
    expect(bound).toHaveLength(1);
    expect(bound[0]!.target).toContain("pref-left");
    expect(bound[0]!.confidence).toBe(EXPLICIT_REFERENCE_CONFIDENCE);
  });

  test("an alias colliding with a page title refuses the mention", () => {
    writePref(
      "pref-second-order.md",
      [
        "---",
        "kind: preference",
        "topic: second-order",
        "status: confirmed",
        "principle: thinking ahead",
        "aliases: [downstream]",
        "---",
        "",
        "Body.",
      ].join("\n"),
    );
    writeNote("Notes/glossary.md", "Downstream", "The downstream page collects the effects.");
    writeNote("Notes/report.md", "Quarterly", "We follow the downstream effect.");

    const { candidates, refusals } = collectRepairCandidatesWithRefusals(vault);
    const bound = candidates.filter(
      (c) => c.strength === IDENTITY_STRENGTH.explicitReference && c.source.includes("report"),
    );
    expect(bound).toEqual([]);
    // The glossary page mentions the term in its own body too, so three
    // (mentioning page, carrying page) pairs are refused in total.
    expect(refusals).toHaveLength(3);
    expect(refusals.every((r) => r.action === "skip-ambiguous")).toBe(true);
    expect(refusals.every((r) => r.reason.includes("Downstream"))).toBe(true);
    const targets = refusals.map((r) => r.target).toSorted();
    expect(targets[0]).toContain("pref-second-order");
    expect(targets[1]).toContain("pref-second-order");
    expect(targets[2]).toContain("glossary");
  });
});
