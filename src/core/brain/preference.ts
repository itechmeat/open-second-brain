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

import { existsSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { FrontmatterMap } from "../types.ts";
import { writeFrontmatterAtomic, parseFrontmatter } from "../vault.ts";
import {
  brainDirs,
  preferencePath,
  retiredPath,
  validateSlug,
} from "./paths.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
  type BrainConfidence,
  type BrainPreference,
  type BrainPreferenceStatus,
  type BrainRetired,
  type BrainRetiredReason,
} from "./types.ts";

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

  constructor(
    message: string,
    path: string,
    status: string,
    folder: "preferences" | "retired",
  ) {
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
  readonly applied_count?: number;
  readonly violated_count?: number;
  readonly last_evidence_at?: string | null;
  readonly confidence?: BrainConfidence;
  readonly pinned?: boolean;
  readonly supersedes?: string;
  readonly aliases?: ReadonlyArray<string>;
  /** Optional extra tags merged after the canonical set. */
  readonly extraTags?: ReadonlyArray<string>;
  /** Free-form "How to apply" prose (rendered as a section). */
  readonly howToApply?: string;
}

export interface WritePreferenceOptions {
  /** When true, overwrite an existing file at the target path. */
  readonly overwrite?: boolean;
}

export interface WritePreferenceResult {
  readonly path: string;
  readonly id: string;
}

export interface MoveToRetiredOptions {
  readonly now: Date;
  readonly retired_by: string;
  readonly superseded_by?: string;
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
    input.status !== BRAIN_PREFERENCE_STATUS.confirmed
  ) {
    throw new Error(
      `preference field 'status' must be 'unconfirmed' or 'confirmed'; got ${JSON.stringify(input.status)}`,
    );
  }

  const slug = validateSlug(input.slug);
  const path = preferencePath(vault, slug);
  const id = `pref-${slug}`;

  const metadata = preferenceFrontmatter(input, id);
  const body = renderPreferenceBody(input);

  writeFrontmatterAtomic(path, metadata, body, {
    overwrite: options.overwrite ?? false,
    existsErrorKind: "preference",
    vaultForRelativePath: vault,
  });

  return { path, id };
}

function preferenceFrontmatter(
  input: WritePreferenceInput,
  id: string,
): FrontmatterMap {
  const tags = composePreferenceTags(input);
  const confidence = input.confidence ?? BRAIN_CONFIDENCE.low;
  const pinned = input.pinned ?? false;
  const applied = input.applied_count ?? 0;
  const violated = input.violated_count ?? 0;

  const metadata: FrontmatterMap = {
    kind: "brain-preference",
    id,
    created_at: input.created_at,
    // Use a textual sentinel for `null` so the simple parser surfaces
    // an empty string and the loader coerces back to `null`. We store
    // the literal text "null" rather than an empty value to keep the
    // emitted YAML one-token per line and the field always present.
    confirmed_at: input.confirmed_at ?? "null",
    unconfirmed_until: input.unconfirmed_until,
    tags: [...tags],
    topic: input.topic.trim(),
    status: input.status,
    principle: input.principle.trim(),
    evidenced_by: [...input.evidenced_by],
    applied_count: applied,
    violated_count: violated,
    last_evidence_at: input.last_evidence_at ?? "null",
    confidence,
    pinned,
  };
  if (input.scope?.trim()) metadata["scope"] = input.scope.trim();
  if (input.supersedes?.trim()) metadata["supersedes"] = input.supersedes.trim();
  if (input.aliases && input.aliases.length > 0) {
    metadata["aliases"] = [...input.aliases];
  }
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

function renderPreferenceBody(input: WritePreferenceInput): string {
  const lines: string[] = [];
  lines.push("## Principle", "", input.principle.trim(), "");
  lines.push("## Origin", "");
  if (input.evidenced_by.length > 0) {
    for (const ev of input.evidenced_by) lines.push(`- ${ev}`);
  } else {
    lines.push("_(no evidence yet)_");
  }
  lines.push("");
  lines.push("## How to apply", "");
  const guidance = input.howToApply?.trim();
  if (guidance) {
    lines.push(guidance.replace(/\r\n?/g, "\n").replace(/\s+$/g, ""));
  } else {
    lines.push("_(not provided)_");
  }
  return lines.join("\n");
}

// ----- Parsers --------------------------------------------------------------

/**
 * Parse a preference file. Defaults `pinned` to `false` when the field
 * is absent (§5.3). Throws {@link BrainStatusFolderMismatchError} when
 * the file lives in `preferences/` but its `status` reads `retired`
 * (or any other state outside `unconfirmed` / `confirmed`).
 */
export function parsePreference(path: string): BrainPreference {
  const [meta, _body] = parseFrontmatter(path);
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
    pinned: parsePinned(meta),
    ...(optionalScalarString(meta, "scope") !== undefined
      ? { scope: optionalScalarString(meta, "scope") }
      : {}),
    ...(optionalScalarString(meta, "supersedes") !== undefined
      ? { supersedes: optionalScalarString(meta, "supersedes") }
      : {}),
    ...(meta["aliases"] !== undefined && Array.isArray(meta["aliases"])
      ? { aliases: [...(meta["aliases"] as ReadonlyArray<string>)] }
      : {}),
  };
  return Object.freeze(result);
}

