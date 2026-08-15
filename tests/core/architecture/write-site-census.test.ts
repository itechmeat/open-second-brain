/**
 * Unit B — every in-vault write site, measured rather than described.
 *
 * The write binding this release ships covers ONE class of destination:
 * the vault-relative path a caller names. That is a real boundary and it
 * is also a small fraction of what puts bytes into a vault. Shipping it
 * while describing the surface as "enforced" would be theatre: dozens of
 * modules reach `node:fs` directly and pass no shared writer at all —
 * including, before this unit, one that wrote a complete vault note with
 * hand-rolled frontmatter and one inside a CLI verb.
 *
 * How many there are is not written down in this docblock, because a
 * number in prose is the thing that goes stale. {@link
 * DIRECT_WRITE_EXCLUSIONS} below IS the count, and it is exact by
 * construction: it walks the tree, finds every direct-`fs` write into
 * the vault, and requires each to carry a written exclusion naming the
 * category it falls in and the reason it does not route through a shared
 * writer. A new direct writer fails here and is named in the failure.
 *
 * ## The population, defined structurally
 *
 * A module is IN POPULATION when it can address the vault: it lives
 * under one of {@link VAULT_WRITE_ROOTS}, or it is one of
 * {@link VAULT_WRITER_FILES}, or it imports the Brain vault-path
 * vocabulary (`paths.ts`) from anywhere in the tree. The last clause is
 * what stops a new in-vault writer escaping by living somewhere new.
 * Modules that write only outside the vault — the install adapters, the
 * machine-config exporter, the benchmark harness — are out by the rule
 * rather than by twenty hand-written "not a vault" entries.
 *
 * ## What counts as a WRITE
 *
 * A CONTENT write: a call that puts file bytes on disk, or removes,
 * moves, or re-permissions a file. `mkdirSync` is deliberately NOT in
 * the set. A directory holds no content, every atomic writer creates its
 * own parent, and counting it would make this census a list of every
 * module that writes anything — which is what the vault-guard census
 * (`tests/core/brain/vault-guard-census.test.ts`) already is. The two
 * censuses answer different questions: that one asks whether a
 * write-capable MODULE asserts vault identity, this one asks whether a
 * write SITE goes through a shared writer.
 *
 * Only identifiers actually bound from `node:fs` or `node:fs/promises`
 * count, so a local helper that happens to be called `writeFileSync` is
 * not miscounted, and a module that reaches `fs` through the shared
 * writers shows up in the shared class instead. "Bound" covers every
 * form the language offers - several statements in one file, a renamed
 * binding, a namespace import, either quote style - because the detector
 * previously read only a file's FIRST `node:fs` statement and the live
 * vault append in `src/core/brain/git/store.ts` sat on the second one.
 * Runtime writers that need no import (`Bun.write`) are matched on the
 * receiver instead.
 *
 * What it still does not see, stated rather than implied: a write issued
 * through a `node:fs/promises` FileHandle method, or through a binding
 * re-exported by an intermediate module. Both would be new shapes in
 * this tree, and the shape table in "the census can fail" is where a new
 * one gets added the day it appears.
 *
 * ## Why the exclusions are categorised
 *
 * Fifty free-text reasons are a wall nobody reads. Every entry carries a
 * category from a closed vocabulary, so the shape of the gap is legible
 * at a glance — how much of it is append-only ledgers, how much is
 * lifecycle moves that author no content, how much is retention pruning
 * — and the free text says only what the category cannot.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

/** Trees whose modules address the vault by construction. */
const VAULT_WRITE_ROOTS: ReadonlyArray<string> = Object.freeze([
  "src/core/brain/",
  "src/core/search/",
  "src/cli/brain/",
  "src/mcp/",
]);

/** Vault writers that live outside those trees, named individually. */
const VAULT_WRITER_FILES: ReadonlyArray<string> = Object.freeze([
  "src/core/vault.ts",
  "src/core/fs-atomic.ts",
]);

/** The vault path vocabulary. Importing it is addressing the vault. */
const VAULT_PATHS_IMPORT_RE = /^[ \t]*import\b[^;]*?\bfrom\s*"\.[^"]*\bpaths\.ts"/m;

/**
 * Calls that put file bytes on disk, or remove, move, or re-permission a
 * file. See the docblock for why `mkdirSync` is not among them.
 */
const CONTENT_WRITE_CALLS: ReadonlyArray<string> = Object.freeze([
  // `node:fs`
  "writeFileSync",
  "appendFileSync",
  "writeSync",
  "renameSync",
  "rmSync",
  "unlinkSync",
  "rmdirSync",
  "cpSync",
  "copyFileSync",
  "createWriteStream",
  "truncateSync",
  "ftruncateSync",
  "symlinkSync",
  "linkSync",
  "utimesSync",
  "chmodSync",
  // `node:fs/promises` twins of the same operations. Nothing in `src/`
  // imports them today; they are here so the FIRST one is reported rather
  // than admitted. The import gate below is what keeps a local helper
  // named `rm` or `link` from being miscounted as one of these.
  "writeFile",
  "appendFile",
  "rename",
  "rm",
  "unlink",
  "rmdir",
  "cp",
  "copyFile",
  "truncate",
  "symlink",
  "link",
  "utimes",
  "chmod",
]);

