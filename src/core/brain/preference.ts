/**
 * Preference (`pref-*.md`) and retired (`ret-*.md`) parsers, writer, and
 * the `preferences/ → retired/` mover.
 *
 * Preferences are rules promoted from clusters of signals (design doc
 * §5.3). They live in `Brain/preferences/` while active; they migrate
 * to `Brain/retired/` once they leave the loop, gaining retire metadata
 * but otherwise keeping the original slug — only the filename prefix
 * flips from `pref-` to `ret-`. The same identity slug is preserved
 * across the move so wikilinks pointing at `[[pref-foo]]` continue to
 * resolve (Obsidian indexes by basename regardless of folder, and the
 * retired file's frontmatter `id` flips to `ret-foo`).
 *
 * Three concerns matter:
 *
 *   1. **Default `pinned: false`** when parsing a file whose
 *      frontmatter omits the field. The design doc §5.3 makes this
 *      explicit; the type contract in `types.ts` says parsers MUST
 *      coerce missing/null/undefined to `false`.
 *
 *   2. **Status-vs-folder invariant.** A file in `preferences/` whose
 *      frontmatter `status` is `retired` (or a file in `retired/` whose
 *      kind is `brain-preference`) is corrupt — almost certainly the
 *      result of a half-completed move. Parsers throw
 *      {@link BrainStatusFolderMismatchError} on read so the doctor
 *      command (Task 4) can surface it as a warning. The parsers
 *      themselves throw because the typed return value would otherwise
 *      lie about the on-disk state.
 *
 *   3. **Atomic move.** `moveToRetired` performs the rename via two
 *      atomic operations (write the new file, unlink the old) to keep
 *      the filesystem consistent on a mid-run crash: the new file is
 *      complete before the old one disappears.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import type { FrontmatterMap } from "../types.ts";
import { formatFrontmatter, parseFrontmatter, writeFrontmatterAtomic } from "../vault.ts";
import { FrontmatterTierConflictError, mergeFrontmatterTiered } from "./frontmatter-tiers.ts";
import { loadSchemaPack } from "./schema-pack.ts";
import { DEFAULT_RELATION_TYPES, type DefaultRelationType } from "../graph/relation-vocab.ts";
import {
  isKnownSchemaToken,
  validateSchemaToken,
  type BrainSchemaVocabulary,
} from "./schema-vocab.ts";
import { brainDirs, preferencePath, retiredPath, validateSlug } from "./paths.ts";
import { asProvenanceLevel, type ProvenanceLevel } from "./provenance/provenance.ts";
import { sanitisePrinciple } from "./text/sanitize-principle.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_MEMORY_LAYER,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
  type BrainConfidence,
  type BrainEvidenceSummary,
  type BrainMemoryLayer,
  type BrainPreference,
  type BrainPreferenceStatus,
  type BrainRetired,
  type BrainRetiredReason,
  isBrainMemoryLayer,
} from "./types.ts";
import type { PageLifecycle } from "./page-meta/lifecycle.ts";
import type { PageTier } from "./page-meta/tier.ts";
import { computeContentHash } from "./content-hash.ts";
import { normalizeExpirationDate } from "./expiration.ts";
import {
  computePayloadHash,
  IdempotencyPayloadMismatchError,
  lookupKey,
  rememberKey,
} from "./idempotency-ledger.ts";
import { appendPrefAudit } from "./pref-audit.ts";
import { PREF_AUDIT_OP } from "./types.ts";

// ----- Errors ---------------------------------------------------------------

/**
 * Raised when a preference / retired file disagrees with the folder
 * it lives in. Surfaces both pieces of information so the caller (and
 * `o2b brain doctor`) can render an actionable message.
 */
export class BrainStatusFolderMismatchError extends Error {
  readonly path: string;
  readonly status: string;
  readonly folder: "preferences" | "retired";

  constructor(message: string, path: string, status: string, folder: "preferences" | "retired") {
    super(`${message} (path=${path}, status=${status}, folder=${folder})`);
    this.name = "BrainStatusFolderMismatchError";
    this.path = path;
    this.status = status;
    this.folder = folder;
  }
}

// ----- Writer inputs --------------------------------------------------------

