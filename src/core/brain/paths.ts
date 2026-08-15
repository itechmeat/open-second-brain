/**
 * Filesystem paths and slug allocation for the Brain layer.
 *
 * Layout lives under `<vault>/Brain/`:
 *
 *   Brain/
 *     _brain.yaml
 *     inbox/
 *       sig-<date>-<slug>.md
 *       processed/sig-<date>-<slug>.md
 *     preferences/
 *       pref-<slug>.md
 *     retired/
 *       ret-<slug>.md
 *     log/
 *       <YYYY-MM-DD>.md
 *     .snapshots/
 *       <run_id>.tar.zst
 *
 * Every constructor here funnels through `ensureInsideVault` (re-exported
 * from `../path-safety`) so a malformed slug or a `..` traversal cannot
 * land a file outside the vault root. Slug validation rejects empties,
 * path separators, traversal sequences, and Windows-reserved basenames.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { isFileAlreadyExists } from "../fs-atomic.ts";
import { ensureInsideVault, vaultRelative } from "../path-safety.ts";
import type { DegradationNotice } from "../integrity/degradation.ts";
import {
  BRAIN_ARTIFACTS_REL,
  BRAIN_ACTIVE_FILE,
  BRAIN_ATTENTION_REL,
  BRAIN_BASES_REL,
  BRAIN_CAPTURES_PROCESSED_REL,
  BRAIN_CAPTURES_REL,
  BRAIN_CLAIM_GRAPH_FILE,
  BRAIN_CONFIG_FILE,
  BRAIN_DECISIONS_REL,
  BRAIN_DISTILLATIONS_REL,
  BRAIN_ENTITIES_REL,
  BRAIN_GAP_TASKS_REL,
  BRAIN_INBOX_REL,
  BRAIN_LESSONS_FILE,
  BRAIN_LOG_REL,
  BRAIN_MANUAL_FILE,
  BRAIN_OBLIGATIONS_REL,
  BRAIN_PENDING_REL,
  BRAIN_PINNED_FILE,
  BRAIN_PREFERENCES_REL,
  BRAIN_PROCEDURAL_MEMORY_REL,
  BRAIN_PROCEDURES_REL,
  BRAIN_PROCESSED_REL,
  BRAIN_REPORTS_REL,
  BRAIN_RETIRED_REL,
  BRAIN_ROLLUP_LEDGER_FILE,
  BRAIN_ROOT_REL,
  BRAIN_SKILL_ACCEPT_JOURNAL_REL,
  BRAIN_SKILL_PROPOSALS_ACCEPTED_REL,
  BRAIN_SKILL_PROPOSALS_PENDING_REL,
  BRAIN_SKILL_PROPOSALS_REJECTED_REL,
  BRAIN_SNAPSHOTS_REL,
  BRAIN_SOURCES_REL,
  BRAIN_STANDING_RULES_FILE,
  BRAIN_STATE_REL,
  BRAIN_TENSIONS_REL,
  BRAIN_THESES_REL,
  DERIVED_STORE_DIR,
  HOOK_AUDIT_DIR,
} from "./path-constants.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

export { ensureInsideVault, vaultRelative } from "../path-safety.ts";

// The canonical vault-relative names live in their own leaf module so
// `vault-identity.ts` can locate the marker without importing the
// builders that guard on it. Re-exported wholesale: every constant this
// module used to declare is still reachable from this path.
export * from "./path-constants.ts";

/**
 * The runtime hooks' audit root: `<vault>/.open-second-brain/hook-audit`.
 *
 * Outside `Brain/` deliberately - it is derived operational evidence, not
 * an authored artifact - and therefore not guarded by
 * {@link assertVaultIdentityForWrite}: the hooks append to it on a
 * fail-open path where a throw would cost the operator their prompt.
 */
export function hookAuditDir(vault: string): string {
  return ensureInsideVault(join(vault, DERIVED_STORE_DIR, HOOK_AUDIT_DIR), vault);
}

/** Path of the persisted claim-graph projection: `Brain/claim-graph.json`. */
export function claimGraphPath(vault: string): string {
  return ensureInsideVault(join(brainDirs(vault).brain, BRAIN_CLAIM_GRAPH_FILE), vault);
}