const CONTENT_WRITE_SET: ReadonlySet<string> = new Set(CONTENT_WRITE_CALLS);

/**
 * Writers reachable with no import at all, so no import gate can see them.
 * Named in full (`Bun.write`) because the receiver is what identifies them.
 */
const GLOBAL_WRITE_CALLS: ReadonlyArray<string> = Object.freeze(["Bun.write"]);

/** The shared writers a site may route through instead. */
const SHARED_WRITE_CALLS: ReadonlyArray<string> = Object.freeze([
  "atomicWriteFileSync",
  "atomicWriteText",
  "atomicCreateFileSyncExclusive",
  "writeFrontmatterAtomic",
  "writeFrontmatter",
]);

/** A dotted call name as a pattern that tolerates spacing around the dot. */
function callPattern(name: string): string {
  return name.split(".").join(String.raw`\s*\.\s*`);
}

/** Longest name first, so a prefix cannot shadow the longer name after it. */
function alternation(names: ReadonlyArray<string>): string {
  return [...names]
    .toSorted((a, b) => b.length - a.length)
    .map(callPattern)
    .join("|");
}

function callRe(names: ReadonlyArray<string>): RegExp {
  return new RegExp(String.raw`\b(${alternation(names)})\s*\(`, "g");
}

/** Member calls on a namespace import, e.g. `fs.writeFileSync(...)`. */
function namespaceCallRe(namespace: string): RegExp {
  return new RegExp(String.raw`\b${namespace}\s*\.\s*(${CONTENT_WRITE_ALTERNATION})\s*\(`, "g");
}

/** The matched call text, with the spacing the source happened to use removed. */
function normalizeCallName(matched: string): string {
  return matched.replace(/\s+/g, "");
}

const CONTENT_WRITE_ALTERNATION = alternation(CONTENT_WRITE_CALLS);
const GLOBAL_WRITE_RE = callRe(GLOBAL_WRITE_CALLS);
const SHARED_WRITE_RE = callRe(SHARED_WRITE_CALLS);

/**
 * Every `node:fs` / `node:fs/promises` import statement, in both binding
 * forms and both quote styles.
 *
 * GLOBAL on purpose. It used to be non-global and read with `.exec()`, so
 * only a module's FIRST `node:fs` statement counted - and the live vault
 * append in `src/core/brain/git/store.ts`, whose `appendFileSync` arrives
 * on the second statement, was invisible to a census that reported a clean
 * sweep. `import type { … }` does not match, because a type cannot be
 * called.
 */
