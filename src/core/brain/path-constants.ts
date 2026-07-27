/**
 * Canonical vault-relative layout of the Brain tree: every directory and
 * artefact filename under `<vault>/Brain/`, and nothing else.
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
export const BRAIN_LOG_REL = posix.join(BRAIN_ROOT_REL, "log");
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
export const BRAIN_SNAPSHOTS_REL = posix.join(BRAIN_ROOT_REL, ".snapshots");
/**
 * Ephemeral MCP tool-result artifacts (v0.18.0). Dot-directory so the
 * vault walker excludes it from search/indexing exactly like
 * `.snapshots`; never backed up, pruned by TTL on server startup.
 */
export const BRAIN_ARTIFACTS_REL = posix.join(BRAIN_ROOT_REL, ".artifacts");

/** Brain-internal artefact filenames at the root of `Brain/`. */
export const BRAIN_CONFIG_FILE = "_brain.yaml";
export const BRAIN_MANUAL_FILE = "_BRAIN.md";
export const BRAIN_ACTIVE_FILE = "active.md";
export const BRAIN_LESSONS_FILE = "lessons.md";
export const BRAIN_PINNED_FILE = "pinned.md";
export const BRAIN_INDEX_FILE = "_INDEX.md";
/** Persisted claim-graph projection artifact (Belief lifecycle suite, A3). */
export const BRAIN_CLAIM_GRAPH_FILE = "claim-graph.json";
/** Persisted rollup-ladder counter ledger (knowledge-intake-and-consolidation, S3). */
export const BRAIN_ROLLUP_LEDGER_FILE = "rollup-ladder.json";

/** Vault-relative path of the `o2b index` output file. */
export const BRAIN_INDEX_REL = posix.join(BRAIN_ROOT_REL, BRAIN_INDEX_FILE);
