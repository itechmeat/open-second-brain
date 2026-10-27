/**
 * Folder-level note lifecycle: `move-folder` and `rename-folder`
 * (t_9571a47f).
 *
 * The note-file lifecycle (`./lifecycle.ts`) is defined per FILE: re-
 * organizing a vault by folder means moving notes one at a time through a
 * surface that refuses any directory change, which is how inbound
 * path-spelled wikilinks break by hand. This module moves a whole folder
 * in one call on the SAME terms the file surface set: the same path
 * envelope minus the `.md` rung, the same link-assert-unlink relocation,
 * the same count guard, the same dry-run default, and the same settled
 * partial-failure doctrine - a mid-set failure is NAMED, never rolled
 * back.
 *
 * ## The envelope has one rung less, and nothing else
 *
 * `resolveNoteTarget` requires a `.md` suffix, which a folder cannot
 * carry; every other rung is mirrored here rung for rung: vault-relative
 * (no absolute path), separators this host reads the way the caller wrote
 * them, no `..` traversal, not the `Brain/` machinery root (on the
 * spelled and the realpath alike, case-insensitively), vault-scope
 * checks, the operator's write binding, inside the vault. The SOURCE must
 * additionally stat as a directory - `source_missing`, the refusal a
 * path with no folder gets - and the vault root is refused as a subject.
 *
 * ## Why one rewrite pass is genuinely complete here
 *
 * A folder move never changes a basename. The bare `[[Name]]` spelling
 * resolved by carrier count before the move and resolves by the same
 * carrier count after it - the carriers moved, the count did not - so
 * `decideBasename`'s whole question does not arise and the bare-name
 * repair pass the file surface needs has nothing to do. Only PATH-spelled
 * links (`[[Projects/Old/a]]`, `[[Projects/Old/a.md]]`) break, and ONE
 * `retargetWikilinks` call over all pairs - minimal spellings computed
 * against the post-move population - fixes them, including links inside
 * the moved folder, because the pass matches text rather than live paths.
 *
 * ## Nothing here is atomic, and the report says where it split
 *
 * The move set is the vault's MARKDOWN, the same population every
 * lifecycle surface addresses (`retargetWikilinks`'s own walk produces
 * it): other files are not notes, are not moved, and are not this
 * operation's business. A folder whose subtree holds them reports the
 * Markdown relocations honestly in `moved` and leaves the rest standing
 * - the prune at the end removes only what the moves genuinely emptied.
 *
 * Occupancy is eliminated up front: every destination file path, and the
 * destination folder itself, is checked (with the dev/ino case-only
 * exemption) BEFORE the first rename, and an occupied destination refuses
 * naming every collision with nothing moved. What the pre-flight cannot
 * eliminate is a mid-set I/O fault, and rolling one back would mean
 * unlinking already-moved destination names - new destructive behavior
 * the snapshot gate does not cover. So the set continues and the result
 * reports the split point exactly: `moved` is what relocated,
 * `moveFailures` is what did not and why, and EVERYTHING downstream - the
 * rewrite pairs, the spellings reported - is computed from the
 * successfully moved set only. A file that failed to move keeps its old
 * path, its inbound links stay correct, and no pair of theirs enters the
 * pass. Relocations are byte-preserving and destroy nothing, so - as on
 * the file surface - no destructive snapshot is taken for a move.
 */

import { mkdirSync, readdirSync, rmdirSync, statSync, type Stats } from "node:fs";
import { join, posix, sep, win32 } from "node:path";