const FS_IMPORT_RE =
  /import\s*(?:\*\s*as\s+([A-Za-z_$][\w$]*)|\{([^}]*)\})\s*from\s*["']node:fs(?:\/promises)?["']/g;

/**
 * Why a direct-`fs` write site does not go through a shared writer.
 * Closed on purpose: a new shape of gap should have to be named, not
 * absorbed into free text.
 */
const WRITE_CATEGORY = Object.freeze({
  /** This module IS a shared writer; the raw call is its implementation. */
  sharedWriterItself: "shared-writer-itself",
  /** Append to a line-oriented ledger. A rewrite would not be an append. */
  appendOnlyLedger: "append-only-ledger",
  /** Move an existing artifact between lifecycle locations; authors no content. */
  lifecycleMove: "lifecycle-move",
  /** Delete an artifact under a retention, reset, or cleanup policy. */
  retentionDelete: "retention-delete",
  /** Machine-readable artifact (JSON, JSONL, sqlite, archive) - never a note. */
  machineArtifact: "machine-artifact",
  /** A lock, marker, or other concurrency primitive. */
  lockPrimitive: "lock-primitive",
  /** Bulk copy of a whole subtree, in or out. */
  archiveTransfer: "archive-transfer",
  /** Permission or metadata change on an existing file; writes no bytes. */
  metadataOnly: "metadata-only",
} as const);

type WriteCategory = (typeof WRITE_CATEGORY)[keyof typeof WRITE_CATEGORY];

interface WriteExclusion {
  /** Every category this file's direct calls fall in. Never empty. */
  readonly categories: ReadonlyArray<WriteCategory>;
  /** The `node:fs` calls this file makes directly, sorted. */
  readonly calls: ReadonlyArray<string>;
  /** What the categories alone do not say. Never empty. */
  readonly reason: string;
}

const C = WRITE_CATEGORY;

/**
 * Every in-vault write site that reaches `node:fs` directly, with the
 * argument for why it is not behind a shared writer.
 *
 * This is the record the write binding cannot cover. Two entries were
 * removed by this unit rather than written: `core/brain/handoff.ts` now
 * emits its frontmatter through `writeFrontmatterAtomic` instead of
 * hand-rolling the block, and `cli/brain/verbs/links.ts` rewrites notes
 * through `atomicWriteFileSync` instead of truncating them in place.
 */
const DIRECT_WRITE_EXCLUSIONS: Readonly<Record<string, WriteExclusion>> = Object.freeze({
  // --- The shared writers themselves ------------------------------------
  "src/core/fs-atomic.ts": {
    categories: [C.sharedWriterItself],
    calls: ["linkSync", "renameSync", "unlinkSync", "writeSync"],
    reason:
      "this module IS the atomic-write pipeline every other site routes through; " +
      "the raw calls are its implementation of temp-file plus link(2)/rename(2).",
  },
  "src/core/vault.ts": {
    categories: [C.sharedWriterItself],
    calls: ["writeFileSync"],
    reason:
      "`writeFrontmatter`, the deliberately non-atomic sibling of " +
      "`writeFrontmatterAtomic`, used where a torn file on crash is acceptable " +
      "because the target is regenerated on the next run.",
  },

  // --- Append-only ledgers ----------------------------------------------
  "src/core/brain/capture/telegram-capture.ts": {
    categories: [C.appendOnlyLedger],
    calls: ["appendFileSync"],
    reason: "one JSON line per capture-routing decision, appended to the decision log.",
  },
  "src/core/brain/continuity/store.ts": {
    categories: [C.appendOnlyLedger],
    calls: ["writeFileSync"],
    reason:
      "`writeFileSync(..., { flag: 'a' })` under the shard lock - an O_APPEND write, " +
      "not a rewrite. Continuity appends are deliberately unfsynced and fail-open so " +
      "telemetry can never fail the operation it observes.",
  },
  "src/core/brain/decisions/receipts.ts": {
    categories: [C.appendOnlyLedger],
    calls: ["appendFileSync"],
    reason: "one receipt JSON line per decision, appended to a per-config shard.",
  },
  "src/core/brain/diagnostics.ts": {
    categories: [C.appendOnlyLedger],
    calls: ["appendFileSync"],
    reason:
      "the WAL-gap fixer appends the missing terminal phase line to a dream workrun " +
      "log. Additive by contract: the forensic content before the gap is preserved.",
  },
  "src/core/brain/dream-workrun.ts": {
    categories: [C.appendOnlyLedger],
    calls: ["appendFileSync"],
    reason:
      "the write-ahead phase log itself. Rewriting it would destroy the very record " +
      "that lets an interrupted run be detected.",
  },
  "src/core/brain/git/store.ts": {
    categories: [C.appendOnlyLedger],
    calls: ["appendFileSync"],
    reason:
      "one JSON line per ingested commit or tag appended to the per-repo " +
      "`commits.jsonl`, behind `assertVaultIdentityForWrite` and after the dedup pass " +
      "that drops shas already on disk. The `state.json` watermark beside it already " +
      "goes through `atomicWriteFileSync`, because a watermark is a rewrite and a " +
      "record is an append. This entry exists because the detector was fixed: the " +
      "import arrives on the module's SECOND `node:fs` statement, and a non-global " +
      "regex read only the first.",
  },
  "src/core/brain/health/edit-history.ts": {
    categories: [C.appendOnlyLedger],
    calls: ["appendFileSync"],
    reason: "deduplicated edit-history lines appended to the per-page history log.",
  },
  "src/core/brain/idempotency-ledger.ts": {
    categories: [C.appendOnlyLedger],
    calls: ["writeFileSync"],
    reason:
      "`writeFileSync(..., { flag: 'a' })` inside the shard lock: one record line per " +
      "remembered key, appended.",
  },
  "src/core/brain/lineage/ledger.ts": {
    categories: [C.appendOnlyLedger, C.lockPrimitive],
    calls: ["appendFileSync", "unlinkSync"],
    reason:
      "appends one record line; the COMPACTION arm beside it already uses " +
      "`atomicWriteFileSync`, because rewriting is a different operation from " +
      "appending. The `unlinkSync` breaks a lock proven stale by its own mtime, with " +
      "exactly one retry.",
  },
  "src/core/brain/maintenance/journal.ts": {
    categories: [C.appendOnlyLedger],
    calls: ["appendFileSync", "renameSync", "writeFileSync"],
    reason:
      "O_APPEND per line so gate-refusal writers - which run BEFORE the lease is " +
      "held - interleave instead of racing a read-modify-rewrite. The tmp-plus-rename " +
      "sweep is the one safe rewrite point and runs only while the lease is held.",
  },
  "src/core/brain/metrics.ts": {
    categories: [C.appendOnlyLedger],
    calls: ["appendFileSync"],
    reason: "one JSON line per surface metrics record.",
  },
  "src/core/brain/pref-audit.ts": {
    categories: [C.appendOnlyLedger],
    calls: ["appendFileSync"],
    reason: "one rendered line per preference mutation, appended to that preference's audit.",
  },
  "src/core/brain/query-demand.ts": {
    categories: [C.appendOnlyLedger],
    calls: ["appendFileSync"],
    reason: "one JSON line per query-demand record, appended under the log lock.",
  },
  "src/core/brain/recurrence.ts": {
    categories: [C.appendOnlyLedger],
    calls: ["appendFileSync"],
    reason: "one JSON line per recurrence event.",
  },

  // --- Lifecycle moves: an existing artifact changes location ------------
  "src/core/brain/capture/capture-note.ts": {
    categories: [C.lifecycleMove],
    calls: ["renameSync", "rmSync"],
    reason:
      "archives a staged capture into `processed/`. The `rmSync` is the source half of " +
      "the cross-device copy-then-remove fallback taken when `rename(2)` cannot span " +
      "filesystems.",
  },
  "src/core/brain/dead-ends.ts": {
    categories: [C.lifecycleMove],
    calls: ["renameSync"],
    reason: "moves dead-end notes past the active cap into `archive/`; the bytes are unchanged.",
  },
  "src/core/brain/dream-apply.ts": {
    categories: [C.lifecycleMove],
    calls: ["renameSync"],
    reason: "moves every consumed signal out of `inbox/` into its processed location.",
  },
  "src/core/brain/dream-stage.ts": {
    categories: [C.lifecycleMove, C.retentionDelete],
    calls: ["renameSync", "rmSync"],
    reason:
      "renames a whole staged bundle DIRECTORY into `applied/` - a directory move has " +
      "no file-writer form - and discards a bundle the operator dropped.",
  },
  "src/core/brain/intentions.ts": {
    categories: [C.lifecycleMove],
    calls: ["renameSync", "rmSync"],
    reason:
      "archives an active intention into `history/` under a collision-suffixed name, " +
      "with the same cross-device copy-then-remove fallback.",
  },
  "src/core/brain/obligations.ts": {
    categories: [C.lifecycleMove],
    calls: ["renameSync", "rmSync"],
    reason:
      "archives a closed obligation; the fallback arm writes the copy through " +
      "`atomicWriteFileSync` and removes the source.",
  },
  "src/core/brain/pending.ts": {
    categories: [C.lifecycleMove],
    calls: ["unlinkSync"],
    reason:
      "removes the source only AFTER `atomicCreateFileSyncExclusive` landed the " +
      "destination, so the exclusive create is the real gate and the unlink cannot " +
      "lose the record.",
  },
  "src/core/brain/preference.ts": {
    categories: [C.lifecycleMove],
    calls: ["unlinkSync"],
    reason:
      "removes the source only after `writeFrontmatterAtomic` landed the retired copy " +
      "AND its presence on disk was re-confirmed - the retire is a move whose write " +
      "half already goes through the shared writer.",
  },
  "src/core/brain/recompile.ts": {
    categories: [C.lifecycleMove],
    calls: ["renameSync"],
    reason: "moves an orphaned generated page into the cleanup directory under a free name.",
  },
  "src/core/brain/signal-retire.ts": {
    categories: [C.lifecycleMove],
    calls: ["unlinkSync"],
    reason:
      "the signal twin of the preference retire: shared-writer write first, existence " +
      "re-confirmed, then the source unlinked.",
  },
  "src/core/search/store/lifecycle.ts": {
    categories: [C.lifecycleMove],
    calls: ["renameSync"],
    reason:
      "restores the `.bak` sqlite index over a missing database after a crashed " +
      "reindex, re-checked under the lock. A database file has no text-writer form.",
  },

  // --- Retention, reset and cleanup deletes ------------------------------
  "src/core/brain/entities/label-hygiene.ts": {
    categories: [C.retentionDelete],
    calls: ["rmSync"],
    reason:
      "prunes entity records inside `withDestructiveSnapshot`, which is the safety " +
      "mechanism here; the surviving records' rewrites go through " +
      "`writeFrontmatterAtomic` in the same block.",
  },
  "src/core/brain/exact-state.ts": {
    categories: [C.retentionDelete],
    calls: ["rmSync"],
    reason: "clears one aspect's exact-state file; the absence IS the cleared state.",
  },
  "src/core/brain/gaps/gap-loop.ts": {
    categories: [C.retentionDelete],
    calls: ["rmSync"],
    reason: "prunes closed gap tasks past their retention window.",
  },
  "src/core/brain/git/ingest.ts": {
    categories: [C.retentionDelete],
    calls: ["rmSync"],
    reason:
      "clears the git ingest `state.json` on a rescan that found no head, so the next " +
      "run starts as an initial walk rather than inheriting a stale marker.",
  },
  "src/core/brain/ingest/checkpoint.ts": {
    categories: [C.retentionDelete],
    calls: ["rmSync"],
    reason: "clears one ingest plan's checkpoint; absence is the terminal state.",
  },
  "src/core/brain/ingest/sources-registry.ts": {
    categories: [C.retentionDelete],
    calls: ["rmSync"],
    reason:
      "deletes a source page after confirming from its own frontmatter that it is one; " +
      "a concurrent delete is reported, not swallowed.",
  },
  "src/core/brain/lineage/identity.ts": {
    categories: [C.retentionDelete],
    calls: ["unlinkSync"],
    reason:
      "clears a worktree identity marker, and prunes the oldest markers past the cap. " +
      "A marker's whole content is its existence.",
  },
  "src/core/brain/link-graph/communities.ts": {
    categories: [C.retentionDelete],
    calls: ["rmSync"],
    reason:
      "removes generated cluster notes the current run no longer expects, and only " +
      "those whose own frontmatter declares the generated kind.",
  },
  "src/core/brain/skill-accept-journal.ts": {
    categories: [C.retentionDelete],
    calls: ["rmSync"],
    reason:
      "removes the accept-journal marker once the accept committed; the path is put " +
      "through `ensureInsideVault` first because the unreadable arm cannot trust the " +
      "slug in the file.",
  },
  "src/core/brain/source-cleanup.ts": {
    categories: [C.retentionDelete],
    calls: ["rmSync"],
    reason: "deletes pages belonging to a removed source, each re-checked by `ensureInsideVault`.",
  },
  "src/core/brain/watchdog.ts": {
    categories: [C.retentionDelete],
    calls: ["rmSync"],
    reason:
      "under `--remediate --apply` only: removes a non-directory occupying a path the " +
      "tree requires to be a directory, immediately before creating it.",
  },
  "src/core/brain/write-session/store.ts": {
    categories: [C.retentionDelete],
    calls: ["rmSync"],
    reason: "deletes write-session files, individually and by sweep. Idempotent by `force`.",
  },
  "src/core/search/tuning-store.ts": {
    categories: [C.retentionDelete],
    calls: ["rmSync"],
    reason: "deletes the persisted tuning state; absence is the reset state.",
  },
  "src/mcp/artifact-store.ts": {
    categories: [C.retentionDelete],
    calls: ["rmSync"],
    reason:
      "prunes preview-artifact directories past their TTL. Directory removal has no " +
      "shared-writer form.",
  },

  // --- Machine-readable artifacts: JSON, sqlite, archives ----------------
  "src/cli/brain/verbs/continuity.ts": {
    categories: [C.machineArtifact],
    calls: ["writeFileSync"],
    reason:
      "`o2b brain continuity export` writes JSONL/JSON export files into an " +
      "operator-named output directory, not vault notes.",
  },
  "src/cli/main.ts": {
    categories: [C.machineArtifact],
    calls: ["writeFileSync"],
    reason:
      "`o2b config export --output` writes a redacted machine-config snapshot to an " +
      "operator-named path. In population only because the module imports the vault " +
      "path vocabulary elsewhere; this write never targets the vault.",
  },
  "src/core/brain/link-graph/bridge-discovery.ts": {
    categories: [C.machineArtifact],
    calls: ["writeFileSync"],
    reason: "rewrites the dismissed-bridge-pairs JSON set in full; there is no note involved.",
  },
  "src/core/brain/link-graph/co-occurrence.ts": {
    categories: [C.machineArtifact],
    calls: ["writeFileSync"],
    reason: "regenerates the co-occurrence JSON artifact in full from the current graph.",
  },
  "src/core/brain/portability/pointer.ts": {
    categories: [C.machineArtifact],
    calls: ["rmSync"],
    reason:
      "the project-side pointer NAMING a vault lives outside that vault " +
      "(`assertNotInsideVault`); removing it is not an in-vault write at all.",
  },
  "src/core/brain/secrets/crypto.ts": {
    categories: [C.machineArtifact],
    calls: ["writeSync"],
    reason:
      "writes key bytes into a descriptor opened `wx` at mode 0600. The exclusivity " +
      "and the mode are the point, and no shared writer takes a mode.",
  },
  "src/core/brain/secrets/store.ts": {
    categories: [C.machineArtifact],
    calls: ["renameSync", "writeFileSync"],
    reason:
      "hand-rolled tmp-plus-rename because it must write at mode 0600, which " +
      "`atomicWriteFileSync` cannot express. Routing it through the shared writer " +
      "would leave the secrets file world-readable for the length of the swap.",
  },
  "src/core/brain/truth/store.ts": {
    categories: [C.appendOnlyLedger, C.machineArtifact, C.retentionDelete],
    calls: ["appendFileSync", "rmSync", "writeFileSync"],
    reason:
      "appends one claim event per line, rewrites the DERIVED state JSON in full, and " +
      "compacts shards by rewriting or removing them.",
  },
  "src/core/search/activation/store.ts": {
    categories: [C.machineArtifact, C.retentionDelete],
    calls: ["rmSync", "writeFileSync"],
    reason:
      "one content-addressed JSON file per access event, the derived activation state " +
      "beside it, and a retention sweep over the events.",
  },
  "src/core/search/embeddings/registry.ts": {
    categories: [C.machineArtifact],
    calls: ["writeFileSync"],
    reason: "rewrites the embedding-provider registry JSON in full, name-sorted for determinism.",
  },
  "src/core/search/feedback.ts": {
    categories: [C.machineArtifact, C.retentionDelete],
    calls: ["rmSync", "writeFileSync"],
    reason:
      "one content-addressed JSON file per recall-feedback event, the derived learned " +
      "weights beside it, and the reset that removes them.",
  },
  "src/core/search/indexer.ts": {
    categories: [C.machineArtifact, C.lifecycleMove],
    calls: ["renameSync", "unlinkSync"],
    reason:
      "swaps a freshly built sqlite index into place under the index lock, keeping the " +
      "previous file as `.bak`. A database is not text and has no shared-writer form.",
  },
  "src/core/search/link-ratchet.ts": {
    categories: [C.archiveTransfer],
    calls: ["cpSync", "rmSync"],
    reason:
      "copies the subject vault into a `mkdtemp` workdir to measure it, then removes " +
      "the workdir. Nothing is written into the vault at all.",
  },
  "src/core/search/reinforce.ts": {
    categories: [C.machineArtifact, C.retentionDelete],
    calls: ["rmSync", "writeFileSync"],
    reason:
      "one content-addressed JSON file per reinforcement event, plus the sweep that " +
      "clears the directory.",
  },
  "src/core/search/rerank/registry.ts": {
    categories: [C.machineArtifact],
    calls: ["writeFileSync"],
    reason: "rewrites the rerank-provider registry JSON in full, name-sorted for determinism.",
  },
  "src/core/search/session-focus.ts": {
    categories: [C.machineArtifact, C.retentionDelete],
    calls: ["rmSync", "writeFileSync"],
    reason: "the per-session focus JSON and the call that clears it.",
  },
  "src/core/search/tuning.ts": {
    categories: [C.machineArtifact],
    calls: ["writeFileSync"],
    reason: "persists the tuning result JSON, keyed by a hash of the dataset it came from.",
  },

  // --- Bulk subtree transfer ---------------------------------------------
  "src/core/brain/init.ts": {
    categories: [C.archiveTransfer],
    calls: ["cpSync", "renameSync"],
    reason:
      "one recursive copy per bootstrap subdirectory into a destination the pre-check " +
      "already proved empty. This is also the path that CREATES the tree, so it can " +
      "not be gated on anything the tree is about to contain. The rename re-dates the " +
      "starter bundle's own log filenames immediately after that copy, inside the same " +
      "proven-empty destination.",
  },
  "src/core/brain/snapshot.ts": {
    categories: [C.archiveTransfer, C.retentionDelete],
    calls: ["cpSync", "renameSync", "rmSync", "unlinkSync", "writeFileSync"],
    reason:
      "writes the compressed archive BYTES into `.snapshots/`, prunes archives past " +
      "the retention count, and restores by recursive copy. A torn archive fails on " +
      "restore exactly as any interrupted snapshot does; no Markdown parser reads it. " +
      "The derived-store restore adds the rename pair: it stages the decompressed " +
      "database beside its destination and swaps it in under the search writer lock, " +
      "which IS the atomic write for a SQLite file - the same discipline `reindexVault` " +
      "uses, and the reason a partial decompression can never be observed as the live " +
      "store. The unlink removes a partial store archive whose snapshot was refused.",
  },

  // --- Concurrency primitives --------------------------------------------
  "src/core/brain/sync-lockfile.ts": {
    categories: [C.lockPrimitive],
    calls: ["unlinkSync", "writeSync"],
    reason:
      "the lock itself. Its semantics come from the exclusive create; the body it " +
      "writes is a diagnostic pid/timestamp stamp whose failure is deliberately " +
      "non-fatal, and the unlink is the release.",
  },

  // --- Metadata only -----------------------------------------------------
  "src/core/brain/health/remediation.ts": {
    categories: [C.metadataOnly],
    calls: ["chmodSync"],
    reason:
      "narrows non-owner permission bits on an existing file or directory. No bytes " +
      "are written, so there is nothing for a writer to make atomic.",
  },

  // --- Mixed: an accept protocol that moves, appends and rolls back ------
  "src/core/brain/skill-proposals.ts": {
    categories: [C.appendOnlyLedger, C.lifecycleMove, C.retentionDelete],
    calls: ["appendFileSync", "rmSync", "unlinkSync"],
    reason:
      "appends one JSON line per verifier rejection; unlinks the pending proposal only " +
      "after the accepted copy landed through `writeFrontmatterAtomic`; and removes " +
      "the accepted copy and its procedure when a journalled accept is rolled back.",
  },
});

interface CensusFile {
  readonly path: string;
  readonly text: string;
}

interface CensusRow {
  readonly path: string;
  /** Direct `node:fs` content-write calls this file makes, sorted, deduped. */
  readonly directCalls: ReadonlyArray<string>;
  /** How many shared-writer calls it makes. */
  readonly sharedCalls: number;
}

/** Every `.ts` file under `src/`, as path + text. */
function readSourceTree(): CensusFile[] {
  const files: CensusFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts")) {
        files.push({
          path: relative(REPO_ROOT, abs).split("\\").join("/"),
          text: readFileSync(abs, "utf8"),
        });
      }
    }
  };
  walk(SRC_ROOT);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/** Whether this module can address the vault - see the docblock. */