/** Path of the rollup-ladder ledger: `Brain/rollup-ladder.json`. */
export function rollupLedgerPath(vault: string): string {
  return ensureInsideVault(join(brainDirs(vault).brain, BRAIN_ROLLUP_LEDGER_FILE), vault);
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Run IDs follow `dream-<YYYY-MM-DD>-<HHMMSS>`; we accept the same generic
// "no path separators / no traversal" rules as slugs, plus a tighter
// shape check for the date-time stem.
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const WINDOWS_RESERVED_BASENAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export interface BrainDirs {
  readonly brain: string;
  readonly inbox: string;
  /** Holding area for signals already folded into a preference. */
  readonly processed: string;
  /** Write-approval staging area for extracted signals awaiting review. */
  readonly pending: string;
  readonly preferences: string;
  readonly retired: string;
  readonly log: string;
  /** Canonical entity registry root: `Brain/entities/<category>/`. */
  readonly entities: string;
  /** Obsidian Bases view definitions: `Brain/bases/<view>.base`. */
  readonly bases: string;
  /** Pre-`dream` archive directory. Never recursed into by `dream`. */
  readonly snapshots: string;
}

/**
 * Compose every Brain subdirectory under `<vault>/Brain/`. Returns
 * absolute paths so callers can hand them straight to `mkdirSync` /
 * `readdirSync`. Each path is verified to resolve inside the vault.
 */
export function brainDirs(vault: string): BrainDirs {
  const brain = ensureInsideVault(join(vault, BRAIN_ROOT_REL), vault);
  return {
    brain,
    inbox: ensureInsideVault(join(vault, BRAIN_INBOX_REL), vault),
    processed: ensureInsideVault(join(vault, BRAIN_PROCESSED_REL), vault),
    pending: ensureInsideVault(join(vault, BRAIN_PENDING_REL), vault),
    preferences: ensureInsideVault(join(vault, BRAIN_PREFERENCES_REL), vault),
    retired: ensureInsideVault(join(vault, BRAIN_RETIRED_REL), vault),
    log: ensureInsideVault(join(vault, BRAIN_LOG_REL), vault),
    entities: ensureInsideVault(join(vault, BRAIN_ENTITIES_REL), vault),
    bases: ensureInsideVault(join(vault, BRAIN_BASES_REL), vault),
    snapshots: ensureInsideVault(join(vault, BRAIN_SNAPSHOTS_REL), vault),
  };
}

/**
 * {@link brainDirs} for a caller that is about to WRITE.
 *
 * Identical directories, plus the vault-identity assertion in front of
 * them (context-integrity-gates, Unit J). The write-intent variant
 * exists because the guard belongs on the write side only: read paths
 * must stay unaffected, and a blanket assertion inside `brainDirs`
 * would fire on every listing, every doctor pass, and every fail-soft
 * hook that merely inspects the tree.
 *
 * An unmarked root emits a `vault-marker-absent` notice into `notices`
 * and proceeds; a root whose marker differs from the one this process
 * pinned raises `VaultIdentityMismatchError`. The bootstrap path
 * deliberately uses plain {@link brainDirs}: it is what legitimately
 * creates the tree, so it must not be gated on the marker it is about
 * to write.
 *
 * ## Which call sites use this one
 *
 * A site is write-intent when EITHER the `BrainDirs` value it produces
 * forms a path the same flow creates, moves, or deletes (even
 * conditionally), OR the site is reached only from flows that mutate
 * the Brain tree. Everything else stays on {@link brainDirs}:
 *
 *   - read, query, report, and analysis flows - widening the guard onto
 *     them would break `src/openclaw/index.ts`, which silently defaults
 *     to the process working directory, and the hooks, which fail open
 *     by contract;
 *   - sites reached from BOTH a mutating flow and a read-only or
 *     dry-run preview of it, where the guard would fire on a preview;
 *   - the path builders in this module. They are intent-neutral by
 *     construction - `preferencePath` serves `parsePreference` and
 *     `writePreference` alike - so a writer that reaches the tree
 *     through one of them is guarded at its own entry point, not here.
 *     Those writers call `assertVaultIdentityForWrite` directly; see
 *     its docblock for the two call surfaces and why they differ.
 */
export function brainDirsForWrite(vault: string, notices?: DegradationNotice[]): BrainDirs {
  assertVaultIdentityForWrite(vault, notices);
  return brainDirs(vault);
}

/** Path of `Brain/_brain.yaml`. */
export function brainConfigPath(vault: string): string {
  return ensureInsideVault(join(brainDirs(vault).brain, BRAIN_CONFIG_FILE), vault);
}

/** Path of the Brain operating manual rendered into the vault. */
export function brainManualPath(vault: string): string {
  return ensureInsideVault(join(brainDirs(vault).brain, BRAIN_MANUAL_FILE), vault);
}

/**
 * Path of the auto-generated active-preferences digest written by
 * `dream` and CLI verbs that mutate preference state. Read by the
 * `SessionStart` / `PostCompact` hook and exposed as the MCP resource
 * `osb://preferences/active`.
 */
export function brainActivePath(vault: string): string {
  return ensureInsideVault(join(brainDirs(vault).brain, BRAIN_ACTIVE_FILE), vault);
}

/**
 * Path of the auto-generated lessons digest (`Brain/lessons.md`) written
 * by `dream`: the unified, signed, recency-scored corpus over
 * preferences and dead-ends. Read by the `SessionStart` / `PostCompact`
 * hook alongside `active.md` and exposed as the MCP resource
 * `osb://lessons`.
 */
export function brainLessonsPath(vault: string): string {
  return ensureInsideVault(join(brainDirs(vault).brain, BRAIN_LESSONS_FILE), vault);
}

/**
 * Path of the operator-authored standing-rules file
 * (`Brain/standing-rules.md`, silence-is-not-an-answer U8).
 *
 * Unlike every other artefact at this level it is written by hand and
 * never by this system: `dream` does not generate it, no CLI verb
 * rewrites it, and the note-target resolver refuses it to every
 * caller-named write tool because its first path segment is `Brain`.
 * Read by the `SessionStart` hook ahead of the memory layer and by
 * `brain_context`.
 */
export function brainStandingRulesPath(vault: string): string {
  return ensureInsideVault(join(brainDirs(vault).brain, BRAIN_STANDING_RULES_FILE), vault);
}

/** Path of the transient current-task scratchpad read by `brain_context`. */
export function brainPinnedPath(vault: string): string {
  return ensureInsideVault(join(brainDirs(vault).brain, BRAIN_PINNED_FILE), vault);
}

/** Overwrite-only exact-state lane directory: `Brain/state/` (t_b0c9d0a3). */
export function brainStateDir(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_STATE_REL), vault);
}

