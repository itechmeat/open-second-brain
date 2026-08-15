/**
 * The declared recovery story of every destructive site under
 * `src/core/brain/` that does not route through the snapshot gate (R1b).
 *
 * `snapshot-gate.ts` promises that no destructive brain mutation runs
 * without a recovery point on disk first, and it is reached by two
 * modules. That is not a bug in the gate; it is what happens to any
 * mechanism that has to be called by hand. Fixing the call sites fixes
 * the call sites. What makes the NEXT unprotected removal impossible to
 * add silently is this file plus
 * `tests/core/architecture/destructive-site-census.test.ts`: the census
 * sweeps the tree for removal calls and requires each site it finds to
 * be routed through the gate or to appear below.
 *
 * ## What an entry is
 *
 * Facts, not conclusions. Each entry states the calls the site makes,
 * what those calls put at risk (in the regions a snapshot archive is
 * defined over), and whether anything archived them first. The verdict
 * is DERIVED from those facts by the same pure classifier the gate uses,
 * so the registry and the gate cannot come to different conclusions
 * about the same shape of risk.
 *
 * The `reason` is what the facts alone do not say: for most of these
 * sites it is the argument that the removal is safe by CONSTRUCTION -
 * the destination landed and was re-confirmed before the source went, or
 * the removed file's whole content was its existence, or a producer will
 * emit it again on the next run. Those are real recovery stories; they
 * are just not archives.
 *
 * ## What this module is not
 *
 * It imports nothing but the verdict vocabularies. A registry that must
 * know about the modules it names is exactly where an import cycle
 * appears, and a cycle here would be paid for by every module in the
 * tree - so the sites are named by PATH, as strings, and the census is
 * what proves those strings still resolve to real files.
 */

import {
  classifyRecoverability,
  type RecoverabilityFacts,
  type RecoverabilityVerdict,
} from "./gates/recoverability.ts";

/**
 * The calls that put existing bytes beyond reach: removal and
 * displacement, in both the sync and the promise spelling. An atomic
 * overwrite is deliberately absent - see the census header for the
 * measurement behind that narrowing.
 */
export const REMOVAL_CALLS: ReadonlyArray<string> = Object.freeze([
  // `node:fs`
  "rmSync",
  "unlinkSync",
  "renameSync",
  "rmdirSync",
  // `node:fs/promises` twins. Nothing in `src/core/brain/` imports them
  // today; they are here so the FIRST one is reported rather than
  // admitted. The import gate in the census is what keeps a local helper
  // named `rm` or `rename` from being miscounted as one of these.
  "rm",
  "unlink",
  "rename",
  "rmdir",
]);

/**
 * What the census records when a module reaches an fs namespace through
 * a COMPUTED member - `fs[call](path)`. Which call that is is a runtime
 * fact, so the site is reported under this token rather than resolved to
 * a name the census would be guessing at.
 *
 * Not a `node:fs` name, and deliberately unspellable as one: a site that
 * needs it has to declare it, and the declaration is where the module
 * says which calls that expression can actually reach.
 */
export const FS_UNRESOLVED_CALL = "fs[]";

/**
 * Shortest reason the census accepts. Set where a real argument fits and
 * a placeholder does not: "cleanup" and "not needed" are both under it.
 */
export const DESTRUCTIVE_SITE_MIN_REASON_LENGTH = 60;

/** One site's declaration. */
export interface DestructiveSiteDeclaration {
  /** The removal calls this module makes directly, sorted. */
  readonly calls: ReadonlyArray<string>;
  /** What is at risk, and whether anything archived it first. */
  readonly recovery: RecoverabilityFacts;
  /** What the facts alone do not say. Never empty, never shared. */
  readonly reason: string;
}

/** No archive behind it, and the bytes are inside the Brain tree. */
const UNARCHIVED_BRAIN: RecoverabilityFacts = Object.freeze({
  recoveryPoint: false,
  blastRadius: Object.freeze({ brainTopLevel: true }),
});

/** No archive behind it, and the bytes are outside the Brain tree. */
const UNARCHIVED_OUTSIDE: RecoverabilityFacts = Object.freeze({
  recoveryPoint: false,
  blastRadius: Object.freeze({ outsideBrainRoot: true }),
});