/**
 * Parse a retired-preference file. Mirrors {@link parsePreference} but
 * enforces the `retired/` folder invariant and validates the
 * `retired_reason` enum.
 */
export function parseRetired(path: string): BrainRetired {
  const [meta] = parseFrontmatter(path);

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
    throw new Error(
      `moveToRetired: source path was not under preferences/: ${prefPath}`,
    );
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
  const newMeta: FrontmatterMap = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === "kind" || k === "id" || k === "status") continue;
    if (k === "unconfirmed_until" || k === "confirmed_at") continue;
    if (k === "tags") {
      // Replace the `brain/preference` tag with `brain/retired`.
      const arr = Array.isArray(v) ? [...v] : [];
      newMeta["tags"] = arr.map((t) =>
        t === "brain/preference" ? "brain/retired" : t,
      );
      continue;
    }
    newMeta[k] = v as never;
  }
  newMeta["kind"] = "brain-retired";
  newMeta["id"] = newId;
  newMeta["status"] = "retired";
  newMeta["retired_at"] = opts.now.toISOString();
  newMeta["retired_reason"] = reason;
  newMeta["retired_by"] = opts.retired_by;
  if (opts.superseded_by?.trim()) {
    newMeta["superseded_by"] = opts.superseded_by.trim();
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

  const newBody = appendRetiredSection(body, reason, opts);

  writeFrontmatterAtomic(newPath, newMeta, newBody, {
    overwrite: false,
    existsErrorKind: "retired",
    vaultForRelativePath: vault,
  });

  // Confirm the new file actually landed before unlinking the source.
  if (!existsSync(newPath)) {
    throw new Error(
      `moveToRetired: write of ${newPath} reported success but file is absent`,
    );
  }
  unlinkSync(prefPath);

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
    if (parent === "preferences" && status !== BRAIN_PREFERENCE_STATUS.unconfirmed && status !== BRAIN_PREFERENCE_STATUS.confirmed) {
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

function requireField(
  meta: Record<string, unknown>,
  field: string,
  path: string,
): void {
  if (!(field in meta) || meta[field] === undefined || meta[field] === null) {
    throw new Error(`preference missing field: ${field} (${path})`);
  }
  if (typeof meta[field] === "string" && (meta[field] as string).trim() === "") {
    throw new Error(`preference missing field: ${field} (${path})`);
  }
}

function requireString(
  meta: Record<string, unknown>,
  field: string,
  path: string,
): string {
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
      throw new Error(
        `preference field '${field}' must be an array of strings (${path})`,
      );
    }
  }
  return [...(v as ReadonlyArray<string>)];
}

function optionalStringArray(
  meta: Record<string, unknown>,
  field: string,
): ReadonlyArray<string> {
  const v = meta[field];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new Error(`preference field '${field}' must be an array`);
  }
  for (const item of v) {
    if (typeof item !== "string") {
      throw new Error(
        `preference field '${field}' must be an array of strings`,
      );
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
function optionalNullableString(
  meta: Record<string, unknown>,
  field: string,
): string | null {
  const v = meta[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") {
    throw new Error(`preference field '${field}' must be a string or null`);
  }
  const trimmed = v.trim();
  if (trimmed === "" || trimmed === "null") return null;
  return v;
}

function optionalNumber(
  meta: Record<string, unknown>,
  field: string,
  fallback: number,
): number {
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

function optionalScalarString(
  meta: Record<string, unknown>,
  field: string,
): string | undefined {
  const v = meta[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : v;
}

function parseConfidence(
  meta: Record<string, unknown>,
  path: string,
): BrainConfidence {
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