/** A single exact-state aspect page: `Brain/state/<aspect>.md` (t_b0c9d0a3). */
export function exactStatePath(vault: string, aspect: string): string {
  const s = validateSlug(aspect);
  return ensureInsideVault(join(brainStateDir(vault), `${s}.md`), vault);
}

/** Active-signal path: `Brain/inbox/sig-<date>-<slug>.md`. */
export function signalPath(vault: string, date: string, slug: string): string {
  const d = validateIsoDate(date);
  const s = validateSlug(slug);
  return ensureInsideVault(join(brainDirs(vault).inbox, `sig-${d}-${s}.md`), vault);
}

/** Processed-signal path: `Brain/inbox/processed/sig-<date>-<slug>.md`. */
export function processedSignalPath(vault: string, date: string, slug: string): string {
  const d = validateIsoDate(date);
  const s = validateSlug(slug);
  return ensureInsideVault(join(brainDirs(vault).processed, `sig-${d}-${s}.md`), vault);
}

/** Preference path: `Brain/preferences/pref-<slug>.md`. */
export function preferencePath(vault: string, slug: string): string {
  const s = validateSlug(slug);
  return ensureInsideVault(join(brainDirs(vault).preferences, `pref-${s}.md`), vault);
}

/** Ingested source summary page: `Brain/sources/src-<slug>.md`. */
export function sourcePagePath(vault: string, slug: string): string {
  const s = validateSlug(slug);
  return ensureInsideVault(join(vault, BRAIN_SOURCES_REL, `src-${s}.md`), vault);
}

/** Source-distillation page: `Brain/distillations/dist-<slug>.md`. */
export function distillationPagePath(vault: string, slug: string): string {
  const s = validateSlug(slug);
  return ensureInsideVault(join(vault, BRAIN_DISTILLATIONS_REL, `dist-${s}.md`), vault);
}

/** Cited research report page: `Brain/reports/<date>-<slug>.md`. */
export function reportPagePath(vault: string, date: string, slug: string): string {
  const d = validateIsoDate(date);
  const s = validateSlug(slug);
  return ensureInsideVault(join(vault, BRAIN_REPORTS_REL, `${d}-${s}.md`), vault);
}

/**
 * Per-preference edit-history sidecar: `Brain/preferences/pref-<slug>.history.jsonl`.
 * Lives next to the preference file; never enters the search index
 * because the walker only yields `.md` files.
 */
export function preferenceHistoryPath(vault: string, slug: string): string {
  const s = validateSlug(slug);
  return ensureInsideVault(join(brainDirs(vault).preferences, `pref-${s}.history.jsonl`), vault);
}

/** Retired-preference path: `Brain/retired/ret-<slug>.md`. */
export function retiredPath(vault: string, slug: string): string {
  const s = validateSlug(slug);
  return ensureInsideVault(join(brainDirs(vault).retired, `ret-${s}.md`), vault);
}

/** Pending skill-proposal path: `Brain/skill-proposals/pending/prop-<slug>.md`. */
export function skillProposalPendingPath(vault: string, slug: string): string {
  const s = validateSlug(slug);
  return ensureInsideVault(join(vault, BRAIN_SKILL_PROPOSALS_PENDING_REL, `prop-${s}.md`), vault);
}

/** Accepted skill-proposal archive path: `Brain/skill-proposals/accepted/prop-<slug>.md`. */
export function skillProposalAcceptedPath(vault: string, slug: string): string {
  const s = validateSlug(slug);
  return ensureInsideVault(join(vault, BRAIN_SKILL_PROPOSALS_ACCEPTED_REL, `prop-${s}.md`), vault);
}

