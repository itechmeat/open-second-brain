export interface SecretReference {
  readonly raw: string;
  readonly name: string;
}

export interface SecretReferenceStatus {
  readonly configKey: string;
  readonly name: string;
  readonly available: boolean;
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
const REDACTED = "***REDACTED***";

export function parseSecretReference(value: unknown): SecretReference | null {
  if (typeof value !== "string") return null;
  const match = SECRET_REFERENCE_RE.exec(value.trim());
  if (!match) return null;
  return Object.freeze({ raw: value.trim(), name: match[1]! });
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
    if (!ref) continue;
    out.push({
      configKey,
      name: ref.name,
      available: Boolean(provider[ref.name]),
    });
  }
  out.sort((a, b) => a.configKey.localeCompare(b.configKey));
  return Object.freeze(out);
}

export function redactKnownSecretValues(
  text: string,
  references: ReadonlyArray<string>,
  provider: SecretProvider = process.env,
): string {
  let out = text;
  const values = Array.from(
    new Set(
      references
        .map((raw) => parseSecretReference(raw))
        .filter((ref): ref is SecretReference => ref !== null)
        .map((ref) => provider[ref.name])
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort((a, b) => b.length - a.length);
  for (const value of values) {
    out = out.replaceAll(value, REDACTED);
  }
  return out;
}
