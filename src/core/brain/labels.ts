/**
 * Controlled-vocabulary labels (write-time-integrity-governance).
 *
 * The schema pack declares label dimensions with a fixed enum of
 * allowed values (`schema.labels`); this module is the write-time
 * enforcement seam. Assignment is fail-closed - an unknown dimension
 * or value is rejected with the declared vocabulary in the error -
 * and classification is single-choice: one value per dimension per
 * note. Labels persist as a sorted `labels: [dim/value]` frontmatter
 * array (filterable through the existing `--property` post-rank
 * filter) plus a canonical `label` entity in the registry so related
 * notes cluster without free-form tag drift.
 *
 * Both writes take a caller-named path and resolve it through
 * `resolveNotePath`, which guarantees containment and nothing about which
 * file is being rewritten. One file needs more than that:
 * `Brain/standing-rules.md` is the operator's own text, and
 * `assertStandingRulesNotTargeted` refuses it by name here because the
 * Brain-root refusal that covers the note-write tools is not on this path.
 */

import { parseFrontmatter, writeFrontmatterAtomic } from "../vault.ts";
import { resolveNotePath } from "./note-path.ts";
import { assertStandingRulesNotTargeted } from "./standing-rules.ts";
import { normalizeSchemaToken } from "./schema-vocab.ts";
import { upsertEntity } from "./entities/registry.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import type { SchemaPack } from "./schema-pack.ts";

export const LABEL_ENTITY_CATEGORY = "label";

/**
 * How the two label writes name themselves in a refusal. Named constants
 * rather than inline strings because the words appear in an operator- and
 * agent-facing error and must not drift between the two paths.
 */
const LABEL_ASSIGN_SURFACE = "label assignment";
const LABEL_REMOVE_SURFACE = "label removal";

export class LabelVocabularyError extends Error {
  readonly dimension: string;
  readonly allowed: ReadonlyArray<string>;

  constructor(dimension: string, allowed: ReadonlyArray<string>, message: string) {
    super(message);
    this.name = "LabelVocabularyError";
    this.dimension = dimension;
    this.allowed = allowed;
  }
}

export interface LabelAssignment {
  readonly dimension: string;
  readonly value: string;
  /** Canonical `dimension/value` form stored in frontmatter. */
  readonly token: string;
}

export interface AssignNoteLabelOptions {
  readonly dimension: string;
  readonly value: string;
  readonly pack: SchemaPack;
  /** Agent identity stamped on the canonical label entity. */
  readonly agent: string;
  /** Injected clock for deterministic registry stamps. */
  readonly now: Date;
}

export interface RemoveNoteLabelOptions {
  readonly dimension: string;
  readonly pack: SchemaPack;
}

export interface NoteLabelResult {
  /** Vault-relative path of the labelled note. */
  readonly path: string;
  /** The note's full label set after the operation, sorted. */
  readonly labels: ReadonlyArray<string>;
  /** Whether the file content changed. */
  readonly changed: boolean;
}

export interface RemoveNoteLabelResult extends NoteLabelResult {
  /** Whether the dimension was present before removal. */
  readonly removed: boolean;
}

/** Render the canonical `dimension/value` label form. */
export function labelToken(dimension: string, value: string): string {
  return `${dimension}/${value}`;
}

/**
 * Validate one assignment against the declared vocabulary.
 * Fail-closed: unknown dimensions and values throw with the declared
 * alternatives listed, so a caller (or its operator) can self-correct.
 */
