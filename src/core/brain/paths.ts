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
import { join, posix } from "node:path";

import { ensureInsideVault, vaultRelative } from "../path-safety.ts";

export { ensureInsideVault, vaultRelative } from "../path-safety.ts";

// ----- Canonical vault-relative path constants ------------------------------
//
// Single source of truth. Every module that builds a path inside the
// Brain layer imports these instead of repeating the literal. A
// future rename ("Brain" → something else) is a one-line change here.

/** Vault-relative root of the Brain layer. */
export const BRAIN_ROOT_REL = "Brain";

/** Vault-relative Brain subdirectory names. */
export const BRAIN_INBOX_REL = posix.join(BRAIN_ROOT_REL, "inbox");
export const BRAIN_PROCESSED_REL = posix.join(BRAIN_INBOX_REL, "processed");
export const BRAIN_PREFERENCES_REL = posix.join(BRAIN_ROOT_REL, "preferences");
export const BRAIN_RETIRED_REL = posix.join(BRAIN_ROOT_REL, "retired");
export const BRAIN_SKILL_PROPOSALS_REL = posix.join(BRAIN_ROOT_REL, "skill-proposals");
export const BRAIN_SKILL_PROPOSALS_PENDING_REL = posix.join(BRAIN_SKILL_PROPOSALS_REL, "pending");
export const BRAIN_SKILL_PROPOSALS_ACCEPTED_REL = posix.join(BRAIN_SKILL_PROPOSALS_REL, "accepted");
export const BRAIN_SKILL_PROPOSALS_REJECTED_REL = posix.join(BRAIN_SKILL_PROPOSALS_REL, "rejected");
export const BRAIN_PROCEDURES_REL = posix.join(BRAIN_ROOT_REL, "procedures");
export const BRAIN_PROCEDURAL_MEMORY_REL = posix.join(BRAIN_ROOT_REL, "procedural-memory");
export const BRAIN_ATTENTION_REL = posix.join(BRAIN_ROOT_REL, "attention");
export const BRAIN_LOG_REL = posix.join(BRAIN_ROOT_REL, "log");
export const BRAIN_ENTITIES_REL = posix.join(BRAIN_ROOT_REL, "entities");
/** Ingested source summary pages: `Brain/sources/src-<slug>.md` (v1.7.0). */
export const BRAIN_SOURCES_REL = posix.join(BRAIN_ROOT_REL, "sources");
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
export const BRAIN_PINNED_FILE = "pinned.md";
export const BRAIN_INDEX_FILE = "_INDEX.md";

/** Vault-relative path of the `o2b index` output file. */
export const BRAIN_INDEX_REL = posix.join(BRAIN_ROOT_REL, BRAIN_INDEX_FILE);

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
  readonly preferences: string;
  readonly retired: string;
  readonly log: string;
  /** Canonical entity registry root: `Brain/entities/<category>/`. */
  readonly entities: string;
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
    preferences: ensureInsideVault(join(vault, BRAIN_PREFERENCES_REL), vault),
    retired: ensureInsideVault(join(vault, BRAIN_RETIRED_REL), vault),
    log: ensureInsideVault(join(vault, BRAIN_LOG_REL), vault),
    entities: ensureInsideVault(join(vault, BRAIN_ENTITIES_REL), vault),
    snapshots: ensureInsideVault(join(vault, BRAIN_SNAPSHOTS_REL), vault),
  };
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

/** Path of the transient current-task scratchpad read by `brain_context`. */
export function brainPinnedPath(vault: string): string {
  return ensureInsideVault(join(brainDirs(vault).brain, BRAIN_PINNED_FILE), vault);
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

/** Snapshot archive path: `Brain/.snapshots/<run_id>.tar.zst`. */
export function snapshotPath(vault: string, runId: string): string {
  const id = validateRunId(runId);
  return ensureInsideVault(join(brainDirs(vault).snapshots, `${id}.tar.zst`), vault);
}

/** Artifacts root: `Brain/.artifacts/`. */
export function brainArtifactsDir(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_ARTIFACTS_REL), vault);
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
   * Hard upper bound on suffix attempts. The default of 10_000 is far
   * beyond any realistic same-day collision count and exists only to
   * make a misuse error (caller passing a `targetDir` that resolves
   * outside the vault, say) terminate instead of loop forever.
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

/**
 * Find the first free `<prefix>-<slug>.md` under `targetDir`, appending
 * `-2`, `-3`, … to the slug on collision. The probe is read-only —
 * callers create the file themselves via the atomic-exclusive writer
 * (which closes the residual TOCTOU window).
 *
 * Returns the chosen slug + the absolute path. The path is funnelled
 * through `ensureInsideVault` so a misconfigured `targetDir` (e.g. one
 * the caller assembled by hand and that points outside the vault)
 * raises before any disk probe is made.
 */
export function allocateSlug(opts: AllocateSlugOptions): AllocateSlugResult {
  const { vault, targetDir, prefix } = opts;
  const baseSlug = validateSlug(opts.slug);
  const maxAttempts = opts.maxAttempts ?? 10_000;

  if (!prefix || /[\\/]/.test(prefix)) {
    throw new Error(`allocateSlug: prefix must be non-empty and path-clean: ${prefix}`);
  }

  // The first candidate is the bare slug. Subsequent attempts append
  // `-2`, `-3`, … per §5.1 / §9.2 of the design doc. Cap at
  // `maxAttempts` to prevent an unbounded loop when the caller passes
  // a target directory containing infinite collisions (e.g. on a fuzz
  // test); the realistic worst case is a handful.
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const slug = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
    const candidate = ensureInsideVault(join(targetDir, `${prefix}-${slug}.md`), vault);
    if (!existsSync(candidate)) {
      return { slug, path: candidate, suffix: attempt === 1 ? null : attempt };
    }
  }
  throw new Error(
    `allocateSlug: could not find a free name after ${maxAttempts} attempts ` +
      `(prefix=${prefix}, slug=${baseSlug})`,
  );
}

/** Vault-relative renderer kept here for the `tests/core/brain.paths.test.ts` import. */
export function brainVaultRelative(target: string, vault: string): string {
  return vaultRelative(target, vault);
}
