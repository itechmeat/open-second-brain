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
 * `acceptedExisted` / `materializedExisted` are captured before the
 * sequence starts so a rollback never deletes a file the sequence did not
 * create.
 *
 * The materialize step writes ONE artifact, but not always the same kind
 * of one: a mined or declared proposal materializes a procedure inside the
 * vault, and a `mature_page` proposal materializes a `SKILL.md` under the
 * configured skills root, which may sit OUTSIDE the vault. So the journal
 * records the absolute path the step is about to write
 * ({@link SkillAcceptJournalEntry.materializedPath}) rather than leaving
 * the resolver to re-derive it from the slug - a rollback that guessed the
 * wrong tree would leave the real artifact behind and claim it had not.
 * The field is optional: a marker written before it existed names the
 * procedure path implicitly, and the resolver falls back to that.
 *
 * The same guess problem applies to the TREE the path sits in: a caller
 * (CLI flag, MCP server config) can resolve the skills root differently
 * from what recovery would resolve on its next run. So a skill
 * materialization also records the root its accept resolved
 * ({@link SkillAcceptJournalEntry.skillsRoot}); the field is optional and
 * absent on legacy markers and on procedure materializations, which never
 * consult the skills tree.
 *
 * The journal is a repair marker, not history: it is removed as soon as
 * the sequence completes or is resolved. A journal left on disk means a
 * sequence is still outstanding.
 *
 * The marker file itself is agent-writable, and its `materializedPath`
 * drives the rollback's deletion and the restore's rewrite, so the parser
 * refuses (security audit M4, the deletion sink) a `materialized_path` the
 * accept sequence cannot have produced on a marker whose target did not
 * exist - the shape the rollback's `rmSync` reads with no at-use guard in
 * front of it: a relative value (the module writes only absolute paths), or
 * an absolute path resolving outside the vault and the skills root the
 * materialize step used - the root the marker itself records when present,
 * else the default resolution (a legacy marker names no root). On a legacy
 * marker, the one shape left outside both roots stays admissible - a
 * `mature_page` materialization under a caller's override skills root,
 * which the marker cannot name - recognized as an absolute path ending in
 * the skill page filename. On a marker whose target DID exist, the path
 * reaches only the restore branch, which validates its own target at use;
 * there the parser stays permissive so diagnosis can still read the marker.
 * A refused marker is unreadable data, exactly like a corrupt one: named,
 * retained, and blocking every accept until an operator removes it. A
 * hand-edited journal is not a recovery input.
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
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { resolveSkillsDir } from "../config.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import { ensureInsideVault } from "../path-safety.ts";
import { SKILL_FILE_NAME } from "../surface/skills.ts";
import { requireNextStep } from "./next-step.ts";
import {
  BRAIN_SKILL_ACCEPT_JOURNAL_REL,
  skillAcceptJournalPath,
  skillAcceptPriorContentPath,
} from "./paths.ts";
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
  /** The materialize target was already on disk before the sequence started. */
  readonly materializedExisted: boolean;
  /**
   * Absolute path the materialize step writes. Absent on a marker written
   * before this field existed, where the target is the procedure path the
   * slug derives.
   */
  readonly materializedPath?: string;
  /**
   * The skills root the accept sequence resolved for a skill
   * materialization: the caller's override, the configured `skills_dir`,
   * or the vault's own skills subtree. Recovery and the parse-time guard
   * check the journal's materialized path against this root rather than
   * re-deriving one. Absent on legacy markers and on procedure
   * materializations, which never consult the skills tree; both fall back
   * to the default resolved root.
   */
  readonly skillsRoot?: string;
  /**
   * Vault-side copy of the incumbent bytes, captured before a scored
   * rewrite's materialize step OVERWRITES an existing SKILL.md. Present
   * only when the sequence was about to displace content; the rollback
   * restores the incumbent BODY from it, not just its existence. Absent
   * on markers written before rewrites existed, and on sequences whose
   * materialize target did not exist.
   */
  readonly priorContentPath?: string;
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
    // Written under the historical key so a marker this build leaves behind
    // is still readable by the build that shipped the key.
    procedure_existed: entry.materializedExisted,
    ...(entry.materializedPath !== undefined ? { materialized_path: entry.materializedPath } : {}),
    ...(entry.skillsRoot !== undefined ? { skills_root: entry.skillsRoot } : {}),
    ...(entry.priorContentPath !== undefined ? { prior_content_path: entry.priorContentPath } : {}),
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

/**
 * Remove the journal for `slug`, and the prior-content copy beside it
 * when a rewrite captured one. Idempotent: both removals are forced, so
 * clearing a journal that never captured anything is not an error.
 */
export function clearSkillAcceptJournal(vault: string, slug: string): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  rmSync(skillAcceptJournalPath(vault, slug), { force: true });
  rmSync(skillAcceptPriorContentPath(vault, slug), { force: true });
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
  // Resolved once per read: the DEFAULT skills root, used by the
  // parse-time materialized-path guard when a marker records no root of
  // its own (legacy markers, procedure materializations).
  const defaultSkillsRoot = resolveJournalSkillsRoot(vault);
  const entries: SkillAcceptJournalEntry[] = [];
  const unreadable: UnreadableSkillAcceptJournal[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(JOURNAL_SUFFIX)) continue;
    const path = join(dir, name);
    const parsed = parseJournal(path, vault, defaultSkillsRoot);
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

