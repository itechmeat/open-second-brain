/**
 * Note-file lifecycle: rename, move, delete, archive (B2).
 *
 * Before this module there was no rename, no move, no delete and no
 * archive on ANY surface. `brain_create_note`, `brain_update_note` and
 * `brain_append_note` were the whole of it: a note could be brought into
 * existence and edited, and after that it was immovable and undeletable
 * through everything this project ships. The remedy an agent actually had
 * was to write the correctly-named note and abandon the wrong one, which
 * is how a vault grows the duplicates the dedup pass then has to reason
 * about.
 *
 * ## Nothing here is new machinery
 *
 * The path envelope is {@link resolveNoteTarget} - the same nine-step
 * refusal ladder `createNote` runs - and BOTH the source and the
 * destination go through it, so a destination cannot reach somewhere a
 * create could not. The relocation is the write-then-unlink-then-assert
 * pattern `signal-retire.ts:141-152` establishes. The confirmation ladder
 * is `deleteBySource`'s: dry-run by default, an explicit confirm, and the
 * shared {@link assertExpectedCount} guard. The recovery point is
 * `withDestructiveSnapshot`, and its verdict is the R1a classifier.
 *
 * ## The honesty requirement, which is the hard part
 *
 * A rename that reports success and stops is a lie, and it is worth being
 * precise about which lie. The Brain backlink index (`backlinks.ts`) is a
 * full scan and Brain-scoped. The vault-wide `links` table is only as
 * fresh as the last `indexVault` pass, and there is no write-to-index
 * hook anywhere in this codebase. So a rename can truthfully say only
 * this: of the Markdown files it READ during this call, these are the
 * ones whose `[[...]]` spellings it rewrote - and the derived index still
 * holds the old path until something re-indexes.
 *
 * Three consequences are load-bearing and each is reported rather than
 * assumed:
 *
 *   - the bare-basename spelling `[[Old]]` is rewritten only when exactly
 *     one note in the scanned population carries that basename. Two
 *     notes named `Old.md` in different folders make `[[Old]]` a
 *     reference to whichever one Obsidian resolves, and rewriting it
 *     would re-point a link that never pointed here. The verdict token
 *     says which of the three happened.
 *   - the search index's state travels back on the result as an
 *     {@link IndexEvidence}, with the instant of its last pass and the
 *     command that makes it agree with the vault again.
 *   - a delete rewrites NOTHING and reports the inbound references it is
 *     about to strand, because a delete that silently repaired its own
 *     inbound links would be erasing the evidence that it happened.
 *
 * ## Where an archived note goes, and why
 *
 * `NOTE_ARCHIVE_ROOT` - a top-level `Archive/` directory mirroring the
 * note's original path. The precedents are `Brain/retired/` for
 * preferences, `Brain/processed/` for signals, and the `archive/` sibling
 * `obligations.ts:366` writes into. Two things carry over from them and
 * one cannot:
 *
 *   - the SHAPE carries: a sibling directory named for the terminal
 *     state, holding the file under a name that cannot collide, with an
 *     occupied destination refused rather than overwritten.
 *   - the PATH-MIRRORING is this surface's own, and it is forced. Those
 *     three precedents are flat because their subjects carry unique ids;
 *     a note is addressed by path and two notes in different folders may
 *     share a basename, so flattening would collide by construction.
 *   - the LOCATION cannot carry. `resolveNoteTarget` refuses the `Brain/`
 *     machinery root for every note path, source and destination alike,
 *     so `Brain/retired/`'s own location is unreachable from here - and
 *     making an exception for it would put the one surface that moves
 *     user notes outside the envelope every other note write obeys.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, posix } from "node:path";

import { atomicCreateFileSyncExclusive, isFileAlreadyExists } from "../../fs-atomic.ts";
import { assertExpectedCount } from "../count-guard.ts";
import { requireNextStep } from "../next-step.ts";
import { SEARCH_INDEX_MISSING_CODE } from "../diagnostics.ts";
import { classifyRecoverability, type RecoverabilityVerdict } from "../gates/recoverability.ts";
import { retargetWikilinks, type WikilinkRetarget } from "../page-dedup.ts";
import { withDestructiveSnapshot } from "../snapshot-gate.ts";
import { BRAIN_SNAPSHOT_REASON } from "../types.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { resolveNoteTarget, type ResolvedNoteTarget } from "./create-note.ts";

// ----- What a caller may ask for --------------------------------------------

/**
 * The four operations. `rename` and `move` are one relocation under the
 * hood and are kept apart at the surface deliberately: a caller that
 * meant to change a note's NAME and accidentally changed its FOLDER has
 * made a mistake no path check would catch, because both spellings are
 * perfectly legal destinations. Declaring which one was intended lets the
 * other be refused.
 */
