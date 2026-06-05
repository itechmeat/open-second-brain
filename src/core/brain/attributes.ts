/**
 * Per-type attribute fields (write-time-integrity-governance).
 *
 * The schema pack's `attributes` field declares, per page type, a
 * small set of fields with natural-language descriptions. The
 * descriptions are agent guidance, not extraction magic: they render
 * in schema explain output so an agent capturing a typed page knows
 * the domain vocabulary, and validation is fail-closed - assigning an
 * undeclared field lists the declared fields WITH their descriptions
 * so the caller can self-correct. Values persist as a sorted
 * `attributes: [field=value]` frontmatter array, filterable through
 * the existing `--property` post-rank search filter. The regex fact
 * extractor is unchanged.
 */

import { parseFrontmatter, writeFrontmatterAtomic } from "../vault.ts";
import { resolveNotePath } from "./note-path.ts";
import { normalizeSchemaToken } from "./schema-vocab.ts";
import type { SchemaPack } from "./schema-pack.ts";

export class AttributeVocabularyError extends Error {
  readonly type: string;
  readonly declared: Readonly<Record<string, string>>;

  constructor(type: string, declared: Readonly<Record<string, string>>, message: string) {
    super(message);
    this.name = "AttributeVocabularyError";
    this.type = type;
    this.declared = declared;
  }
}

export interface AttributeAssignment {
  readonly type: string;
  readonly field: string;
  readonly value: string;
}

export interface AssignNoteAttributeOptions {
  readonly field: string;
  readonly value: string;
  readonly pack: SchemaPack;
}

export interface RemoveNoteAttributeOptions {
  readonly field: string;
}

export interface NoteAttributeResult {
  /** Vault-relative path of the note. */
  readonly path: string;
  /** The note's full `field=value` set after the operation, sorted. */
  readonly attributes: ReadonlyArray<string>;
  /** Whether the file content changed. */
  readonly changed: boolean;
}

export interface RemoveNoteAttributeResult extends NoteAttributeResult {
  /** Whether the field was present before removal. */
  readonly removed: boolean;
}

/**
 * Validate one assignment against the declared descriptors.
 * Fail-closed both ways: a type with no declared attributes names the
 * types that have them; an undeclared field lists the declared fields
 * with their descriptions - the descriptions ARE the guidance.
 */
export function validateAttributeAssignment(
  pack: SchemaPack,
  type: string,
  field: string,
  value: string,
): AttributeAssignment {
  const normalizedType = normalizeSchemaToken(type);
  const declared = pack.attributes[normalizedType];
  if (declared === undefined) {
    const types = Object.keys(pack.attributes);
    throw new AttributeVocabularyError(
      normalizedType,
      {},
      types.length === 0
        ? "no attribute fields are declared in the schema pack"
        : `type "${normalizedType}" declares no attributes - declared attribute types: ${types.join(", ")}`,
    );
  }
  const normalizedField = normalizeSchemaToken(field);
  if (declared[normalizedField] === undefined) {
    const fields = Object.entries(declared)
      .map(([name, description]) => `${name} (${description})`)
      .join(", ");
    throw new AttributeVocabularyError(
      normalizedType,
      declared,
      `attribute "${normalizedField}" is not declared for type "${normalizedType}" - declared fields: ${fields}`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new AttributeVocabularyError(
      normalizedType,
      declared,
      "attribute value must not be empty",
    );
  }
  if (/[\r\n]/.test(value)) {
    throw new AttributeVocabularyError(
      normalizedType,
      declared,
      "attribute value must be a single line",
    );
  }
  if (trimmed.includes(",")) {
    throw new AttributeVocabularyError(
      normalizedType,
      declared,
      "attribute value must not contain a comma (it breaks the inline frontmatter array)",
    );
  }
  return { type: normalizedType, field: normalizedField, value: trimmed };
}

/**
 * Assign one attribute to a typed note. The note's own frontmatter
 * `type` selects the descriptor set; validation runs before any write
 * so an invalid assignment never touches the file. One value per
 * field - reassignment replaces.
 */
export function assignNoteAttribute(
  vault: string,
  relPath: string,
  opts: AssignNoteAttributeOptions,
): NoteAttributeResult {
  const path = resolveNotePath(vault, relPath);
  const [metadata, body] = parseFrontmatter(path);
  const rawType = metadata["type"];
  if (typeof rawType !== "string" || normalizeSchemaToken(rawType).length === 0) {
    throw new Error(`note declares no type in frontmatter: ${relPath}`);
  }
  const assignment = validateAttributeAssignment(opts.pack, rawType, opts.field, opts.value);
  const existing = readAttributeEntries(metadata);
  const kept = existing.filter((entry) => !entry.startsWith(`${assignment.field}=`));
  const next = [...kept, `${assignment.field}=${assignment.value}`].toSorted((a, b) =>
    a.localeCompare(b),
  );
  const changed = !sameEntries(existing, next);
  if (changed) {
    writeFrontmatterAtomic(path, { ...metadata, attributes: next }, body, { overwrite: true });
  }
  return { path: relPath, attributes: next, changed };
}

/** Remove a field's attribute from a note. */
export function removeNoteAttribute(
  vault: string,
  relPath: string,
  opts: RemoveNoteAttributeOptions,
): RemoveNoteAttributeResult {
  const field = normalizeSchemaToken(opts.field);
  const path = resolveNotePath(vault, relPath);
  const [metadata, body] = parseFrontmatter(path);
  const existing = readAttributeEntries(metadata);
  const next = existing.filter((entry) => !entry.startsWith(`${field}=`));
  const removed = next.length !== existing.length;
  if (removed) {
    const nextMetadata = { ...metadata };
    if (next.length > 0) nextMetadata["attributes"] = next;
    else delete nextMetadata["attributes"];
    writeFrontmatterAtomic(path, nextMetadata, body, { overwrite: true });
  }
  return { path: relPath, attributes: next, changed: removed, removed };
}

/** Parse a note's `attributes` array into a `field -> value` record. */
export function readAttributes(metadata: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readAttributeEntries(metadata)) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

function readAttributeEntries(metadata: Record<string, unknown>): string[] {
  const raw = metadata["attributes"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
}

function sameEntries(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