export interface WritePreferenceInput {
  /** Slug stem (no `pref-` prefix). Used as the file basename. */
  readonly slug: string;
  readonly topic: string;
  readonly principle: string;
  readonly created_at: string;
  readonly unconfirmed_until: string;
  readonly status: BrainPreferenceStatus;
  readonly evidenced_by: ReadonlyArray<string>;
  readonly confirmed_at?: string | null;
  readonly scope?: string;
  /**
   * Optional owner token (Knowledge Provenance suite, v1.7). When set, the
   * fact is owner-private: owner-scoped recall returns it only to its owner,
   * while ownerless facts stay shared. Stored verbatim; normalized for
   * comparison by the shared owner-visibility model.
   */
  readonly owner?: string;
  /**
   * Optional provenance trust level (Knowledge Provenance suite, v1.7).
   * Absent reads as `stated` (operator-asserted) for every existing
   * preference. A derived fact is written `deduced` or `inferred` with its
   * premise links in `evidenced_by`.
   */
  readonly provenance?: ProvenanceLevel;
  readonly applied_count?: number;
  readonly violated_count?: number;
  readonly last_evidence_at?: string | null;
  readonly confidence?: BrainConfidence;
  /**
   * Numeric `confidence_value` (Wilson lower bound × freshness
   * decay). `null` or absent leaves the on-disk field as `null`,
   * signalling "not yet computed" to downstream readers. Dream's
   * refresh pass always supplies a finite value.
   */
  readonly confidence_value?: number | null;
  /**
   * Per-page lifecycle. Defaults to `stable` when unspecified so
   * legacy callers do not need to thread the field through. Dream
   * promotes `stable` → `verified` once a preference accumulates
   * enough independent applied-evidence events; the lint --consolidate
   * pass can demote `stable` → `draft` for very old, never-applied
   * pages.
   */
  readonly lifecycle?: PageLifecycle;
  /**
   * Per-page importance tier. User-editable, unprefixed in YAML
   * (next to `pinned`). Reader-side default is `supporting`; emitted
   * only when supplied so legacy fixtures stay byte-identical.
   */
  readonly tier?: PageTier;
  readonly pinned?: boolean;
  /**
   * Directional freshness trend (Time-Aware Recall & Activation Suite,
   * t_ee09a6ce). Stamped by the dream refresh pass from the evidence
   * time distribution; emitted only when supplied so legacy fixtures
   * stay byte-identical. Recall reads it as a bounded ranking
   * multiplier; absent means neutral.
   */
  readonly freshness_trend?: string;
  /**
   * Brain Integrity Suite (v0.12.0). Optional monotonic write counter
   * persisted as `_revision`. `writePreferenceTxn` auto-stamps the
   * next value when callers omit. Direct `writePreference` callers
   * that omit the field skip the emission entirely - legacy fixtures
   * stay byte-identical (the reader treats absent as `0`).
   */
  readonly revision?: number;
  /**
   * Brain Integrity Suite (v0.12.0). Optional sha256 of the canonical
   * `(principle, scope)` pair persisted as `_content_hash`. Dream
   * supplies on promotion to `confirmed`; emitted verbatim when
   * supplied, omitted otherwise.
   */
  readonly content_hash?: string;
  readonly supersedes?: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly schema_type?: string;
  readonly memory_layer?: BrainMemoryLayer;
  readonly memory_branch?: string;
  readonly related?: ReadonlyArray<string>;
  readonly extends?: ReadonlyArray<string>;
  readonly depends_on?: ReadonlyArray<string>;
  readonly refines?: ReadonlyArray<string>;
  readonly contradicts?: ReadonlyArray<string>;
  /**
   * Brain lifecycle suite (F5). Bi-temporal validity window, filled by
   * the dream promotion path from the source signal's ISO temporal
   * text. Emitted verbatim when supplied; absent leaves the field off.
   */
  readonly valid_from?: string;
  readonly valid_until?: string;
  /**
   * Caller-settable expiration (C5 / t_a82b674e). ISO date
   * (`YYYY-MM-DD`) or full timestamp. Additive and optional: absent →
   * the write is byte-identical to the historical path. When present it
   * is validated and stamped into frontmatter; the default read/list
   * path drops a preference past this date unless the caller opts into
   * `showExpired`. Orthogonal to dream retirement — the file is never
   * moved to `Brain/retired/` on expiry.
   */
  readonly expiration_date?: string;
  /** Optional extra tags merged after the canonical set. */
  readonly extraTags?: ReadonlyArray<string>;
  /** Free-form "How to apply" prose (rendered as a section). */
  readonly howToApply?: string;
  /**
   * Client-supplied idempotency key (C1 / t_213f356b). Additive and
   * optional: absent → the write is byte-identical to the historical
   * path. When present, the writer hashes the identity-defining fields
   * (slug, topic, principle, scope, status, evidenced_by — never the
   * timestamps or dream-owned counters) and consults the idempotency
   * ledger. A repeat with the same key + same payload is a deduped no-op;
   * the same key + a different payload throws
   * {@link IdempotencyPayloadMismatchError}. Used by the force-confirmed
   * feedback path and by C4's session checkpoint.
   */
  readonly idempotency_key?: string;
  /**
   * Recent `apply-evidence applied` rows for this pref, derived from
   * `Brain/log/`. Newest first. Used by {@link renderPreferenceBody}
   * to render `## Recent applications` so the file mirrors what the
   * counters say.
   */
  readonly recentApplied?: ReadonlyArray<BrainEvidenceSummary>;
  /**
   * Recent `apply-evidence violated` / `outdated` rows. Newest first.
   */
  readonly recentViolated?: ReadonlyArray<BrainEvidenceSummary>;
}

export interface WritePreferenceOptions {
  /** When true, overwrite an existing file at the target path. */
  readonly overwrite?: boolean;
}

export interface ParsePreferenceOptions {
  readonly schemaVocabulary?: BrainSchemaVocabulary;
}

export interface WritePreferenceResult {
  readonly path: string;
  readonly id: string;
  /**
   * Set to `true` when an `idempotency_key` matched a prior write with an
   * identical payload, so this call was a deduped no-op. Absent on a
   * normal write, so existing callers are unaffected.
   */
  readonly deduped?: boolean;
}

export interface MoveToRetiredOptions {
  readonly now: Date;
  readonly retired_by: string;
  readonly superseded_by?: string;
  /**
   * Free-form reason supplied by `o2b brain reject --reason <text>`.
   * Persisted to the retired frontmatter as `user_rejected_reason`
   * and rendered in the `## Retired` body block. Required by the CLI
   * for `user-rejected` retires; left undefined for automatic
   * retire-reasons emitted by dream.
   */
  readonly user_rejected_reason?: string;
  /**
   * Pre-collected evidence slice to render into the retired snapshot.
   * Dream passes this to avoid re-scanning the log when it already
   * computed evidence during the refresh phase; the CLI reject path
   * leaves it undefined and {@link moveToRetired} collects internally.
   */
  readonly evidenceApplied?: ReadonlyArray<BrainEvidenceSummary>;
  readonly evidenceViolated?: ReadonlyArray<BrainEvidenceSummary>;
  /**
   * Opt-in per-preference audit (Brain lifecycle suite F1). When
   * supplied, a `retire` record is appended to the original
   * preference's audit trail (`pref-<slug>.jsonl`) so the whole
   * lifecycle stays in one file. The retire reason is taken from the
   * `reason` argument, not from the sink. Omitting it preserves
   * pre-suite behaviour (no audit file).
   */
  readonly audit?: { readonly agent: string };
}

export interface MoveToRetiredResult {
  readonly path: string;
  readonly id: string;
}

// ----- Writer ---------------------------------------------------------------

/**
 * Write a preference atomically to `Brain/preferences/pref-<slug>.md`.
 *
 * The frontmatter snapshot includes every field on `BrainPreference`,
 * with safe defaults for the optional counters (zero) and confidence
 * (`low`). The body is the canonical three-section layout described in
 * §5.3 — "## Principle", "## Origin", "## How to apply".
 */