function addressesVault(file: CensusFile): boolean {
  if (VAULT_WRITE_ROOTS.some((root) => file.path.startsWith(root))) return true;
  if (VAULT_WRITER_FILES.includes(file.path)) return true;
  return VAULT_PATHS_IMPORT_RE.test(file.text);
}

interface FsImports {
  /**
   * Local binding -> the `node:fs` name it was imported under. The two
   * differ under `import { writeFileSync as put }`, and matching on the
   * LOCAL name is what makes the renamed form countable at all.
   */
  readonly bindings: ReadonlyMap<string, string>;
  /** Local names of namespace imports, e.g. `fs` in `import * as fs`. */
  readonly namespaces: ReadonlySet<string>;
}

/** What this module actually imported from `node:fs` / `node:fs/promises`. */
function fsImports(text: string): FsImports {
  const bindings = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const match of text.matchAll(FS_IMPORT_RE)) {
    const namespace = match[1];
    if (namespace !== undefined) {
      namespaces.add(namespace);
      continue;
    }
    for (const raw of match[2]!.split(",")) {
      const [imported, local] = raw
        .trim()
        .split(/\s+as\s+/)
        .map((part) => part.trim());
      if (imported === undefined || imported.length === 0) continue;
      bindings.set(local !== undefined && local.length > 0 ? local : imported, imported);
    }
  }
  return { bindings, namespaces };
}