function parseJournal(
  path: string,
  vault: string,
  defaultSkillsRoot: string,
): SkillAcceptJournalEntry | UnreadableSkillAcceptJournal {
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
  const materializedPath = raw["materialized_path"];
  const priorContentPath = raw["prior_content_path"];
  const skillsRoot = raw["skills_root"];
  const recordedSkillsRoot =
    typeof skillsRoot === "string" && skillsRoot.length > 0 ? skillsRoot : undefined;
  const materializedExisted = raw["procedure_existed"] === true;
  // The rollback's rmSync is the one sink a hand-edited path reaches with
  // no at-use guard in front of it. The restore branch validates its own
  // target (security audit M4), and once the target existed mid-sequence
  // the path feeds nothing else - so the parse boundary refuses an
  // unproducible path exactly where the deletion sink reads it, against
  // the skills root the marker itself records when present, else the
  // default resolution.
  if (!materializedExisted && typeof materializedPath === "string" && materializedPath.length > 0) {
    const refusal = refusedMaterializedPathDetail(
      materializedPath,
      vault,
      recordedSkillsRoot ?? defaultSkillsRoot,
      recordedSkillsRoot !== undefined,
    );
    if (refusal !== null) return Object.freeze({ path, detail: refusal });
  }
  return Object.freeze({
    slug,
    id,
    phase: phase as SkillAcceptPhase,
    startedAt,
    acceptedExisted: raw["accepted_existed"] === true,
    materializedExisted,
    ...(typeof materializedPath === "string" && materializedPath.length > 0
      ? { materializedPath }
      : {}),
    ...(recordedSkillsRoot !== undefined ? { skillsRoot: recordedSkillsRoot } : {}),
    ...(typeof priorContentPath === "string" && priorContentPath.length > 0
      ? { priorContentPath }
      : {}),
  });
}

/**
 * The DEFAULT skills root, used by the parse-time guard when a marker
 * records no root of its own: the configured override, else the vault's
 * own skills subtree. The same resolution a legacy accept performed, so
 * the guard admits exactly the paths such an accept can write.
 */
function resolveJournalSkillsRoot(vault: string): string {
  return resolveSkillsDir() ?? join(vault, "Brain", "skills");
}

/**
 * The parse-time refusal for a journal-supplied `materialized_path` on a
 * marker whose target did not exist (the rollback's deletion shape), or
 * null when the accept sequence itself could have written it.
 *
 * `skillsRoot` is the root the marker itself recorded when it names one,
 * else the default resolution; `skillsRootRecorded` says which. A value
 * the module cannot have produced is refused at the boundary both readers
 * share, before any recovery touches the filesystem: a relative value (the
 * module writes only absolute paths), or an absolute path resolving
 * outside the vault and that root - except on a LEGACY marker, where the
 * one shape recovery cannot re-derive stays admissible: a `mature_page`
 * materialization under a caller's override skills root the marker cannot
 * name, recognized as an absolute path ending in the skill page filename
 * (this also keeps legacy markers readable across a skills-dir config
 * change between accept and recovery). A marker that records its root
 * needs no such escape: its recorded root bounds the materialize tree, and
 * only the module's own shape inside it is admitted.
 */
function refusedMaterializedPathDetail(
  value: string,
  vault: string,
  skillsRoot: string,
  skillsRootRecorded: boolean,
): string | null {
  if (!isAbsolute(value)) {
    return (
      `materialized_path '${value}' is not an absolute path; the accept sequence writes only ` +
      "absolute paths, so this marker was hand-edited and is not a recovery input"
    );
  }
  if (isLexicallyInside(value, vault)) return null;
  if (isLexicallyInside(value, skillsRoot)) {
    if (!skillsRootRecorded) return null;
    if (basename(value) === SKILL_FILE_NAME) return null;
  } else if (!skillsRootRecorded && basename(value) === SKILL_FILE_NAME) {
    return null;
  }
  return skillsRootRecorded
    ? `materialized_path '${value}' resolves outside the vault and the skills root the accept ` +
        `recorded (${skillsRoot}) and is not a materialized ${SKILL_FILE_NAME} path; ` +
        "a hand-edited journal is not a recovery input"
    : `materialized_path '${value}' resolves outside the vault and the skills root ` +
        `(${skillsRoot}) and is not a materialized ${SKILL_FILE_NAME} path; a hand-edited ` +
        "journal is not a recovery input";
}

/**
 * Lexical containment of `target` inside `root`, mirroring the rollback
 * confinement predicate in `skill-proposals` (`isLexicallyInside` there):
 * `path.resolve` normalisation plus the platform separator, so the
 * parse-time guard and the at-use guard admit the same paths.
 */
function isLexicallyInside(target: string, root: string): boolean {
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(root) + sep;
  return resolvedTarget.startsWith(resolvedRoot);
}
