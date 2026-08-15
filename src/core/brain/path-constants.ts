/**
 * Canonical vault-relative layout of the Brain tree: every directory and
 * artefact filename under `<vault>/Brain/`, plus the two names of the
 * sibling derived-store directory that the snapshot family has to reach.
 *
 * Single source of truth. Every module that builds a path inside the
 * Brain layer imports these instead of repeating the literal. A future
 * rename ("Brain" → something else) is a one-line change here.
 *
 * A LEAF by construction — it imports nothing from the Brain layer. The
 * builders in `paths.ts` compose absolute paths from these names AND
 * carry the write-intent guard, so they depend on `vault-identity.ts`;
 * `vault-identity.ts` in turn only needs to know where the marker lives,
 * which is a name, not a builder. Keeping the names here is what lets
 * both sides reach them without pointing at each other. `paths.ts`
 * re-exports the whole module, so no importer changes.
 */

import { posix } from "node:path";

/** Vault-relative root of the Brain layer. */
export const BRAIN_ROOT_REL = "Brain";

/** Vault-relative Brain subdirectory names. */
export const BRAIN_INBOX_REL = posix.join(BRAIN_ROOT_REL, "inbox");
export const BRAIN_PROCESSED_REL = posix.join(BRAIN_INBOX_REL, "processed");
/** Write-approval staging area: `Brain/pending/sig-*.md` (A3, t_e540b093). */
export const BRAIN_PENDING_REL = posix.join(BRAIN_ROOT_REL, "pending");
export const BRAIN_PREFERENCES_REL = posix.join(BRAIN_ROOT_REL, "preferences");
export const BRAIN_RETIRED_REL = posix.join(BRAIN_ROOT_REL, "retired");
export const BRAIN_SKILL_PROPOSALS_REL = posix.join(BRAIN_ROOT_REL, "skill-proposals");
export const BRAIN_SKILL_PROPOSALS_PENDING_REL = posix.join(BRAIN_SKILL_PROPOSALS_REL, "pending");
export const BRAIN_SKILL_PROPOSALS_ACCEPTED_REL = posix.join(BRAIN_SKILL_PROPOSALS_REL, "accepted");
export const BRAIN_SKILL_PROPOSALS_REJECTED_REL = posix.join(BRAIN_SKILL_PROPOSALS_REL, "rejected");
/** Write-ahead journal of in-flight skill-proposal accepts (no-dead-ends, Unit I). */
export const BRAIN_SKILL_ACCEPT_JOURNAL_REL = posix.join(
  BRAIN_SKILL_PROPOSALS_REL,
  "accept-journal",
);
export const BRAIN_PROCEDURES_REL = posix.join(BRAIN_ROOT_REL, "procedures");
export const BRAIN_PROCEDURAL_MEMORY_REL = posix.join(BRAIN_ROOT_REL, "procedural-memory");
export const BRAIN_ATTENTION_REL = posix.join(BRAIN_ROOT_REL, "attention");
export const BRAIN_OBLIGATIONS_REL = posix.join(BRAIN_ROOT_REL, "obligations");
/** Declared-thesis register pages: `Brain/theses/thesis-<slug>.md` (D3). */
export const BRAIN_THESES_REL = posix.join(BRAIN_ROOT_REL, "theses");
export const BRAIN_DECISIONS_REL = posix.join(BRAIN_ROOT_REL, "decisions");
/**
 * Knowledge-gap task notes: `Brain/gap-tasks/gap-<hash>.md` (A3 /
 * t_67d38036). Plain durable note files - never on the Hermes kanban board.
 */
export const BRAIN_GAP_TASKS_REL = posix.join(BRAIN_ROOT_REL, "gap-tasks");
/** Persisted contradiction (tension) notes: `Brain/tensions/tension-<slug>.md` (S2). */
export const BRAIN_TENSIONS_REL = posix.join(BRAIN_ROOT_REL, "tensions");
/**
 * Directory NAME of the Brain log, as a top-level `Brain/` entry. Named
 * beside the vault-relative path because a consumer comparing paths that
 * are relative to `Brain/` itself - the snapshot differ, which walks two
 * extracted trees with no vault around them - needs the segment rather
 * than the path.
 */
export const BRAIN_LOG_DIR = "log";
export const BRAIN_LOG_REL = posix.join(BRAIN_ROOT_REL, BRAIN_LOG_DIR);
/**
 * Inbound-capture staging + archive (Knowledge intake suite, seam 1,
 * t_f8f5ef6a). Mirrors the inbox-versus-processed distinction: a capture
 * lands in `Brain/captures/` (staging) and moves to
 * `Brain/captures/processed/` (archive) once drained. Kept in its own
 * subtree so the signal inbox and the dream pass stay untouched.
 */
export const BRAIN_CAPTURES_REL = posix.join(BRAIN_ROOT_REL, "captures");
export const BRAIN_CAPTURES_PROCESSED_REL = posix.join(BRAIN_CAPTURES_REL, "processed");
export const BRAIN_ENTITIES_REL = posix.join(BRAIN_ROOT_REL, "entities");
/**
 * Overwrite-only exact-state lane: `Brain/state/<aspect>.md` (t_b0c9d0a3).
 * A structured operational-state store keyed by aspect; each write replaces
 * the aspect's canonical value with no history. The lane is excluded from
 * the search index by the index-admission predicate so a stale "current"
 * value can never resurface through semantic recall.
 */
