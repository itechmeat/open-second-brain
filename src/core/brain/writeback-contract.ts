/**
 * Write-back contract audit, CHECK-ONLY (t_7c01bb39).
 *
 * Asserts that the workspace's agent-instruction file(s) carry the
 * same-turn atomic-fact memory write gate: a marker-delimited Open Second
 * Brain managed block (`hasManagedBlock`/`extractManagedBlock`,
 * `src/core/install/managed-block.ts`) whose body states the gate. The
 * audit only READS; it never writes, installs or repairs anything.
 *
 * THE SETTLED MARKER CONTRACT - this section is the input the repair lane
 * (t_af5e252f, ambient writeback) must satisfy when it installs the block:
 *
 *   1. Delimiters: the default managed-block markers
 *      (`DEFAULT_BEGIN_MARKER` / `DEFAULT_END_MARKER`,
 *      `src/core/install/managed-block.ts`) - exactly one pair, end after
 *      begin, anything outside preserved byte-for-byte.
 *   2. Location: the workspace agent-instruction file(s)
 *      ({@link AGENT_INSTRUCTION_FILES}, AGENTS.md first, discovery by
 *      existence over the fixed list, never by pattern).
 *   3. Body: a regex/keyword contract, expressed in the marker write-back
 *      guardrail's own vocabulary so the check and the runtime refuse in
 *      the same words ({@link WRITEBACK_CONTRACT_REQUIREMENTS}):
 *        - the `marker_writeback` guardrail flag name verbatim
 *          (`MARKER_WRITEBACK_GUARDRAIL`, `src/core/brain/marker-writeback.ts`);
 *        - the same-turn rule (memory is written in the same turn the
 *          fact is learned);
 *        - the atomic-fact rule (memory is written as atomic facts).
 *
 *   t_af5e252f installs a block satisfying all three clauses; this module
 *   is the checker that defines conformance. NO INSTALLER LIVES HERE.
 *
 * Read posture: every candidate file is lstat'd first and a symbolic link
 * is REFUSED, never followed - the upstream posture is that a reader that
 * follows a link has already left the workspace, and no symlink guard
 * existed anywhere on this lane before this module (premise report,
 * t_7c01bb39). The refusal is written even though the write lane is out
 * of scope: a check that silently reads through a link would audit a file
 * the agent instruction surface does not contain.
 *
 * Findings are the closed {@link WRITEBACK_CONTRACT_FINDING} vocabulary:
 * `conforming`, `missing-block`, `missing-clauses` (the file exists and
 * was measured - pass/fail material), and `absent`, `symlink`,
 * `unreadable` (the file was not measured - skip/unknown material; the
 * doctor-readiness probe maps these). Every finding carries a non-empty
 * detail naming the file and, when the contract fails, the missing piece.
 */

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { extractManagedBlock, hasManagedBlock } from "../install/managed-block.ts";
import { MARKER_WRITEBACK_GUARDRAIL } from "./marker-writeback.ts";

// ----- Constants ------------------------------------------------------------

/**
 * The workspace agent-instruction files this audit reads, in priority
 * order, AGENTS.md first. Deliberately the same fixed, short, explicit
 * list posture as the vault instruction-file ceiling: discovery is by
 * existence over THIS list, not by glob - a pattern-discovered file is a
 * second convention, and the contract must not drift per host.
 */
export const AGENT_INSTRUCTION_FILES: ReadonlyArray<string> = Object.freeze([
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
]);

/**
 * Recovery clause a failing audit carries, per the wave's CLI examples:
 * the repair is NOT built in this wave - it is the t_af5e252f surface.
 */
export const WRITEBACK_CONTRACT_RECOVERY =
  "recovery: install the managed block (t_af5e252f surface)";

/** One clause of the gate contract: what it is called and how it matches. */
export interface WritebackContractRequirement {
  /** Label used verbatim in findings, so the missing piece is named. */
  readonly label: string;
  /** Keyword/regex contract evaluated against the extracted block body. */
  readonly pattern: RegExp;
}

/**
 * The same-turn atomic-fact write-gate contract over an extracted managed
 * block body. Clause order is reporting order: the guardrail flag first
 * because it is the shared-vocabulary clause - the exact token
 * `marker-writeback.ts` refuses with - followed by the two rules that
 * make the gate a write gate at all.
 */
export const WRITEBACK_CONTRACT_REQUIREMENTS: ReadonlyArray<WritebackContractRequirement> =
  Object.freeze([
    {
      label: `the '${MARKER_WRITEBACK_GUARDRAIL}' guardrail`,
      pattern: new RegExp(MARKER_WRITEBACK_GUARDRAIL),
    },
    {
      label: "the same-turn write rule",
      pattern: /same[-\s]turn/i,
    },
    {
      label: "the atomic-fact rule",
      pattern: /atomic[-\s]fact/i,
    },
  ]);

// ----- Types ----------------------------------------------------------------

/** Closed finding vocabulary of one audited instruction file. */
export const WRITEBACK_CONTRACT_FINDING = Object.freeze({
  /** Block present, every contract clause present. */
  conforming: "conforming",
  /** The file exists but carries no well-formed managed block. */
  missingBlock: "missing-block",
  /** A managed block is present but the gate contract is not fully met. */
  missingClauses: "missing-clauses",
  /** No file at the candidate path: nothing installed. */
  absent: "absent",
  /** The candidate path is a symbolic link; the read was refused. */
  symlink: "symlink",
  /** The candidate path exists but could not be read as a file. */
  unreadable: "unreadable",
} as const);