import { checkWriteBinding } from "../../write-binding/index.ts";
import { ensureInsideVault, realVaultRelative } from "../../path-safety.ts";
import { pathCovers } from "../../vault-scope/defaults.ts";
import { assertExpectedCount } from "../count-guard.ts";
import { classifyRecoverability, type RecoverabilityVerdict } from "../gates/recoverability.ts";
import { minimalSpellingFor } from "../link-graph/minimal-spelling.ts";
import { retargetWikilinks } from "../page-dedup.ts";
import { BRAIN_LOG_REL, BRAIN_CONFIG_FILE, BRAIN_ROOT_REL, isUnderBrainRoot } from "../paths.ts";
import { BrainConfigError } from "../policy.ts";
import { requireNextStep } from "../next-step.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import {
  inspectPath,
  resolveVaultScope,
  type InspectResult,
  type VaultScope,
} from "../../vault-scope/index.ts";
import {
  BASENAME_REWRITE,
  INDEX_REFRESH,
  namesSameEntry,
  NOTE_LIFECYCLE_ACTION,
  NoteLifecycleError,
  readIndexEvidence,
  relocateFileBytes,
  type IndexEvidence,
  type IndexRefresh,
  type NoteLifecycleAction,
  type NoteReferenceReport,
} from "./lifecycle.ts";
// The claim itself is NOT re-exported by `./lifecycle.ts` (only the
// vocabulary and the evidence read are, for reporters): sibling writers
// import it from the module that owns it, exactly as the create and
// content-update writers do.
import { claimPostWriteRefresh } from "./index-refresh.ts";
import { CreateNoteError, NOTE_CONFIG_INVALID_CODE } from "./create-note.ts";

// ----- What a caller may ask for --------------------------------------------

/**
 * The folder actions, spelled by the ONE lifecycle vocabulary
 * (`NOTE_LIFECYCLE_ACTION`) so the CLI guard, the MCP enum and the
 * manifest cannot drift apart. The file actions refuse a folder subject
 * (their envelope requires `.md`), and this surface refuses the file
 * actions by name: `delete` and `archive` are decisions about a FILE, and
 * running them over a directory would invent new destructive behavior
 * this module does not own.
 */
export const FOLDER_LIFECYCLE_ACTION = Object.freeze({
  /** Move a whole folder under a destination parent. */
  moveFolder: NOTE_LIFECYCLE_ACTION.moveFolder,
  /** Rename a whole folder within its parent. */
  renameFolder: NOTE_LIFECYCLE_ACTION.renameFolder,
} as const);

/** Closed union over {@link FOLDER_LIFECYCLE_ACTION}. */
export type FolderLifecycleAction =
  (typeof FOLDER_LIFECYCLE_ACTION)[keyof typeof FOLDER_LIFECYCLE_ACTION];

/** Membership list. */
export const FOLDER_LIFECYCLE_ACTIONS: ReadonlyArray<FolderLifecycleAction> = Object.freeze(
  Object.values(FOLDER_LIFECYCLE_ACTION),
);

/**
 * `unknown` rather than `string`: the value arrives as an untyped MCP
 * argument or a raw CLI positional, exactly like
 * {@link isNoteLifecycleAction}, whose census probing this guard shares.
 */
export function isFolderLifecycleAction(value: unknown): value is FolderLifecycleAction {
  return (
    typeof value === "string" && (FOLDER_LIFECYCLE_ACTIONS as ReadonlyArray<string>).includes(value)
  );
}

// ----- Inputs, results, refusals --------------------------------------------

export interface FolderLifecycleInput {
  /** `move-folder` or `rename-folder`; every other action is refused. */
  readonly action: NoteLifecycleAction;
  /** Vault-relative path of the subject folder. */
  readonly path: string;
  /**
   * `move-folder`: the vault-relative destination DIRECTORY (the folder
   * lands under it, keeping its name). `rename-folder`: the new single-
   * segment name, under the same parent. Required for both.
   */
  readonly to?: string;
  /** False (the default) walks, counts and writes nothing. */
  readonly apply?: boolean;
  /** `--expect N`: assert the inbound-reference count before any write. */
  readonly expect?: number | null;
  /** `--strict`: refuse a mutation carrying no `--expect` guard. */
  readonly strict?: boolean;
  /** Injected clock, forwarded to the recovery claim so a run stays reproducible. */
  readonly now?: Date;
  /**
   * May the caller read the vault file at this vault-relative path? One
   * it may not read is reported as a vault without it would be - absent
   * from `inboundFiles`, `filesScanned` and `rewriteFailures` - the same
   * rule the file surface's `readable` documents. Absent, every file
   * counts (the CLI, which reads the vault directly).
   */
  readonly readable?: (rel: string) => boolean;
  /** Test seam: replaces the detached spawn of the post-write index refresh. */
  readonly refreshSpawn?: (argv: string[]) => void;
  /**
   * The config file the post-write refresh resolves the search config
   * through - the caller's `--config` (or the MCP server's config path).
   */
  readonly refreshConfigPath?: string;
}