/** The `node:fs` write calls this module makes directly, by their fs name. */
function directWriteCalls(text: string, imported: FsImports): Set<string> {
  const direct = new Set<string>();
  const locals = [...imported.bindings.keys()];
  if (locals.length > 0) {
    for (const match of text.matchAll(callRe(locals))) {
      const name = imported.bindings.get(normalizeCallName(match[1]!));
      if (name !== undefined && CONTENT_WRITE_SET.has(name)) direct.add(name);
    }
  }
  for (const namespace of imported.namespaces) {
    for (const match of text.matchAll(namespaceCallRe(namespace))) {
      direct.add(normalizeCallName(match[1]!));
    }
  }
  for (const match of text.matchAll(GLOBAL_WRITE_RE)) {
    direct.add(normalizeCallName(match[1]!));
  }
  return direct;
}

/** Classify one file into its direct and shared write sites. */
function classify(file: CensusFile): CensusRow | null {
  if (!addressesVault(file)) return null;
  const direct = directWriteCalls(file.text, fsImports(file.text));
  const shared = [...file.text.matchAll(SHARED_WRITE_RE)].length;
  if (direct.size === 0 && shared === 0) return null;
  return { path: file.path, directCalls: [...direct].toSorted(), sharedCalls: shared };
}

function census(files: ReadonlyArray<CensusFile>): CensusRow[] {
  const rows: CensusRow[] = [];
  for (const file of files) {
    const row = classify(file);
    if (row !== null) rows.push(row);
  }
  return rows;
}

