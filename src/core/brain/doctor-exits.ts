/**
 * Why a doctor finding has no next command (no-dead-ends, phase 3).
 *
 * `o2b brain doctor` resolves each reported code through the diagnostics
 * registry and prints `next: <command>` when one is registered. About two
 * thirds of its codes are not, and nothing said why - so an operator
 * reading a finding with no exit could not tell "no command resolves
 * this" from "someone forgot to register it". Silence carried both
 * meanings, which makes it worth nothing.
 *
 * This table removes the second meaning. Every code the doctor spells is
 * either in `DIAGNOSTIC_SIGNALS` with a structural command, or here with
 * the reason there is none. `tests/core/brain/doctor-exit-census.test.ts`
 * enumerates the population out of `doctor.ts` and fails on a code in
 * neither table, or in both.
 *
 * ## What earns an entry here rather than a registration
 *
 * Two shapes, and only these two:
 *
 *   - the repair is a JUDGEMENT over content - which of two contradicting
 *     rules survives, which of two files keeps a duplicated id, whether a
 *     pin is still intended. A command that picked one would be making
 *     the operator's decision and recording it as a repair.
 *   - the repair is an EDIT to a file whose target shape is not derivable
 *     from the finding - a malformed timestamp does not say what instant
 *     it meant, a failed regular expression does not say what it was
 *     meant to match. Writing a plausible value would turn an unreadable
 *     record into a confidently wrong one.
 *
 * A code with a real single command belongs in the registry instead, and
 * the census enforces that direction too: a reason here may not name an
 * `o2b` invocation. If one fits, it is a registration, not an excuse.
 *
 * ## Related, and deliberately separate
 *
 * `applier-capability.ts` answers a different question - whether a
 * MECHANICAL repair exists - and the answers do not coincide. A finding
 * can have no automatic fixer and still have an exact next command
 * (`contradictory-preferences` has both a refusal there and a command in
 * the registry), so folding the two tables together would force one
 * verdict onto two independent axes.
 */

import { resolveNextStep } from "./next-step.ts";

/** One doctor code with no single command, and the reason it has none. */
export interface DoctorExitExclusion {
  readonly code: string;
  /** Why no one command resolves the finding. Never empty. */
  readonly reason: string;
}