/** One file that relocated. */
export interface FolderMovedPath {
  /** Vault-relative path the file was at. */
  readonly from: string;
  /** Vault-relative path it is at now. */
  readonly to: string;
}

/** One file the set could not relocate, with the filesystem's reason. */
export interface FolderMoveFailure {
  /** Vault-relative path the file KEEPS - it never moved. */
  readonly path: string;
  /** The filesystem's own message, never a re-description of it. */
  readonly reason: string;
}

export interface FolderLifecycleResult {
  readonly action: FolderLifecycleAction;
  /** Vault-relative path the folder was at. */
  readonly from: string;
  /** Vault-relative path it is at now. */
  readonly to: string;
  /** False when this was a plan-only run. */
  readonly applied: boolean;
  /**
   * Every file that relocated, sorted by its old path. A plan-only run
   * relocates nothing and reports the PLANNED set here - the preview the
   * apply would carry out - so an empty list always means an empty move
   * set, never an unapplied one; {@link FolderLifecycleResult.applied}
   * carries that distinction.
   */
  readonly moved: ReadonlyArray<FolderMovedPath>;
  /**
   * Every file that did not relocate, with why. Non-empty means the
   * operation is HALF-APPLIED: the rewrite pairs were computed from
   * {@link FolderLifecycleResult.moved} only, so each failure's inbound
   * links still name the path its bytes are actually at. Never rolled
   * back - see the module header for why that is the better half-state.
   */
  readonly moveFailures: ReadonlyArray<FolderMoveFailure>;
  /** What the recovery point (if any) is worth for THIS operation. */
  readonly recoverability: RecoverabilityVerdict;
  /**
   * Always `null`, kept for shape parity with the file result: a
   * relocation destroys nothing, so no recovery point is taken for a
   * move. The REWRITE's risk is what {@link FolderLifecycleResult.recoverability}
   * grades, exactly as on the file surface.
   */
  readonly snapshot: null;
  /** What happened to inbound references, and on what evidence. */
  readonly references: NoteReferenceReport;
}

// ----- The folder envelope: resolveNoteTarget minus the `.md` rung ----------

/** The separator that is structure on Windows and a filename character elsewhere. */
const FOLDER_WINDOWS_SEP = win32.sep;

/** Registry code for a vault whose Brain config does not load. */
const FOLDER_CONFIG_INVALID_EXIT = requireNextStep(NOTE_CONFIG_INVALID_CODE).nextCommand;

/** Vault-relative spelling of the config file every refusal here names. */
const BRAIN_CONFIG_REL = posix.join(BRAIN_ROOT_REL, BRAIN_CONFIG_FILE);

/**
 * Translate a Brain config failure into this surface's typed refusal -
 * the same composition `resolveNoteTarget` uses, so a malformed config
 * reads the same on whichever surface reaches it first.
 */
function withConfigFault<T>(read: () => T): T {
  try {
    return read();
  } catch (err) {
    if (err instanceof BrainConfigError) {
      throw new CreateNoteError(
        "config_invalid",
        `${BRAIN_CONFIG_REL}: ${err.message}; ${FOLDER_CONFIG_INVALID_EXIT}`,
      );
    }
    throw err;
  }
}

/**
 * Refuse a caller-named path whose separators this host does not read the
 * way the caller wrote them - the same refusal `resolveNoteTarget` makes,
 * for the same reason: normalising `\` would silently reinterpret the
 * caller's string into a path it did not send.
 */
function assertHostPathSeparators(path: string): void {
  if (FOLDER_WINDOWS_SEP === sep) return;
  if (!path.includes(FOLDER_WINDOWS_SEP)) return;
  throw new CreateNoteError(
    "invalid_path",
    `folder path must use '${posix.sep}' to separate segments; on this host ` +
      `'${FOLDER_WINDOWS_SEP}' is an ordinary filename character, so the path would not ` +
      `mean what it looks like: ${path}`,
  );
}

/** The refusal sentence for a path vault scope rejects - `create-note.ts`'s wording. */
function scopeRefusal(scope: VaultScope, inspected: InspectResult): string {
  if (inspected.reason === "not-included") {
    return `path is outside vault.include_paths (${(scope.includePaths ?? []).join(", ")})`;
  }
  return `path is excluded by vault.ignore_paths (${inspected.rule?.raw ?? "rule"})`;
}