export const NOTE_LIFECYCLE_ACTION = Object.freeze({
  /** Change the filename, keeping the note in its directory. */
  rename: "rename",
  /** Change the directory, keeping the filename. */
  move: "move",
  /** Displace the note under {@link NOTE_ARCHIVE_ROOT}, path mirrored. */
  archive: "archive",
  /** Remove the note. The one operation here that destroys bytes. */
  delete: "delete",
} as const);

/** Closed union over {@link NOTE_LIFECYCLE_ACTION}. */
export type NoteLifecycleAction =
  (typeof NOTE_LIFECYCLE_ACTION)[keyof typeof NOTE_LIFECYCLE_ACTION];

/** Membership list, least destructive first. */
export const NOTE_LIFECYCLE_ACTIONS: ReadonlyArray<NoteLifecycleAction> = Object.freeze(
  Object.values(NOTE_LIFECYCLE_ACTION),
);

/**
 * `unknown` rather than `string`: the value arrives as an untyped MCP
 * argument or a raw CLI positional, and the vocabulary census probes
 * every guard with `null`, `42` and `{}`.
 */
export function isNoteLifecycleAction(value: unknown): value is NoteLifecycleAction {
  return (
    typeof value === "string" && (NOTE_LIFECYCLE_ACTIONS as ReadonlyArray<string>).includes(value)
  );
}

// ----- What happened to the bare-basename spelling --------------------------

/**
 * What this call did about `[[Old]]` - the spelling Obsidian writes by
 * default and the only one of the three that is not unique by
 * construction.
 */
export const BASENAME_REWRITE = Object.freeze({
  /** Exactly one note carried the basename, so the spelling was rewritten. */
  applied: "applied",
  /** The basename did not change, so no bare spelling needed rewriting. */
  notNeeded: "not_needed",
  /** Another note carries the same basename; rewriting could re-point its links. */
  ambiguous: "ambiguous",
} as const);

/** Closed union over {@link BASENAME_REWRITE}. */
export type BasenameRewrite = (typeof BASENAME_REWRITE)[keyof typeof BASENAME_REWRITE];

/** Membership list, in declaration order. */
export const BASENAME_REWRITES: ReadonlyArray<BasenameRewrite> = Object.freeze(
  Object.values(BASENAME_REWRITE),
);

/** See {@link isNoteLifecycleAction} for why the parameter is `unknown`. */
export function isBasenameRewrite(value: unknown): value is BasenameRewrite {
  return typeof value === "string" && (BASENAME_REWRITES as ReadonlyArray<string>).includes(value);
}

// ----- How stale the derived index is ---------------------------------------

/**
 * The state of the search index at the moment this call finished.
 *
 * There is no `current` member and that is a result, not an omission: no
 * write path in this codebase updates the `links` table, so an index that
 * exists is stale with respect to a relocation that just happened, by
 * construction. Declaring a member nothing can produce would be inviting
 * a reader to believe a rename might have refreshed the index.
 */