const EXCLUSIONS: ReadonlyArray<DoctorExitExclusion> = [
  // --- Judgements over content -------------------------------------------
  {
    code: "active-budget-pressure",
    reason:
      "active.md is rendered from the preference set, so it shrinks by retiring, merging or " +
      "unpinning rules rather than by editing the file; which rule to drop is a statement about " +
      "what the operator still believes, and the finding already ranks the candidates",
  },
  {
    code: "batch-concept-inflation",
    reason:
      "the finding is that a batch was confirmed together without a dedup pass, not that any " +
      "particular pair duplicates. Whether two principles say the same thing is a reading of " +
      "their content, and merging the wrong pair destroys a rule nobody decided to drop",
  },
  {
    code: "broken-entity-relation",
    reason:
      "the edge names an entity id the registry does not hold. Repairing it means either " +
      "creating that entity or correcting the edge, and which was intended is only in the " +
      "author's head - the two produce different graphs",
  },
  {
    code: "concept-gap",
    reason:
      "the repair is to write a preference that does not exist yet, which is authoring content " +
      "rather than repairing a record; the same reason applier-capability.ts refuses it a fixer",
  },
  {
    code: "duplicate-entity",
    reason:
      "two entity files claim one identity, and lookups already resolve to the first claimant. " +
      "Merging them or archiving one decides which history survives, which needs both files " +
      "read rather than a rule applied",
  },
  {
    code: "duplicate-id",
    reason:
      "two records carry the same id and either could be the one that keeps it. Renaming a file " +
      "breaks every wikilink that resolved to it, so the choice is a judgement about which " +
      "record the rest of the vault means",
  },
  {
    code: "entity-alias-candidate",
    reason:
      "a nomination, never a drop: the finding is that two names MIGHT denote one entity. " +
      "Confirming it means adding an alias to the surviving entity, which is a claim about the " +
      "world the lexical detector is not entitled to make",
  },
  {
    code: "id-filename-mismatch",
    reason:
      "the id and the basename disagree and neither is authoritative. Renaming the file breaks " +
      "inbound wikilinks, rewriting the id breaks outbound ones, and the finding cannot tell " +
      "which of the two was the typo",
  },
  {
    code: "pinned-without-recent-evidence",
    reason:
      "the pin is doing exactly what a pin does - holding a rule back from automatic retire. " +
      "Whether that is still intended is the operator's call, and asking the question is the " +
      "entire content of the warning",
  },
  {
    code: "removed-tool-reference",
    reason:
      "the reference sits in prose an operator or another tool wrote, and the replacement " +
      "mapping is already printed in the finding. Rewriting someone else's note is an edit to " +
      "their content, not a repair of a record this store owns",
  },
  {
    code: "stale-lock",
    reason:
      "the lock primitive is a single-attempt exclusive create, so no timeout distinguishes a " +
      "crashed writer from a slow live one and nothing may remove the file automatically. The " +
      "exit is the operator's judgement followed by a manual deletion",
  },
  {
    code: "status-folder-mismatch",
    reason:
      "the status field and the containing folder disagree, and either could be the true one. " +
      "Moving the file and rewriting the field are different repairs with different lifecycle " +
      "consequences, and the record does not say which happened",
  },
  {
    code: "symlink-escape",
    reason:
      "a link leaving the vault is removed or repointed depending on what it was for, and " +
      "following it to find out is exactly what this check refuses to do - a reader that " +
      "follows it has already left the store",
  },
  {
    code: "vault-include-missing-path",
    reason:
      "the allowlist names a root that is not at the vault root. Creating the folder and " +
      "correcting the spelling are different intents with different indexes as their result, " +
      "and the finding cannot tell which the operator meant - deleting the entry, the only " +
      "mechanical option, would silently widen the boundary they wrote",
  },
  {
    code: "vault-include-admits-nothing",
    reason:
      "the allowlist as a whole matches no file in this vault, so the index would be empty. " +
      "Which of the declared roots is wrong, and whether the answer is to fix a spelling, add " +
      "a root or create the folder, is a question about what the operator meant to index; a " +
      "mechanical repair would have to pick one of those on their behalf",
  },
  {
    code: "vault-ignore-missing-path",
    reason:
      "the ignore rule names a path that is not in this vault. It is usually a typo, but it can " +
      "also be a path not created yet, and silently deleting a rule the operator wrote is worse " +
      "than reporting that it currently matches nothing",
  },

  // --- Edits whose target shape the finding cannot supply ------------------
  {
    code: "config-warning",
    reason:
      "the resolver reports a key in Brain/_brain.yaml it could not honour. The repair is an " +
      "edit to that file and the value to write is a policy choice; the resolver fell back to " +
      "a default rather than guessing, and so does this",
  },
  {
    code: "invalid-capture-pattern",
    reason:
      "a regular expression in the capture configuration failed to compile. What it was meant " +
      "to match is not recoverable from a pattern that does not parse, so the repair is an edit " +
      "by whoever wrote it",
  },
  {
    code: "iso-invalid",
    reason:
      "a timestamp field is not ISO-8601. The instant it meant is not recoverable from the " +
      "malformed text, and writing today's date would make a record that lost its time look " +
      "like one that was written now",
  },
  {
    code: "log-malformed",
    reason:
      "a log line the parser has no branch for. The log is append-only history, so rewriting a " +
      "line to fit the grammar changes what was recorded - the finding names the file and the " +
      "line number precisely so a human can read the original",
  },
  {
    code: "malformed-evidence-range",
    reason:
      "the line range on a logged artifact reference does not parse. The range the author meant " +
      "is not derivable from the malformed text, and the event itself stays valid, so nothing " +
      "is lost by leaving it reported",
  },
  {
    code: "recall-channel-unmeasured",
    reason:
      "the finding is that the install side of a recall channel could not be READ - a config gate " +
      "that would not resolve, or an audit root that denied the walk. What repairs it depends on " +
      "which, and on why: a permission an operator has to decide to grant, a config file to fix, " +
      "or a path that belongs to another user entirely. Guessing one would act on a state this " +
      "pass never managed to observe",
  },
  {
    code: "preference-missing-field",
    reason:
      "a required frontmatter field is absent and its value is not recoverable from the rest of " +
      "the record. Writing a placeholder would make an unreadable preference read as a true " +
      "one, which is worse than a record the doctor keeps naming",
  },
  {
    code: "preference-invalid",
    reason:
      "the preference could not be parsed, for a reason the parser reports verbatim in the " +
      "finding. The repair is an edit whose target shape depends on which part of the grammar " +
      "broke, so there is no one command that covers the class",
  },
  {
    code: "retired-missing-field",
    reason:
      "a required frontmatter field is absent from a retired record and its value is not " +
      "recoverable from the rest of the file. A placeholder would fabricate lifecycle " +
      "provenance, which is the one thing a retired record exists to hold",
  },
  {
    code: "retired-invalid",
    reason:
      "the retired record could not be parsed, for a reason the parser reports verbatim in the " +
      "finding. As with its preference twin, the repair is an edit whose shape depends on which " +
      "part of the grammar broke",
  },
  {
    code: "signal-invalid",
    reason:
      "the signal file could not be parsed. A signal is a captured observation, so what it was " +
      "meant to say exists only in the source it was captured from - reconstructing it here " +
      "would be inventing the observation",
  },
];