export function writePreference(
  vault: string,
  input: WritePreferenceInput,
  options: WritePreferenceOptions = {},
): WritePreferenceResult {
  if (!input.slug?.trim()) throw new Error("preference missing field: slug");
  if (!input.topic?.trim()) throw new Error("preference missing field: topic");
  if (!input.principle?.trim()) {
    throw new Error("preference missing field: principle");
  }
  if (!input.created_at?.trim()) {
    throw new Error("preference missing field: created_at");
  }
  if (!input.unconfirmed_until?.trim()) {
    throw new Error("preference missing field: unconfirmed_until");
  }
  if (
    input.status !== BRAIN_PREFERENCE_STATUS.unconfirmed &&
    input.status !== BRAIN_PREFERENCE_STATUS.confirmed &&
    input.status !== BRAIN_PREFERENCE_STATUS.quarantine
  ) {
    throw new Error(
      `preference field 'status' must be 'unconfirmed', 'confirmed', or 'quarantine'; got ${JSON.stringify(input.status)}`,
    );
  }

  const slug = validateSlug(input.slug);
  const path = preferencePath(vault, slug);
  const id = `pref-${slug}`;

  // Idempotency consult (C1): a repeat with the same key + same payload
  // dedupes; the same key + a different payload throws before any write.
  const idKey = input.idempotency_key?.trim();
  let idContentHash: string | undefined;
  if (idKey) {
    idContentHash = computePayloadHash(preferencePayloadFields(input, slug));
    const existing = lookupKey(vault, idKey);
    if (existing) {
      if (existing.contentHash === idContentHash) {
        return { path, id, deduped: true };
      }
      throw new IdempotencyPayloadMismatchError(idKey, existing.contentHash, idContentHash);
    }
  }

  let metadata = preferenceFrontmatter(input, id);
  const body = renderPreferenceBody(input);

  if (options.overwrite && existsSync(path)) {
    // Tier guard (write-time-integrity-governance): rewrites merge
    // through the tier model so a user-tier field a human added by
    // hand survives, framework-owned legacy keys the writer no longer
    // emits are dropped, and a changed identity join key throws
    // instead of being silently re-accepted. An unreadable existing
    // file or schema pack falls back to the plain framework write.
    try {
      const [existingMeta] = parseFrontmatter(path);
      metadata = mergeFrontmatterTiered(existingMeta, metadata, {
        kind: "brain-preference",
        pack: loadSchemaPack(vault),
      });
    } catch (exc) {
      if (exc instanceof FrontmatterTierConflictError) throw exc;
    }
    // Content-level idempotency: skip the rename when the file would
    // be byte-identical. Keeps the dream invariant "a no-op rerun
    // must not rewrite preference files" even after v0.10.1 expanded
    // what dream recomputes per pass (evidence slices), and it spares
    // Syncthing peers from spurious sync events.
    try {
      const next = formatFrontmatter(metadata, body);
      const prev = readFileSync(path, "utf8");
      if (next === prev) {
        recordPreferenceKey(vault, idKey, idContentHash, input.created_at, id, path);
        return { path, id };
      }
    } catch {
      // Fall through to the atomic write — a read failure should not
      // prevent a legitimate update.
    }
  }

  writeFrontmatterAtomic(path, metadata, body, {
    overwrite: options.overwrite ?? false,
    existsErrorKind: "preference",
    vaultForRelativePath: vault,
  });

  recordPreferenceKey(vault, idKey, idContentHash, input.created_at, id, path);
  return { path, id };
}

/**
 * The identity-defining fields of a preference for idempotency hashing.
 * Timestamps, dream-owned counters, and confidence are excluded so a
 * retried write (or a force-confirmed re-record) with the same rule
 * dedupes regardless of when it arrives.
 */
function preferencePayloadFields(
  input: WritePreferenceInput,
  slug: string,
): Record<string, unknown> {
  return {
    slug,
    topic: input.topic.trim(),
    principle: sanitisePrinciple(input.principle),
    scope: input.scope?.trim(),
    status: input.status,
    evidenced_by: [...input.evidenced_by],
    // `owner` drives owner-scoped visibility and is written to frontmatter,
    // so a retry that only changes it must NOT silently dedupe — fold it into
    // the idempotency hash (mirrors the write path at recordPreference).
    owner: input.owner?.trim(),
  };
}

/**
 * Record the idempotency key after a successful preference write so a
 * future retry dedupes. No-op when no key was supplied.
 */
function recordPreferenceKey(
  vault: string,
  idKey: string | undefined,
  contentHash: string | undefined,
  createdAt: string,
  id: string,
  path: string,
): void {
  if (!idKey || contentHash === undefined) return;
  rememberKey(vault, {
    key: idKey,
    contentHash,
    createdAt,
    ref: { id, path: relative(vault, path) },
  });
}

/**
 * Predicate twin of {@link writePreference}'s content-equality
 * short-circuit. Returns `true` iff calling `writePreference(vault,
 * input, { overwrite: true })` would change the on-disk bytes
 * (file missing, or file present with different content). The dream
 * pass uses this to decide whether a pref needs to land in the
 * refresh set — emitting a refresh entry triggers a snapshot + log
 * event, so we must not emit one if the rewrite would be a no-op.
 *
 * Cheap: one stat + one readFileSync + one render of frontmatter +
 * body. Caller-side cost is negligible compared with the writePref
 * + log overhead avoided when the body is up to date.
 */
export function wouldRewritePreference(vault: string, input: WritePreferenceInput): boolean {
  const slug = validateSlug(input.slug);
  const path = preferencePath(vault, slug);
  if (!existsSync(path)) return true;
  try {
    const id = `pref-${slug}`;
    const metadata = preferenceFrontmatter(input, id);
    const body = renderPreferenceBody(input);
    const next = formatFrontmatter(metadata, body);
    const prev = readFileSync(path, "utf8");
    return next !== prev;
  } catch {
    // Conservative: a read or render failure should not silently
    // mark the file as up-to-date.
    return true;
  }
}

function preferenceFrontmatter(input: WritePreferenceInput, id: string): FrontmatterMap {
  const tags = composePreferenceTags(input);
  const confidence = input.confidence ?? BRAIN_CONFIDENCE.low;
  const pinned = input.pinned ?? false;
  const applied = input.applied_count ?? 0;
  const violated = input.violated_count ?? 0;
  // Round numeric confidence to 4 decimals so a no-op rerun produces
  // byte-identical YAML even if upstream callers pass a value with
  // floating-point jitter. `null` sentinel mirrors the other Group C
  // null-encoded fields so the simple parser keeps round-tripping.
  const confidenceValueRaw = input.confidence_value;
  const confidenceValueField =
    confidenceValueRaw === undefined || confidenceValueRaw === null
      ? "null"
      : Math.round(confidenceValueRaw * 10000) / 10000;

  // §24: Group C derived fields gain `_` prefix so the visual
  // boundary between "what dream owns" and "what the user owns"
  // becomes obvious in Obsidian. Identity (`kind`, `id`, `created_at`,
  // `unconfirmed_until`, `topic`, `principle`, `scope`, `tags`,
  // `aliases`, `supersedes`) and user-editable (`pinned`) stay
  // unprefixed. Parser accepts both shapes; writer only emits the new.
  const metadata: FrontmatterMap = {
    kind: "brain-preference",
    id,
    created_at: input.created_at,
    // Use a textual sentinel for `null` so the simple parser surfaces
    // an empty string and the loader coerces back to `null`. We store
    // the literal text "null" rather than an empty value to keep the
    // emitted YAML one-token per line and the field always present.
    _confirmed_at: input.confirmed_at ?? "null",
    unconfirmed_until: input.unconfirmed_until,
    tags: [...tags],
    topic: input.topic.trim(),
    _status: input.status,
    principle: sanitisePrinciple(input.principle),
    _evidenced_by: [...input.evidenced_by],
    _applied_count: applied,
    _violated_count: violated,
    _last_evidence_at: input.last_evidence_at ?? "null",
    _confidence: confidence,
    _confidence_value: confidenceValueField,
    pinned,
  };
  // Brain Integrity Suite additive fields. Both follow the
  // `_lifecycle` precedent: emit only when the caller supplies a
  // value so legacy fixtures and the starter bundle stay
  // byte-identical with absent-as-default reader semantics.
  if (input.revision !== undefined) metadata["_revision"] = input.revision;
  if (input.content_hash) metadata["_content_hash"] = input.content_hash;
  if (input.scope?.trim()) metadata["scope"] = input.scope.trim();
  if (input.owner?.trim()) metadata["owner"] = input.owner.trim();
  // Only emit a non-default provenance; absent reads as `stated`, so an
  // existing preference stays byte-identical.
  if (input.provenance !== undefined && input.provenance !== "stated") {
    metadata["provenance"] = input.provenance;
  }
  if (input.supersedes?.trim()) metadata["supersedes"] = input.supersedes.trim();
  if (input.aliases && input.aliases.length > 0) {
    metadata["aliases"] = [...input.aliases];
  }
  if (input.schema_type?.trim()) {
    metadata["schema_type"] = validateSchemaToken(input.schema_type, "schema_type");
  }
  if (input.memory_layer !== undefined) {
    metadata["memory_layer"] = validateMemoryLayer(input.memory_layer, "writePreference");
  }
  if (input.memory_branch?.trim()) {
    metadata["memory_branch"] = validateMemoryBranch(input.memory_branch, "writePreference");
  }
  for (const field of PREFERENCE_RELATION_FIELDS) {
    const values = input[field];
    if (values && values.length > 0) metadata[field] = [...values];
  }
  // `_lifecycle` is emitted only when the caller supplies it. Legacy
  // call sites stay byte-identical; new writers (dream refresh pass,
  // lint consolidate) opt in by passing the field. Readers fall back
  // to `stable` via `readLifecycle()`.
  if (input.lifecycle !== undefined) {
    metadata["_lifecycle"] = input.lifecycle;
  }
  // `tier` is user-editable (unprefixed). Emitted only when supplied;
  // readers fall back to `supporting` via `readTier()`.
  if (input.tier !== undefined) {
    metadata["tier"] = input.tier;
  }
  // Brain lifecycle suite (F5): bi-temporal validity, emitted only when
  // supplied (e.g. dream filled it from the source signal's ISO text).
  // Reader-side support already exists via readBitemporalSlots; legacy
  // callers stay byte-identical.
  if (input.valid_from?.trim()) metadata["valid_from"] = input.valid_from.trim();
  if (input.valid_until?.trim()) metadata["valid_until"] = input.valid_until.trim();
  // Caller-settable expiration (C5): validated + emitted only when
  // supplied so legacy callers stay byte-identical. Reader-side support
  // is via parsePreference's optional-scalar read + the expiration filter.
  if (input.expiration_date?.trim()) {
    metadata["expiration_date"] = normalizeExpirationDate(input.expiration_date);
  }
  // Freshness trend (t_ee09a6ce): stamped by the dream refresh pass;
  // emitted only when supplied so legacy callers stay byte-identical.
  if (input.freshness_trend?.trim()) metadata["freshness_trend"] = input.freshness_trend.trim();
  return metadata;
}