export const INDEX_EVIDENCE = Object.freeze({
  /** An index exists; its last pass predates this call and names the old path. */
  stale: "stale",
  /** No index at the configured path, so it held no evidence either way. */
  absent: "absent",
  /** An index exists and could not be opened, or records no run instant. */
  unreadable: "unreadable",
} as const);

/** Closed union over {@link INDEX_EVIDENCE}. */
export type IndexEvidenceState = (typeof INDEX_EVIDENCE)[keyof typeof INDEX_EVIDENCE];

/** Membership list, in declaration order. */
export const INDEX_EVIDENCE_STATES: ReadonlyArray<IndexEvidenceState> = Object.freeze(
  Object.values(INDEX_EVIDENCE),
);

/** See {@link isNoteLifecycleAction} for why the parameter is `unknown`. */
export function isIndexEvidenceState(value: unknown): value is IndexEvidenceState {
  return (
    typeof value === "string" && (INDEX_EVIDENCE_STATES as ReadonlyArray<string>).includes(value)
  );
}

/** What the derived index knows, and how old that knowledge is. */
export interface IndexEvidence {
  readonly state: IndexEvidenceState;
  /** ISO instant of the index's last pass; `null` unless the state is `stale`. */
  readonly lastIndexedAt: string | null;
  /** The registered command that makes the index agree with the vault again. */
  readonly nextCommand: string;
}

/**
 * What a lifecycle call did to the vault's inbound references, and on
 * what evidence.
 *
 * `filesScanned` is the honest denominator: it is the number of Markdown
 * files this call actually opened, so `filesRewritten` is a fraction of a
 * population the caller can see rather than a bare count implying a
 * complete graph.
 */
export interface NoteReferenceReport {
  /** Markdown files read during this call. */
  readonly filesScanned: number;
  /** Files holding at least one inbound reference, vault-relative, sorted. */
  readonly inboundFiles: ReadonlyArray<string>;
  /** Files whose bytes this call rewrote. Zero for a dry run and for a delete. */
  readonly filesRewritten: number;
  /** Old spellings rewritten to new ones, in the order they were applied. */
  readonly rewrittenSpellings: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  /** What happened to the bare `[[Basename]]` spelling. */
  readonly basename: BasenameRewrite;
  /** How fresh the derived index is with respect to this call. */
  readonly index: IndexEvidence;
}

/** Machine-readable reason a {@link noteLifecycle} call was refused. */
export type NoteLifecycleErrorCode =
  /** The source note does not exist. */
  | "source_missing"
  /** A destination is required for this action, or forbidden for it. */
  | "destination_required"
  | "destination_forbidden"
  /** The destination is already occupied. */
  | "destination_occupied"
  /** Source and destination are the same path. */
  | "destination_unchanged"
  /** A `rename` that changes the directory, or a `move` that does not. */
  | "wrong_action"
  /** A delete reached the mutating path without an explicit confirmation. */
  | "not_confirmed"
  /** The subject already sits under the archive root. */
  | "already_archived";

export class NoteLifecycleError extends Error {
  readonly code: NoteLifecycleErrorCode;
  constructor(code: NoteLifecycleErrorCode, message: string) {
    super(message);
    this.name = "NoteLifecycleError";
    this.code = code;
  }
}

export interface NoteLifecycleInput {
  readonly action: NoteLifecycleAction;
  /** Vault-relative path of the subject note; must end in `.md`. */
  readonly path: string;
  /** Vault-relative destination. Required for rename/move, forbidden otherwise. */
  readonly to?: string;
  /** False (the default) walks, counts and writes nothing. */
  readonly apply?: boolean;
  /** Required by `delete` before it will remove anything. */
  readonly confirm?: boolean;
  /** `--expect N`: assert the inbound-reference count before any write. */
  readonly expect?: number | null;
  /** `--strict`: refuse a mutation carrying no `--expect` guard. */
  readonly strict?: boolean;
  /** Injected clock, forwarded to the recovery point so a run stays reproducible. */
  readonly now?: Date;
}

