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
 * And the set is judged by REAL LOCATION, never by the spelling the walk
 * happened to reach a file through: the walk lists a note under whichever
 * alias of its directory won the walk, so a move set built from spellings
 * would relocate another folder's notes through a symlinked directory
 * inside the source, or read as an empty applied success when an alias
 * elsewhere was walked first. Membership - and the spelling every move
 * pair and rewrite pair carries - is decided by where a file really
 * lives: inside the source's real path, under the source's real name. A
 * symlinked directory inside the source therefore relocates none of the
 * foreign notes it reaches (the link is the named residue), a symlinked
 * note is left standing rather than hard-linking its target, and a
 * source reached through an alias is moved, reported and pruned under
 * the name its bytes actually answer to.
 *
 * Relative Markdown links and images are NOT wikilinks and get no
 * rewrite - the pass repairs `[[path]]` spellings only, and a relative
 * `![pic](diagram.png)` depends on the note's directory, which the move
 * changed. When a moved note's relative target stayed behind, the
 * receipt names the pair in `danglingRelativeLinks` instead of letting
 * `files_rewritten: 0` read as "nothing broke".
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

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { dirname, join, posix, sep, win32 } from "node:path";

import { checkWriteBinding } from "../../write-binding/index.ts";
import { ensureInsideVault, realVaultRelative, toPosix } from "../../path-safety.ts";
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
   * they may not is reported as a vault without it would be - absent
   * from `inboundFiles`, `filesScanned` and `rewriteFailures` - the same
   * rule the file surface's `readable` documents. The reach judges the
   * MOVE SET as well: a folder holding any note the caller may not read
   * is refused exactly as a missing folder, so neither the plan nor the
   * apply can name, count or relocate a page past the caller's reach. A
   * folder with no Markdown at all has no page to judge and moves.
   * Absent, every file counts (the CLI, which reads the vault directly).
   */
  readonly readable?: (rel: string) => boolean;
  /** Test seam: replaces the detached spawn of the post-write index refresh. */
  readonly refreshSpawn?: (argv: string[]) => void;
  /**
   * Test seam: the byte relocation itself, defaulting to the shared
   * {@link relocateFileBytes}. A stand-in produces faults the host cannot
   * schedule deterministically - a foreign file appearing at a destination
   * name the pre-flight had cleared, the exact race the occupied-name
   * guard exists for.
   */
  readonly relocate?: typeof relocateFileBytes;
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

