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
 *
 * A marker that cannot be READ is a third state, and it used to be a dead
 * end: the sweep runs before every accept, so one unparseable file blocked
 * the verb permanently and the refusal named no way out. There are now two
 * readers - {@link readSkillAcceptJournals}, which reports unreadable
 * markers as data for the diagnosis surface, and
 * {@link listSkillAcceptJournals}, which still refuses, now by name and
 * naming the command that clears them.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { ensureInsideVault } from "../path-safety.ts";
import { requireNextStep } from "./next-step.ts";
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

/**
 * Remove one marker file by path. Idempotent, vault-guarded and confined
 * to the vault. Exists for the unreadable case, where the slug cannot be
 * trusted to come from the file's own contents.
 */
export function removeSkillAcceptJournalFile(vault: string, path: string): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  rmSync(ensureInsideVault(path, vault), { force: true });
}

/** Remove the journal for `slug`. Idempotent. */
export function clearSkillAcceptJournal(vault: string, slug: string): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  rmSync(skillAcceptJournalPath(vault, slug), { force: true });
}

/** Registry code for a marker file this module cannot parse. */
export const SKILL_ACCEPT_JOURNAL_UNREADABLE_CODE = "skill-accept-journal-unreadable";

/**
 * Resolved once, at module scope, so a registry that lost the entry fails
 * at import rather than inside the very refusal it is meant to explain.
 */
const UNREADABLE_EXIT = requireNextStep(SKILL_ACCEPT_JOURNAL_UNREADABLE_CODE).nextCommand;

/** One marker file on disk that cannot be parsed back into an entry. */
export interface UnreadableSkillAcceptJournal {
  readonly path: string;
  /** Why it could not be read - a parse failure or a missing field. */
  readonly detail: string;
}

/** Outstanding markers, split into the ones that read and the ones that do not. */
export interface SkillAcceptJournalState {
  readonly entries: ReadonlyArray<SkillAcceptJournalEntry>;
  readonly unreadable: ReadonlyArray<UnreadableSkillAcceptJournal>;
}

/**
 * A marker file that cannot be parsed back into a complete entry.
 *
 * The write is atomic, so this shape never comes from a torn write of
 * ours - it arrives by hand edit, a sync merge or media damage, and it
 * blocks every accept until it is gone. The message therefore names both
 * the file and the command that removes it; without that the operator's
 * only route was reading this module.
 */
export class SkillAcceptJournalUnreadableError extends Error {
  readonly path: string;
  readonly detail: string;
  constructor(entry: UnreadableSkillAcceptJournal) {
    super(
      `skill accept journal is unreadable: ${entry.path} (${entry.detail}). ` +
        `Every accept is blocked until it is resolved: ${UNREADABLE_EXIT}`,
    );
    this.name = "SkillAcceptJournalUnreadableError";
    this.path = entry.path;
    this.detail = entry.detail;
  }
}

/**
 * Every outstanding journal, slug-ordered, partitioned by whether it
 * parses.
 *
 * This is the DIAGNOSIS surface: it reports an unreadable marker as data
 * so an operator can be shown what is wrong and act on it. The transaction
 * paths use {@link listSkillAcceptJournals} instead, which refuses - a
 * writer must never mistake an unreadable marker for "no outstanding work".
 */
export function readSkillAcceptJournals(vault: string): SkillAcceptJournalState {
  const dir = ensureInsideVault(join(vault, BRAIN_SKILL_ACCEPT_JOURNAL_REL), vault);
  if (!existsSync(dir)) {
    return Object.freeze({ entries: Object.freeze([]), unreadable: Object.freeze([]) });
  }
  const entries: SkillAcceptJournalEntry[] = [];
  const unreadable: UnreadableSkillAcceptJournal[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(JOURNAL_SUFFIX)) continue;
    const path = join(dir, name);
    const parsed = parseJournal(path);
    if ("detail" in parsed) unreadable.push(parsed);
    else entries.push(parsed);
  }
  return Object.freeze({ entries: Object.freeze(entries), unreadable: Object.freeze(unreadable) });
}

/**
 * Every outstanding journal, slug-ordered. A file this module cannot parse
 * back into a complete entry is a defect, not a soft skip: it is reported
 * by throwing {@link SkillAcceptJournalUnreadableError} so the caller
 * cannot mistake an unreadable marker for "no outstanding work".
 */
export function listSkillAcceptJournals(vault: string): ReadonlyArray<SkillAcceptJournalEntry> {
  const state = readSkillAcceptJournals(vault);
  const first = state.unreadable[0];
  if (first !== undefined) throw new SkillAcceptJournalUnreadableError(first);
  return state.entries;
}

function parseJournal(path: string): SkillAcceptJournalEntry | UnreadableSkillAcceptJournal {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (cause) {
    return Object.freeze({
      path,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
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
    return Object.freeze({ path, detail: "a required field is missing or of the wrong type" });
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