export interface NoteLifecycleResult {
  readonly action: NoteLifecycleAction;
  /** Vault-relative path the note was at. */
  readonly from: string;
  /** Vault-relative path it is at now; `null` for a delete. */
  readonly to: string | null;
  /** False when this was a plan-only run. */
  readonly applied: boolean;
  /** What the recovery point (if any) is worth for THIS operation. */
  readonly recoverability: RecoverabilityVerdict;
  /** The recovery point taken, when one was; `null` otherwise. */
  readonly snapshot: { readonly runId: string; readonly path: string } | null;
  /** What happened to inbound references, and on what evidence. */
  readonly references: NoteReferenceReport;
}

/**
 * Top-level directory an archived note is displaced into, its original
 * path mirrored beneath. See the module header for why here and not
 * under `Brain/`.
 */
export const NOTE_ARCHIVE_ROOT = "Archive";

/** The vault-relative root the reference scan walks: the whole vault. */
const VAULT_ROOT_REL = "";

/**
 * The command that reconciles the derived index with the vault. Resolved
 * from the diagnostics registry rather than written here, so the string
 * an operator is handed is the same one every other index advisory names,
 * and a registry rename fails at import instead of inside the advisory it
 * was meant to explain.
 */
const REINDEX_COMMAND = requireNextStep(SEARCH_INDEX_MISSING_CODE).nextCommand;

/** The `.md` suffix, matched case-insensitively by the path envelope. */
const MARKDOWN_SUFFIX = ".md";

/** `Projects/Old.md` -> `Old`. */
function basenameOf(relPath: string): string {
  const last = relPath.split(posix.sep).at(-1) ?? relPath;
  return last.toLowerCase().endsWith(MARKDOWN_SUFFIX)
    ? last.slice(0, -MARKDOWN_SUFFIX.length)
    : last;
}

/** `Projects/Old.md` -> `Projects`, and `Old.md` -> `""`. */
function directoryOf(relPath: string): string {
  const cut = relPath.lastIndexOf(posix.sep);
  return cut < 0 ? "" : relPath.slice(0, cut);
}

/** `Projects/Old.md` -> `Projects/Old`. */
function withoutSuffix(relPath: string): string {
  return relPath.toLowerCase().endsWith(MARKDOWN_SUFFIX)
    ? relPath.slice(0, -MARKDOWN_SUFFIX.length)
    : relPath;
}

/**
 * The three spellings an inbound `[[...]]` can use for one note. Ordered
 * longest-first is {@link retargetWikilinks}'s job, not this one's; what
 * matters here is that all three are named, because a rename that fixed
 * only the one spelling it happened to think of would report a rewrite
 * count that read as coverage.
 */
function spellingsOf(relPath: string): ReadonlyArray<string> {
  return [relPath, withoutSuffix(relPath), basenameOf(relPath)];
}

/**
 * Read the derived index's freshness. Never throws: this is evidence
 * ABOUT the operation, and an unreadable index must not fail a relocation
 * that already succeeded - it must be reported as unreadable, which is a
 * different answer from "no stale references exist".
 *
 * The import is deferred because the search barrel reaches back into the
 * Brain tree, and a static edge from a Brain note writer into it is the
 * shape the acyclic-import ratchet exists to keep out.
 */
