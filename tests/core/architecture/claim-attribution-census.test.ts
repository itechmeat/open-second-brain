/**
 * Claim-attribution census (answer-trust, task B6).
 *
 * The claim-attribution card adds an optional `sample_id` to the claim
 * path and a READ-ONLY join (`truth/claim-provenance.ts`) that resolves
 * it at read time. Two invariants make that card safe, and either
 * failing stops the lane:
 *
 *   (a) The continuity record-kind vocabulary is unchanged by the wave.
 *       The join reads existing `context_receipt` and
 *       `context_pack_outcome` rows (and the `context_pack_evidence`
 *       verdict row posted beside them) and introduces no new kind. A
 *       per-statement provenance row was the rejected design - this
 *       census is the guard that keeps the rejection binding: parse the
 *       `ContinuityRecordKind` union out of its source and pin its
 *       exact member set.
 *
 *   (b) No recall-time writes. The `truth/` modules - the ledger store,
 *       the stated-claims boundary, and the provenance join - import no
 *       continuity append path. Reading a claim's provenance can never
 *       become a write, no matter the caller or the reach, because no
 *       module in the subsystem can even name the append surface.
 *
 * Like its sibling censuses, this one reads a LEXED view of each module
 * (`tests/helpers/source-lexer.ts`), so an append path named in a
 * docblock is not an import and a call inside a string literal is not a
 * site.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { lexSource } from "../../helpers/source-lexer.ts";

const TRUTH_DIR = join(import.meta.dir, "..", "..", "..", "src", "core", "brain", "truth");
const CONTINUITY_TYPES_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "src",
  "core",
  "brain",
  "continuity",
  "types.ts",
);
const CLAIM_PROVENANCE_PATH = join(TRUTH_DIR, "claim-provenance.ts");

/**
 * The append surface of the continuity store and its emit helpers, plus
 * every typed writer that lands a continuity row behind a gate. Any of
 * these identifiers appearing in a `truth/` module's code view is a
 * recall-time write.
 */
const CONTINUITY_APPEND_IDENTIFIERS: ReadonlyArray<string> = Object.freeze([
  "appendContinuityRecord",
  "emitGatedTelemetry",
  "appendLogEvent",
  "emitContextReceipt",
  "emitContextPackOutcome",
  "postContextPackOutcome",
  "recordContextPackEvidence",
  "recordTokenImpactOutcome",
]);

/**
 * Vault write primitives the provenance join must never touch: it
 * performs NO vault writes, so it may not even bind `node:fs`.
 */
const CLAIM_PROVENANCE_FORBIDDEN_WRITE_CALLS: ReadonlyArray<string> = Object.freeze([
  "appendFileSync",
  "writeFileSync",
  "mkdirSync",
  "rmSync",
  "unlinkSync",
  "appendFile",
  "writeFile",
  "mkdir",
  "rm",
  "cpSync",
]);

/** The kind vocabulary exactly as the wave found it (see invariant (a)). */
const PINNED_CONTINUITY_KINDS: ReadonlyArray<string> = Object.freeze([
  "context_receipt",
  "recall_telemetry",
  "gate_telemetry",
  "pre_compact_extract",
  "post_compact_audit",
  "session_turn",
  "recent_turn",
  "session_summary_node",
  "session_summary_digest",
  "generation_report",
  "ingest_dedup",
  "mcp_route_latency",
  "token_impact",
  "token_impact_outcome",
  "context_pack_outcome",
  "context_pack_evidence",
  "host_memory_write",
  "recall_observed_use",
  "skill_invoked",
  "source_invalidation",
  "negative_recall",
  "decision_model_call",
  "decision_model_extract_commit",
  "session_entity_mention",
]);

function truthModulePaths(): ReadonlyArray<string> {
  return readdirSync(TRUTH_DIR)
    .filter((name) => name.endsWith(".ts"))
    .toSorted()
    .map((name) => join(TRUTH_DIR, name));
}

function truthModuleNames(): ReadonlyArray<string> {
  return readdirSync(TRUTH_DIR)
    .filter((name) => name.endsWith(".ts"))
    .toSorted();
}

/** Parse the `ContinuityRecordKind` union's string members out of source. */
function continuityKindVocabulary(): ReadonlyArray<string> {
  const text = readFileSync(CONTINUITY_TYPES_PATH, "utf8");
  // The union's docblocks quote words ("no") that are not members; parse
  // the comment-blanked view so a quotation in a comment is not a kind -
  // the same discipline the sibling censuses document.
  const code = lexSource(text).withoutComments;
  const marker = "export type ContinuityRecordKind =";
  const start = code.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = code.indexOf(";", start);
  expect(end).toBeGreaterThan(start);
  const segment = code.slice(start, end);
  return [...segment.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!);
}

describe("claim-attribution census", () => {
  test("the sweep sees the truth subsystem, join included", () => {
    // A census over an empty directory is a claim about a census; pin
    // the population and the join's presence in it.
    const names = truthModuleNames();
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(names).toContain("store.ts");
    expect(names).toContain("stated-claims.ts");
    expect(names).toContain("claim-provenance.ts");
  });

  test("(a) the continuity record-kind vocabulary is unchanged by the wave", () => {
    // The wave introduces no new kind; the join reads existing
    // `context_receipt` and `context_pack_outcome` rows. A new member
    // here means a lane is minting a record kind the plan refused.
    const kinds = continuityKindVocabulary();
    expect(kinds.toSorted()).toEqual(PINNED_CONTINUITY_KINDS.toSorted());
  });

  test("(a) the pinned vocabulary contains the kinds the join reads", () => {
    // The join's inputs must stay existing, named kinds - if one of
    // these leaves the vocabulary the join reads nothing and the card
    // has silently rotted.
    const kinds = continuityKindVocabulary();
    for (const kind of ["context_receipt", "context_pack_outcome", "context_pack_evidence"]) {
      expect(kinds).toContain(kind);
    }
  });

  test("(b) no truth module imports or calls a continuity append path", () => {
    // Checked on the code view (comments and literal contents blanked):
    // an append path discussed in a docblock is not an import, and the
    // match covers every import shape - named, renamed, namespace,
    // dynamic - because it matches the identifier itself.
    const offenders: string[] = [];
    for (const path of truthModulePaths()) {
      const code = lexSource(readFileSync(path, "utf8")).code;
      for (const identifier of CONTINUITY_APPEND_IDENTIFIERS) {
        if (code.includes(identifier)) offenders.push(`${path}: ${identifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("(b) claim-provenance.ts performs no vault writes and binds no fs module", () => {
    const code = lexSource(readFileSync(CLAIM_PROVENANCE_PATH, "utf8")).code;
    expect(code).not.toMatch(/node:fs/);
    const offenders = CLAIM_PROVENANCE_FORBIDDEN_WRITE_CALLS.filter((call) => code.includes(call));
    expect(offenders).toEqual([]);
  });
});
