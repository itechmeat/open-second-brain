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
  IDENTITY_STRENGTH,
  collectRepairCandidates,
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