/** Two entries claimed one code - the table would silently lose one. */
export class DuplicateDoctorExitExclusionError extends Error {
  constructor(code: string) {
    super(`DOCTOR_EXIT_EXCLUSIONS declares doctor code ${JSON.stringify(code)} more than once`);
    this.name = "DuplicateDoctorExitExclusionError";
  }
}

/**
 * The published table, code to reason. Built eagerly so a duplicate fails
 * at import rather than silently losing an entry.
 */
export const DOCTOR_EXIT_EXCLUSIONS: ReadonlyMap<string, string> = (() => {
  const table = new Map<string, string>();
  for (const entry of EXCLUSIONS) {
    if (table.has(entry.code)) throw new DuplicateDoctorExitExclusionError(entry.code);
    table.set(entry.code, entry.reason);
  }
  return table;
})();

/**
 * The published reason `code` has no next command, or `null` when the
 * table publishes none. `null` is also what a code WITH a registered
 * command yields: the two questions are asked in that order by every
 * caller, and a code cannot honestly answer both.
 */
export function doctorExitReason(code: string): string | null {
  if (resolveNextStep(code) !== null) return null;
  return DOCTOR_EXIT_EXCLUSIONS.get(code) ?? null;
}

/**
 * The additive JSON key a machine-readable surface carries the reasons
 * in. Named once here for the same reason `NEXT_COMMAND_KEY` is: the CLI
 * `--json` renderer and its MCP twin must not drift on the spelling.
 */
export const NO_EXIT_KEY = "no_exit";

/**
 * The published reasons for `codes`, deduplicated, in the order the codes
 * were reported.
 *
 * Deduplicated by code rather than by reason, because unlike a next
 * command - which two codes can share - a reason is about one class. A
 * registered code contributes nothing, and neither does one the table
 * does not know: an empty result is what a report whose every code has an
 * exit produces, which is what keeps both surfaces byte-identical on the
 * vaults that had no gap to explain.
 */
export function noExitReasons(codes: Iterable<string>): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const code of codes) {
    if (out.has(code)) continue;
    const reason = doctorExitReason(code);
    if (reason === null) continue;
    out.set(code, reason);
  }
  return out;
}