export const BRAIN_STATE_REL = posix.join(BRAIN_ROOT_REL, "state");
/** Obsidian Bases view definitions: `Brain/bases/<view>.base` (v1.15.0). */
export const BRAIN_BASES_REL = posix.join(BRAIN_ROOT_REL, "bases");
/** Ingested source summary pages: `Brain/sources/src-<slug>.md` (v1.7.0). */
export const BRAIN_SOURCES_REL = posix.join(BRAIN_ROOT_REL, "sources");
/** Cited research report pages: `Brain/reports/<date>-<slug>.md` (v1.7.0). */
export const BRAIN_REPORTS_REL = posix.join(BRAIN_ROOT_REL, "reports");
/** Source-distillation pages: `Brain/distillations/dist-<slug>.md` (t_2e2e959f). */
export const BRAIN_DISTILLATIONS_REL = posix.join(BRAIN_ROOT_REL, "distillations");
/** Directory NAME of the snapshot archive home, as a top-level `Brain/` entry. */
export const BRAIN_SNAPSHOTS_DIR = ".snapshots";
export const BRAIN_SNAPSHOTS_REL = posix.join(BRAIN_ROOT_REL, BRAIN_SNAPSHOTS_DIR);
/**
 * Ephemeral MCP tool-result artifacts (v0.18.0). Dot-directory so the
 * vault walker excludes it from search/indexing exactly like
 * `.snapshots`; never backed up, pruned by TTL on server startup.
 */
export const BRAIN_ARTIFACTS_DIR = ".artifacts";
export const BRAIN_ARTIFACTS_REL = posix.join(BRAIN_ROOT_REL, BRAIN_ARTIFACTS_DIR);

/**
 * The top-level `Brain/` entries the snapshot family never touches:
 * never archived, never hashed into a manifest, and never removed by a
 * restore.
 *
 * `.snapshots` is excluded because archiving the archive home would
 * either explode the tar or let a rollback to an older state erase the
 * newer recovery points that are the operator's way forward.
 *
 * `.artifacts` is excluded because it is ephemeral tool output with a
 * TTL, documented above as never backed up. It was nevertheless archived
 * in every snapshot and hashed into every manifest, so churn in a cache
 * nobody wants restored tripped the rollback drift gate. One list, read
 * by the archiver, the manifest walker and the restore, is what keeps the
 * three from disagreeing again.
 */
export const BRAIN_SNAPSHOT_EXCLUDED_ENTRIES: ReadonlyArray<string> = Object.freeze([
  BRAIN_SNAPSHOTS_DIR,
  BRAIN_ARTIFACTS_DIR,
]);

/**
 * The DERIVED store: `<vault>/.open-second-brain/brain.sqlite`.
 *
 * A sibling of `Brain/`, not a member of it, and the only file in that
 * directory the snapshot family may ever touch. The directory also holds
 * encrypted secrets, the install and protect lockfiles, a second SQLite
 * lease database and the ingest checkpoints - none of which belongs in a
 * recovery archive of the Markdown tree, which is why the constant names
 * the FILE and every caller joins the two rather than archiving the
 * directory.
 *
 * The literal used to be repeated at roughly a dozen sites behind four
 * private per-module constants. Naming it here does not make this module
 * know what a search index is: it knows a name, exactly as it does for
 * every `Brain/` entry above.
 */
export const DERIVED_STORE_DIR = ".open-second-brain";
export const DERIVED_STORE_FILE = "brain.sqlite";
/**
 * Where the runtime hooks append their one-line-per-decision audit trail,
 * one shard per ISO week.
 *
 * Named here (C1) because it stopped being only the hooks' business: it
 * is the readable install fact for the `hook` recall channel - the doctor
 * check that asks whether an enabled hook ever ran has nothing else to
 * look at. Six hook files used to spell the root as a raw three-argument
 * join beside a `DERIVED_STORE_DIR` that already existed; all six now go
 * through {@link hookAuditDir}, and `tests/hooks/audit-root.test.ts`
 * reads the hook sources to keep it that way. Five independent spellings
 * of a path a check depends on is a rename that succeeds once and looks
 * done.
 */
export const HOOK_AUDIT_DIR = "hook-audit";

/** Brain-internal artefact filenames at the root of `Brain/`. */
export const BRAIN_CONFIG_FILE = "_brain.yaml";
export const BRAIN_MANUAL_FILE = "_BRAIN.md";
export const BRAIN_ACTIVE_FILE = "active.md";
export const BRAIN_LESSONS_FILE = "lessons.md";
/**
 * Operator-authored standing rules injected at the head of every session
 * preamble (silence-is-not-an-answer, U8).
 *
 * The DIRECTORY is most of the enforcement mechanism, and the reason the
 * name is a constant rather than a config key. Living under `Brain/` means
 * the note-target resolver already refuses it for the four caller-named
 * note-write tools; the label writer, which reaches a caller-named path
 * through the containment-only resolver, is refused by name in
 * `standing-rules.ts` instead. A configurable filename would be a second
 * thing to keep protected on both of those paths and would buy nothing the
 * operator cannot get by editing this file.
 */
export const BRAIN_STANDING_RULES_FILE = "standing-rules.md";
export const BRAIN_PINNED_FILE = "pinned.md";
export const BRAIN_INDEX_FILE = "_INDEX.md";
/** Persisted claim-graph projection artifact (Belief lifecycle suite, A3). */
export const BRAIN_CLAIM_GRAPH_FILE = "claim-graph.json";
/** Persisted rollup-ladder counter ledger (knowledge-intake-and-consolidation, S3). */
export const BRAIN_ROLLUP_LEDGER_FILE = "rollup-ladder.json";

/** Vault-relative path of the `o2b index` output file. */
export const BRAIN_INDEX_REL = posix.join(BRAIN_ROOT_REL, BRAIN_INDEX_FILE);