/** Rejected skill-proposal archive path: `Brain/skill-proposals/rejected/prop-<slug>.md`. */
export function skillProposalRejectedPath(vault: string, slug: string): string {
  const s = validateSlug(slug);
  return ensureInsideVault(join(vault, BRAIN_SKILL_PROPOSALS_REJECTED_REL, `prop-${s}.md`), vault);
}

/** Accept-journal path: `Brain/skill-proposals/accept-journal/<slug>.json`. */
export function skillAcceptJournalPath(vault: string, slug: string): string {
  const s = validateSlug(slug);
  return ensureInsideVault(join(vault, BRAIN_SKILL_ACCEPT_JOURNAL_REL, `${s}.json`), vault);
}

/** Accepted procedure reference path: `Brain/procedures/proc-<slug>.md`. */
export function procedurePath(vault: string, slug: string): string {
  const s = validateSlug(slug);
  return ensureInsideVault(join(vault, BRAIN_PROCEDURES_REL, `proc-${s}.md`), vault);
}

/** Procedural-memory index path: `Brain/procedural-memory/index.json`. */
export function proceduralMemoryIndexPath(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_PROCEDURAL_MEMORY_REL, "index.json"), vault);
}

/** Procedural-memory usage sidecar path: `Brain/procedural-memory/usage.jsonl`. */
export function proceduralMemoryUsagePath(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_PROCEDURAL_MEMORY_REL, "usage.jsonl"), vault);
}

/** Procedural graph projection path: `Brain/procedural-memory/graph.json`. */
export function proceduralGraphPath(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_PROCEDURAL_MEMORY_REL, "graph.json"), vault);
}

/** Prospective recall hints path: `Brain/procedural-memory/hints.json`. */
export function proceduralHintsPath(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_PROCEDURAL_MEMORY_REL, "hints.json"), vault);
}

/** Declarative attention-flows directory: `Brain/attention/flows/`. */
export function attentionFlowsDir(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_ATTENTION_REL, "flows"), vault);
}

/** Recurring-obligation pages dir: `Brain/obligations/`. */
export function obligationsDir(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_OBLIGATIONS_REL), vault);
}

/** Retired-obligation archive dir: `Brain/obligations/archive/`. */
export function obligationsArchiveDir(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_OBLIGATIONS_REL, "archive"), vault);
}

/** A single obligation page: `Brain/obligations/<slug>.md`. */
export function obligationPath(vault: string, slug: string): string {
  return ensureInsideVault(join(vault, BRAIN_OBLIGATIONS_REL, `${slug}.md`), vault);
}

/** Declared-thesis register pages dir: `Brain/theses/`. */
export function thesesDir(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_THESES_REL), vault);
}

/** A single thesis page: `Brain/theses/thesis-<slug>.md`. */
export function thesisPath(vault: string, slug: string): string {
  const s = validateSlug(slug);
  return ensureInsideVault(join(vault, BRAIN_THESES_REL, `thesis-${s}.md`), vault);
}

/** Decision-record note-family dir: `Brain/decisions/`. */
export function decisionsDir(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_DECISIONS_REL), vault);
}

/** A single decision page: `Brain/decisions/decision-<slug>.md`. */
export function decisionPath(vault: string, slug: string): string {
  const s = validateSlug(slug);
  return ensureInsideVault(join(vault, BRAIN_DECISIONS_REL, `decision-${s}.md`), vault);
}

/** Persisted-contradiction note-family dir: `Brain/tensions/` (S2). */
export function tensionsDir(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_TENSIONS_REL), vault);
}

/** A single tension page: `Brain/tensions/tension-<slug>.md` (S2). */
export function tensionPath(vault: string, slug: string): string {
  const s = validateSlug(slug);
  return ensureInsideVault(join(vault, BRAIN_TENSIONS_REL, `tension-${s}.md`), vault);
}

/** Proposal scan watermark path: `Brain/procedural-memory/proposal-watermark.json`. */
export function proposalWatermarkPath(vault: string): string {
  return ensureInsideVault(
    join(vault, BRAIN_PROCEDURAL_MEMORY_REL, "proposal-watermark.json"),
    vault,
  );
}

/** Recurrence support ledger path: `Brain/log/recurrence-support.jsonl`. */
export function proceduralRecurrencePath(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_LOG_REL, "recurrence-support.jsonl"), vault);
}

/**
 * Cross-query demand ledger path: `Brain/log/query-demand.jsonl`. A
 * rolling, byte-budget-capped append-only log of normalized recall
 * queries with their result count and IDF-weighted coverage, aggregated
 * to surface recurring queries the vault answers poorly (unmet demand).
 */
