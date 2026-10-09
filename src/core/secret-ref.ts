export interface SecretReference {
  readonly raw: string;
  readonly name: string;
}

export interface SecretReferenceStatus {
  readonly configKey: string;
  readonly name: string;
  readonly available: boolean;
  /**
   * Present (true) only on a value that is reference-SHAPED but fails the
   * reference grammar - `$secret:tg-token` with a dashed name the grammar
   * cannot spell. Such a value resolves to a `SecretReferenceError` at
   * use time no matter what the store or the environment holds, so the
   * inspection surfaces must show it rather than silently drop it.
   * Optional so well-formed rows keep their exact shape.
   */
  readonly invalid?: boolean;
}

export type SecretProvider = Readonly<Record<string, string | undefined>>;

export class SecretReferenceError extends Error {
  readonly nameValue: string;

  constructor(message: string, nameValue: string) {
    super(message);
    this.name = "SecretReferenceError";
    this.nameValue = nameValue;
  }
}

const SECRET_REFERENCE_RE = /^\$secret:([A-Za-z_][A-Za-z0-9_]*)$/;
/** The syntax prefix every named-secret reference starts with. */
const REFERENCE_PREFIX = "$secret:";
const REDACTED = "***REDACTED***";

export function parseSecretReference(value: unknown): SecretReference | null {
  if (typeof value !== "string") return null;
  const match = SECRET_REFERENCE_RE.exec(value.trim());
  if (!match) return null;
  return Object.freeze({ raw: value.trim(), name: match[1]! });
}

/**
 * Whether a config value claims to be a reference. `$secret:` with a
 * malformed body is still reference-shaped - it resolves to a
 * `SecretReferenceError`, never to the literal text.
 */
export function isSecretReferenceValue(value: unknown): boolean {
  return typeof value === "string" && value.trimStart().startsWith(REFERENCE_PREFIX);
}

/**
 * The reference body of a reference-SHAPED value the grammar cannot spell
 * (e.g. the dashed `tg-token` in `$secret:tg-token`), or null when the
 * value is not reference-shaped at all. This is the name the runtime
 * refusal names, so the inspection surfaces can show the same identifier
 * the operator must fix (rename the store entry, or change the config
 * value to a spellable reference).
 */
export function invalidSecretReferenceBody(value: unknown): string | null {
  if (!isSecretReferenceValue(value)) return null;
  const body = (value as string).trim().slice(REFERENCE_PREFIX.length);
  return body.length > 0 ? body : null;
}

export function resolveSecretReference(
  value: string,
  provider: SecretProvider = process.env,
): string {
  const ref = parseSecretReference(value);
  if (!ref) {
    throw new SecretReferenceError(`invalid secret reference: ${value}`, value);
  }
  const resolved = provider[ref.name];
  if (!resolved) {
    throw new SecretReferenceError(`missing secret provider value: ${ref.name}`, ref.name);
  }
  return resolved;
}

export function listSecretReferences(
  data: Readonly<Record<string, unknown>>,
  provider: SecretProvider = process.env,
): ReadonlyArray<SecretReferenceStatus> {
  const out: SecretReferenceStatus[] = [];
  for (const [configKey, value] of Object.entries(data)) {
    const ref = parseSecretReference(value);
    if (!ref) {
      const body = invalidSecretReferenceBody(value);
      if (body !== null) {
        out.push({ configKey, name: body, available: false, invalid: true });
      }
      continue;
    }
    out.push({
      configKey,
      name: ref.name,
      available: Boolean(provider[ref.name]),
    });
  }
  out.sort((a, b) => a.configKey.localeCompare(b.configKey));
  return Object.freeze(out);
}

/**
 * Dedupe, drop empties, and order longest-first. The order is the
 * substitution-safety rule, not cosmetics: when one resolved value
 * contains another, a shorter-first replacement would destroy the longer
 * value's match and leak its head as a fragment, so every caller that
 * substitutes literal values into text goes through this.
 */
export function sortedDistinctLiterals(values: Iterable<string>): string[] {
  return [...new Set(values)]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length);
}

export function redactKnownSecretValues(
  text: string,
  references: ReadonlyArray<string>,
  provider: SecretProvider = process.env,
): string {
  let out = text;
  const values = sortedDistinctLiterals(
    references
      .map((raw) => parseSecretReference(raw))
      .filter((ref): ref is SecretReference => ref !== null)
      .map((ref) => provider[ref.name])
      .filter((value): value is string => Boolean(value)),
  );
  for (const value of values) {
    out = out.replaceAll(value, REDACTED);
  }
  return out;
}