/** One relative link or image in a moved note whose target stayed behind. */
export interface FolderDanglingLink {
  /**
   * The moved note, spelled at its NEW path - where the broken spelling
   * now lives.
   */
  readonly note: string;
  /** The relative target, spelled exactly as the note spells it. */
  readonly target: string;
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
  /**
   * What stayed in the source folder after the prune, from a readdir of
   * it once the prune had done its best. The move set is the vault's
   * MARKDOWN, so a subtree that also holds anything else - an image
   * beside the notes, a file the moves could not relocate - keeps its
   * source folder, and without this field the result would read as if
   * the folder went with its notes. Empty (and absent on the rendered
   * surfaces) means nothing was left behind: the folder itself is gone.
   * A plan-only run relocates nothing, so it leaves nothing behind
   * either.
   */
  readonly leftBehind: ReadonlyArray<string>;
  /**
   * The moved notes' RELATIVE Markdown links and images that no longer
   * resolve: targets the move did not carry (the set is the vault's
   * MARKDOWN) and that stayed behind in the source folder. The rewrite
   * pass repairs `[[path]]` spellings only, so without this field a
   * `files_rewritten: 0` would read as "nothing broke" while every moved
   * note's relative embed pointed at nothing. A target that moved with
   * its note still resolves and is not named; a vault-absolute or scheme
   * spelling never depended on the note's directory; a link that was
   * already dangling is not this operation's doing. A plan reports the
   * same judgment for its planned set. Empty (and absent on the rendered
   * surfaces) when nothing dangles.
   */
  readonly danglingRelativeLinks: ReadonlyArray<FolderDanglingLink>;
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
  // The folder envelope speaks POSIX: every judgment below compares or
  // slices relPath against real locations and walk spellings, which are
  // POSIX spellings on every platform. `inspectPath` joins its segments
  // with the platform separator, so without this rung a Windows relPath
  // carries backslashes and the spelled guards (`startsWith(`${rel}/`)`)
  // silently stop matching - the destination-inside-source refusal never
  // fires and the move nests the folder into itself on a case-folding
  // host.
  return { relPath: toPosix(relPath), abs };
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

/**
 * `lstatSync`, or `null` when the NAME is not there or cannot be read.
 * Unlike `statSync`/`existsSync` this judges the name itself, so a
 * symlink whose target is gone - a name this call created and then
 * reported as failed - still counts as present and can be dropped.
 */
function lstatOrNull(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch {
    return null;
  }
}

/**
 * The spelling the disk answers to: `relPath`'s real vault-relative
 * location, or the caller's spelling when that does not resolve (the
 * vault root, or a path whose deepest existing ancestor already carries
 * the answer). Every path this module JUDGES, MOVES or REPORTS goes
 * through it, so a symlink alias cannot make one folder look like two:
 * the review's H2/M15 faults were both spelling comparisons where one
 * side was an alias.
 */
function realSpelling(vault: string, relPath: string): string {
  return realVaultRelative(vault, relPath) ?? relPath;
}

/**
 * Whether the folder's REAL subtree holds any Markdown file: a plain
 * readdir that never follows a symlinked entry, because a link's name is
 * not a Markdown file of this subtree - its target's real location is
 * somewhere else (or nowhere) and is judged there. This is the disk's
 * own answer for the empty-move-set refusal, independent of what the
 * vault walk happened to list.
 */
function subtreeHoldsMarkdown(vault: string, fromRel: string): boolean {
  const stack: string[] = [join(vault, fromRel)];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(MARKDOWN_SUFFIX)) return true;
    }
  }
  return false;
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
 * Both judgments run on REAL paths, never on spellings. The source
 * arrives already normalized to the name its bytes answer to; the
 * destination directory is normalized here before anything is decided,
 * because a symlink alias spells a path outside the source while naming
 * the source itself (or something inside it) - the inside-source guard
 * comparing spellings let such a destination fold the folder into
 * itself, and a case-folded spelling slipped past the same way. The
 * landing path is reported in its real spelling too, so the receipt
 * names where the bytes actually went.
 *
 * The rename-intent heuristic for `move-folder` - a destination in the
 * source's own parent is the spelling of a RENAME - applies ONLY when
 * the named destination directory does not exist: an existing sibling
 * directory is a real move target (moving `Projects/Old` under an
 * existing `Projects/Archive`), and refusing it pointed at
 * `rename-folder`, which refuses the cross-parent move right back. A
 * sibling that is not there is exactly the caller mistake the heuristic
 * exists for, so it is refused by name. The heuristic exempts the top
 * level: a rename there spells a single segment, so `Old` under
 * `Archive` can only ever mean the move it asked for, and refusing it
 * would leave every top-level folder unmovable into a sibling
 * top-level directory.
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
  /** The landing folder, judged and reported in its real spelling. */
  const landing = (folder: { relPath: string; abs: string }): { relPath: string; abs: string } => {
    const real = realSpelling(vault, folder.relPath);
    return real === folder.relPath
      ? folder
      : { relPath: real, abs: ensureInsideVault(join(vault, real), vault) };
  };
  if (action === FOLDER_LIFECYCLE_ACTION.moveFolder) {
    const destinationDirectory = resolveFolderTarget(vault, input.to, { allowVaultRoot: true });
    const destinationReal = realSpelling(vault, destinationDirectory.relPath);
    // A destination directory inside the source's own subtree nests the
    // tree inside itself: every planned path stays a strict descendant of
    // the source, so the file-surface refusals (same path, same parent)
    // all pass while the operation folds the folder into its own
    // descendant. Refused on the destination DIRECTORY the caller named -
    // the computed landing path is necessarily deeper still - and judged
    // by real path on both sides, which is what an alias (or a case
    // fold) cannot talk its way past.
    if (destinationReal === source.relPath || destinationReal.startsWith(`${source.relPath}/`)) {
      throw new NoteLifecycleError(
        "destination_inside_source",
        `${action} destination ${destinationDirectory.relPath} sits inside the source folder ` +
          `${source.relPath} (it resolves on disk to ${destinationReal}); the folder would ` +
          "nest inside itself",
      );
    }
    // Spelling-independent rung: walk the destination chain up to the
    // vault root and refuse when any existing entry IS the source's own
    // directory entry. A file-identity compare is what a case fold, a
    // Unicode normalization form or an alias cannot talk past - the
    // spelled rungs above judge spellings, and a host that answers a
    // spelled path from a differently spelled real entry can slip a
    // mismatch past every one of them.
    const sourceEntry = statOrNull(source.abs);
    if (sourceEntry !== null && sourceEntry.ino !== 0) {
      let cursor = destinationDirectory.abs;
      for (;;) {
        const entry = statOrNull(cursor);
        if (entry !== null && entry.ino === sourceEntry.ino && entry.dev === sourceEntry.dev) {
          throw new NoteLifecycleError(
            "destination_inside_source",
            `${action} destination ${destinationDirectory.relPath} is the source folder ` +
              `${source.relPath} (same directory entry on this host); the folder would ` +
              "nest inside itself",
          );
        }
        const parent = dirname(cursor);
        if (parent === cursor || parent === vault || parent.length < vault.length) break;
        cursor = parent;
      }
    }
    const destination = landing(
      resolveFolderTarget(
        vault,
        posix.join(destinationDirectory.relPath, folderBasename(source.relPath)),
      ),
    );
    if (destination.relPath === source.relPath) {
      throw new NoteLifecycleError(
        "destination_unchanged",
        `${action} destination is the source folder: ${source.relPath}`,
      );
    }
    if (
      statOrNull(destinationDirectory.abs) === null &&
      folderParent(source.relPath) !== "" &&
      folderParent(destinationReal) === folderParent(source.relPath)
    ) {
      throw new NoteLifecycleError(
        "wrong_action",
        `move-folder changes the folder's parent; ${destinationDirectory.relPath} sits in ` +
          `${folderParent(source.relPath) || "the vault root"}, where ${source.relPath} lives - ` +
          `use rename-folder`,
      );
    }
    return destination;
  }
  const destination = landing(
    resolveFolderTarget(vault, posix.join(folderParent(source.relPath), input.to)),
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
  } else if (destinationStat !== null && !namesSameEntry(sourceAbs, destination.abs)) {
    // An unreadable destination directory states nothing about emptiness,
    // so it is an occupancy too - a move into it cannot be verified free,
    // and a refusal names the directory rather than guessing.
    const entries = readdirOrNull(destination.abs);
    if (entries === null) collisions.push(`${destination.relPath} (could not be read)`);
    else if (entries.length > 0) collisions.push(`${destination.relPath} (not empty)`);
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

// ----- What a Markdown-only move leaves dangling -----------------------------

/** Inline Markdown link/image target: `[text](target)`, `![alt](<target>)`. */
const MARKDOWN_LINK_TARGET_RE = /\[[^\]]*\]\(\s*<?([^)<>]+?)>?\s*\)/g;