/**
 * A folder path resolved through the shared write safety envelope: the
 * exact ladder {@link resolveNoteTarget} runs, minus the `.md` rung a
 * folder cannot pass. Both the source folder and the destination folder
 * go through it, so a destination cannot reach somewhere a note could not
 * live.
 *
 * `allowVaultRoot` relaxes exactly one rung, for exactly one caller: the
 * destination DIRECTORY of a `move-folder` may be the vault root, because
 * a folder may land at the top level - while the root itself stays
 * refused as a SUBJECT (a subject is what moves; the root is what
 * everything moves within).
 */
function resolveFolderTarget(
  vault: string,
  path: string,
  opts: { readonly allowVaultRoot?: boolean } = {},
): { relPath: string; abs: string } {
  if (path.startsWith(posix.sep) || path.startsWith(FOLDER_WINDOWS_SEP)) {
    throw new CreateNoteError("invalid_path", `folder path must be vault-relative: ${path}`);
  }
  assertHostPathSeparators(path);

  const scope = withConfigFault(() => resolveVaultScope(vault));
  let inspected;
  try {
    inspected = inspectPath(path, scope, vault);
  } catch (err) {
    throw new CreateNoteError("invalid_path", err instanceof Error ? err.message : String(err));
  }
  const relPath = inspected.relPath;
  // The vault root (`""`, or a spelling `inspectPath` normalises to it)
  // is the whole vault: moving or renaming it is not a folder operation,
  // and pretending otherwise would report a move of every note in the
  // vault under one `moved` count.
  if (relPath === "" && opts.allowVaultRoot !== true) {
    throw new CreateNoteError(
      "invalid_path",
      `the vault root is not a folder subject: ${path === "" ? "(empty path)" : path}`,
    );
  }
  if (relPath === "") {
    // Reachable only with `allowVaultRoot`: the destination directory IS
    // the vault, inside it by definition, with no realpath or binding
    // rung of its own left to run - every file that lands beneath it
    // resolves through a full pass of its own.
    return { relPath: "", abs: ensureInsideVault(vault, vault) };
  }

  if (isUnderBrainRoot(relPath)) {
    throw new CreateNoteError(
      "excluded",
      `the Brain machinery root is not writable via the folder lifecycle: ${relPath}`,
    );
  }
  let landsAt: string | null;
  try {
    landsAt = realVaultRelative(vault, relPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
    throw new CreateNoteError(
      "invalid_path",
      `folder path cannot be resolved (${code}): ${relPath}`,
    );
  }
  if (landsAt === null) {
    throw new CreateNoteError(
      "outside_vault",
      `folder path resolves outside the vault: ${relPath}`,
    );
  }
  if (isUnderBrainRoot(landsAt)) {
    throw new CreateNoteError(
      "excluded",
      `the Brain machinery root is not writable via the folder lifecycle: ${relPath} resolves to ${landsAt}`,
    );
  }
  if (inspected.excluded) {
    throw new CreateNoteError("excluded", `${scopeRefusal(scope, inspected)}: ${relPath}`);
  }
  const refusal = withConfigFault(() => checkWriteBinding(vault, relPath));
  if (refusal !== null) {
    throw new CreateNoteError("write_binding", refusal.message);
  }
  let abs: string;
  try {
    abs = ensureInsideVault(join(vault, relPath), vault);
  } catch (err) {
    throw new CreateNoteError("outside_vault", err instanceof Error ? err.message : String(err));
  }
  return { relPath, abs };
}

// ----- Path helpers (folder-shaped) -----------------------------------------

/** `Projects/Old` -> `Old`. */
function folderBasename(relPath: string): string {
  return relPath.split(posix.sep).at(-1) ?? relPath;
}

/** `Projects/Old` -> `Projects`, and `Old` -> `""`. */
function folderParent(relPath: string): string {
  const cut = relPath.lastIndexOf(posix.sep);
  return cut < 0 ? "" : relPath.slice(0, cut);
}

/** The `.md` suffix, matched case-insensitively. */
const MARKDOWN_SUFFIX = ".md";

/** `Projects/Old/a.md` -> `Projects/Old/a`. */
function withoutSuffix(relPath: string): string {
  return relPath.toLowerCase().endsWith(MARKDOWN_SUFFIX)
    ? relPath.slice(0, -MARKDOWN_SUFFIX.length)
    : relPath;
}

/** `statSync`, or `null` when the path is not there or cannot be read. */
function statOrNull(target: string): Stats | null {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

/** `readdirSync`, or `null` when the directory cannot be read. */
function readdirOrNull(target: string): string[] | null {
  try {
    return readdirSync(target);
  } catch {
    return null;
  }
}

/**
 * Subtrees the rewrite pass READS and REPORTS but never rewrites - the
 * file surface's one entry, shared for the same reason: `Brain/log` is an
 * append-only record of what an agent said at an instant, and repairing
 * testimony changes what it says was said.
 */
const APPEND_ONLY_REL: ReadonlyArray<string> = Object.freeze([BRAIN_LOG_REL]);

/** The walk root the reference scan and the move-set planning share: the whole vault. */
const VAULT_ROOT_REL = "";

/** Where one planned file goes, with the dev/ino answer for its destination name. */
interface PlannedMove {
  readonly fromRel: string;
  readonly toRel: string;
  readonly fromAbs: string;
  readonly toAbs: string;
  /** The case-only folder rename: destination name IS the source entry. */
  readonly sameEntry: boolean;
}

// ----- Destination resolution -----------------------------------------------

/**
 * Resolve the destination FOLDER this action implies, through the same
 * envelope as the source, and refuse the caller mistakes the file
 * surface's rename/move split exists to catch - at folder granularity:
 * `move-folder` must change the folder's parent, `rename-folder` must
 * keep it.
 *
 * The destination directory a `move-folder` names is judged in its own
 * right: it is resolved through the envelope first, and a destination
 * directory that sits in the source's own parent is refused as the
 * spelling of a RENAME intent - a caller reading `to` as the folder's
 * new full path, which is exactly the mistake no path check would
 * otherwise catch, because both spellings name legal destinations.
 */
function resolveFolderDestination(
  vault: string,
  input: FolderLifecycleInput,
  source: { relPath: string; abs: string },
): { relPath: string; abs: string } {
  if (input.to === undefined) {
    throw new NoteLifecycleError(
      "destination_required",
      `${input.action} requires a destination ('to')`,
    );
  }
  const action = input.action;
  if (action === FOLDER_LIFECYCLE_ACTION.renameFolder) {
    if (input.to.includes(posix.sep) || input.to.includes(FOLDER_WINDOWS_SEP)) {
      // Refused as the caller mistake it is - a rename spelled across
      // parents - not normalised into the move it did not ask for.
      throw new NoteLifecycleError(
        "wrong_action",
        `rename-folder keeps the folder in ${folderParent(source.relPath) || "the vault root"}; ` +
          `'${input.to}' crosses parents - use move-folder`,
      );
    }
  }
  if (action === FOLDER_LIFECYCLE_ACTION.moveFolder) {
    const destinationDirectory = resolveFolderTarget(vault, input.to, { allowVaultRoot: true });
    // A destination directory inside the source's own subtree nests the
    // tree inside itself: every planned path stays a strict descendant of
    // the source, so the file-surface refusals (same path, same parent)
    // all pass while the operation folds the folder into its own
    // descendant. Refused on the destination DIRECTORY the caller named -
    // the computed landing path is necessarily deeper still.
    if (
      destinationDirectory.relPath === source.relPath ||
      destinationDirectory.relPath.startsWith(`${source.relPath}/`)
    ) {
      throw new NoteLifecycleError(
        "destination_inside_source",
        `${action} destination ${destinationDirectory.relPath} sits inside the source folder ` +
          `${source.relPath}; the folder would nest inside itself`,
      );
    }
    const destination = resolveFolderTarget(
      vault,
      posix.join(destinationDirectory.relPath, folderBasename(source.relPath)),
    );
    if (destination.relPath === source.relPath) {
      throw new NoteLifecycleError(
        "destination_unchanged",
        `${action} destination is the source folder: ${source.relPath}`,
      );
    }
    if (folderParent(destinationDirectory.relPath) === folderParent(source.relPath)) {
      throw new NoteLifecycleError(
        "wrong_action",
        `move-folder changes the folder's parent; ${destinationDirectory.relPath} sits in ` +
          `${folderParent(source.relPath) || "the vault root"}, where ${source.relPath} lives - ` +
          `use rename-folder`,
      );
    }
    return destination;
  }
  const destination = resolveFolderTarget(
    vault,
    posix.join(folderParent(source.relPath), input.to),
  );
  if (destination.relPath === source.relPath) {
    throw new NoteLifecycleError(
      "destination_unchanged",
      `${action} destination is the source folder: ${source.relPath}`,
    );
  }
  return destination;
}

// ----- Occupancy pre-flight --------------------------------------------------

/**
 * Check EVERY destination before the first rename and refuse naming every
 * collision. Within-set collisions are impossible (the relative structure
 * is preserved), so the only collisions are with pre-existing files and
 * directories at the destination - and finding them all before anything
 * moves is the closest thing to atomicity this operation honestly has.
 * The check runs on the PLAN, so a zero-file move set is covered too: an
 * empty folder whose destination path is taken by a FILE refuses exactly
 * like a full one.
 *
 * A destination folder that exists is an occupancy unless it is EMPTY
 * (the files land into it) or is the same directory entry as the SOURCE
 * folder (the case-only folder rename). A destination FILE path is an
 * occupancy unless it names the same entry as its source file - the
 * case-only rename's per-file face.
 */
function assertDestinationsFree(
  planned: ReadonlyArray<PlannedMove>,
  sourceAbs: string,
  destination: { relPath: string; abs: string },
): void {
  const collisions: string[] = [];
  const destinationStat = statOrNull(destination.abs);
  if (destinationStat !== null && !destinationStat.isDirectory()) {
    collisions.push(destination.relPath);
  } else if (
    destinationStat !== null &&
    !namesSameEntry(sourceAbs, destination.abs) &&
    readdirSync(destination.abs).length > 0
  ) {
    collisions.push(`${destination.relPath} (not empty)`);
  }
  for (const move of planned) {
    const destinationStat = statOrNull(move.toAbs);
    if (destinationStat === null) continue;
    if (namesSameEntry(move.fromAbs, move.toAbs)) continue;
    collisions.push(move.toRel);
  }
  if (collisions.length > 0) {
    throw new NoteLifecycleError(
      "destination_occupied",
      `destinations already exist and nothing was moved: ${collisions.join(", ")}`,
    );
  }
}

// ----- The operation ----------------------------------------------------------

/**
 * Run one folder lifecycle operation. Ordering is load-bearing, as on the
 * file surface: the envelope judges both folders before anything is read;
 * the walk establishes the move set and the blast radius before the count
 * guard runs; the occupancy pre-flight runs before the first rename; the
 * rewrite runs once, over the successfully moved set's pairs; and the
 * index evidence is read at the END, with the refresh claim trailing it.
 */
export async function folderLifecycle(
  vault: string,
  input: FolderLifecycleInput,
): Promise<FolderLifecycleResult> {
  const apply = input.apply === true;
  // Vault-identity write guard (context-integrity-gates, Unit J) - on the
  // planning path too, exactly as the file surface asserts it: a plan
  // names real vault paths, and computing one against a vault this
  // process was not pointed at is already the confusion the guard exists
  // to refuse.
  assertVaultIdentityForWrite(vault);

  if (!isFolderLifecycleAction(input.action)) {
    throw new NoteLifecycleError(
      "wrong_action",
      `the folder lifecycle runs ${FOLDER_LIFECYCLE_ACTIONS.join(" | ")}; ` +
        `'${input.action}' is a note-file action and refuses a folder subject`,
    );
  }
  const action = input.action;
  const source = resolveFolderTarget(vault, input.path);
  const sourceStat = statOrNull(source.abs);
  if (sourceStat === null || !sourceStat.isDirectory()) {
    throw new NoteLifecycleError("source_missing", `no note folder at ${source.relPath}`);
  }
  const destination = resolveFolderDestination(vault, input, source);
  const reported = (rel: string): boolean => input.readable?.(rel) ?? true;

  // Pass one: walk the whole vault once. This is the move set's source,
  // the post-move population the minimal spellings are computed against,
  // and the filesScanned denominator - one walk, so no two of those can
  // see different vaults.
  const walk = retargetWikilinks(vault, [], { root: VAULT_ROOT_REL, apply: false });
  const vaultFiles = walk.files;
  const underSource = (rel: string): boolean =>
    rel === source.relPath || rel.startsWith(`${source.relPath}/`);
  const movingSet = vaultFiles.filter(underSource).toSorted();
  // An empty move set over a folder the disk says is non-empty is not a
  // quiet success waiting to happen - it is a spelling that matched
  // nothing. The move set is a STRING prefix match of the caller's
  // spelling of the source against the walk's own spellings, so a path
  // whose case (or Unicode normalization form) differs from the vault's
  // real names stats fine on a case-insensitive host and yet matches no
  // walked file: the operation would report applied:true with an empty
  // `moved` and leave the whole tree standing. Refused instead, naming
  // the suspicion. A directory this process cannot read states nothing
  // about emptiness, so it does not refuse here - the per-file machinery
  // names the fault if the move really is attempted.
  const sourceEntries = readdirOrNull(source.abs);
  if (movingSet.length === 0 && sourceEntries !== null && sourceEntries.length > 0) {
    throw new NoteLifecycleError(
      "move_set_empty",
      `no Markdown moves from ${source.relPath} but the folder is not empty on disk: ` +
        `the walk saw ${vaultFiles.length} Markdown file(s) and none sits under the path as ` +
        "spelled - check the spelling, casing and character normalization of the path " +
        "against the vault's own names",
    );
  }
  const planned: PlannedMove[] = movingSet.map((fromRel) => {
    const toRel = `${destination.relPath}${fromRel.slice(source.relPath.length)}`;
    const fromAbs = ensureInsideVault(join(vault, fromRel), vault);
    const toAbs = ensureInsideVault(join(vault, toRel), vault);
    return { fromRel, toRel, fromAbs, toAbs, sameEntry: namesSameEntry(fromAbs, toAbs) };
  });

  // The occupancy gate runs on the plan too: a dry run that reports a
  // move it cannot perform would preview a lie.
  assertDestinationsFree(planned, source.abs, destination);

  // The post-move population: every file that is not moving, plus every
  // destination - the folder analogue of the file surface's
  // postRelocationPopulation, derived from the same walked list.
  const newRels = new Set(planned.map((move) => move.toRel));
  const postPopulation = [...vaultFiles.filter((rel) => !underSource(rel)), ...newRels].toSorted();

  // One pair set, no bare basename rung: a folder move never changes a
  // basename, so the bare `[[Name]]` spellings keep resolving and
  // bareNameRepairs has nothing to do. Each old spelling collapses onto
  // the minimal spelling of the destination, as on the file surface.
  const pairsFor = (moves: ReadonlyArray<PlannedMove>): { from: string; to: string }[] =>
    moves.flatMap((move) => {
      const to = minimalSpellingFor(move.toRel, postPopulation);
      return [
        { from: move.fromRel, to },
        { from: withoutSuffix(move.fromRel), to },
      ];
    });
  const plannedPairs = pairsFor(planned);

  const probe = retargetWikilinks(
    vault,
    plannedPairs.map((pair) => ({ from: pair.from })),
    { root: VAULT_ROOT_REL, apply: false },
  );
  const inboundFiles = probe.matched.filter(reported);
  const filesScanned = vaultFiles.filter(reported).length;

  assertExpectedCount({
    matched: inboundFiles.length,
    expect: input.expect ?? null,
    strict: input.strict === true,
    willMutate: apply,
    matchList: inboundFiles,
  });

  let moved: FolderMovedPath[] = apply
    ? []
    : // A plan-only run relocates nothing, so an empty `moved` would read
      // as "nothing to do" - the plan IS the preview, and it reports the
      // full set the apply would relocate (recon 1.3: a dry run reports
      // the full planned set and writes nothing).
      planned.map((move) => ({ from: move.fromRel, to: move.toRel }));
  let moveFailures: FolderMoveFailure[] = [];
  let rewritten: ReadonlyArray<string> = [];
  let rewriteFailures: ReadonlyArray<{ readonly path: string; readonly reason: string }> = [];
  let appliedPairs: ReadonlyArray<{ readonly from: string; readonly to: string }> = [];

  if (apply) {
    // The destination folder exists before the first relocation, so a
    // zero-file move set (an empty folder) still lands somewhere: the
    // per-file machinery below mkdirs the same parents, and the pre-
    // flight has already approved or refused this exact path.
    mkdirSync(destination.abs, { recursive: true });
    // The moves run in sorted order and the set continues past a failure:
    // by the time one file cannot relocate, others already have, and
    // undoing them would unlink destination names - new destructive
    // behavior no gate covers. The report names the split instead.
    for (const move of planned) {
      try {
        relocateFileBytes(move.fromAbs, move.toAbs, move.toRel, move.sameEntry);
        moved.push({ from: move.fromRel, to: move.toRel });
      } catch (err) {
        moveFailures.push({
          path: move.fromRel,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // The folders the moves emptied go with their files: bottom-up, and
    // only while genuinely empty, so a failed file's parent stays exactly
    // where the report says its bytes are. An empty folder moved with a
    // zero-file set is handled by the same prune - the source folder
    // itself is last.
    pruneEmptiedFolders(vault, source.relPath);
    // ONE rewrite pass over the SUCCESSFULLY moved set's pairs, under the
    // destination. A failed file's pairs are excluded, which is the
    // correct outcome: its inbound links still resolve to where its
    // bytes actually are.
    const movedPlanned = planned.filter((move) =>
      moved.some((entry) => entry.from === move.fromRel),
    );
    appliedPairs = pairsFor(movedPlanned);
    const pass = retargetWikilinks(vault, appliedPairs, {
      root: VAULT_ROOT_REL,
      apply: true,
      neverRewrite: APPEND_ONLY_REL,
    });
    rewritten = pass.rewritten.filter(reported);
    rewriteFailures = pass.failed
      .filter((failure) => reported(failure.path))
      .map((failure) => ({ path: failure.path, reason: failure.reason }))
      .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  // The MOVE destroys nothing; the REWRITE overwrites hand-authored prose
  // in place, so the blast radius is declared from the files this call
  // actually rewrote - the file surface's reading, region for region.
  const recoverability = classifyRecoverability({
    recoveryPoint: false,
    blastRadius: {
      ...(rewritten.some((rel) => pathCovers(BRAIN_ROOT_REL, rel)) ? { brainTopLevel: true } : {}),
      ...(rewritten.some((rel) => !pathCovers(BRAIN_ROOT_REL, rel))
        ? { outsideBrainRoot: true }
        : {}),
    },
  });

  const index: IndexEvidence = await readIndexEvidence(vault, apply, input.refreshConfigPath);
  // The refresh claim trails the evidence read on purpose: the evidence
  // must describe the index as this call left it, and the claim starts a
  // DETACHED run that will not have landed by any instant this call can
  // observe. A plan-only run claims nothing and refused nothing.
  let refresh: IndexRefresh;
  let refreshReason: string | null;
  if (apply) {
    const claim = await claimPostWriteRefresh(
      vault,
      index,
      input.refreshSpawn,
      input.now,
      input.refreshConfigPath,
    );
    refresh = claim.refresh;
    refreshReason = claim.refreshReason;
  } else {
    refresh = INDEX_REFRESH.notClaimed;
    refreshReason = null;
  }

  return Object.freeze({
    action,
    from: source.relPath,
    to: destination.relPath,
    applied: apply,
    moved: Object.freeze(
      moved.toSorted((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)),
    ),
    moveFailures: Object.freeze(
      moveFailures.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ),
    recoverability,
    snapshot: null,
    references: Object.freeze({
      filesScanned,
      inboundFiles: Object.freeze([...inboundFiles]),
      filesRewritten: rewritten.length,
      rewrittenSpellings: Object.freeze(appliedPairs.filter((pair) => pair.from.length > 0)),
      rewriteFailures: Object.freeze([...rewriteFailures]),
      basename: BASENAME_REWRITE.notNeeded,
      index,
      refresh,
      refreshReason,
    }),
  });
}

/**
 * Remove the subject folder when the moves genuinely emptied it.
 * `rmdirSync` removes only an empty directory, so a folder whose subtree
 * still holds a failed file - or any file this surface does not address -
 * keeps it, which is exactly where the report says the bytes are. The
 * prune is bounded at the subject: the folders ABOVE it are not this
 * operation's to delete, and an emptied `Projects/` left behind reads as
 * the ordinary residue a file move leaves too.
 */
function pruneEmptiedFolders(vault: string, fromRel: string): void {
  try {
    const abs = ensureInsideVault(join(vault, fromRel), vault);
    rmdirSync(abs);
  } catch {
    // The folder is not empty (or not removable): the residue stands, and
    // the report already names where every file is.
  }
}