async function readIndexEvidence(vault: string): Promise<IndexEvidence> {
  try {
    const { resolveSearchConfig } = await import("../../search/index.ts");
    const { LAST_INDEXED_AT_STATE_KEY, Store } = await import("../../search/store.ts");
    const config = resolveSearchConfig({ vault });
    if (!existsSync(config.dbPath)) {
      return Object.freeze({
        state: INDEX_EVIDENCE.absent,
        lastIndexedAt: null,
        nextCommand: REINDEX_COMMAND,
      });
    }
    const store = await Store.open(config, { mode: "read" });
    try {
      const last = store.getState(LAST_INDEXED_AT_STATE_KEY);
      if (last === null) {
        return Object.freeze({
          state: INDEX_EVIDENCE.unreadable,
          lastIndexedAt: null,
          nextCommand: REINDEX_COMMAND,
        });
      }
      return Object.freeze({
        state: INDEX_EVIDENCE.stale,
        lastIndexedAt: last,
        nextCommand: REINDEX_COMMAND,
      });
    } finally {
      await store.close();
    }
  } catch {
    return Object.freeze({
      state: INDEX_EVIDENCE.unreadable,
      lastIndexedAt: null,
      nextCommand: REINDEX_COMMAND,
    });
  }
}

/**
 * Resolve the destination this action implies, running it through the
 * same envelope as the source. Returns `null` for a delete, which has no
 * destination by definition.
 */
function resolveDestination(
  vault: string,
  input: NoteLifecycleInput,
  source: ResolvedNoteTarget,
): ResolvedNoteTarget | null {
  const action = input.action;
  if (action === NOTE_LIFECYCLE_ACTION.delete) {
    if (input.to !== undefined) {
      throw new NoteLifecycleError(
        "destination_forbidden",
        `${action} takes no destination; it removes ${source.relPath}`,
      );
    }
    return null;
  }

  if (action === NOTE_LIFECYCLE_ACTION.archive) {
    if (input.to !== undefined) {
      throw new NoteLifecycleError(
        "destination_forbidden",
        `${action} chooses its own destination under ${NOTE_ARCHIVE_ROOT}/; drop 'to'`,
      );
    }
    if (
      source.relPath === NOTE_ARCHIVE_ROOT ||
      source.relPath.startsWith(`${NOTE_ARCHIVE_ROOT}/`)
    ) {
      throw new NoteLifecycleError(
        "already_archived",
        `${source.relPath} is already under ${NOTE_ARCHIVE_ROOT}/`,
      );
    }
    return resolveNoteTarget(vault, posix.join(NOTE_ARCHIVE_ROOT, source.relPath));
  }

  if (input.to === undefined) {
    throw new NoteLifecycleError(
      "destination_required",
      `${action} requires a destination path ('to')`,
    );
  }
  const destination = resolveNoteTarget(vault, input.to);
  if (destination.relPath === source.relPath) {
    throw new NoteLifecycleError(
      "destination_unchanged",
      `${action} destination is the source path: ${source.relPath}`,
    );
  }
  const sameDirectory = directoryOf(destination.relPath) === directoryOf(source.relPath);
  if (action === NOTE_LIFECYCLE_ACTION.rename && !sameDirectory) {
    throw new NoteLifecycleError(
      "wrong_action",
      `rename keeps the note in ${directoryOf(source.relPath) || "the vault root"}; ` +
        `${destination.relPath} is in another directory - use move`,
    );
  }
  if (action === NOTE_LIFECYCLE_ACTION.move && sameDirectory) {
    throw new NoteLifecycleError(
      "wrong_action",
      `move changes the directory; ${destination.relPath} shares one with ` +
        `${source.relPath} - use rename`,
    );
  }
  return destination;
}

/**
 * Decide what to do about the bare `[[Basename]]` spelling, from the
 * population the rewrite would act on.
 *
 * `files` is the list the counting pass just walked, which is exactly the
 * set of notes whose links are candidates for rewriting - deriving the
 * answer from a second walk under a second rule set is how the count and
 * the rewrite would come to disagree.
 */
function decideBasename(
  files: ReadonlyArray<string>,
  sourceRel: string,
  destinationRel: string,
): BasenameRewrite {
  const from = basenameOf(sourceRel);
  if (from === basenameOf(destinationRel)) return BASENAME_REWRITE.notNeeded;
  const carriers = files.filter((rel) => basenameOf(rel) === from).length;
  return carriers > 1 ? BASENAME_REWRITE.ambiguous : BASENAME_REWRITE.applied;
}

