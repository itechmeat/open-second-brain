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

import { existsSync } from "node:fs";

import { installNamedSecretResolver } from "./config.ts";
import {
  isSecretReferenceValue,
  parseSecretReference,
  resolveSecretReference,
  type SecretProvider,
  type SecretReferenceStatus,
  invalidSecretReferenceBody,
} from "./secret-ref.ts";

/**
 * The `$secret:` syntax check lives in the leaf `secret-ref.ts` beside the
 * rest of the reference grammar; re-exported here so this module's
 * consumers keep one import path.
 */
export { isSecretReferenceValue } from "./secret-ref.ts";

/**
 * The custody store, joined at CALL time rather than at module load.
 *
 * The store's own import neighbourhood reaches back into `config.ts`
 * (store → audit → ledger-shards → config), and `config.ts` resolves
 * credentials through THIS module, so a static import here closed the
 * six-module cycle whose initialisation order is undefined - it aborted
 * `audit.ts` at module scope with a TDZ error whenever the shard-grammar
 * module was entered first. The lazy require is the sanctioned cure (see
 * `tests/core/architecture/import-cycles.test.ts`); the store is needed
 * only when a reference or a probe actually resolves, and `require`
 * caches the module after the first call.
 */
type CustodyStore = typeof import("./brain/secrets/store.ts");

let custodyStoreModule: CustodyStore | undefined;

function custodyStore(): CustodyStore {
  if (custodyStoreModule === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    custodyStoreModule = require("./brain/secrets/store.ts") as CustodyStore;
  }
  return custodyStoreModule;
}

/**
 * The store leg of the merged provider: one name's custody answer, or
 * undefined when the store does not hold it (the caller falls back to the
 * environment). Probing is on demand - a name the store does not hold costs
 * one metadata read and never decrypts; the store's plaintext is handed to
 * the caller exactly where the value is used. A name the store holds under
 * a locked envelope raises the named locked-store refusal, never a silent
 * env fallback.
 */
function storeValue(vault: string, name: string): string | undefined {
  const held = custodyStore()
    .listSecrets(vault)
    .some((meta) => meta.name === name);
  if (!held) return undefined;
  return custodyStore().resolveSecretReadOnly(vault, name).value;
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
  return (
    custodyStore()
      .listSecrets(vault)
      .some((meta) => meta.name === name) || Boolean(process.env[name])
  );
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
  const held = new Set(
    custodyStore()
      .listSecrets(vault)
      .map((meta) => meta.name),
  );
  const out: SecretReferenceStatus[] = [];
  for (const [configKey, value] of Object.entries(data)) {
    const ref = parseSecretReference(value);
    if (!ref) {
      // A reference-SHAPED value the grammar cannot spell (a dashed store
      // name, say) resolves to a `SecretReferenceError` at use time and
      // can never be answered by the store or the env - report it instead
      // of silently dropping it while `secrets status` answers the same
      // name from metadata alone.
      const body = invalidSecretReferenceBody(value);
      if (body !== null) {
        out.push({ configKey, name: body, available: false, invalid: true });
      }
      continue;
    }
    out.push({
      configKey,
      name: ref.name,
      available: held.has(ref.name) || Boolean(process.env[ref.name]),
    });
  }
  out.sort((a, b) => a.configKey.localeCompare(b.configKey));
  return Object.freeze(out);
}

/**
 * The VALUES the vault's custody store can currently answer with - the
 * input the egress boundaries need to scrub resolved credentials (the
 * `resolvedLiterals` option on `EgressPolicy` and the MCP error
 * redactor's fourth parameter). This is the one production join between
 * the store and the redactor plane; without it the literal passes were
 * plumbed but never fed, and a resolved credential under a quiet key
 * name stayed as invisible to the boundary as before the wave.
 *
 * Wired boundaries, and only these: the MCP error redaction (both the
 * tools/call catch and the one builder every JSON-RPC error answer
 * passes through), the config-mapping status surfaces, and the
 * decision-model adapters that hold the key they are about to send. A
 * boundary that cannot know the vault (the CLI export verbs run
 * vault-scoped already but scan vault-authored content the structural
 * passes cover) must not pretend - the absent option stays byte-
 * identical there, and this docblock is where the next wiring decision
 * starts.
 *
 * Degradation is the point: a store that is absent, empty, unreadable,
 * LOCKED (the named locked refusal), or missing its keyfile contributes
 * NOTHING - the boundary then answers exactly as the pre-literal
 * redactor did. Redaction never blocks, never surfaces a refusal, and
 * never mints: a lost keyfile is skipped rather than regenerated, so a
 * scan leaves no custody state behind.
 */
export function resolvedSecretLiterals(vault: string): string[] {
  const store = custodyStore();
  let held: ReadonlyArray<{ readonly name: string }>;
  try {
    held = store.listSecrets(vault);
  } catch {
    // An unreadable store is not a redactable store: contribute nothing.
    return [];
  }
  if (held.length === 0) return [];
  if (!existsSync(store.keyPath(vault))) return [];
  const out: string[] = [];
  for (const meta of held) {
    try {
      out.push(store.resolveSecretReadOnly(vault, meta.name).value);
    } catch {
      // The locked envelope lands here (the named refusal), as does an
      // entry that cannot be decrypted; each contributes nothing.
    }
  }
  return out;
}

/**
 * Install THIS module as the adapter behind config's resolver port (see
 * {@link installNamedSecretResolver}). Config values carrying a
 * `$secret:` reference resolve through the custody store from here, and
 * the dependency points resolver -> config - the direction that keeps
 * the six-module cycle (config -> resolver -> custody store -> audit ->
 * ledger-shards -> config) cut. Every production entry (the CLI's
 * `main.ts`, the MCP server, the OpenClaw bridge) imports this module
 * statically at startup, which is what wires the port before any command
 * dispatch; a test exercising the reference branch of a config resolver
 * imports this module for the same side effect.
 */
installNamedSecretResolver({ resolveNamedSecret });