const SOURCE_TREE = readSourceTree();
const ROWS = census(SOURCE_TREE);
const DIRECT_ROWS = ROWS.filter((row) => row.directCalls.length > 0);

describe("in-vault write-site census", () => {
  test("every direct-fs write site carries a written exclusion", () => {
    const unlisted = DIRECT_ROWS.filter((row) => !(row.path in DIRECT_WRITE_EXCLUSIONS)).map(
      (row) => `${row.path} [${row.directCalls.join(",")}]`,
    );
    // Named, not counted: the failure has to say which file.
    expect(unlisted).toEqual([]);
  });

  test("no exclusion outlives the site it excuses", () => {
    const present = new Set(DIRECT_ROWS.map((row) => row.path));
    const stale = Object.keys(DIRECT_WRITE_EXCLUSIONS).filter((path) => !present.has(path));
    expect(stale).toEqual([]);
  });

  test("each exclusion still names exactly the calls its site makes", () => {
    // A new KIND of direct write inside an already-excused file is a new
    // decision, not one the existing argument already covered.
    const drifted: string[] = [];
    for (const row of DIRECT_ROWS) {
      const entry = DIRECT_WRITE_EXCLUSIONS[row.path];
      if (entry === undefined) continue;
      if (entry.calls.join(",") !== row.directCalls.join(",")) {
        drifted.push(
          `${row.path}: declared [${entry.calls.join(",")}] found [${row.directCalls.join(",")}]`,
        );
      }
    }
    expect(drifted).toEqual([]);
  });

  test("every exclusion carries a non-empty reason", () => {
    for (const [path, entry] of Object.entries(DIRECT_WRITE_EXCLUSIONS)) {
      expect(`${path}: ${entry.reason.trim().length > 0} ${entry.categories.length > 0}`).toBe(
        `${path}: true true`,
      );
    }
  });

  test("the two writers this unit routed through a shared helper are gone from the record", () => {
    // Both wrote vault content by hand: one a complete note with
    // hand-rolled frontmatter, one a truncating rewrite of notes the
    // operator edits concurrently. Their absence here is the assertion.
    const direct = new Set(DIRECT_ROWS.map((row) => row.path));
    expect(direct.has("src/core/brain/handoff.ts")).toBe(false);
    expect(direct.has("src/cli/brain/verbs/links.ts")).toBe(false);
  });
});