/**
 * Move one note's BYTES from `source` to `destination`: write the
 * destination exclusively, re-confirm it landed, then unlink the source.
 *
 * The pattern is `signal-retire.ts:141-152`'s, and the ordering is the
 * whole of its value - the note exists twice at the instant the source
 * goes and never zero times. It copies rather than re-renders, so a
 * note's own formatting, its comments and any frontmatter key this
 * project's parser does not model survive the move; the preference retire
 * re-renders and loses the original prose, which is the arm of that
 * precedent deliberately not taken here.
 */
function relocateBytes(source: ResolvedNoteTarget, destination: ResolvedNoteTarget): void {
  const bytes = readFileSync(source.abs, "utf8");
  mkdirSync(dirname(destination.abs), { recursive: true });
  try {
    atomicCreateFileSyncExclusive(destination.abs, bytes);
  } catch (err) {
    if (isFileAlreadyExists(err)) {
      throw new NoteLifecycleError(
        "destination_occupied",
        `destination already exists: ${destination.relPath}`,
      );
    }
    throw err;
  }
  if (!existsSync(destination.abs)) {
    throw new Error(
      `noteLifecycle: write of ${destination.relPath} reported success but the file is absent`,
    );
  }
  unlinkSync(source.abs);
}

/**
 * Run one note-file lifecycle operation.
 *
 * Ordering is load-bearing throughout. The envelope judges both paths
 * before anything is read; the counting pass establishes the blast radius
 * before the count guard runs; the count guard runs before any byte
 * moves; and the index evidence is read at the END, so the instant it
 * reports is the one a caller comparing it against the relocation will
 * actually reason about.
 */
export async function noteLifecycle(
  vault: string,
  input: NoteLifecycleInput,
): Promise<NoteLifecycleResult> {
  const apply = input.apply === true;
  // Vault-identity write guard (context-integrity-gates, Unit J). Asserted
  // on the planning path too: a plan names real vault paths, and computing
  // one against a vault this process was not pointed at is already the
  // confusion the guard exists to refuse.
  assertVaultIdentityForWrite(vault);

  const action = input.action;
  const source = resolveNoteTarget(vault, input.path);
  if (!existsSync(source.abs)) {
    throw new NoteLifecycleError("source_missing", `no note at ${source.relPath}`);
  }
  const destination = resolveDestination(vault, input, source);
  if (destination !== null && existsSync(destination.abs)) {
    throw new NoteLifecycleError(
      "destination_occupied",
      `destination already exists: ${destination.relPath}`,
    );
  }
  if (action === NOTE_LIFECYCLE_ACTION.delete && input.confirm !== true && apply) {
    throw new NoteLifecycleError(
      "not_confirmed",
      `delete removes ${source.relPath} and no archive covers a note outside Brain/; ` +
        "pass an explicit confirmation to proceed",
    );
  }

  // Pass one: walk, count, write nothing. This is both the blast radius
  // the count guard asserts against and the population the basename
  // decision is made from.
  const probe = retargetWikilinks(
    vault,
    spellingsOf(source.relPath).map((from) => ({ from })),
    { root: VAULT_ROOT_REL, apply: false },
  );
  const inboundFiles = probe.matched.filter((rel) => rel !== source.relPath);

  assertExpectedCount({
    matched: inboundFiles.length,
    expect: input.expect ?? null,
    strict: input.strict === true,
    willMutate: apply,
    matchList: inboundFiles,
  });

  const basename =
    destination === null
      ? BASENAME_REWRITE.notNeeded
      : decideBasename(probe.files, source.relPath, destination.relPath);

  const retargets = destination === null ? [] : retargetsFor(source, destination, basename);

  let snapshot: NoteLifecycleResult["snapshot"] = null;
  let rewritten = 0;

  if (apply) {
    if (action === NOTE_LIFECYCLE_ACTION.delete) {
      // The gate takes the recovery point BEFORE the unlink and returns
      // the verdict that says what it is worth. The archive holds the
      // Brain tree - the log, the backlink sources, the continuity
      // records that name this note - and never the note itself, because
      // `resolveNoteTarget` refuses `Brain/` for every note path. That is
      // `partial` coverage stated as `unproven`, and stating it is the
      // point: the previous shape of this problem returned a snapshot
      // path with nothing beside it, which every caller reads as "this is
      // reversible".
      const gated = withDestructiveSnapshot(
        vault,
        BRAIN_SNAPSHOT_REASON.noteDelete,
        () => {
          unlinkSync(source.abs);
        },
        {
          blastRadius: { outsideBrainRoot: true },
          ...(input.now !== undefined ? { now: input.now } : {}),
        },
      );
      snapshot = Object.freeze({ runId: gated.snapshot.runId, path: gated.snapshot.path });
      return finish(
        action,
        source.relPath,
        null,
        true,
        gated.recoverability,
        snapshot,
        probe.files.length,
        inboundFiles,
        0,
        [],
        basename,
        await readIndexEvidence(vault),
      );
    }
    relocateBytes(source, destination!);
    rewritten = retargetWikilinks(vault, retargets, {
      root: VAULT_ROOT_REL,
      apply: true,
    }).rewritten.length;
  }

  // A relocation destroys nothing: the bytes exist at the destination
  // before the source is unlinked, and the assertion between the two is
  // what makes that a fact rather than an intention. Wrapping it in a
  // recovery point would archive `Brain/`, which holds neither the note
  // nor its destination, and report a coverage the archive does not have.
  const recoverability = classifyRecoverability({ recoveryPoint: false, blastRadius: {} });

  return finish(
    action,
    source.relPath,
    destination === null ? null : destination.relPath,
    apply,
    recoverability,
    snapshot,
    probe.files.length,
    inboundFiles,
    rewritten,
    retargets.flatMap((r) => (r.to === undefined ? [] : [{ from: r.from, to: r.to }])),
    basename,
    await readIndexEvidence(vault),
  );
}

