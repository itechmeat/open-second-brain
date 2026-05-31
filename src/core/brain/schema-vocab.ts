import { BRAIN_LOG_EVENT_KIND } from "./types.ts";

export const SCHEMA_VOCAB_CATEGORIES = Object.freeze([
  "preference_types",
  "signal_types",
  "page_types",
  "log_event_kinds",
] as const);

export type SchemaVocabularyCategory = (typeof SCHEMA_VOCAB_CATEGORIES)[number];

export interface BrainSchemaDeclarations {
  readonly preference_types?: ReadonlyArray<string>;
  readonly signal_types?: ReadonlyArray<string>;
  readonly page_types?: ReadonlyArray<string>;
  readonly log_event_kinds?: ReadonlyArray<string>;
}

export interface BrainSchemaVocabulary {
  readonly preference_types: ReadonlyArray<string>;
  readonly signal_types: ReadonlyArray<string>;
  readonly page_types: ReadonlyArray<string>;
  readonly log_event_kinds: ReadonlyArray<string>;
}

export class SchemaVocabularyError extends Error {
  readonly field: string;
  readonly token: unknown;

  constructor(field: string, token: unknown, message: string) {
    super(`${field}: ${message}`);
    this.name = "SchemaVocabularyError";
    this.field = field;
    this.token = token;
  }
}

const TOKEN_RE = /^[\p{L}][\p{L}\p{N}_-]*$/u;

export const DEFAULT_SCHEMA_VOCAB: BrainSchemaVocabulary = Object.freeze({
  preference_types: Object.freeze(["preference"]),
  signal_types: Object.freeze(["feedback"]),
  page_types: Object.freeze(["note"]),
  log_event_kinds: Object.freeze(Object.values(BRAIN_LOG_EVENT_KIND)),
});

export function normalizeSchemaToken(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase();
}

export function validateSchemaDeclarations(
  declarations: BrainSchemaDeclarations | undefined | null,
): BrainSchemaDeclarations {
  if (declarations == null) return Object.freeze({});

  const normalized: Partial<Record<SchemaVocabularyCategory, ReadonlyArray<string>>> = {};
  for (const category of SCHEMA_VOCAB_CATEGORIES) {
    const values = declarations[category];
    if (values === undefined) continue;
    if (!Array.isArray(values)) {
      throw new SchemaVocabularyError(`schema.${category}`, values, "must be an array of tokens");
    }
    normalized[category] = Object.freeze(
      values.map((value, index) => validateSchemaToken(value, `schema.${category}[${index}]`)),
    );
  }

  return Object.freeze(normalized) as BrainSchemaDeclarations;
}

export function resolveSchemaVocabulary(
  declarations: BrainSchemaDeclarations | undefined | null = undefined,
): BrainSchemaVocabulary {
  const normalized = validateSchemaDeclarations(declarations);

  return Object.freeze({
    preference_types: mergeCategory(
      DEFAULT_SCHEMA_VOCAB.preference_types,
      normalized.preference_types,
    ),
    signal_types: mergeCategory(DEFAULT_SCHEMA_VOCAB.signal_types, normalized.signal_types),
    page_types: mergeCategory(DEFAULT_SCHEMA_VOCAB.page_types, normalized.page_types),
    log_event_kinds: mergeCategory(
      DEFAULT_SCHEMA_VOCAB.log_event_kinds,
      normalized.log_event_kinds,
    ),
  });
}

export function isKnownSchemaToken(
  vocab: BrainSchemaVocabulary,
  category: SchemaVocabularyCategory,
  token: string,
): boolean {
  const normalized = normalizeSchemaToken(token);
  return vocab[category].includes(normalized);
}

function mergeCategory(
  builtins: ReadonlyArray<string>,
  declared: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const token of [...builtins, ...(declared ?? [])]) {
    const normalized = normalizeSchemaToken(token);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(normalized);
  }
  return Object.freeze(merged);
}

export function validateSchemaToken(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new SchemaVocabularyError(field, value, "must be a string token");
  }
  const normalized = normalizeSchemaToken(value);
  if (!TOKEN_RE.test(normalized)) {
    throw new SchemaVocabularyError(
      field,
      value,
      "must start with a letter and contain only letters, numbers, underscores, or hyphens",
    );
  }
  return normalized;
}
