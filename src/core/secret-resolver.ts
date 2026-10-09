/**
 * The named-secret resolver (trust-surface-hardening, t_e5807974).
 *
 * A `$secret:NAME` reference in a consumer's config resolves through the
 * vault's custody store ahead of the process environment. Resolution is
 * READ-ONLY: it composes `parseSecretReference` with the custody store's
 * read-only resolve export, so a config read never stamps
 * `last_used_at` and never appends an exec audit record - resolution
 * must not take the write path.
 *
 * Precedence is store first, env fallback - EXCEPT a name the store
 * holds under a locked envelope, which surfaces the named locked-store
 * error rather than silently answering from the environment (a silent
 * fallback would hide the locked state). A vault with no custody store
 * gains no state from resolution: the metadata read creates nothing.
 *
 * Resolution happens at use sites, not at config load, keeping
 * plaintext spread no wider than the exec path's one-variable
 * discipline. The probe re-reads store metadata per lookup
 * (correctness first); caching stays deferred until measured.
 */

import {
  parseSecretReference,
  resolveSecretReference,
  type SecretProvider,
  type SecretReferenceStatus,
} from "./secret-ref.ts";
import { listSecrets, resolveSecretReadOnly } from "./brain/secrets/store.ts";

/** The syntax prefix every named-secret reference starts with. */
const REFERENCE_PREFIX = "$secret:";

/**
 * Whether a config value claims to be a reference. `$secret:` with a
 * malformed body is still reference-shaped - it resolves to a
 * `SecretReferenceError`, never to the literal text.
 */
export function isSecretReferenceValue(value: unknown): boolean {
  return typeof value === "string" && value.trimStart().startsWith(REFERENCE_PREFIX);
}

/**
 * The store's answer for one name, or undefined when the store does not
 * hold it. A store-held name always answers from the store - even when
 * the environment carries the same name - and decryption under a locked
 * envelope surfaces the store's named locked error.
 */
function storeValue(vault: string, name: string): string | undefined {
  const held = listSecrets(vault).some((meta) => meta.name === name);
  if (!held) return undefined;
  return resolveSecretReadOnly(vault, name).value;
}

/**
 * The merged provider: custody store ahead of the process environment.
 * Probing is on demand - a name the store does not hold costs one
 * metadata read and never decrypts; the store's plaintext is handed to
 * the caller exactly where the value is used.
 */
export function secretProvider(vault: string): SecretProvider {
  const env = process.env;
  return new Proxy(env as SecretProvider, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return storeValue(vault, prop) ?? env[prop];
    },
    has(_target, prop) {
      if (typeof prop !== "string") return Reflect.has(env, prop);
      return storeValue(vault, prop) !== undefined || Reflect.has(env, prop);
    },
  });
}

/**
 * Resolve one config value for the vault. A plain value passes through
 * untouched; a reference resolves store-first with env fallback, and a
 * reference that resolves nowhere keeps the existing
 * `SecretReferenceError` behavior.
 */
export function resolveNamedSecret(vault: string, value: string): string {
  if (!isSecretReferenceValue(value)) return value;
  return resolveSecretReference(value.trim(), secretProvider(vault));
}

/**
 * Probe one config key through the merged provider. A reference-shaped
 * key resolves as a reference; any other key is a store-held name ahead
 * of `env`. This is the seam the registry's env probing expands through.
 */
export function resolveMergedValue(
  vault: string,
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  if (isSecretReferenceValue(key)) return resolveNamedSecret(vault, key.trim());
  return storeValue(vault, key) ?? env[key];
}

/**
 * Whether one named secret is usable by this process: the store holds
 * the name (metadata only - a locked envelope still counts, no
 * decrypt), or the environment carries it. Backs `o2b secrets status`.
 */
export function namedSecretAvailable(vault: string, name: string): boolean {
  return listSecrets(vault).some((meta) => meta.name === name) || Boolean(process.env[name]);
}

/**
 * Metadata-only availability for a config object's references: the
 * store's name set joined with the environment, never a decrypt. The
 * same `SecretReferenceStatus` rows `listSecretReferences` reports, so
 * `o2b secrets list` keeps its output shape with the store joined in.
 */
export function listNamedSecretAvailability(
  vault: string,
  data: Readonly<Record<string, unknown>>,
): ReadonlyArray<SecretReferenceStatus> {
  const held = new Set(listSecrets(vault).map((meta) => meta.name));
  const out: SecretReferenceStatus[] = [];
  for (const [configKey, value] of Object.entries(data)) {
    const ref = parseSecretReference(value);
    if (!ref) continue;
    out.push({
      configKey,
      name: ref.name,
      available: held.has(ref.name) || Boolean(process.env[ref.name]),
    });
  }
  out.sort((a, b) => a.configKey.localeCompare(b.configKey));
  return Object.freeze(out);
}