/**
 * The URI-scheme shape (`https:`, `obsidian:`, `mailto:`) that is an
 * address rather than a path - the same judgment `path-safety.ts`'s
 * unexported `URI_SCHEME_RE` makes for wikilink targets.
 */
const URI_SCHEME_TEST = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Which of the moved notes' RELATIVE Markdown links and images now point
 * at nothing. The judgment is made for each target exactly as the note
 * spells it, against the OLD directory the link was written to resolve
 * from and the NEW one the note now lives at: the link dangles only when
 * the target sat where the old spelling resolved to (it was never this
 * operation's business otherwise) and sits nowhere where the new one
 * does. A target that moved with the folder still resolves; a
 * vault-absolute (`/pic.png`) or scheme spelling never depended on the
 * note's directory; an in-page `#anchor` names the note itself; a link
 * that was already dangling names no fault of the move. Each distinct
 * note-and-target pair is named once, sorted by note then target.
 */
function danglingRelativeLinks(
  vault: string,
  moves: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    /** Where the note's bytes are right now - the old path on a plan, the new one on an apply. */
    readonly bytesAbs: string;
  }>,
  /**
   * PLAN only: the move-set's own promise that a Markdown target sitting
   * inside the source will be at the new location once the move runs.
   * An apply needs no promise - the relocation has already happened and
   * the disk is the whole truth - but a plan that judged by the current
   * disk would name EVERY relative target dangling, because nothing has
   * landed yet.
   */
  willLand?: (oldRel: string) => boolean,
): FolderDanglingLink[] {
  const seen = new Set<string>();
  const out: FolderDanglingLink[] = [];
  for (const move of moves) {
    let body: string;
    try {
      body = readFileSync(move.bytesAbs, "utf8");
    } catch {
      // A note that cannot be read states nothing about its links; the
      // per-file machinery has already named it if the move failed.
      continue;
    }
    for (const match of body.matchAll(MARKDOWN_LINK_TARGET_RE)) {
      const raw = match[1]!;
      if (raw === "" || raw.startsWith("#") || raw.startsWith("/") || URI_SCHEME_TEST.test(raw)) {
        continue;
      }
      const target = (() => {
        try {
          return decodeURIComponent(raw);
        } catch {
          return raw;
        }
      })();
      const hash = target.indexOf("#");
      const pathPart = hash < 0 ? target : target.slice(0, hash);
      if (pathPart === "") continue;
      const oldRel = posix.normalize(posix.join(posix.dirname(move.from), pathPart));
      const newRel = posix.normalize(posix.join(posix.dirname(move.to), pathPart));
      if (oldRel.startsWith("..") || newRel.startsWith("..")) continue;
      const stayed = existsSync(join(vault, oldRel));
      const landed = existsSync(join(vault, newRel)) || (willLand?.(oldRel) ?? false);
      if (stayed && !landed) {
        const key = `${move.to}\u0000${raw}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ note: move.to, target: raw });
        }
      }
    }
  }
  return out.toSorted((a, b) =>
    a.note === b.note ? (a.target < b.target ? -1 : 1) : a.note < b.note ? -1 : 1,
  );
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
  // The source is judged, moved and reported under its REAL spelling.
  // Every judgment below compares or slices it against walk spellings
  // and real locations, so an alias-spelled source would plan a move of
  // names the disk does not answer to. The envelope has already vetted
  // the real location - it refuses a path whose realpath leaves the
  // vault or lands under `Brain/` - so this only makes the name honest.
  const sourceRel = realSpelling(vault, source.relPath);
  const sourceFolder =
    sourceRel === source.relPath
      ? source
      : { relPath: sourceRel, abs: ensureInsideVault(join(vault, sourceRel), vault) };
  // Pass one: walk the whole vault once. This is the move set's source,
  // the post-move population the minimal spellings are computed against,
  // and the filesScanned denominator - one walk, so no two of those can
  // see different vaults.
  const walk = retargetWikilinks(vault, [], { root: VAULT_ROOT_REL, apply: false });
  const vaultFiles = walk.files;
  // The move set is the walked files whose REAL LOCATION is inside the
  // source's real path, carried under that real spelling. The walk lists
  // a file under whichever alias of its directory won the walk (it skips
  // a directory whose realpath was already visited), so membership - and
  // the spelling every move pair and rewrite pair carries - must be
  // decided by where a file really lives: a symlinked directory inside
  // the source puts ANOTHER folder's notes under the source's spelling,
  // and an alias elsewhere puts the source's own notes under a foreign
  // one. The walk dedupes directories by realpath, so each file is
  // listed under exactly one spelling and the set cannot hold a file
  // twice. (The realpath read is memoized per spelling; the judgment is
  // order-independent, so either alias order plans the same move.)
  const realCache = new Map<string, string>();
  const realOf = (rel: string): string => {
    const cached = realCache.get(rel);
    if (cached !== undefined) return cached;
    const real = realSpelling(vault, rel);
    realCache.set(rel, real);
    return real;
  };
  const movingReal = new Set<string>();
  for (const rel of vaultFiles) {
    const real = realOf(rel);
    if (real === sourceRel || real.startsWith(`${sourceRel}/`)) movingReal.add(real);
  }
  const movingSet = [...movingReal].toSorted();
  // The caller's reach judges the MOVE SET, and it judges BEFORE the
  // destination is resolved: one note under the folder that the caller
  // may not read refuses the WHOLE operation as a missing folder, on
  // every later error path too - a denied folder that answers a
  // destination mistake with `wrong_action` while a truly missing one
  // answers `source_missing` would be an existence oracle. Skipping the
  // denied files would still leak them - through the occupancy
  // pre-flight, the rewrite pairs and the residue report - and moving
  // them would relocate pages the caller cannot read, so the refusal
  // reads exactly as the file surface's missing-note one. (A folder is
  // not itself a page, so its notes are what the reach predicate can
  // judge.)
  if (movingSet.some((rel) => input.readable?.(rel) === false)) {
    throw new NoteLifecycleError("source_missing", `no note folder at ${source.relPath}`);
  }
  const reported = (rel: string): boolean => input.readable?.(rel) ?? true;
  const destination = resolveFolderDestination(vault, input, sourceFolder);
  // A destination that IS the source's directory entry - the case-only
  // folder rename on a host that folds case - cannot be performed by
  // re-homing the folder's files: the entry keeps its spelling, the
  // prune cannot remove it, and the receipt would name a move that
  // never happened. Refused before anything is planned, on the plan
  // too: a dry run that previews a move it cannot perform is a lie.
  if (namesSameEntry(sourceFolder.abs, destination.abs)) {
    throw new NoteLifecycleError(
      "destination_unchanged",
      `${action} destination ${destination.relPath} is the source folder's own directory ` +
        "entry on this host (a case-only spelling); moving the folder's files cannot " +
        "re-case the entry - rename the directory itself",
    );
  }
  // An empty move set over a folder the disk says is non-empty is not a
  // quiet success waiting to happen when the spelling is the fault: a
  // path whose case (or Unicode normalization form) differs from the
  // vault's real names stats fine on a case-insensitive host and yet
  // matches no walked file, and the operation would report applied:true
  // with an empty `moved` over notes that are really there. The same
  // empty applied success is what a symlinked entry inside the source
  // used to produce from the other direction: the walk holds spellings
  // that fold under the path, but each names a file whose real location
  // is elsewhere. Both shapes are recognisable and refused, naming the
  // suspicion. A folder the walk has NOTHING under, whatever it holds on
  // disk, is simply not a Markdown subject: an attachments-only or
  // empty-subtree folder moves an empty set, keeps its contents, and the
  // residue report says so - unless the disk holds Markdown under the
  // source that NO walked spelling accounts for (out of the caller's
  // vault scope, or a directory the walk could not read), which is the
  // third shape of the same lie and refused too. A directory this
  // process cannot read states nothing about emptiness either, so it
  // does not refuse here - the per-file machinery names the fault if the
  // move really is attempted.
  const sourceEntries = readdirOrNull(sourceFolder.abs);
  if (movingSet.length === 0 && sourceEntries !== null && sourceEntries.length > 0) {
    const fold = (rel: string): string => `${rel.normalize("NFC").toLowerCase()}/`;
    const foldedSource = fold(sourceRel);
    if (vaultFiles.some((rel) => fold(rel).startsWith(foldedSource))) {
      throw new NoteLifecycleError(
        "move_set_empty",
        `no Markdown moves from ${sourceRel} but the folder is not empty on disk: the walk saw ` +
          `${vaultFiles.length} Markdown file(s) spelled under the path, and none of them ` +
          "really lives inside it - each is reached through a symlink whose target the move " +
          "does not follow, or sits under a different casing or character normalization of " +
          "the path - check the folder's own names against the vault's",
      );
    }
    if (subtreeHoldsMarkdown(vault, sourceRel)) {
      throw new NoteLifecycleError(
        "move_set_empty",
        `no Markdown moves from ${sourceRel} but the folder is not empty on disk: it holds ` +
          "Markdown that no walked spelling accounts for - excluded by vault scope, or a " +
          "directory the walk could not read - and moving none of it is refused rather than " +
          "reported as an empty success",
      );
    }
  }
  const planned: PlannedMove[] = movingSet.map((fromRel) => {
    const toRel = `${destination.relPath}${fromRel.slice(sourceRel.length)}`;
    const fromAbs = ensureInsideVault(join(vault, fromRel), vault);
    const toAbs = ensureInsideVault(join(vault, toRel), vault);
    return { fromRel, toRel, fromAbs, toAbs, sameEntry: namesSameEntry(fromAbs, toAbs) };
  });

  // The occupancy gate runs on the plan too: a dry run that reports a
  // move it cannot perform would preview a lie.
  assertDestinationsFree(planned, sourceFolder.abs, destination);

  // The post-move population: every walked file that is not moving - by
  // real location, so a foreign note that merely sat under the source's
  // alias spelling stays in the population the minimal spellings are
  // disambiguated against - plus every destination. The folder analogue
  // of the file surface's postRelocationPopulation, derived from the
  // same walked list.
  const newRels = new Set(planned.map((move) => move.toRel));
  const postPopulation = [
    ...vaultFiles.filter((rel) => !movingReal.has(realOf(rel))),
    ...newRels,
  ].toSorted();

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
  // Nothing has been left behind until something has been moved.
  let leftBehind: ReadonlyArray<string> = [];
  let rewritten: ReadonlyArray<string> = [];
  let rewriteFailures: ReadonlyArray<{ readonly path: string; readonly reason: string }> = [];
  let appliedPairs: ReadonlyArray<{ readonly from: string; readonly to: string }> = [];

  if (apply) {
    // The destination folder exists before the first relocation, so a
    // zero-file move set still lands somewhere when the SOURCE folder
    // was itself empty (the pre-flight has already approved or refused
    // this exact path). A folder that KEEPS entries - the attachments-
    // only case - creates nothing: its destination directory would hold
    // no file and no folder, just residue this operation invented.
    const destinationExisted = statOrNull(destination.abs) !== null;
    // The deepest ancestor of the destination that is already on disk
    // ("." when that is the vault root): the directories this apply
    // invents all sit strictly below it, and the cleanup of an invented
    // chain stops AT it - before removing anything. A directory that was
    // already here is not this operation's to remove, empty or not.
    let existingAncestor = ".";
    if (!destinationExisted) {
      let probe = dirname(destination.relPath);
      while (probe !== ".") {
        if (statOrNull(ensureInsideVault(join(vault, probe), vault)) !== null) {
          existingAncestor = probe;
          break;
        }
        const parentRel = dirname(probe);
        if (parentRel === probe) break;
        probe = parentRel;
      }
    }
    if (planned.length > 0 || sourceEntries === null || sourceEntries.length === 0) {
      mkdirSync(destination.abs, { recursive: true });
    }
    // The directories below the destination that are already on disk
    // before the first relocation - a failed move's branch the vault
    // already had, empty or not, is the vault's own and never this
    // cleanup's to remove. Recorded now, before any of it can change.
    const preExistingBranchDirs = new Set<string>();
    for (const move of planned) {
      let dir = dirname(move.toRel);
      while (dir !== destination.relPath && dir !== ".") {
        if (statOrNull(ensureInsideVault(join(vault, dir), vault)) !== null) {
          preExistingBranchDirs.add(dir);
        }
        const parentRel = dirname(dir);
        if (parentRel === dir) break;
        dir = parentRel;
      }
    }
    // The destination spellings the per-file machinery created for moves
    // that then failed: the invented subtree the cleanup below offers
    // back to the filesystem.
    const failedDestinations: string[] = [];
    // The moves run in sorted order and the set continues past a failure:
    // by the time one file cannot relocate, others already have, and
    // undoing them would unlink destination names - new destructive
    // behavior no gate covers. The report names the split instead.
    for (const move of planned) {
      try {
        (input.relocate ?? relocateFileBytes)(move.fromAbs, move.toAbs, move.toRel, move.sameEntry);
        moved.push({ from: move.fromRel, to: move.toRel });
      } catch (err) {
        let reason = err instanceof Error ? err.message : String(err);
        failedDestinations.push(move.toRel);
        // A fault AFTER the destination name was created - a linked name
        // (same inode) or a cross-device copy the fallback wrote - leaves
        // bytes at `toRel` while the report is about to say this path
        // "never moved". The source name still holds the original bytes
        // whenever it exists, so the extra destination name is dropped
        // before the failure is reported; if even that fails, the
        // failure says so. The name is judged with LSTAT, not
        // `existsSync`: a name that dangles - a link whose target the
        // new depth cannot see - is still a name this call created, and
        // following the link would see nothing and leave it standing.
        // A source that no longer exists means the unlink SUCCEEDED and
        // a later step threw - the file moved, and the destination name
        // is the only copy, so it stays. And a destination this call
        // never created is never this operation's to drop: the
        // pre-flight cleared the name, so `destination_occupied` means a
        // foreign file appeared there between the check and the link,
        // and unlinking it would delete bytes this operation did not
        // write.
        const occupied = err instanceof NoteLifecycleError && err.code === "destination_occupied";
        if (!move.sameEntry && !occupied && lstatOrNull(move.toAbs) !== null) {
          if (existsSync(move.fromAbs)) {
            try {
              unlinkSync(move.toAbs);
            } catch (cleanup) {
              reason +=
                `; the destination name ${move.toRel} was written before the fault and ` +
                `could not be dropped either (${cleanup instanceof Error ? cleanup.message : String(cleanup)})`;
            }
          } else {
            reason += `; the destination name ${move.toRel} holds the moved bytes`;
          }
        }
        moveFailures.push({ path: move.fromRel, reason });
      }
    }
    // The directories the per-file machinery invented for FAILED moves
    // never stay behind: each failed move's own destination spelling
    // names its branch, offered to rmdirSync deepest-first, each only
    // while genuinely empty - so a moved file's branch, a foreign name or
    // a name that could not be dropped keeps its branch standing - and a
    // branch that was already here is spared by name. When NOTHING moved,
    // the destination folder and the chain the recursive mkdir invented
    // above it go too, up to - never including - the ancestor that was
    // already here; with a partial set they hold real moves, so the walk
    // stops at the destination folder. A destination that existed before,
    // or one an empty-source move deliberately created, is not this
    // cleanup's business.
    if (failedDestinations.length > 0) {
      const doomed = new Set<string>();
      if (moved.length === 0 && !destinationExisted) {
        doomed.add(destination.relPath);
        let up = dirname(destination.relPath);
        while (up !== "." && up !== existingAncestor) {
          doomed.add(up);
          const parentRel = dirname(up);
          if (parentRel === up) break;
          up = parentRel;
        }
      }
      for (const toRel of failedDestinations) {
        let dir = dirname(toRel);
        while (dir !== destination.relPath && dir !== ".") {
          doomed.add(dir);
          const parentRel = dirname(dir);
          if (parentRel === dir) break;
          dir = parentRel;
        }
      }
      const deepestFirst = [...doomed]
        .filter((rel) => !preExistingBranchDirs.has(rel))
        .toSorted((a, b) => b.length - a.length);
      for (const rel of deepestFirst) {
        try {
          rmdirSync(ensureInsideVault(join(vault, rel), vault));
        } catch {
          // Not empty (a foreign name, or a name that could not be
          // dropped) or not removable: what stands, stands, and the
          // report already names where every file is.
        }
      }
    }
    // The folders the moves emptied go with their files: every ancestor
    // of a successfully moved file, up to and including the subject, is
    // offered to rmdirSync deepest-first, and only genuinely empty ones
    // go - so a failed file's parent stays exactly where the report says
    // its bytes are, and directories the move never touched (empty
    // siblings, a subtree that held no Markdown) are not this operation's
    // to delete.
    pruneEmptiedFolders(vault, sourceRel, moved);
    // An EMPTY folder's move is the directory entry itself: nothing was
    // relocated, so the prune has no moved file whose ancestors name the
    // subject, and the entry is dropped by hand - but only while the disk
    // still says the source is empty, and never when the source keeps
    // entries it was never going to move (the attachments-only case).
    if (planned.length === 0 && (readdirOrNull(sourceFolder.abs) ?? []).length === 0) {
      try {
        rmdirSync(sourceFolder.abs);
      } catch {
        // The entry is not removable (or re-appeared between the read and
        // the removal): the residue report names what stayed.
      }
    }
    // Whatever the prune could not remove is exactly what stayed - a
    // non-Markdown file beside the notes, a symlinked entry whose real
    // location is outside the source, or a failed file's folder - and
    // the report names it rather than reading as if the source folder
    // went with its notes.
    leftBehind = (readdirOrNull(sourceFolder.abs) ?? []).toSorted();
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

  // The relative-link judgment (M17) reads the moved notes' bytes once,
  // from where they now are: the planned set on a plan (the notes have
  // not moved - the plan is the preview), the SUCCESSFULLY moved set on
  // an apply - a failed file never moved, so its relative links still
  // resolve and name no fault.
  const linkMoves = (
    apply
      ? moved.map((m) => ({
          from: m.from,
          to: m.to,
          bytesAbs: ensureInsideVault(join(vault, m.to), vault),
        }))
      : planned.map((m) => ({ from: m.fromRel, to: m.toRel, bytesAbs: m.fromAbs }))
  ).toSorted((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const dangling = danglingRelativeLinks(
    vault,
    linkMoves,
    apply
      ? undefined
      : // The plan's promise: a target whose real location is inside the
        // source's real path is IN the move set and will be at the new
        // location once the move runs.
        (oldRel: string) => movingReal.has(realSpelling(vault, oldRel)),
  );

  return Object.freeze({
    action,
    from: sourceRel,
    to: destination.relPath,
    applied: apply,
    moved: Object.freeze(
      moved.toSorted((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)),
    ),
    moveFailures: Object.freeze(
      moveFailures.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ),
    leftBehind: Object.freeze([...leftBehind]),
    danglingRelativeLinks: Object.freeze(dangling),
    recoverability,
    snapshot: null,
    references: Object.freeze({
      filesScanned,
      inboundFiles: Object.freeze([...inboundFiles]),
      filesRewritten: rewritten.length,
      rewrittenSpellings: Object.freeze([...(apply ? appliedPairs : plannedPairs)]),
      rewriteFailures: Object.freeze([...rewriteFailures]),
      basename: BASENAME_REWRITE.notNeeded,
      index,
      refresh,
      refreshReason,
    }),
  });
}

/**
 * Remove the directories the moves genuinely emptied, deepest first.
 * `rmdirSync` removes only an empty directory, so a folder whose subtree
 * still holds a failed file - or any file this surface does not address -
 * keeps it, which is exactly where the report says the bytes are. The
 * candidate set is derived from the MOVED FILES' ancestor chains up to
 * the subject - never from a walk of the subject's subtree - so a
 * symlinked directory anywhere under the source is neither followed nor
 * removed, and directories the move never touched (empty siblings, a
 * no-Markdown subtree) are not this operation's to delete. The folders
 * ABOVE the subject are not its business either, and an emptied
 * `Projects/` left behind reads as the ordinary residue a file move
 * leaves too.
 */
function pruneEmptiedFolders(
  vault: string,
  fromRel: string,
  moved: ReadonlyArray<FolderMovedPath>,
): void {
  const candidates = new Set<string>();
  for (const file of moved) {
    let dir = dirname(file.from);
    // Walk the ancestor chain in VAULT-RELATIVE spellings - the move
    // report's own paths, never names resolved through the filesystem -
    // and stop at the subject itself. The walk is bounded to fail closed:
    // a moved path outside the subject (a different spelling, a future
    // caller) can never send the walk below the vault root, where
    // `dirname` stops changing and the loop would never end.
    candidates.add(dir);
    while (dir !== fromRel) {
      const parent = dirname(dir);
      if (parent === dir || parent === ".") break;
      dir = parent;
      candidates.add(dir);
    }
  }
  const deepestFirst = [...candidates]
    .filter((rel) => rel === fromRel || rel.startsWith(`${fromRel}/`))
    .toSorted((a, b) => b.length - a.length);
  for (const rel of deepestFirst) {
    try {
      rmdirSync(ensureInsideVault(join(vault, rel), vault));
    } catch {
      // The directory is not empty (or not removable): the residue
      // stands, and the report already names where every file is.
    }
  }
}
