/**
 * Write-ahead journal for the skill-proposal accept sequence
 * (no-dead-ends, Unit I).
 *
 * Accepting a proposal is four filesystem steps against three different
 * trees: write the accepted archive, materialize the procedure, remove the
 * pending copy, rebuild the procedural projections. Each individual write
 * is already atomic and exclusive (`writeFrontmatterAtomic` over
 * `atomicCreateFileSyncExclusive`), so the risk is never a torn file - it
 * is a process that stops BETWEEN two of those steps and leaves a
 * duplicate (pending plus accepted), an orphan (an accepted archive with
 * no procedure) or a stale projection.
 *
 * An exception can be compensated in a `catch`; a crash cannot. So the
 * sequence records its intent here BEFORE each step, and the next accept
 * resolves whatever it finds. The journal states the step the writer was
 * ABOUT to perform, never the one it completed - that is what makes a
 * crash inside a step recoverable:
 *
 *   - `archive`     - about to write the accepted archive
 *   - `materialize` - about to write the procedure
 *   - `commit`      - about to remove the pending copy, then reproject
 *
 * `acceptedExisted` / `procedureExisted` are captured before the sequence
 * starts so a rollback never deletes a file the sequence did not create.
 *
 * The journal is a repair marker, not history: it is removed as soon as
 * the sequence completes or is resolved. A journal left on disk means a
 * sequence is still outstanding.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { ensureInsideVault } from "../path-safety.ts";
import { BRAIN_SKILL_ACCEPT_JOURNAL_REL, skillAcceptJournalPath } from "./paths.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

/** Step the accept sequence was about to perform when the journal was stamped. */
export type SkillAcceptPhase = "archive" | "materialize" | "commit";

export interface SkillAcceptJournalEntry {
  readonly slug: string;
  readonly id: string;
  readonly phase: SkillAcceptPhase;
  readonly startedAt: string;
  /** The accepted archive was already on disk before the sequence started. */
  readonly acceptedExisted: boolean;
  /** The procedure file was already on disk before the sequence started. */
  readonly procedureExisted: boolean;
}

const JOURNAL_SCHEMA_VERSION = 1;
const JOURNAL_SUFFIX = ".json";
const PHASES: ReadonlySet<string> = new Set<SkillAcceptPhase>(["archive", "materialize", "commit"]);

/** Stamp (or re-stamp) the journal for `entry.slug`. Overwrites by design. */
export function writeSkillAcceptJournal(vault: string, entry: SkillAcceptJournalEntry): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const path = skillAcceptJournalPath(vault, entry.slug);
  mkdirSync(ensureInsideVault(dirname(path), vault), { recursive: true });
  const payload = {
    schema_version: JOURNAL_SCHEMA_VERSION,
    slug: entry.slug,
    id: entry.id,
    phase: entry.phase,
    started_at: entry.startedAt,
    accepted_existed: entry.acceptedExisted,
    procedure_existed: entry.procedureExisted,
  };
  atomicWriteFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

/** Remove the journal for `slug`. Idempotent. */
export function clearSkillAcceptJournal(vault: string, slug: string): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  rmSync(skillAcceptJournalPath(vault, slug), { force: true });
}

/**
 * Every outstanding journal, slug-ordered. A file this module cannot parse
 * back into a complete entry is a defect, not a soft skip: it is reported
 * by throwing so the caller cannot mistake an unreadable marker for "no
 * outstanding work".
 */
export function listSkillAcceptJournals(vault: string): ReadonlyArray<SkillAcceptJournalEntry> {
  const dir = ensureInsideVault(join(vault, BRAIN_SKILL_ACCEPT_JOURNAL_REL), vault);
  if (!existsSync(dir)) return Object.freeze([]);
  const out: SkillAcceptJournalEntry[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(JOURNAL_SUFFIX)) continue;
    out.push(parseJournal(join(dir, name)));
  }
  return Object.freeze(out);
}

function parseJournal(path: string): SkillAcceptJournalEntry {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`skill accept journal is unreadable: ${path}`, { cause });
  }
  const slug = raw["slug"];
  const id = raw["id"];
  const phase = raw["phase"];
  const startedAt = raw["started_at"];
  if (
    typeof slug !== "string" ||
    typeof id !== "string" ||
    typeof phase !== "string" ||
    !PHASES.has(phase) ||
    typeof startedAt !== "string"
  ) {
    throw new Error(`skill accept journal is malformed: ${path}`);
  }
  return Object.freeze({
    slug,
    id,
    phase: phase as SkillAcceptPhase,
    startedAt,
    acceptedExisted: raw["accepted_existed"] === true,
    procedureExisted: raw["procedure_existed"] === true,
  });
}
