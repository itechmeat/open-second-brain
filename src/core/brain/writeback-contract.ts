/**
 * Write-back contract audit, CHECK-ONLY (t_7c01bb39).
 *
 * Asserts that the workspace's agent-instruction file(s) carry the
 * same-turn atomic-fact memory write gate: a marker-delimited Open Second
 * Brain managed block (`hasManagedBlock`/`extractManagedBlock`,
 * `src/core/install/managed-block.ts`) whose body states the gate. The
 * audit only READS; it never writes, installs or repairs anything.
 *
 * THE SETTLED MARKER CONTRACT - this section is the input the ambient
 * write-back managed block must satisfy wherever it is installed:
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
 *   This module is the checker that defines conformance. NO INSTALLER
 *   LIVES HERE, which is why a file with no block at all is reported as
 *   `missing-block` (not installed, graded skipped by the readiness probe)
 *   while a block that is present but broken is `malformed-block` or
 *   `missing-clauses` (graded fail).
 *
 * Read posture: every candidate file is lstat'd first and a symbolic link
 * is REFUSED, never followed - the upstream posture is that a reader that
 * follows a link has already left the workspace, and no symlink guard
 * existed anywhere on this lane before this module (premise report,
 * t_7c01bb39). The refusal is written even though the write lane is out
 * of scope: a check that silently reads through a link would audit a file
 * the agent instruction surface does not contain.
 *
 * Shadowing (t_00b617b6): the candidates are audited in isolation, but a
 * host reads exactly ONE of them - its entry in
 * {@link HOST_INSTRUCTION_PRECEDENCE}. A workspace where the file a host
 * reads carries no managed block while another candidate carries it is
 * shadowed: the operative host never sees the contract no matter how
 * conforming the other file is. {@link resolveShadowedInstructionContracts}
 * resolves that from the audit rows alone - pure, no I/O, no writes - and
 * the doctor-readiness probe grades each triple as a `fail`.
 *
 * Findings are the closed {@link WRITEBACK_CONTRACT_FINDING} vocabulary:
 * `conforming`, `malformed-block`, `missing-clauses` (a block is present
 * and was measured - pass/fail material), `missing-block` (the file
 * exists but the block was never installed - skip material), and
 * `absent`, `symlink`, `unreadable` (the file was not measured -
 * skip/unknown material; the doctor-readiness probe maps these). Every finding carries a non-empty
 * detail naming the file and, when the contract fails, the missing piece.
 */

import { lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  DEFAULT_BEGIN_MARKER,
  DEFAULT_END_MARKER,
  extractManagedBlock,
  hasManagedBlock,
} from "../install/managed-block.ts";
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
 * Host family to the ordered agent-instruction files the host reads at a
 * workspace root, first existing entry wins per host (t_00b617b6). This is
 * the PRECEDENCE table - which file an operative host actually reads - and
 * is deliberately a different shape from {@link AGENT_INSTRUCTION_FILES},
 * which is the existence-loop list this audit walks. The installer lane
 * (sibling card t_af5e252f) is expected to share this definition, which is
 * why each value is an ordered list even where the repo today names only
 * one file per host.
 *
 * Evidence, entry by entry:
 *
 *   - `claude-code` reads `CLAUDE.md` - REPO-CITED,
 *     `docs/cross-project-pointer.md:15`.
 *   - `codex`, `cursor`, `aider` read `AGENTS.md` - REPO-CITED,
 *     `docs/cross-project-pointer.md:16-17` ("Codex, Cursor, Aider, and
 *     other tools that follow the `agents.md` convention").
 *   - `opencode` reads `AGENTS.md` - REPO-CITED,
 *     `docs/brainstorm/opencode-native-integration/variants.md` ("opencode
 *     reads AGENTS.md natively").
 *   - `gemini-cli` reads `GEMINI.md` - NAME-IMPLIED ONLY. No repo document
 *     states it (the cross-project pointer predates the Gemini entry), and
 *     upstream `context.fileName` can rename the surface. Recorded as the
 *     open question the instruction-file-ceiling and removed-tool-sweep
 *     docblocks carry; the finding vocabulary stays honest because a
 *     shadow is claimed only from files this tree actually audited.
 *
 * There is no claude-code INSTALL target (the adapters write MCP configs
 * only), so "which host is operative here" cannot be derived from an
 * install manifest - detection keys on which candidate files co-exist plus
 * this table, never on manifests.
 */
export const HOST_INSTRUCTION_PRECEDENCE = Object.freeze({
  "claude-code": Object.freeze(["CLAUDE.md"]),
  codex: Object.freeze(["AGENTS.md"]),
  cursor: Object.freeze(["AGENTS.md"]),
  opencode: Object.freeze(["AGENTS.md"]),
  aider: Object.freeze(["AGENTS.md"]),
  "gemini-cli": Object.freeze(["GEMINI.md"]),
} as const);

/** Closed union over {@link HOST_INSTRUCTION_PRECEDENCE} keys. */
export type HostInstructionName = keyof typeof HOST_INSTRUCTION_PRECEDENCE;

/**
 * Recovery clause an audit carries when the block is missing or broken.
 * It names the surface to add and the markers that delimit it; nothing
 * here writes it.
 */
export const WRITEBACK_CONTRACT_RECOVERY =
  "recovery: add the ambient write-back managed block between the " +
  `"${DEFAULT_BEGIN_MARKER}" and "${DEFAULT_END_MARKER}" lines, stating the ` +
  `${MARKER_WRITEBACK_GUARDRAIL} same-turn atomic-fact write gate`;

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
  /** The file exists but carries no managed-block marker at all: not installed. */
  missingBlock: "missing-block",
  /** A managed-block marker is present but not as one well-formed pair. */
  malformedBlock: "malformed-block",
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
  const body = hasManagedBlock(content) ? extractManagedBlock(content) : null;
  if (body === null) {
    if (!carriesMarkerLine(content)) {
      return {
        path,
        finding: WRITEBACK_CONTRACT_FINDING.missingBlock,
        detail:
          `${path} has no Open Second Brain managed block - the ambient write-back ` +
          `managed block is not installed, so the write gate is not graded; ` +
          WRITEBACK_CONTRACT_RECOVERY,
        missing: [],
      };
    }
    // A marker is there but not as one ordered pair (a lone, repeated or
    // reversed marker), or the two helpers disagree on the same bytes:
    // a block somebody installed and then broke, which is a file fault.
    return {
      path,
      finding: WRITEBACK_CONTRACT_FINDING.malformedBlock,
      detail:
        `${path} carries an Open Second Brain managed-block marker but no well-formed ` +
        `block - broken same-turn atomic-fact write gate; ${WRITEBACK_CONTRACT_RECOVERY}`,
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

/** Whether any line of `content` is a default managed-block marker. */
function carriesMarkerLine(content: string): boolean {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => line === DEFAULT_BEGIN_MARKER || line === DEFAULT_END_MARKER);
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

// ----- Shadow resolution (t_00b617b6) ---------------------------------------

/**
 * One host reading a contract-free instruction file while another
 * workspace candidate carries the write-back contract: the operative host
 * never sees the gate. Pure data - resolved from audit rows, never from
 * the filesystem.
 */
export interface WritebackContractShadow {
  /** The host family whose preferred file misses the contract. */
  readonly host: HostInstructionName;
  /** Absolute path of the file the host reads, without the managed block. */
  readonly readsPath: string;
  /** Absolute path of another candidate that carries the contract. */
  readonly contractPath: string;
}

/**
 * The findings that prove a file CARRIES the managed block, in any state:
 * conforming, or installed-then-broken (`malformed-block`,
 * `missing-clauses`). A block that is present is evidence a host is being
 * shadowed away from, whatever its condition; `missing-block` is the one
 * present-file finding that does not carry it, and `absent`, `symlink`,
 * `unreadable` never measured a block at all.
 */
const BLOCK_BEARING_FINDINGS: ReadonlySet<WritebackContractFinding> = new Set([
  WRITEBACK_CONTRACT_FINDING.conforming,
  WRITEBACK_CONTRACT_FINDING.malformedBlock,
  WRITEBACK_CONTRACT_FINDING.missingClauses,
]);

/**
 * Resolve which hosts the workspace's contract placement shadows, PURELY
 * over the per-candidate audits (as {@link auditWorkspaceWritebackContract}
 * produces them): no reads, no lstats, no writes - synthetic audits of
 * paths that exist nowhere resolve exactly like audited ones.
 *
 * A host is shadowed when its preferred candidate - the first entry of its
 * {@link HOST_INSTRUCTION_PRECEDENCE} list that exists - is a file WITHOUT
 * the managed block while another candidate carries the block in any state.
 * A host whose preferred file is absent reads nothing and is not shadowed;
 * a host whose preferred file carries the block is not shadowed even when
 * a peer carries a better-formed one; a symlink or unreadable preferred
 * file is refused evidence, so no shadow is claimed from it (whether a
 * link between candidates should be admitted as evidence is a recorded
 * open question, not decided here). The contract side is the first
 * block-bearing candidate in the audits' given order - the candidate list's
 * priority order for a workspace audit.
 */
export function resolveShadowedInstructionContracts(
  audits: ReadonlyArray<WritebackContractFileAudit>,
): ReadonlyArray<WritebackContractShadow> {
  const contractPath = audits.find((audit) => BLOCK_BEARING_FINDINGS.has(audit.finding));
  if (contractPath === undefined) return Object.freeze([]);
  const byName = new Map<string, WritebackContractFileAudit>();
  for (const audit of audits) byName.set(basename(audit.path), audit);
  const shadows: WritebackContractShadow[] = [];
  for (const [host, files] of Object.entries(HOST_INSTRUCTION_PRECEDENCE)) {
    const preferred = files
      .map((name) => byName.get(name))
      .find((audit) => audit !== undefined && audit.finding !== WRITEBACK_CONTRACT_FINDING.absent);
    if (preferred === undefined) continue;
    if (preferred.finding !== WRITEBACK_CONTRACT_FINDING.missingBlock) continue;
    shadows.push(
      Object.freeze({
        host: host as HostInstructionName,
        readsPath: preferred.path,
        contractPath: contractPath.path,
      }),
    );
  }
  return Object.freeze(shadows);
}