describe("the census can fail", () => {
  /** Run the real census over the real tree plus one synthetic module. */
  function unlistedWith(intruder: CensusFile): string[] {
    return census([...SOURCE_TREE, intruder])
      .filter((row) => row.directCalls.length > 0)
      .filter((row) => !(row.path in DIRECT_WRITE_EXCLUSIONS))
      .map((row) => row.path);
  }

  /**
   * Every source shape a direct write can arrive in. Each must be reported
   * on its own: the detector used to see only the first `node:fs` import
   * statement of a file, in the one binding form and the one quote style,
   * so the shapes below were unreachable by construction and the suite
   * still passed. A shape that stops being detected shows up here as a
   * named failure rather than as a silently smaller census.
   */
  const INTRUDER_SHAPES: ReadonlyArray<readonly [string, string]> = Object.freeze([
    [
      "a plain named import",
      'import { writeFileSync } from "node:fs";\nwriteFileSync("x", "y");\n',
    ],
    [
      "a second `node:fs` import statement",
      'import { readFileSync } from "node:fs";\nimport { appendFileSync } from "node:fs";\nappendFileSync("x", "y");\n',
    ],
    ["a renamed binding", 'import { writeFileSync as put } from "node:fs";\nput("x", "y");\n'],
    ["a namespace import", 'import * as fs from "node:fs";\nfs.writeFileSync("x", "y");\n'],
    [
      "the promise API",
      'import { writeFile } from "node:fs/promises";\nawait writeFile("x", "y");\n',
    ],
    [
      "a single-quoted specifier",
      "import { writeFileSync } from 'node:fs';\nwriteFileSync('x', 'y');\n",
    ],
    ["a runtime built-in needing no import", 'await Bun.write("x", "y");\n'],
  ]);

  for (const [shape, source] of INTRUDER_SHAPES) {
    test(`a new direct writer using ${shape} is reported unlisted`, () => {
      const path = "src/core/brain/synthetic-intruder.ts";
      expect(unlistedWith({ path, text: source })).toEqual([path]);
    });
  }

  test("a type-only fs import is not a write site", () => {
    // The complement of the import gate: naming a type cannot write bytes,
    // and counting it would put every module that annotates a `Dirent` in
    // the record.
    expect(
      classify({
        path: "src/core/brain/synthetic-types-only.ts",
        text: 'import type { WriteFileOptions } from "node:fs";\nexport type T = WriteFileOptions;\n',
      }),
    ).toBeNull();
  });

  test("the live second-statement import stays visible", () => {
    // The concrete defect this detector fix closes, pinned by name: the
    // vault append in the git record store arrives through the module's
    // SECOND `node:fs` statement. A regression to a single-statement read
    // makes this row vanish and the sweep read as clean.
    const row = DIRECT_ROWS.find((candidate) => candidate.path === "src/core/brain/git/store.ts");
    expect(row?.directCalls).toEqual(["appendFileSync"]);
  });

  test("a writer outside every vault root is out of population, not silently listed", () => {
    // The complement of the rule above: over-reach would drag the
    // install adapters in and make the record meaningless.
    const outsider: CensusFile = {
      path: "src/core/install/adapters/synthetic.ts",
      text: 'import { writeFileSync } from "node:fs";\nwriteFileSync("x", "y");\n',
    };
    expect(classify(outsider)).toBeNull();
  });

  test("the detectors still match the shapes they measure", () => {
    // A regex that stopped matching would report a clean sweep over an
    // empty set. Pin the measurement, not only its verdict.
    // Set just under the measurement, not an order of magnitude under it:
    // a floor of 40 against 63 would let a third of the tree stop being
    // seen and still report a clean sweep.
    expect(DIRECT_ROWS.length).toBeGreaterThan(58);
    expect(ROWS.filter((row) => row.sharedCalls > 0).length).toBeGreaterThan(88);
  });
});