export function validateLabelAssignment(
  pack: SchemaPack,
  dimension: string,
  value: string,
): LabelAssignment {
  const dimensions = Object.keys(pack.labels);
  if (dimensions.length === 0) {
    throw new LabelVocabularyError(
      normalizeSchemaToken(dimension),
      [],
      "no label dimensions are declared in the schema pack",
    );
  }
  const normalizedDimension = normalizeSchemaToken(dimension);
  const allowed = pack.labels[normalizedDimension];
  if (allowed === undefined) {
    throw new LabelVocabularyError(
      normalizedDimension,
      dimensions,
      `unknown label dimension "${normalizedDimension}" - declared dimensions: ${dimensions.join(", ")}`,
    );
  }
  const normalizedValue = normalizeSchemaToken(value);
  if (!allowed.includes(normalizedValue)) {
    throw new LabelVocabularyError(
      normalizedDimension,
      allowed,
      `label ${normalizedDimension}="${normalizedValue}" is not in the vocabulary - allowed values: ${allowed.join(", ")}`,
    );
  }
  return {
    dimension: normalizedDimension,
    value: normalizedValue,
    token: labelToken(normalizedDimension, normalizedValue),
  };
}

/**
 * Assign one label to a note: validates against the pack, replaces
 * any existing value of the same dimension (single-choice), writes a
 * sorted `labels` frontmatter array atomically, and registers the
 * canonical `label` entity. Validation runs before any I/O so an
 * invalid assignment never touches the file.
 */
export function assignNoteLabel(
  vault: string,
  relPath: string,
  opts: AssignNoteLabelOptions,
): NoteLabelResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  // The operator's standing rules are refused by NAME here. This surface
  // takes a caller-named path and reaches the file through
  // `resolveNotePath`, which enforces containment and symlinks and nothing
  // about which file is being written, so the Brain-root refusal that
  // protects the note-write tools does not reach it. Placed before the
  // vocabulary check so the refusal is about the target rather than about
  // whichever dimension the caller happened to invent.
  assertStandingRulesNotTargeted(vault, relPath, LABEL_ASSIGN_SURFACE);
  const assignment = validateLabelAssignment(opts.pack, opts.dimension, opts.value);
  const path = resolveNotePath(vault, relPath);
  const [metadata, body] = parseFrontmatter(path);
  const existing = readLabels(metadata);
  const kept = existing.filter((token) => !token.startsWith(`${assignment.dimension}/`));
  const next = [...kept, assignment.token].toSorted((a, b) => a.localeCompare(b));
  const changed = !sameLabels(existing, next);
  if (changed) {
    const nextMetadata = { ...metadata, labels: next };
    writeFrontmatterAtomic(path, nextMetadata, body, { overwrite: true });
  }
  upsertEntity(vault, {
    category: LABEL_ENTITY_CATEGORY,
    name: assignment.token,
    agent: opts.agent,
    now: opts.now,
  });
  return { path: relPath, labels: next, changed };
}

/**
 * Remove a dimension's label from a note. The canonical label entity
 * stays in the registry - other notes may still carry the label, and
 * an orphaned label entity is harmless vocabulary, not corruption.
 */
export function removeNoteLabel(
  vault: string,
  relPath: string,
  opts: RemoveNoteLabelOptions,
): RemoveNoteLabelResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  // Removal rewrites the same frontmatter with the same overwrite, so it
  // is the same write and takes the same refusal.
  assertStandingRulesNotTargeted(vault, relPath, LABEL_REMOVE_SURFACE);
  const dimension = normalizeSchemaToken(opts.dimension);
  const path = resolveNotePath(vault, relPath);
  const [metadata, body] = parseFrontmatter(path);
  const existing = readLabels(metadata);
  const next = existing.filter((token) => !token.startsWith(`${dimension}/`));
  const removed = next.length !== existing.length;
  if (removed) {
    const nextMetadata = { ...metadata };
    if (next.length > 0) nextMetadata["labels"] = next;
    else delete nextMetadata["labels"];
    writeFrontmatterAtomic(path, nextMetadata, body, { overwrite: true });
  }
  return { path: relPath, labels: next, changed: removed, removed };
}

/** Read the validated string entries of a note's `labels` array. */
export function readLabels(metadata: Record<string, unknown>): string[] {
  const raw = metadata["labels"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
}

function sameLabels(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}