function composePreferenceTags(input: WritePreferenceInput): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string): void => {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  push("brain");
  push("brain/preference");
  push(`brain/topic/${input.topic.trim()}`);
  if (input.scope?.trim()) push(`brain/scope/${input.scope.trim()}`);
  for (const t of input.extraTags ?? []) {
    if (t.trim()) push(t.trim());
  }
  return out;
}

/**
 * Render the preference body. Sections are emitted **only when they
 * have real content** — v0.10.1 removes the always-empty placeholder
 * blocks (`_(no evidence yet)_`, `_(not provided)_`) that the v0.9.x
 * shape used to ship. Principle text is intentionally NOT duplicated:
 * frontmatter is the single source for that field.
 *
 * Sections, in order:
 *
 *   - `## Origin` — wikilinks from `evidenced_by` (one bullet each).
 *     Omitted when the array is empty (e.g. `--force-confirmed`).
 *   - `## Recent applications` — last N `apply-evidence applied` rows,
 *     newest first. Each bullet: `[[artifact]] — ts (agent) — note`.
 *     Omitted when zero.
 *   - `## Recent violations` — same shape for `violated` / `outdated`.
 *     Omitted when zero.
 *   - `## How to apply` — only when `howToApply` is non-empty prose
 *     supplied by the caller; never auto-filled.
 *
 * If all sections are skipped, the body is empty and {@link
 * writeFrontmatterAtomic} writes a frontmatter-only file.
 */
function renderPreferenceBody(input: WritePreferenceInput): string {
  const sections: string[] = [];

  if (input.evidenced_by.length > 0) {
    const block: string[] = ["## Origin", ""];
    for (const ev of input.evidenced_by) block.push(`- ${ev}`);
    sections.push(block.join("\n"));
  }

  if (input.recentApplied && input.recentApplied.length > 0) {
    sections.push(renderEvidenceSection("Recent applications", input.recentApplied));
  }

  if (input.recentViolated && input.recentViolated.length > 0) {
    sections.push(renderEvidenceSection("Recent violations", input.recentViolated));
  }

  const guidance = input.howToApply?.trim();
  if (guidance) {
    const normalised = guidance.replace(/\r\n?/g, "\n").replace(/\s+$/g, "");
    sections.push(["## How to apply", "", normalised].join("\n"));
  }

  return sections.join("\n\n");
}

function renderEvidenceSection(heading: string, rows: ReadonlyArray<BrainEvidenceSummary>): string {
  const lines: string[] = [`## ${heading}`, ""];
  for (const ev of rows) {
    const parts: string[] = [`- ${ev.artifact}`, `— ${ev.timestamp}`];
    if (ev.agent) parts.push(`(${ev.agent})`);
    if (ev.result === "violated" || ev.result === "outdated") {
      parts.push(`[${ev.result}]`);
    }
    if (ev.note) parts.push(`— ${ev.note.replace(/\s+/g, " ").trim()}`);
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}

// ----- Parsers --------------------------------------------------------------

/**
 * Group C — derived fields that get a `_` prefix in the on-disk
 * shape (dream-rewritten state, see §24). Parser accepts both
 * `name` and `_name`; writer always emits `_name`. Listed once so
 * both `parsePreference`, `parseRetired`, and the migration helper
 * share the same list — a follow-up adding a derived field updates
 * exactly this constant.
 */
export const DERIVED_FIELDS: ReadonlyArray<string> = Object.freeze([
  "status",
  "confirmed_at",
  "last_evidence_at",
  "applied_count",
  "violated_count",
  "confidence",
  "confidence_value",
  "evidenced_by",
  "contradicted_by",
  "lifecycle",
  "revision",
  "content_hash",
]);

/**
 * Rename `_`-prefixed Group C keys (`_status`, `_applied_count`, ...)
 * to their canonical un-prefixed form so every downstream
 * `meta[name]` call site keeps working. Returns a shallow copy of
 * `meta`; original is untouched. Exported because the backlink
 * index and other raw-frontmatter consumers need the same rule.
 */
export function normalizeDerivedKeys(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...meta };
  for (const name of DERIVED_FIELDS) {
    if (name in out && out[name] !== undefined) {
      throw new Error(
        `frontmatter field '${name}' must use the '_'-prefixed shape ('_${name}'); ` +
          "un-prefixed Group C keys are no longer accepted",
      );
    }
    const prefixed = `_${name}`;
    if (prefixed in out && out[prefixed] !== undefined) {
      out[name] = out[prefixed];
      delete out[prefixed];
    }
  }
  return out;
}