/**
 * The spellings this relocation will actually rewrite. The bare basename
 * is included only when {@link decideBasename} cleared it, so the
 * `rewrittenSpellings` a caller reads back is the list that was applied
 * and not the list that was considered.
 */
function retargetsFor(
  source: ResolvedNoteTarget,
  destination: ResolvedNoteTarget,
  basename: BasenameRewrite,
): ReadonlyArray<WikilinkRetarget> {
  const pairs: WikilinkRetarget[] = [
    { from: source.relPath, to: destination.relPath },
    { from: withoutSuffix(source.relPath), to: withoutSuffix(destination.relPath) },
  ];
  if (basename === BASENAME_REWRITE.applied) {
    pairs.push({ from: basenameOf(source.relPath), to: basenameOf(destination.relPath) });
  }
  return Object.freeze(pairs);
}

/** Compose the frozen result. One place, so no arm can omit a field. */
function finish(
  action: NoteLifecycleAction,
  from: string,
  to: string | null,
  applied: boolean,
  recoverability: RecoverabilityVerdict,
  snapshot: NoteLifecycleResult["snapshot"],
  filesScanned: number,
  inboundFiles: ReadonlyArray<string>,
  filesRewritten: number,
  rewrittenSpellings: ReadonlyArray<{ readonly from: string; readonly to: string }>,
  basename: BasenameRewrite,
  index: IndexEvidence,
): NoteLifecycleResult {
  return Object.freeze({
    action,
    from,
    to,
    applied,
    recoverability,
    snapshot,
    references: Object.freeze({
      filesScanned,
      inboundFiles: Object.freeze([...inboundFiles]),
      filesRewritten,
      rewrittenSpellings: Object.freeze([...rewrittenSpellings]),
      basename,
      index,
    }),
  });
}