/** Closed union over {@link WRITEBACK_CONTRACT_FINDING}. */
export type WritebackContractFinding =
  (typeof WRITEBACK_CONTRACT_FINDING)[keyof typeof WRITEBACK_CONTRACT_FINDING];

/** The audit verdict for one candidate instruction file. */
export interface WritebackContractFileAudit {
  /** Absolute candidate path that was audited. */
  readonly path: string;
  readonly finding: WritebackContractFinding;
  /** Never empty; names the file and the finding's evidence. */
  readonly detail: string;
  /** Labels of the unmet contract clauses; empty unless `missing-clauses`. */
  readonly missing: ReadonlyArray<string>;
}

// ----- Pure contract --------------------------------------------------------

/**
 * The labels of the gate clauses `blockBody` does not satisfy; empty when
 * the body carries the full same-turn atomic-fact write gate. This is the
 * whole content contract - a keyword check over the extracted block, not
 * a semantic assertion.
 */
export function missingWritebackGateClauses(blockBody: string): ReadonlyArray<string> {
  const missing: string[] = [];
  for (const requirement of WRITEBACK_CONTRACT_REQUIREMENTS) {
    if (!requirement.pattern.test(blockBody)) missing.push(requirement.label);
  }
  return Object.freeze(missing);
}

// ----- File audit -----------------------------------------------------------

/**
 * Audit one candidate instruction file. Reads with an lstat guard: a
 * symbolic link is refused (`symlink`), an absent path is the named
 * `absent` finding, anything else that cannot be read as a file is
 * `unreadable` with the reason. Only an actually-read file gets a
 * contract verdict. Never throws for filesystem conditions - refusals
 * are findings, by name.
 */
export function auditWritebackContractFile(path: string): WritebackContractFileAudit {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path,
        finding: WRITEBACK_CONTRACT_FINDING.absent,
        detail: `${path} does not exist - nothing installed is not a contract violation`,
        missing: [],
      };
    }
    return {
      path,
      finding: WRITEBACK_CONTRACT_FINDING.unreadable,
      detail: `${path} could not be stat'ed: ${reason(err)}`,
      missing: [],
    };
  }
  if (stat.isSymbolicLink()) {
    return {
      path,
      finding: WRITEBACK_CONTRACT_FINDING.symlink,
      detail:
        `${path} is a symbolic link - the audit refuses to read through symlinks, ` +
        "so the contract is unmeasured",
      missing: [],
    };
  }
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    return {
      path,
      finding: WRITEBACK_CONTRACT_FINDING.unreadable,
      detail: `${path} could not be read: ${reason(err)}`,
      missing: [],
    };
  }
  if (!hasManagedBlock(content)) {
    return {
      path,
      finding: WRITEBACK_CONTRACT_FINDING.missingBlock,
      detail:
        `${path} has no Open Second Brain managed block - present file without the ` +
        `same-turn atomic-fact write gate; ${WRITEBACK_CONTRACT_RECOVERY}`,
      missing: [],
    };
  }
  const body = extractManagedBlock(content);
  if (body === null) {
    // Unreachable by construction - `hasManagedBlock` true implies a
    // well-formed single block to extract - but the null case is a
    // missing-block verdict rather than a thrown assertion, because the
    // two helpers reading the same bytes disagreeing is a file fault.
    return {
      path,
      finding: WRITEBACK_CONTRACT_FINDING.missingBlock,
      detail:
        `${path} has no extractable Open Second Brain managed block - present file without ` +
        `the same-turn atomic-fact write gate; ${WRITEBACK_CONTRACT_RECOVERY}`,
      missing: [],
    };
  }
  const missing = missingWritebackGateClauses(body);
  if (missing.length > 0) {
    return {
      path,
      finding: WRITEBACK_CONTRACT_FINDING.missingClauses,
      detail:
        `${path} managed block is missing ${missing.join(", ")} - incomplete ` +
        `same-turn atomic-fact write gate; ${WRITEBACK_CONTRACT_RECOVERY}`,
      missing,
    };
  }
  return {
    path,
    finding: WRITEBACK_CONTRACT_FINDING.conforming,
    detail:
      `${path} carries the managed block and the same-turn atomic-fact write gate ` +
      `(${WRITEBACK_CONTRACT_REQUIREMENTS.length} clauses verified)`,
    missing: [],
  };
}

// ----- Workspace audit ------------------------------------------------------

/**
 * The absolute candidate paths for `workspace`, in priority order. Pure
 * path computation: existence is decided by the audit, not here.
 */
export function locateAgentInstructionFiles(workspace: string): ReadonlyArray<string> {
  return Object.freeze(AGENT_INSTRUCTION_FILES.map((name) => join(workspace, name)));
}

/**
 * Audit every workspace agent-instruction candidate, in priority order.
 * One row per candidate, always - an absent candidate is a named finding,
 * not a gap in the table.
 */
export function auditWorkspaceWritebackContract(
  workspace: string,
): ReadonlyArray<WritebackContractFileAudit> {
  const audits: WritebackContractFileAudit[] = [];
  for (const path of locateAgentInstructionFiles(workspace)) {
    audits.push(auditWritebackContractFile(path));
  }
  return Object.freeze(audits);
}

/** One-line an error message so a multi-line fs reason stays one detail. */
function reason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim();
}