/**
 * Parse a preference file. Defaults `pinned` to `false` when the field
 * is absent (§5.3). Throws {@link BrainStatusFolderMismatchError} when
 * the file lives in `preferences/` but its `status` reads `retired`
 * (or any other state outside `unconfirmed` / `confirmed`).
 *
 * Derived Group C fields use the `_`-prefixed shape on disk
 * (`_status:`, `_applied_count:`, ...); {@link normalizeDerivedKeys}
 * renames them to the un-prefixed form for downstream readers.
 */
export function parsePreference(
  path: string,
  options: ParsePreferenceOptions = {},
): BrainPreference {
  const [rawMeta, _body] = parseFrontmatter(path);
  const meta = normalizeDerivedKeys(rawMeta);
  // `_body` is unused for preferences — the body is purely human prose;
  // every machine-actionable field lives in the frontmatter.
  void _body;

  requireField(meta, "kind", path);
  if (meta["kind"] !== "brain-preference") {
    throw new Error(
      `preference kind must be 'brain-preference'; got ${JSON.stringify(meta["kind"])} (${path})`,
    );
  }

  const status = requireString(meta, "status", path);
  // Reject unknown status values BEFORE the folder invariant: a malformed
  // file should never coerce into a typed `BrainPreference.status`
  // downstream, regardless of which folder it sits in. We tolerate
  // `status: "retired"` here because that case is the dedicated
  // status-folder-mismatch the parser surfaces below as a typed error
  // (doctor downgrades it to a warning) — see §4 of the design doc.
  const statusValues = Object.values(BRAIN_PREFERENCE_STATUS) as ReadonlyArray<string>;
  if (!statusValues.includes(status) && status !== "retired") {
    throw new Error(
      `preference status must be one of ${statusValues.join(", ")}; got ${JSON.stringify(status)} (${path})`,
    );
  }
  enforceStatusFolderInvariant(path, status, "preferences");

  const id = requireString(meta, "id", path);
  const created_at = requireString(meta, "created_at", path);
  const unconfirmed_until = requireString(meta, "unconfirmed_until", path);
  const tags = requireStringArray(meta, "tags", path);
  const topic = requireString(meta, "topic", path);
  const principle = requireString(meta, "principle", path);

  const evidenced_by = optionalStringArray(meta, "evidenced_by");
  const confirmed_at = optionalNullableString(meta, "confirmed_at");
  const last_evidence_at = optionalNullableString(meta, "last_evidence_at");
  // Provenance level: validated through the shared narrowing guard, never cast.
  const provenance = asProvenanceLevel(meta["provenance"]);

  const result: BrainPreference = {
    kind: "brain-preference",
    id,
    created_at,
    confirmed_at,
    unconfirmed_until,
    tags,
    topic,
    status: status as BrainPreferenceStatus,
    principle,
    evidenced_by,
    applied_count: optionalNumber(meta, "applied_count", 0),
    violated_count: optionalNumber(meta, "violated_count", 0),
    last_evidence_at,
    confidence: parseConfidence(meta, path),
    confidence_value: parseConfidenceValue(meta, path),
    pinned: parsePinned(meta),
    revision: optionalNumber(meta, "revision", 0),
    ...(optionalScalarString(meta, "content_hash") !== undefined
      ? { content_hash: optionalScalarString(meta, "content_hash") }
      : {}),
    ...(optionalScalarString(meta, "scope") !== undefined
      ? { scope: optionalScalarString(meta, "scope") }
      : {}),
    ...(optionalScalarString(meta, "owner") !== undefined
      ? { owner: optionalScalarString(meta, "owner") }
      : {}),
    ...(provenance !== null ? { provenance } : {}),
    ...(optionalScalarString(meta, "freshness_trend") !== undefined
      ? { freshness_trend: optionalScalarString(meta, "freshness_trend") }
      : {}),
    ...(optionalScalarString(meta, "expiration_date") !== undefined
      ? { expiration_date: optionalScalarString(meta, "expiration_date") }
      : {}),
    ...(optionalScalarString(meta, "supersedes") !== undefined
      ? { supersedes: optionalScalarString(meta, "supersedes") }
      : {}),
    ...(meta["aliases"] !== undefined && Array.isArray(meta["aliases"])
      ? { aliases: [...(meta["aliases"] as ReadonlyArray<string>)] }
      : {}),
    ...spreadSchemaMetadata(meta, path, "preference_types", options),
    ...spreadMemorySemantics(meta, path),
    ...spreadBiTemporal(meta),
  };
  return Object.freeze(result);
}

type PreferenceRelationField = Exclude<DefaultRelationType, "superseded_by">;

const PREFERENCE_RELATION_FIELDS = Object.freeze(
  DEFAULT_RELATION_TYPES.filter(
    (field): field is PreferenceRelationField => field !== "superseded_by",
  ),
);

function spreadMemorySemantics(
  meta: Record<string, unknown>,
  path: string,
): {
  readonly memory_layer?: BrainMemoryLayer;
  readonly memory_branch?: string;
  readonly related?: ReadonlyArray<string>;
  readonly extends?: ReadonlyArray<string>;
  readonly depends_on?: ReadonlyArray<string>;
  readonly refines?: ReadonlyArray<string>;
  readonly contradicts?: ReadonlyArray<string>;
} {
  const out: Record<string, BrainMemoryLayer | string | ReadonlyArray<string>> = {};
  const memoryLayer = optionalScalarString(meta, "memory_layer");
  if (memoryLayer !== undefined) {
    out["memory_layer"] = validateMemoryLayer(memoryLayer, path);
  }
  const memoryBranch = optionalScalarString(meta, "memory_branch");
  if (memoryBranch !== undefined) {
    out["memory_branch"] = validateMemoryBranch(memoryBranch, path);
  }
  for (const field of PREFERENCE_RELATION_FIELDS) {
    const values = optionalStringList(meta, field);
    if (values !== undefined) out[field] = values;
  }
  return out;
}

function spreadSchemaMetadata(
  meta: Record<string, unknown>,
  path: string,
  category: "preference_types" | "signal_types",
  options: ParsePreferenceOptions,
): { readonly schema_type?: string } {
  const raw = optionalScalarString(meta, "schema_type");
  if (raw === undefined) return {};
  const schemaType = validateSchemaToken(raw, "schema_type");
  const vocab = options.schemaVocabulary;
  if (vocab !== undefined && !isKnownSchemaToken(vocab, category, schemaType)) {
    throw new Error(
      `schema_type ${JSON.stringify(schemaType)} is not declared in ${category} (${path})`,
    );
  }
  return { schema_type: schemaType };
}

function validateMemoryLayer(value: string, path: string): BrainMemoryLayer {
  if (isBrainMemoryLayer(value)) return value;
  const allowed = Object.values(BRAIN_MEMORY_LAYER).join(", ");
  throw new Error(
    `preference field 'memory_layer' must be one of ${allowed}; got ${JSON.stringify(value)} (${path})`,
  );
}