/**
 * No archive behind it, and the bytes are in an entry no archive has
 * ever contained: `Brain/.snapshots` or `Brain/.artifacts`.
 */
const UNARCHIVED_EXCLUDED: RecoverabilityFacts = Object.freeze({
  recoveryPoint: false,
  blastRadius: Object.freeze({ snapshotExcludedEntries: true }),
});

/**
 * Every destructive site under `src/core/brain/` that is not routed
 * through the destructive gate, with the argument for why the removal
 * is accounted for anyway.
 *
 * Paths are repo-relative and POSIX-separated, matching the census's own
 * enumeration.
 */
export const DESTRUCTIVE_SITES: Readonly<Record<string, DestructiveSiteDeclaration>> =
  Object.freeze({
    // --- Moves whose destination is proved before the source goes -------
    "src/core/brain/pending.ts": {
      calls: ["unlinkSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "`atomicCreateFileSyncExclusive` lands the inbox copy and throws on a name " +
        "collision BEFORE the unlink runs, so the record exists twice at the moment " +
        "the source is removed and never zero times.",
    },
    "src/core/brain/preference.ts": {
      calls: ["unlinkSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "the retire re-renders into `retired/` through `writeFrontmatterAtomic` and " +
        "then re-confirms the destination with `existsSync`, throwing if it is absent, " +
        "before unlinking. Worth naming precisely: it RE-RENDERS rather than copies, so " +
        "the record survives and the original prose does not.",
    },
    "src/core/brain/signal-retire.ts": {
      calls: ["unlinkSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "the signal twin of the preference retire - shared-writer write, existence " +
        "re-confirmed with a throw on absence, then the source unlinked - and the one " +
        "of the pair that copies rather than re-renders, so no prose is lost.",
    },

    // --- Archival moves: the bytes change location, not existence -------
    "src/core/brain/capture/capture-note.ts": {
      calls: ["renameSync", "rmSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "moves a staged capture into `processed/`. The `rmSync` is the source half of " +
        "the cross-device fallback and runs only after `atomicWriteText` has written " +
        "the archived copy from bytes already read into memory.",
    },
    "src/core/brain/dead-ends.ts": {
      calls: ["renameSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "moves dead-end notes past the active cap into `archive/` under their own id. " +
        "A rename inside one directory tree keeps the inode, so nothing is read back " +
        "from a copy and there is nothing to lose to a partial write.",
    },
    "src/core/brain/dream-apply.ts": {
      calls: ["renameSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "moves each consumed signal from `inbox/` into its processed location. It runs " +
        "inside the dream pass, whose pre-run archive covers the whole Brain tree - " +
        "coverage this entry cannot claim itself, because the archive belongs to the " +
        "caller and this module is reachable from tests without one.",
    },
    "src/core/brain/intentions.ts": {
      calls: ["renameSync", "rmSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "archives an active intention into `history/` under a name a collision loop has " +
        "already proved free, so an existing history entry can never be renamed over. " +
        "The `rmSync` is the cross-device fallback's source half.",
    },
    "src/core/brain/obligations.ts": {
      calls: ["renameSync", "rmSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "archives a closed obligation the same way, with the fallback arm writing the " +
        "copy through `atomicWriteFileSync` from bytes already in memory before the " +
        "source is removed.",
    },
    "src/core/brain/recompile.ts": {
      calls: ["renameSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "moves an orphaned GENERATED page into the cleanup directory under a suffixed " +
        "free name. The page is reproducible from its inputs by definition, and the " +
        "move is what lets an operator see what was orphaned rather than guess.",
    },
    "src/core/brain/dream-stage.ts": {
      calls: ["renameSync", "rmSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "renames a staged bundle DIRECTORY into `applied/`, and discards a bundle the " +
        "operator explicitly dropped. A discarded bundle was never applied to the " +
        "vault, so its removal loses a proposal rather than any vault state.",
    },

    // --- Files whose whole content is their existence --------------------
    "src/core/brain/exact-state.ts": {
      calls: ["rmSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "clears one aspect's exact-state file. Absence IS the cleared state, so the " +
        "removal is the state transition rather than a loss of one.",
    },
    "src/core/brain/ingest/checkpoint.ts": {
      calls: ["rmSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "clears one ingest plan's checkpoint once the plan reached its terminal state. " +
        "The checkpoint exists to let an interrupted plan resume; after the plan is " +
        "done there is nothing it could resume into.",
    },
    "src/core/brain/skill-accept-journal.ts": {
      calls: ["rmSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "removes the accept-journal marker once the accept committed. The journal is a " +
        "crash-recovery record for the accept it describes, so keeping it past the " +
        "commit would make the NEXT run try to roll back finished work.",
    },
    "src/core/brain/lineage/identity.ts": {
      calls: ["unlinkSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "clears a worktree identity marker and prunes the oldest past a fixed retain " +
        "count, expired and undatable first. A marker carries no content beyond the " +
        "fact that a worktree was seen, and the next run re-creates the live ones.",
    },
    "src/core/brain/git/ingest.ts": {
      calls: ["rmSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "clears the git-ingest `state.json` watermark on a rescan that found no head, " +
        "so the next run starts as an initial walk instead of inheriting a marker that " +
        "points at a commit the repository no longer has.",
    },

    // --- Regenerable derivations -----------------------------------------
    "src/core/brain/link-graph/communities.ts": {
      calls: ["rmSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "removes generated cluster notes the current run no longer expects, and only " +
        "those whose own frontmatter declares the generated kind - so a hand-written " +
        "note that happens to sit in the directory is never a candidate.",
    },
    "src/core/brain/truth/store.ts": {
      calls: ["rmSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "removes a claim-event shard only when compaction has filtered every line out " +
        "of it, so the file removed is provably empty of surviving events at the moment " +
        "it goes.",
    },
    "src/core/brain/write-session/store.ts": {
      calls: ["rmSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "deletes write-session files individually and by sweep, and the sweep removes " +
        "only sessions in a terminal status or names outside the session-id grammar, " +
        "which can never become a live session.",
    },
    "src/core/brain/gaps/gap-loop.ts": {
      calls: ["rmSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "prunes gap tasks that are both CLOSED and past a fixed retention window, read " +
        "from each task's own `closed_at`; a task with an unparseable or recent " +
        "`closed_at` is skipped rather than removed.",
    },
    "src/core/brain/ingest/sources-registry.ts": {
      calls: ["rmSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "deletes a source page only after re-reading its frontmatter and confirming " +
        "from the file itself that it is one, so a caller cannot aim it at an arbitrary " +
        "note by passing the wrong path.",
    },

    // --- Bootstrap: a tree that did not exist a moment ago ---------------
    "src/core/brain/init.ts": {
      calls: ["renameSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "re-dates the starter bundle's own log filenames immediately after copying them " +
        "into a destination the pre-check already proved empty. This is also the path " +
        "that CREATES the tree, so it cannot be gated on anything the tree is about to " +
        "contain.",
    },

    // --- The archive machinery itself ------------------------------------
    "src/core/brain/snapshot.ts": {
      calls: ["renameSync", "rmSync", "unlinkSync"],
      recovery: UNARCHIVED_EXCLUDED,
      reason:
        "the module that MAKES recovery points: it prunes archives past the retention " +
        "count, removes a partial store archive whose snapshot was refused, and swaps a " +
        "decompressed database into place. Gating any of it on taking a snapshot would " +
        "be circular, so `pruneSnapshots` carries a floor and a named refusal instead " +
        "and `restoreSnapshot` takes a manual recovery point of the tree it discards.",
    },

    // --- Concurrency primitives ------------------------------------------
    "src/core/brain/sync-lockfile.ts": {
      calls: ["unlinkSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "the lock release and the process-exit sweep that releases any lock still held. " +
        "A lock file's meaning comes entirely from its exclusive creation; removing one " +
        "grants access rather than destroying anything.",
    },
    "src/core/brain/lineage/ledger.ts": {
      calls: ["unlinkSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "breaks a lock its own mtime has proved stale past a fixed threshold, with the " +
        "original `ELOCKED` rethrown when it has not. The ledger the lock protects is " +
        "append-only and is not touched here.",
    },

    // --- Rewrites through a temp file ------------------------------------
    "src/core/brain/maintenance/journal.ts": {
      calls: ["renameSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "the tmp-plus-rename half of the journal cap sweep, which runs only while the " +
        "maintenance lease is held. The rename is what makes the trim atomic - a reader " +
        "sees either the full journal or the capped one, never a torn file.",
    },
    "src/core/brain/secrets/store.ts": {
      calls: ["renameSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "the tmp-plus-rename half of a hand-rolled atomic write that must land at mode " +
        "0600, which no shared writer expresses. The store holds encrypted secrets and " +
        "is deliberately outside every snapshot archive, so its safety comes from the " +
        "atomicity of the swap and not from a recovery point.",
    },

    // --- Two-phase accept with a journalled rollback ---------------------
    "src/core/brain/skill-proposals.ts": {
      calls: ["rmSync", "unlinkSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "unlinks the pending proposal only after the accepted copy landed through " +
        "`writeFrontmatterAtomic` and the journal recorded the commit phase; the " +
        "`rmSync` arm is the rollback, and it removes the accepted copy and its " +
        "procedure only when the journal recorded that neither existed beforehand.",
    },

    // --- Repair under an explicit apply ----------------------------------
    "src/core/brain/watchdog.ts": {
      calls: ["rmSync"],
      recovery: UNARCHIVED_BRAIN,
      reason:
        "under `--remediate` without `--dry-run` only: removes a non-directory " +
        "occupying a path the Brain tree requires to be a directory, immediately before " +
        "creating it. The plan naming that file is returned on every dry run, so the " +
        "operator sees the exact removal before authorising it.",
    },

    // --- Reached from the gate, but not lexically inside it --------------
    "src/core/brain/source-cleanup.ts": {
      calls: ["rmSync"],
      recovery: Object.freeze({
        recoveryPoint: true,
        blastRadius: Object.freeze({ brainTopLevel: true, outsideBrainRoot: true }),
      }),
      reason:
        "`removeFile` is reached only from `runDeletion`, which `deleteBySource` hands to " +
        "`withDestructiveSnapshot` BY NAME - so the archive exists before any removal, but the " +
        "census sees a helper rather than a gated block and this entry is that claim written " +
        "down. The one ungated call of `runDeletion` is the no-work branch, where the derived, " +
        "originals and manifest lists are all empty and the loops remove nothing. Recovery is " +
        "PARTIAL rather than covered because `--include-originals` removes the imported file " +
        "outside `Brain/`, which no archive has ever held.",
    },
    "src/core/brain/notes/lifecycle.ts": {
      calls: ["renameSync", "unlinkSync"],
      recovery: UNARCHIVED_OUTSIDE,
      reason:
        "the note MOVE, which is a relink and not a copy: `linkSync` attaches the inode to the " +
        "destination name and the name is re-confirmed on disk before the source name is " +
        "dropped, so the bytes are reachable under two names at that instant and under one at " +
        "every other. The case-only rename cannot use that order - unlinking the source would " +
        "remove the destination with it - so it stages a third private name for the same inode " +
        "first. A note lives outside `Brain/` by construction, which is why no archive covers " +
        "it and why the DELETE arm of the same module is behind the gate instead.",
    },

    // --- Outside the vault entirely --------------------------------------
    "src/core/brain/portability/pointer.ts": {
      calls: ["rmSync"],
      recovery: UNARCHIVED_OUTSIDE,
      reason:
        "the project-side pointer NAMING a vault lives outside that vault - " +
        "`assertNotInsideVault` enforces it - so no archive could ever have covered it, " +
        "and its whole content is one path an operator can write again.",
    },
  });

/**
 * The verdict for one declared site, or `null` when the path carries no
 * declaration (which for a real path means it routes through the gate).
 *
 * Derived rather than stored, so a registry entry cannot claim a state
 * its own facts do not support.
 */
export function destructiveSiteRecoverability(path: string): RecoverabilityVerdict | null {
  const entry = DESTRUCTIVE_SITES[path];
  return entry === undefined ? null : classifyRecoverability(entry.recovery);
}