export function queryDemandLogPath(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_LOG_REL, "query-demand.jsonl"), vault);
}

/** Inbound-capture staging dir: `Brain/captures/` (seam 1, t_f8f5ef6a). */
export function capturesDir(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_CAPTURES_REL), vault);
}

/** Inbound-capture archive dir: `Brain/captures/processed/` (seam 1). */
export function capturesProcessedDir(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_CAPTURES_PROCESSED_REL), vault);
}

/** A staged capture page: `Brain/captures/<id>.md` (seam 1). */
export function captureStagingPath(vault: string, id: string): string {
  return ensureInsideVault(join(capturesDir(vault), `${validateSlug(id)}.md`), vault);
}

/** An archived capture page: `Brain/captures/processed/<id>.md` (seam 1). */
export function captureArchivePath(vault: string, id: string): string {
  return ensureInsideVault(join(capturesProcessedDir(vault), `${validateSlug(id)}.md`), vault);
}

/**
 * Catchup watermark sidecar: `Brain/captures/.catchup-watermark.json` (seam
 * 1). Dot-file so the vault walker never indexes it; records the id of the
 * last capture acknowledged by a `/catchup` reply.
 */
export function captureWatermarkPath(vault: string): string {
  return ensureInsideVault(join(capturesDir(vault), ".catchup-watermark.json"), vault);
}

/**
 * Capture-decision ledger: `Brain/log/capture-decisions.jsonl` (seam 1).
 * One JSON line per inbound update the bot handled - accepted, rejected, or
 * malformed - so no update is ever silently dropped.
 */
export function captureDecisionLogPath(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_LOG_REL, "capture-decisions.jsonl"), vault);
}

/** Log file for the given UTC date: `Brain/log/<YYYY-MM-DD>.md`. */
export function logPath(vault: string, date: string): string {
  const d = validateIsoDate(date);
  return ensureInsideVault(join(brainDirs(vault).log, `${d}.md`), vault);
}

/**
 * Canonical entity file path: `Brain/entities/<category>/<id>.md`
 * (Memory Integrity Suite). Both segments are slug-validated; the id
 * is the entity's stable identifier and the file basename.
 */
export function entityPath(vault: string, category: string, id: string): string {
  const c = validateSlug(category);
  const i = validateSlug(id);
  return ensureInsideVault(join(brainDirs(vault).entities, c, `${i}.md`), vault);
}

/**
 * Structured JSONL sidecar that accompanies each `<date>.md` log
 * file (§23, v0.10.8). Every machine consumer reads through this
 * helper instead of doing the `.md → .jsonl` string conversion
 * inline; if the sidecar layout ever moves (subdirectory,
 * compression, …) every caller follows in one edit.
 */
export function logJsonlPath(vault: string, date: string): string {
  const d = validateIsoDate(date);
  return ensureInsideVault(join(brainDirs(vault).log, `${d}.jsonl`), vault);
}

/**
 * Per-device markdown log shard: `Brain/log/<date>.<deviceId>.md`
 * (Memory Integrity Suite). The empty device id resolves to the
 * legacy un-sharded path so pre-shard call sites keep working.
 */
export function logShardPath(vault: string, date: string, deviceId: string): string {
  if (deviceId === "") return logPath(vault, date);
  const d = validateIsoDate(date);
  return ensureInsideVault(join(brainDirs(vault).log, `${d}.${validateSlug(deviceId)}.md`), vault);
}

/** Per-device JSONL log shard: `Brain/log/<date>.<deviceId>.jsonl`. */
export function logShardJsonlPath(vault: string, date: string, deviceId: string): string {
  if (deviceId === "") return logJsonlPath(vault, date);
  const d = validateIsoDate(date);
  return ensureInsideVault(
    join(brainDirs(vault).log, `${d}.${validateSlug(deviceId)}.jsonl`),
    vault,
  );
}

/**
 * Brain Integrity Suite (v0.12.0). Workrun directory used by the
 * durable dream-pass checkpoint surface: `Brain/log/dream-runs/`.
 * Lives under the log dir so backups already include it.
 */
export function dreamRunsDir(vault: string): string {
  return join(brainDirs(vault).log, "dream-runs");
}

/**
 * Brain Integrity Suite (v0.12.0). Durable workrun JSONL for a
 * single dream invocation: `Brain/log/dream-runs/<run-id>.jsonl`.
 * The run id is validated through {@link validateRunId} so it stays
 * inside the canonical directory.
 */
export function dreamWorkrunPath(vault: string, runId: string): string {
  const id = validateRunId(runId);
  return ensureInsideVault(join(dreamRunsDir(vault), `${id}.jsonl`), vault);
}

/**
 * Brain lifecycle suite (Feature 1). Per-preference mutation audit
 * directory: `Brain/log/pref-audit/`. Lives under the log dir so
 * backups already include it.
 */