function validateMemoryBranch(value: string, path: string): string {
  try {
    return validateSlug(value);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`preference field 'memory_branch' is invalid: ${reason} (${path})`, {
      cause: err,
    });
  }
}

/**
 * Read the additive bi-temporal slots (`valid_from`, `valid_until`,
 * `recorded_at`) from a frontmatter map. Returns a partial object
 * with only the slots the file actually carries; absent on legacy
 * files. Shared between `parsePreference` and `parseRetired` so the
 * spread call site stays one-line and the slot names live in exactly
 * one place.
 */
function spreadBiTemporal(meta: Record<string, unknown>): {
  readonly valid_from?: string;
  readonly valid_until?: string;
  readonly recorded_at?: string;
} {
  const validFrom = optionalScalarString(meta, "valid_from");
  const validUntil = optionalScalarString(meta, "valid_until");
  const recordedAt = optionalScalarString(meta, "recorded_at");
  return {
    ...(validFrom !== undefined ? { valid_from: validFrom } : {}),
    ...(validUntil !== undefined ? { valid_until: validUntil } : {}),
    ...(recordedAt !== undefined ? { recorded_at: recordedAt } : {}),
  };
}

/**
 * Parse a retired-preference file. Mirrors {@link parsePreference} but
 * enforces the `retired/` folder invariant and validates the
 * `retired_reason` enum.
 *
 * Shares {@link normalizeDerivedKeys} with `parsePreference` so
 * both forms of Group C frontmatter parse identically.
 */
export function parseRetired(path: string, options: ParsePreferenceOptions = {}): BrainRetired {
  const [rawMeta] = parseFrontmatter(path);
  const meta = normalizeDerivedKeys(rawMeta);

  requireField(meta, "kind", path);
  if (meta["kind"] !== "brain-retired") {
    throw new Error(
      `retired kind must be 'brain-retired'; got ${JSON.stringify(meta["kind"])} (${path})`,
    );
  }

  const status = requireString(meta, "status", path);
  if (status !== "retired") {
    throw new BrainStatusFolderMismatchError(
      "retired file frontmatter status is not 'retired'",
      path,
      status,
      "retired",
    );
  }
  enforceStatusFolderInvariant(path, status, "retired");

  const id = requireString(meta, "id", path);
  const retired_at = requireString(meta, "retired_at", path);
  const reasonStr = requireString(meta, "retired_reason", path);
  const reasonValues = Object.values(BRAIN_RETIRED_REASON) as ReadonlyArray<string>;
  if (!reasonValues.includes(reasonStr)) {
    throw new Error(
      `retired_reason must be one of ${reasonValues.join(", ")}; got ${JSON.stringify(reasonStr)} (${path})`,
    );
  }
  const retired_by = requireString(meta, "retired_by", path);
  const created_at = requireString(meta, "created_at", path);
  const tags = requireStringArray(meta, "tags", path);
  const topic = requireString(meta, "topic", path);
  const principle = requireString(meta, "principle", path);

  const result: BrainRetired = {
    kind: "brain-retired",
    id,
    status: "retired",
    retired_at,
    retired_reason: reasonStr as BrainRetiredReason,
    retired_by,
    created_at,
    tags,
    topic,
    principle,
    evidenced_by: optionalStringArray(meta, "evidenced_by"),
    applied_count: optionalNumber(meta, "applied_count", 0),
    violated_count: optionalNumber(meta, "violated_count", 0),
    last_evidence_at: optionalNullableString(meta, "last_evidence_at"),
    confidence: parseConfidence(meta, path),
    confidence_value: parseConfidenceValue(meta, path),
    pinned: parsePinned(meta),
    ...(optionalScalarString(meta, "scope") !== undefined
      ? { scope: optionalScalarString(meta, "scope") }
      : {}),
    ...(optionalScalarString(meta, "superseded_by") !== undefined
      ? { superseded_by: optionalScalarString(meta, "superseded_by") }
      : {}),
    ...(meta["aliases"] !== undefined && Array.isArray(meta["aliases"])
      ? { aliases: [...(meta["aliases"] as ReadonlyArray<string>)] }
      : {}),
    ...spreadSchemaMetadata(meta, path, "preference_types", options),
    ...spreadMemorySemantics(meta, path),
    ...(optionalScalarString(meta, "user_rejected_reason") !== undefined
      ? {
          user_rejected_reason: optionalScalarString(meta, "user_rejected_reason"),
        }
      : {}),
    ...spreadBiTemporal(meta),
  };
  return Object.freeze(result);
}

// ----- preferences/ -> retired/ mover --------------------------------------

/**
 * Move a preference into `Brain/retired/`. Rewrites the frontmatter
 * with the retire metadata (status, kind, retired_at, retired_reason,
 * retired_by, optional superseded_by) and preserves the inherited
 * fields (topic, principle, evidenced_by, …).
 *
 * Body decision: we keep the original "## Principle" / "## Origin" /
 * "## How to apply" sections and append a "## Retired" section that
 * names the reason and pointer. The design doc §5.4 is silent on the
 * body shape; keeping the prose intact (rather than truncating it)
 * preserves the audit trail value — a future reader sees both what the
 * rule was and why it left.
 *
 * The move is performed as: write the new file atomically under
 * `retired/`, then `unlink` the original under `preferences/`. If the
 * write fails, the original stays untouched. If the unlink fails after
 * a successful write, the caller is left with both copies — `o2b brain
 * doctor` flags the duplicate id.
 */
