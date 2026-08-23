/**
 * Link candidates on the three note-producing envelopes
 * (nothing-writes-silently, unit E).
 *
 * Claims pinned here:
 *
 *   1. The SPINE does not move. `LlmStepFields` and `NEEDS_LLM_STEP_KEYS`
 *      carry exactly what they carried; `link_candidates` rides on the
 *      consumer's own type, exactly as the rollup's `tier`/`produces`
 *      already do, and lands AFTER the spine's own keys so no existing
 *      serialized position changes.
 *   2. All three note-producing lanes - rollup ladder, diarization,
 *      design note - carry a manifest, and each carries the one schema
 *      hint that says what the manifest is.
 *   3. The three lanes that produce no wikilinked note - skill page
 *      drafts, extract-signals, the durable write session - carry NO
 *      manifest. A field three of six consumers want is not spine, and
 *      this is the assertion that keeps it off the other three.
 *   4. The rollup ladder stays PURE: its manifest arrives on the input
 *      rather than being walked from a vault inside the planner.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { diarize } from "../../../src/core/brain/diarization.ts";
import { planDesignNote } from "../../../src/core/brain/design-note.ts";
import { upsertEntity } from "../../../src/core/brain/entities/registry.ts";
import { NEEDS_LLM_STEP_KEYS } from "../../../src/core/brain/llm-step.ts";
import {
  buildLinkCandidateManifest,
  type LinkCandidateManifest,
} from "../../../src/core/brain/notes/link-candidates.ts";
import { planRollupLadder } from "../../../src/core/brain/rollup-ladder.ts";

const NOW = new Date("2026-08-23T10:00:00Z");
const RUN_ID = "dream-2026-08-23-100000";
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** The three envelope lanes whose artifact carries no wikilink. */
const NON_NOTE_LANES: ReadonlyArray<string> = Object.freeze([
  "src/core/brain/skill-page-drafts.ts",
  "src/core/brain/extract-signals.ts",
  "src/core/brain/write-session/types.ts",
]);

let vault: string;

function writeNote(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-link-envelopes-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeNote("notes/analytical-engine.md", "# Analytical engine\n");
  writeNote("notes/vector-index-storage.md", "# Vector index storage\n");
});

describe("the spine does not move", () => {
  test("NEEDS_LLM_STEP_KEYS is byte-identical", () => {
    expect([...NEEDS_LLM_STEP_KEYS]).toEqual([
      "status",
      "step",
      "prompt",
      "schema_hints",
      "target_path",
    ]);
  });
});

describe("the three note-producing lanes carry a manifest", () => {
  test("the rollup envelope carries the manifest it was handed, last in key order", () => {
    const linkCandidates = buildLinkCandidateManifest(vault);
    const plan = planRollupLadder({
      factCount: 5,
      ledger: null,
      thresholds: { fact: 5, identity: 2 },
      runId: RUN_ID,
      linkCandidates,
    });
    const envelope = plan.entries[0]!.envelope;
    expect(envelope.link_candidates).toEqual(linkCandidates);
    expect(Object.keys(envelope)).toEqual([
      "status",
      "step",
      "tier",
      "produces",
      "prompt",
      "schema_hints",
      "target_path",
      "link_candidates",
    ]);
    expect(envelope.schema_hints.some((hint) => hint.includes("link_candidates"))).toBe(true);
  });

  test("the diarization envelope ranks candidates on the subject it profiles", () => {
    upsertEntity(vault, {
      category: "person",
      name: "Ada Lovelace",
      agent: "test",
      now: NOW,
      body: "Ada Lovelace worked on the analytical engine.",
    });
    const report = diarize(vault, { query: "Ada Lovelace" }, { now: NOW });
    const manifest: LinkCandidateManifest = report.llmStep.link_candidates;
    expect(manifest.candidates).toContain("analytical-engine");
    expect(manifest.total).toBeGreaterThan(0);
    expect(report.llmStep.schema_hints.some((hint) => hint.includes("link_candidates"))).toBe(true);
    // The spine's own keys keep their positions; the manifest is appended.
    expect(Object.keys(report.llmStep).at(-1)).toBe("link_candidates");
  });

  test("the design-note envelope carries a manifest ranked on the topic", () => {
    const report = planDesignNote(vault, "vector index storage", { now: NOW });
    expect(report.llmStep.link_candidates.candidates).toContain("vector-index-storage");
    expect(report.llmStep.schema_hints.some((hint) => hint.includes("link_candidates"))).toBe(true);
    expect(Object.keys(report.llmStep).at(-1)).toBe("link_candidates");
  });
});

describe("the lanes that produce no wikilinked note carry none", () => {
  /**
   * Read off the source rather than driven, because each of these three
   * needs a whole world to build one envelope - imported session turns,
   * observed-use verdicts, an open durable session - and the claim is
   * about the FIELD, which the module either names or does not. A lane
   * that started carrying a manifest would have to name it here.
   */
  test("skill page drafts, extract-signals and the write session never name the field", () => {
    const carriers = NON_NOTE_LANES.filter((rel) =>
      readFileSync(join(REPO_ROOT, rel), "utf8").includes("link_candidates"),
    );
    expect(carriers.join("\n")).toBe("");
    // The read has to be reaching real envelope lanes, or it proves nothing.
    for (const rel of NON_NOTE_LANES) {
      expect(readFileSync(join(REPO_ROOT, rel), "utf8")).toMatch(/LlmStepFields|NeedsLlmStep/);
    }
  });
});