export function prefAuditDir(vault: string): string {
  return join(brainDirs(vault).log, "pref-audit");
}

/**
 * Brain lifecycle suite (Feature 1). Append-only audit JSONL for a
 * single preference: `Brain/log/pref-audit/<pref-id>.jsonl`. The pref
 * id (`pref-<slug>` / `ret-<slug>`) is validated through
 * {@link validateSlug} so it cannot escape the canonical directory.
 */
export function prefAuditPath(vault: string, prefId: string): string {
  const id = validateSlug(prefId);
  return ensureInsideVault(join(prefAuditDir(vault), `${id}.jsonl`), vault);
}

/** Snapshots directory: `Brain/.snapshots/`. */
export function snapshotsDir(vault: string): string {
  return brainDirs(vault).snapshots;
}

/**
 * Filename suffix of the Markdown-tree archive. The extension stays
 * `.zst` even when the host only has gzip: the restore probes the magic
 * bytes rather than the name, and one suffix keeps the listing filter a
 * single comparison.
 */
export const SNAPSHOT_ARCHIVE_SUFFIX = ".tar.zst";

/**
 * Filename suffix of the derived-store archive that may sit BESIDE the
 * tar for the same run id.
 *
 * Beside, not inside: the extractor requires a `Brain/` root and the
 * restore is defined as "live `Brain/` equals archive `Brain/` minus the
 * excluded entries", so a second top-level member in the tar would break
 * both invariants. Keeping the file in the SAME `.snapshots/` directory
 * keeps listing and retention one family with one loop.
 */
export const SNAPSHOT_STORE_ARCHIVE_SUFFIX = ".store.sqlite.zst";

/** Snapshot archive path: `Brain/.snapshots/<run_id>.tar.zst`. */
export function snapshotPath(vault: string, runId: string): string {
  const id = validateRunId(runId);
  return ensureInsideVault(
    join(brainDirs(vault).snapshots, `${id}${SNAPSHOT_ARCHIVE_SUFFIX}`),
    vault,
  );
}

/**
 * Derived-store archive path:
 * `Brain/.snapshots/<run_id>.store.sqlite.zst`.
 *
 * Built through the same run-id validation and vault containment as
 * {@link snapshotPath}, because it is written into the same directory
 * from the same caller-supplied id and deserves no weaker guard.
 */
export function snapshotStorePath(vault: string, runId: string): string {
  const id = validateRunId(runId);
  return ensureInsideVault(
    join(brainDirs(vault).snapshots, `${id}${SNAPSHOT_STORE_ARCHIVE_SUFFIX}`),
    vault,
  );
}

/** Artifacts root: `Brain/.artifacts/`. */
export function brainArtifactsDir(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_ARTIFACTS_REL), vault);
}

/** Knowledge-gap task notes root: `Brain/gap-tasks/` (A3 / t_67d38036). */
export function brainGapTasksDir(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_GAP_TASKS_REL), vault);
}

/** Per-run artifact directory: `Brain/.artifacts/<run_id>/`. */
export function artifactRunDir(vault: string, runId: string): string {
  const id = validateRunId(runId);
  return ensureInsideVault(join(brainArtifactsDir(vault), id), vault);
}

/**
 * Single artifact path: `Brain/.artifacts/<run_id>/<artifact_id>.json`.
 * Both ids go through {@link validateRunId} (the same filesystem-safety
 * contract: no separators, no traversal, no Windows reservation), so a
 * malicious `artifact_id` from an MCP argument cannot escape the run dir.
 */
export function artifactPath(vault: string, runId: string, artifactId: string): string {
  const aid = validateRunId(artifactId);
  return ensureInsideVault(join(artifactRunDir(vault, runId), `${aid}.json`), vault);
}

// ----- Validators -----------------------------------------------------------

/**
 * Reject slugs that could escape their intended subdirectory or hit a
 * Windows-incompatible filename.
 */
export function validateSlug(slug: string): string {
  const trimmed = slug.trim();
  if (!trimmed) throw new Error("slug must not be empty");
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`slug must not contain path separators: ${slug}`);
  }
  // Reject Windows-invalid filename characters (`:*?"<>|`) and ASCII
  // control characters (0x00-0x1F). On NTFS these are forbidden in a
  // filename; on POSIX a NUL byte is illegal in a path and the rest are
  // ambiguous when round-tripped through cross-platform tooling (zip
  // archives, syncthing, git on Windows).
  if (/[:*?"<>|\x00-\x1F]/.test(trimmed)) {
    throw new Error(`slug contains invalid character: ${JSON.stringify(slug)}`);
  }
  if (trimmed === ".." || trimmed === "." || /(?:^|[^\w])\.\.(?:$|[^\w])/.test(trimmed)) {
    throw new Error(`slug must not contain '..' traversal: ${slug}`);
  }
  if (/[. ]$/.test(trimmed)) {
    throw new Error(`slug must not end with '.' or whitespace (Windows-incompatible): ${slug}`);
  }
  if (WINDOWS_RESERVED_BASENAME_RE.test(trimmed)) {
    throw new Error(`slug uses a Windows-reserved filename: ${slug}`);
  }
  return trimmed;
}