export function moveToRetired(
  vault: string,
  prefPath: string,
  reason: BrainRetiredReason,
  opts: MoveToRetiredOptions,
): MoveToRetiredResult {
  // Pre-condition: ensure the source path is actually inside the
  // canonical `preferences/` folder. Doing this check *before* any I/O
  // means a buggy caller cannot trick us into deleting an unrelated
  // file: a misrouted call fails fast with no destructive side effect.
  const dirs = brainDirs(vault);
  if (dirname(prefPath) !== dirs.preferences) {
    throw new Error(`moveToRetired: source path was not under preferences/: ${prefPath}`);
  }

  const [meta, body] = parseFrontmatter(prefPath);
  if (meta["kind"] !== "brain-preference") {
    throw new Error(
      `moveToRetired: expected a preference file; got kind ${JSON.stringify(meta["kind"])} (${prefPath})`,
    );
  }
  const oldId = requireString(meta, "id", prefPath);
  if (!oldId.startsWith("pref-")) {
    throw new Error(
      `moveToRetired: preference id must start with 'pref-'; got ${oldId} (${prefPath})`,
    );
  }
  const slug = oldId.slice("pref-".length);
  if (!slug) {
    throw new Error(`moveToRetired: empty slug derived from id ${oldId}`);
  }

  const newId = `ret-${slug}`;
  const newPath = retiredPath(vault, slug);

  // Build the new frontmatter map. We preserve every inherited field
  // verbatim (`topic`, `principle`, `evidenced_by`, counters, …), drop
  // the active-state fields that no longer apply (`unconfirmed_until`,
  // `confirmed_at`), and stamp the retire metadata on top.
  const derivedSet = new Set<string>(DERIVED_FIELDS);
  const newMeta: FrontmatterMap = {};
  for (const [k, v] of Object.entries(meta)) {
    // Identity keys overwritten below.
    if (k === "kind" || k === "id" || k === "status" || k === "_status") continue;
    // Fields that don't apply to retired (drop both shapes per §24).
    if (k === "unconfirmed_until") continue;
    if (k === "confirmed_at" || k === "_confirmed_at") continue;
    if (k === "tags") {
      // Replace the `brain/preference` tag with `brain/retired`.
      const arr = Array.isArray(v) ? [...v] : [];
      newMeta["tags"] = arr.map((t) => (t === "brain/preference" ? "brain/retired" : t));
      continue;
    }
    // Group C derived fields go to disk in the `_`-prefixed shape so
    // parseRetired's `normalizeDerivedKeys` accepts the file. `meta`
    // is the normalised in-memory view, so the keys here are still
    // un-prefixed and need re-prefixing on write.
    if (derivedSet.has(k)) {
      newMeta[`_${k}`] = v as never;
      continue;
    }
    newMeta[k] = v as never;
  }
  newMeta["kind"] = "brain-retired";
  newMeta["id"] = newId;
  newMeta["_status"] = "retired";
  newMeta["retired_at"] = opts.now.toISOString();
  newMeta["retired_reason"] = reason;
  newMeta["retired_by"] = opts.retired_by;
  if (opts.superseded_by?.trim()) {
    newMeta["superseded_by"] = opts.superseded_by.trim();
  }
  if (opts.user_rejected_reason?.trim()) {
    newMeta["user_rejected_reason"] = opts.user_rejected_reason.trim();
  }

  // Add the prior `pref-<slug>` basename as an Obsidian alias on the
  // retired file. Wikilinks in append-only logs and signal frontmatter
  // were written when the file still lived in `preferences/`; without
  // this alias they would stop resolving the moment the file is
  // renamed. Obsidian's wikilink resolver checks `aliases` after
  // basename, so `[[pref-<slug>]]` continues to land on the right note
  // without rewriting any historical entry.
  const existingAliases = Array.isArray(newMeta["aliases"])
    ? (newMeta["aliases"] as ReadonlyArray<string>)
    : [];
  if (!existingAliases.includes(oldId)) {
    newMeta["aliases"] = [oldId, ...existingAliases];
  }

  // Re-render the body from scratch so the retired file carries the
  // v0.10.1 shape (only sections with content), even if the source
  // pref was last written in the v0.9.x placeholder format. Evidence
  // is collected from the live log so the snapshot reflects how the
  // rule was actually used right up to retirement.
  const renderInput: WritePreferenceInput = {
    slug,
    topic: requireString(meta, "topic", prefPath),
    principle: requireString(meta, "principle", prefPath),
    created_at: requireString(meta, "created_at", prefPath),
    unconfirmed_until: requireString(meta, "unconfirmed_until", prefPath),
    status: BRAIN_PREFERENCE_STATUS.confirmed, // body render is status-agnostic
    evidenced_by: optionalStringArray(meta, "evidenced_by"),
    ...(opts.evidenceApplied !== undefined ? { recentApplied: opts.evidenceApplied } : {}),
    ...(opts.evidenceViolated !== undefined ? { recentViolated: opts.evidenceViolated } : {}),
  };
  // moveToRetired is also called outside dream (CLI reject) — when the
  // caller did not pre-fetch evidence, we collect it here so the
  // retired file is the canonical historical snapshot in both paths.
  let renderInputWithEvidence: WritePreferenceInput = renderInput;
  if (renderInput.recentApplied === undefined && renderInput.recentViolated === undefined) {
    // Late-bound import to avoid a cyclic dependency: evidence.ts
    // imports nothing from preference.ts at module load time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ev = (require("./evidence.ts") as typeof import("./evidence.ts")).collectEvidenceForSlug(
      vault,
      slug,
      { sinceIso: renderInput.created_at },
    );
    renderInputWithEvidence = {
      ...renderInput,
      recentApplied: ev.applied,
      recentViolated: ev.violated,
    };
  }
  const renderedBody = renderPreferenceBody(renderInputWithEvidence);
  const newBody = appendRetiredSection(renderedBody, reason, opts);
  void body; // original source body is intentionally discarded — see above.

  writeFrontmatterAtomic(newPath, newMeta, newBody, {
    overwrite: false,
    existsErrorKind: "retired",
    vaultForRelativePath: vault,
  });

  // Confirm the new file actually landed before unlinking the source.
  if (!existsSync(newPath)) {
    throw new Error(`moveToRetired: write of ${newPath} reported success but file is absent`);
  }
  unlinkSync(prefPath);

  // Per-preference mutation audit (opt-in, Brain lifecycle suite F1).
  // Keyed by the ORIGINAL `pref-<slug>` id so create -> ... -> retire
  // all land in one trail. A retire is a lifecycle transition, so it
  // always records (the audit's no-op rule only suppresses `update`).
  if (opts.audit) {
    const principle = requireString(meta, "principle", prefPath);
    const scope = typeof meta["scope"] === "string" ? (meta["scope"] as string) : undefined;
    const revRaw = meta["_revision"];
    const contentHash = computeContentHash(principle, scope);
    appendPrefAudit(
      vault,
      {
        pref_id: oldId,
        op: PREF_AUDIT_OP.retire,
        agent: opts.audit.agent,
        reason,
        revision_before: typeof revRaw === "number" ? revRaw : null,
        revision_after: null,
        hash_before: contentHash,
        hash_after: contentHash,
      },
      { now: opts.now },
    );
  }

  return { path: newPath, id: newId };
}

function appendRetiredSection(
  body: string,
  reason: BrainRetiredReason,
  opts: MoveToRetiredOptions,
): string {
  const trimmed = body.trimEnd();
  const block: string[] = [
    "",
    "",
    "## Retired",
    "",
    `Reason: \`${reason}\``,
    `Retired at: ${opts.now.toISOString()}`,
    `Retired by: ${opts.retired_by}`,
  ];
  if (opts.superseded_by?.trim()) {
    block.push(`Superseded by: ${opts.superseded_by.trim()}`);
  }
  if (opts.user_rejected_reason?.trim()) {
    // Multi-line user prose: collapse internal newlines so the rendered
    // block stays a flat bullet list. Long-form context belongs in the
    // log entry, not in the retired body.
    const reasonLine = opts.user_rejected_reason.trim().replace(/\s+/g, " ");
    block.push(`User reason: ${reasonLine}`);
  }
  return trimmed + block.join("\n") + "\n";
}

// ----- Field helpers --------------------------------------------------------