/** Validate `YYYY-MM-DD`. Throws on bad shape or impossible calendar date. */
export function validateIsoDate(value: string): string {
  const m = ISO_DATE_RE.exec(value);
  if (!m) {
    throw new Error(`brain date must use YYYY-MM-DD format: ${value}`);
  }
  const year = parseInt(m[1]!, 10);
  const month = parseInt(m[2]!, 10);
  const day = parseInt(m[3]!, 10);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new Error(`brain date is not a valid calendar date: ${value}`);
  }
  return value;
}

/**
 * Validate a snapshot run_id. The dream algorithm forms run_ids as
 * `dream-<YYYY-MM-DD>-<HHMMSS>`; the validator is intentionally
 * permissive about the exact stem (we want manual snapshots later) and
 * focuses on filesystem-safety: no separators, no traversal, no Windows
 * reservation, no leading dot.
 */
export function validateRunId(runId: string): string {
  const trimmed = runId.trim();
  if (!trimmed) throw new Error("run_id must not be empty");
  if (!RUN_ID_RE.test(trimmed)) {
    throw new Error(`run_id must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/: ${runId}`);
  }
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`run_id must not contain '..' or path separators: ${runId}`);
  }
  if (WINDOWS_RESERVED_BASENAME_RE.test(trimmed)) {
    throw new Error(`run_id uses a Windows-reserved filename: ${runId}`);
  }
  return trimmed;
}

// ----- Slug-collision allocator --------------------------------------------

export interface AllocateSlugOptions {
  /** Vault root. Required so collision probes stay inside the vault. */
  readonly vault: string;
  /** Directory the file will live in (absolute). */
  readonly targetDir: string;
  /** File-name prefix without trailing dash, e.g. `sig-2026-05-14`. */
  readonly prefix: string;
  /** Base slug requested by the caller. */
  readonly slug: string;
  /**
   * Hard upper bound on how many DISTINCT candidate names are tried.
   * Defaults to {@link SLUG_ALLOCATION_MAX_ATTEMPTS}, far beyond any
   * realistic same-day collision count; it exists only to make a misuse
   * error (caller passing a `targetDir` that resolves outside the vault,
   * say) terminate instead of loop forever.
   *
   * One meaning, in both allocators: a name skipped because the probe
   * found it taken and a name lost to a concurrent create each consume
   * exactly one attempt.
   */
  readonly maxAttempts?: number;
}

export interface AllocateSlugResult {
  /** Allocated slug ready to be combined with the prefix. */
  readonly slug: string;
  /** Final absolute filename (`<targetDir>/<prefix>-<slug>.md`). */
  readonly path: string;
  /** Suffix that was appended (`null` when no collision). */
  readonly suffix: number | null;
}

export interface AllocateAndCreateResult<T> {
  /** The name that was successfully created under. */
  readonly allocation: AllocateSlugResult;
  /** Whatever the injected create returned. */
  readonly value: T;
}

/**
 * Default bound on distinct candidate names one allocation tries.
 *
 * Named rather than inlined because two allocators and every caller's
 * docblock refer to it: a bound that lives as a literal in one loop is a
 * bound nobody else can state.
 */
export const SLUG_ALLOCATION_MAX_ATTEMPTS = 10_000;

/**
 * Candidate `attempt` of a collision ladder: the bare base first, then
 * `-2`, `-3`, … per §5.1 / §9.2 of the design doc.
 *
 * Exported because the rule is not slug-specific - run ids ladder the
 * same way in `snapshot-gate.ts` and `dream.ts`, and three private
 * copies of `n === 1 ? base : \`${base}-${n}\`` were three places for
 * the ladder to drift apart.
 */
export function collisionCandidateName(base: string, attempt: number): string {
  return attempt === 1 ? base : `${base}-${attempt}`;
}

/** Shared guard: a prefix that is empty or carries separators is caller misuse. */
function assertUsablePrefix(caller: string, prefix: string): void {
  if (!prefix || /[\\/]/.test(prefix)) {
    throw new Error(`${caller}: prefix must be non-empty and path-clean: ${prefix}`);
  }
}

/**
 * Candidate `attempt` as a full allocation. The path is funnelled through
 * `ensureInsideVault`, so a `targetDir` that resolves outside the vault
 * raises before any disk probe is made.
 */