function enforceStatusFolderInvariant(
  path: string,
  status: string,
  expectedFolder: "preferences" | "retired",
): void {
  // Resolve the immediate parent directory's basename. Files outside
  // the canonical `Brain/<folder>/...` get a softer treatment: we let
  // the caller use the parser on a synthetic path (e.g. tests writing
  // to a tmpdir) so long as the status itself is coherent.
  const parent = basename(dirname(path));
  if (expectedFolder === "preferences") {
    // We accept `preferences` as the canonical folder. A status of
    // `retired` here is the mismatch case the design doc §4 calls out.
    if (
      parent === "preferences" &&
      status !== BRAIN_PREFERENCE_STATUS.unconfirmed &&
      status !== BRAIN_PREFERENCE_STATUS.confirmed &&
      status !== BRAIN_PREFERENCE_STATUS.quarantine
    ) {
      throw new BrainStatusFolderMismatchError(
        "preference file frontmatter status does not match preferences/ folder",
        path,
        status,
        "preferences",
      );
    }
  } else {
    if (parent === "retired" && status !== "retired") {
      throw new BrainStatusFolderMismatchError(
        "retired file frontmatter status does not match retired/ folder",
        path,
        status,
        "retired",
      );
    }
  }
}

function requireField(meta: Record<string, unknown>, field: string, path: string): void {
  if (!(field in meta) || meta[field] === undefined || meta[field] === null) {
    throw new Error(`preference missing field: ${field} (${path})`);
  }
  if (typeof meta[field] === "string" && (meta[field] as string).trim() === "") {
    throw new Error(`preference missing field: ${field} (${path})`);
  }
}

function requireString(meta: Record<string, unknown>, field: string, path: string): string {
  requireField(meta, field, path);
  const v = meta[field];
  if (typeof v !== "string") {
    throw new Error(`preference field '${field}' must be a string (${path})`);
  }
  return v;
}

function requireStringArray(
  meta: Record<string, unknown>,
  field: string,
  path: string,
): ReadonlyArray<string> {
  requireField(meta, field, path);
  const v = meta[field];
  if (!Array.isArray(v)) {
    throw new Error(`preference field '${field}' must be an array (${path})`);
  }
  for (const item of v) {
    if (typeof item !== "string") {
      throw new Error(`preference field '${field}' must be an array of strings (${path})`);
    }
  }
  return [...(v as ReadonlyArray<string>)];
}

function optionalStringArray(meta: Record<string, unknown>, field: string): ReadonlyArray<string> {
  const v = meta[field];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new Error(`preference field '${field}' must be an array`);
  }
  for (const item of v) {
    if (typeof item !== "string") {
      throw new Error(`preference field '${field}' must be an array of strings`);
    }
  }
  return [...(v as ReadonlyArray<string>)];
}

function optionalStringList(
  meta: Record<string, unknown>,
  field: PreferenceRelationField,
): ReadonlyArray<string> | undefined {
  const v = meta[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v.trim() ? [v] : [];
  if (!Array.isArray(v)) {
    throw new Error(`preference field '${field}' must be a string or array of strings`);
  }
  for (const item of v) {
    if (typeof item !== "string") {
      throw new Error(`preference field '${field}' must be a string or array of strings`);
    }
  }
  return [...(v as ReadonlyArray<string>)];
}

/**
 * Parse a string field whose semantic value is nullable. Both the
 * literal string `"null"` and an empty string surface as JS `null` so
 * the on-disk roundtrip survives the simple YAML emitter (which has no
 * native null token).
 */
function optionalNullableString(meta: Record<string, unknown>, field: string): string | null {
  const v = meta[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") {
    throw new Error(`preference field '${field}' must be a string or null`);
  }
  const trimmed = v.trim();
  if (trimmed === "" || trimmed === "null") return null;
  return v;
}

function optionalNumber(meta: Record<string, unknown>, field: string, fallback: number): number {
  const v = meta[field];
  if (v === undefined || v === null || v === "") return fallback;
  // The simple parser surfaces all values as strings; numerics included.
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      throw new Error(
        `preference field '${field}' must be a finite number; got ${JSON.stringify(v)}`,
      );
    }
    return n;
  }
  throw new Error(`preference field '${field}' must be a number`);
}

function optionalScalarString(meta: Record<string, unknown>, field: string): string | undefined {
  const v = meta[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : v;
}

function parseConfidence(meta: Record<string, unknown>, path: string): BrainConfidence {
  const v = meta["confidence"];
  if (v === undefined || v === null || v === "") return BRAIN_CONFIDENCE.low;
  if (typeof v !== "string") {
    throw new Error(`preference field 'confidence' must be a string (${path})`);
  }
  const values = Object.values(BRAIN_CONFIDENCE) as ReadonlyArray<string>;
  if (!values.includes(v)) {
    throw new Error(
      `preference field 'confidence' must be one of ${values.join(", ")}; got ${JSON.stringify(v)} (${path})`,
    );
  }
  return v as BrainConfidence;
}

/**
 * Parse the numeric `confidence_value` field.
 *
 * Returns `null` when the field is absent, empty, or carries the
 * literal sentinel `"null"` (the writer's null encoding for the
 * simple YAML formatter). Otherwise must be a finite number in
 * `[0, 1]`; out-of-range / non-finite / non-numeric values raise a
 * hard parse error — drifting numeric confidence into `> 1` or
 * `NaN` would corrupt every downstream comparison silently.
 */
function parseConfidenceValue(meta: Record<string, unknown>, path: string): number | null {
  const v = meta["confidence_value"];
  if (v === undefined || v === null || v === "" || v === "null") return null;
  let n: number | null = null;
  if (typeof v === "number") {
    n = v;
  } else if (typeof v === "string") {
    const trimmed = v.trim();
    // Whitespace-only string is the "null" sentinel in disguise.
    // `Number("")` coerces to `0`, which would otherwise smuggle in a
    // confident-zero band for a file the writer never produced a
    // value for.
    if (trimmed.length === 0 || trimmed === "null") return null;
    const candidate = Number(trimmed);
    if (Number.isFinite(candidate)) n = candidate;
  }
  if (n === null || !Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(
      `preference field 'confidence_value' must be a number in [0, 1]; got ${JSON.stringify(v)} (${path})`,
    );
  }
  return n;
}

/**
 * Coerce `pinned` to boolean with a hard default of `false`. Accepts
 * the literal string forms ("true"/"false") emitted by the simple
 * formatter and the native boolean if a richer parser ever lands.
 */
function parsePinned(meta: Record<string, unknown>): boolean {
  const v = meta["pinned"];
  if (v === undefined || v === null || v === "") return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v === "true") return true;
    if (v === "false") return false;
  }
  // Unexpected representations fall back to false; we treat this as a
  // forward-compat soft default rather than an error so a hand-edited
  // file with an oddly-quoted boolean still parses.
  return false;
}

// Internal use only: prevent "unused variable" lint after destructuring.
void join;