function slugCandidate(
  opts: AllocateSlugOptions,
  baseSlug: string,
  attempt: number,
): AllocateSlugResult {
  const slug = collisionCandidateName(baseSlug, attempt);
  const path = ensureInsideVault(join(opts.targetDir, `${opts.prefix}-${slug}.md`), opts.vault);
  return { slug, path, suffix: attempt === 1 ? null : attempt };
}

/**
 * The one loud exhaustion error, shared by both allocators so their
 * bounds cannot be reported in two different vocabularies. `lostRace`
 * carries the last collision when at least one attempt was lost to a
 * concurrent create: the operator gets both the bound that stopped us
 * and the failure that consumed the attempts.
 */
function slugExhaustedError(
  caller: string,
  opts: AllocateSlugOptions,
  baseSlug: string,
  maxAttempts: number,
  lostRace: unknown,
): Error {
  const head =
    `${caller}: could not find a free name after ${maxAttempts} attempts ` +
    `(prefix=${opts.prefix}, slug=${baseSlug})`;
  if (lostRace === undefined) return new Error(head);
  return new Error(`${head}; the attempts include names lost to a concurrent create`, {
    cause: lostRace,
  });
}

/**
 * Find the first free `<prefix>-<slug>.md` under `targetDir`, appending
 * `-2`, `-3`, … to the slug on collision. The probe is read-only, so the
 * name it returns can be taken by another process before the caller
 * creates it.
 *
 * Prefer {@link allocateAndCreate} for anything that goes on to create
 * the file: it is this probe fused with the create, and losing the race
 * costs it one attempt instead of the whole write. This entry point
 * remains for callers that only want to know a free name.
 */
export function allocateSlug(opts: AllocateSlugOptions): AllocateSlugResult {
  const baseSlug = validateSlug(opts.slug);
  const maxAttempts = opts.maxAttempts ?? SLUG_ALLOCATION_MAX_ATTEMPTS;
  assertUsablePrefix("allocateSlug", opts.prefix);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = slugCandidate(opts, baseSlug, attempt);
    if (!existsSync(candidate.path)) return candidate;
  }
  throw slugExhaustedError("allocateSlug", opts, baseSlug, maxAttempts, undefined);
}

/**
 * Allocate a name AND create the artifact under it, retrying the next
 * candidate when the create loses the name to a concurrent writer.
 *
 * The probe and the create have to be one loop. Separately, they are a
 * check-then-act: two agents writing a signal on the same topic and date
 * both see `sig-<date>-<topic>.md` free, one wins the exclusive create,
 * and the other used to fail terminally with its event dropped on the
 * floor (GitHub #161). Nothing looped back to try `-2`.
 *
 * The create is INJECTED rather than performed here, and that is
 * load-bearing twice over. Every caller derives its frontmatter `id`
 * from the ALLOCATED slug, so a helper that re-linked pre-rendered bytes
 * would ship a file whose `id` contradicts its own filename. And it
 * keeps this module free of any write call, so the path vocabulary does
 * not acquire a dependency on the frontmatter writer.
 *
 * The rejected alternative was the lockfile primitive in
 * `sync-lockfile.ts`. It locks one known target path, whereas the
 * contended resource here is "the next free name under this directory
 * for this prefix" - a directory-scoped lock, which would add a
 * crash-stale-lock failure mode (only `brain_doctor` clears one) to the
 * hottest write path in the system while buying nothing: `link(2)`
 * already gives race-free exclusivity. The only missing piece was "on
 * collision, try the next name".
 *
 * Only a collision retries. Any other failure - a full disk, a
 * read-only mount - propagates from the attempt that raised it, with
 * nothing swallowed and nothing re-labelled; retrying those would burn
 * the bound and then report the wrong problem.
 */
export function allocateAndCreate<T>(
  opts: AllocateSlugOptions,
  create: (allocation: AllocateSlugResult) => T,
): AllocateAndCreateResult<T> {
  const baseSlug = validateSlug(opts.slug);
  const maxAttempts = opts.maxAttempts ?? SLUG_ALLOCATION_MAX_ATTEMPTS;
  assertUsablePrefix("allocateAndCreate", opts.prefix);

  let lostRace: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const allocation = slugCandidate(opts, baseSlug, attempt);
    // The probe stays as a cheap skip past names already on disk: it
    // saves rendering and a temp file per taken name. It is no longer
    // load-bearing for correctness - the exclusive create is.
    if (existsSync(allocation.path)) continue;
    try {
      return { allocation, value: create(allocation) };
    } catch (err) {
      if (!isFileAlreadyExists(err)) throw err;
      lostRace = err;
    }
  }
  throw slugExhaustedError("allocateAndCreate", opts, baseSlug, maxAttempts, lostRace);
}

/** Vault-relative renderer kept here for the `tests/core/brain.paths.test.ts` import. */
export function brainVaultRelative(target: string, vault: string): string {
  return vaultRelative(target, vault);
}
