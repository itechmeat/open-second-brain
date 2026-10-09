/**
 * Passphrase-encrypted credential bundles (t_592d9e91).
 *
 * Export turns the store's entries into ONE schema-versioned envelope
 * each entry's value re-encrypted under a key the passphrase derives
 * through the keyfile envelope's KDF (`./envelope.ts` - same scrypt
 * cost curve, fresh salt, parameters recorded inside the bundle). Import
 * verifies, decrypts EVERY value before writing anything, reuses the
 * store's name, env-var AND allow-pattern validation (so a rewritten
 * bundle cannot land entries the store's own writer would refuse), and
 * lands the entries through the store's lock and writer with
 * `removeSecret`'s exactness on collisions.
 *
 * What the envelope carries in the clear, by design: the schema version,
 * the wall-clock stamp, the KDF parameters, and each entry's name,
 * env-var mapping and allowlist - the same metadata `list` exposes. What
 * it never carries in the clear: any value, and the passphrase. The
 * export path's egress declaration (`src/core/egress/registry.ts`) runs
 * the shared redactor over exactly this non-ciphertext metadata tree.
 *
 * Honest warning, as for the keyfile envelope: the bundle's secrecy is
 * the passphrase's strength against offline guessing wherever the file
 * travels. A lost passphrase makes the bundle unreadable; there is no
 * recovery path and none is pretended.
 */

import { join } from "node:path";

import { appendAuditRecord } from "../../reliability/audit.ts";
import { SECRET_CUSTODY_AUDIT_DIR } from "../audit-dirs.ts";
import { brainDirsForWrite } from "../paths.ts";
import { isoSecond } from "../time.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { decryptValue, encryptValue, loadOrCreateKey, type EncryptedValue } from "./crypto.ts";
import {
  deriveWrapKey,
  freshWrapKdfParams,
  kdfCostCurveRefusal,
  type EnvelopeKdfParams,
} from "./envelope.ts";
import {
  isValidSecretEnvVar,
  isValidSecretName,
  keyPath,
  normalizeAllowPatterns,
  readStore,
  SECRETS_SCHEMA_VERSION,
  type SecretAuditContext,
  withSecretsLock,
  writeStore,
} from "./store.ts";

/** Bundle schema version. Bumped only on an incompatible field change. */
export const SECRET_BUNDLE_SCHEMA_VERSION = 1;

/**
 * Closed refusal table for every named failure shape of the bundle.
 * Errors surface by code; nothing is assembled from prose at runtime.
 */
export const BUNDLE_REFUSAL_CODES = Object.freeze({
  /** The bundle's schema version is not one this build reads. */
  version: "secret_bundle_version_refused",
  /** The bundle names a KDF this build does not implement. */
  kdfAlgo: "secret_bundle_kdf_algo_refused",
  /** The stored KDF parameters exceed (or fall below) this build's cost curve. */
  kdfCost: "secret_bundle_kdf_params_refused",
  /** The passphrase did not decrypt the entries (wrong passphrase, corrupt). */
  passphrase: "secret_bundle_passphrase_refused",
  /** The file is bundle-shaped but does not parse as one. */
  malformed: "secret_bundle_malformed",
  /** An entry's name or env-var mapping fails the store's own validation. */
  entry: "secret_bundle_entry_refused",
  /** An entry collides with a name the target store already holds. */
  nameExists: "secret_bundle_name_exists",
} as const);

export type SecretBundleRefusalCode =
  (typeof BUNDLE_REFUSAL_CODES)[keyof typeof BUNDLE_REFUSAL_CODES];

/** A named bundle refusal: the stable `code` is the contract. */
export class SecretBundleError extends Error {
  readonly code: SecretBundleRefusalCode;

  constructor(code: SecretBundleRefusalCode, detail: string) {
    super(`secret bundle refused (${code}): ${detail}`);
    this.name = "SecretBundleError";
    this.code = code;
  }
}

/** One bundle entry: the metadata travels in the clear, the value sealed. */
export interface SecretBundleEntry {
  readonly env_var: string;
  readonly allow: ReadonlyArray<string>;
  readonly value: EncryptedValue;
}

/** The on-disk bundle envelope. */
export interface SecretBundleFile {
  readonly version: number;
  /** Wall clock of the export - deliberately OUTSIDE the sealed content. */
  readonly generated_at: string;
  readonly kdf: EnvelopeKdfParams;
  readonly entries: Record<string, SecretBundleEntry>;
}

/**
 * Export every stored entry as a bundle. Reads under the store's lock for
 * one consistent snapshot; decrypts in memory and re-encrypts each value
 * under the bundle's own derived key. A locked store refuses with the
 * named locked-store error - exporting needs the plaintext values, and a
 * bundle that skipped decryption would be a lie.
 */
export function exportSecretBundle(
  vault: string,
  passphrase: string,
  ctx: SecretAuditContext,
): SecretBundleFile {
  assertVaultIdentityForWrite(vault);
  const bundle = withSecretsLock(vault, () => {
    if (passphrase.length === 0) {
      throw new SecretBundleError(
        BUNDLE_REFUSAL_CODES.passphrase,
        "an export passphrase must not be empty",
      );
    }
    const key = loadOrCreateKey(keyPath(vault));
    const file = readStore(vault);
    const kdf = freshWrapKdfParams();
    const derived = deriveWrapKey(passphrase, kdf);
    const entries: Record<string, SecretBundleEntry> = {};
    for (const name of Object.keys(file.secrets).toSorted()) {
      const stored = file.secrets[name]!;
      entries[name] = {
        env_var: stored.env_var,
        allow: [...stored.allow],
        value: encryptValue(derived, decryptValue(key, stored)),
      };
    }
    return {
      version: SECRET_BUNDLE_SCHEMA_VERSION,
      generated_at: isoSecond(ctx.now),
      kdf,
      entries,
    };
  });
  auditBundle(vault, ctx, "secret_bundle_exported", {
    exported: Object.keys(bundle.entries).toSorted(),
  });
  return bundle;
}

/**
 * The metadata tree the egress guard scans, shaped so the scan can only
 * help and never corrupt:
 *
 * - The KDF block is EXCLUDED. Its random salt is exactly the high-
 *   entropy run the bare-token pass exists to catch, so scanning it
 *   would flag every export forever over config that carries no vault
 *   content. The parameters travel in the file regardless.
 * - Entries are an ARRAY of objects, not a name-keyed map. A name like
 *   `api-key` as a mapping KEY is the redactor's credential-assignment
 *   shape (`api_key: ...`) and would replace the whole entry; as a
 *   string leaf it is judged as text instead.
 * - The free-text fields (allow patterns) scan in full - that is the
 *   value the guard adds here.
 *
 * Names and env-var mappings are IDENTIFIERS: {@link bundleFromEgressScan}
 * refuses rather than merges if the guard rewrote one.
 */
export function bundleEgressScanTree(bundle: SecretBundleFile): Record<string, unknown> {
  return {
    version: bundle.version,
    generated_at: bundle.generated_at,
    entries: Object.entries(bundle.entries)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, entry]) => ({ name, env_var: entry.env_var, allow: [...entry.allow] })),
  };
}

/**
 * Rebuild the bundle from the guard's redacted scan tree, re-attaching
 * the sealed values. The scan tree is an array in a deterministic order,
 * so the merge is by position. A redacted ALLOW pattern merges (the
 * export then differs from the vault, and the notice says so); a
 * REWRITTEN name or env-var mapping refuses the export instead - an
 * identifier is never rewritten into the file that has to carry it.
 */
export function bundleFromEgressScan(bundle: SecretBundleFile, scanned: unknown): SecretBundleFile {
  const fail = (detail: string): SecretBundleError =>
    new SecretBundleError(BUNDLE_REFUSAL_CODES.entry, detail);
  if (typeof scanned !== "object" || scanned === null) throw fail("redacted scan is not an object");
  const entries = (scanned as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) throw fail("redacted scan lost the entry list");
  const original = Object.entries(bundle.entries).toSorted(([a], [b]) => a.localeCompare(b));
  if (entries.length !== original.length) {
    throw fail("redacted scan has a different number of entries");
  }
  const out: Record<string, SecretBundleEntry> = {};
  for (const [index, [name, entry]] of original.entries()) {
    const scannedEntry = entries[index] as { name?: unknown; env_var?: unknown; allow?: unknown };
    if (
      typeof scannedEntry !== "object" ||
      scannedEntry === null ||
      typeof scannedEntry.name !== "string" ||
      typeof scannedEntry.env_var !== "string" ||
      !Array.isArray(scannedEntry.allow)
    ) {
      throw fail(`redacted scan lost the entry for "${name}"`);
    }
    if (scannedEntry.name !== name || scannedEntry.env_var !== entry.env_var) {
      throw fail(
        `the egress redactor rewrote an entry identifier (name "${name}", env var ` +
          `${JSON.stringify(entry.env_var)}); an identifier is never rewritten into the ` +
          "export - rename the entry in the store, or exclude it, then re-run",
      );
    }
    out[name] = {
      env_var: entry.env_var,
      allow: scannedEntry.allow.map(String),
      value: entry.value,
    };
  }
  return { ...bundle, entries: out };
}

export interface ImportSecretBundleInput {
  readonly passphrase: string;
  /** Overwrite entries whose names the target store already holds. */
  readonly replace: boolean;
  readonly agent: string;
  readonly now: Date;
}

/**
 * Import a bundle into `vault`. Every value is decrypted and every name
 * and env-var mapping validated BEFORE anything is written, so a wrong
 * passphrase or a malformed entry leaves the target store untouched.
 * Without `replace`, any colliding name refuses the whole import by
 * name; with it, exactly those entries are overwritten.
 */
export function importSecretBundle(
  vault: string,
  bundle: unknown,
  input: ImportSecretBundleInput,
): { imported: string[]; replaced: string[] } {
  // Guard ahead of the first byte the import writes.
  assertVaultIdentityForWrite(vault);
  const parsed = parseBundle(bundle);
  if (input.passphrase.length === 0) {
    throw new SecretBundleError(
      BUNDLE_REFUSAL_CODES.passphrase,
      "an import passphrase must not be empty",
    );
  }
  const derived = deriveWrapKey(input.passphrase, parsed.kdf);
  const decrypted = new Map<string, { value: string; env_var: string; allow: string[] }>();
  for (const name of Object.keys(parsed.entries).toSorted()) {
    const entry = parsed.entries[name]!;
    if (!isValidSecretName(name)) {
      throw new SecretBundleError(
        BUNDLE_REFUSAL_CODES.entry,
        `entry name does not match the store's name rule: ${JSON.stringify(name)}`,
      );
    }
    if (!isValidSecretEnvVar(entry.env_var)) {
      throw new SecretBundleError(
        BUNDLE_REFUSAL_CODES.entry,
        `entry "${name}" has an env-var mapping that fails the store's rule: ` +
          JSON.stringify(entry.env_var),
      );
    }
    // The third rule `set` enforces, applied to the imported allowlist:
    // trim each pattern, refuse empty ones. The allow list rides in the
    // clear, so without this a rewritten bundle could land entries the
    // store's own writer would refuse.
    let allow: string[];
    try {
      allow = normalizeAllowPatterns(entry.allow);
    } catch {
      throw new SecretBundleError(
        BUNDLE_REFUSAL_CODES.entry,
        `entry "${name}" has an allow pattern that fails the store's rule: ` +
          "patterns must be non-empty",
      );
    }
    let value: string;
    try {
      value = decryptValue(derived, entry.value);
    } catch {
      // The GCM tag is the passphrase check. Nothing has been written.
      throw new SecretBundleError(
        BUNDLE_REFUSAL_CODES.passphrase,
        "the passphrase does not open this bundle (wrong passphrase, or the bundle is corrupt); nothing was written",
      );
    }
    decrypted.set(name, { value, env_var: entry.env_var, allow });
  }

  const replaced = withSecretsLock(vault, () => {
    const file = readStore(vault);
    const collisions = [...decrypted.keys()].filter(
      (name) => !input.replace && file.secrets[name] !== undefined,
    );
    if (collisions.length > 0) {
      throw new SecretBundleError(
        BUNDLE_REFUSAL_CODES.nameExists,
        `the store already holds: ${collisions.join(", ")}; pass --replace to import over them`,
      );
    }
    const key = loadOrCreateKey(keyPath(vault));
    const secrets = { ...file.secrets };
    const overwritten: string[] = [];
    for (const [name, entry] of decrypted) {
      const current = file.secrets[name];
      if (current !== undefined) overwritten.push(name);
      secrets[name] = {
        ...encryptValue(key, entry.value),
        env_var: entry.env_var,
        allow: entry.allow,
        created_at: current?.created_at ?? isoSecond(input.now),
        last_used_at: current?.last_used_at ?? null,
      };
    }
    writeStore(vault, { version: SECRETS_SCHEMA_VERSION, secrets });
    return overwritten;
  });
  const imported = [...decrypted.keys()].toSorted();
  auditBundle(vault, input, "secret_bundle_imported", { imported, replaced: replaced.toSorted() });
  return { imported, replaced: replaced.toSorted() };
}

// ----- Internals -------------------------------------------------------------

/**
 * Strict shape read: refuse an unknown version or KDF algo BY NAME, and a
 * file that merely looks like a bundle with the malformed code.
 */
function parseBundle(bundle: unknown): SecretBundleFile {
  if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)) {
    throw new SecretBundleError(BUNDLE_REFUSAL_CODES.malformed, "not a bundle object");
  }
  const candidate = bundle as Partial<SecretBundleFile>;
  if (typeof candidate.version !== "number" || typeof candidate.generated_at !== "string") {
    throw new SecretBundleError(BUNDLE_REFUSAL_CODES.malformed, "missing envelope fields");
  }
  const kdf = candidate.kdf as Partial<EnvelopeKdfParams> | undefined;
  if (
    typeof kdf !== "object" ||
    kdf === null ||
    typeof kdf.algo !== "string" ||
    typeof kdf.salt !== "string" ||
    typeof kdf.n !== "number" ||
    typeof kdf.r !== "number" ||
    typeof kdf.p !== "number" ||
    typeof kdf.maxmem !== "number"
  ) {
    throw new SecretBundleError(BUNDLE_REFUSAL_CODES.malformed, "missing kdf parameters");
  }
  if (candidate.version !== SECRET_BUNDLE_SCHEMA_VERSION) {
    throw new SecretBundleError(
      BUNDLE_REFUSAL_CODES.version,
      `version ${String(candidate.version)} is not read by this build`,
    );
  }
  if (kdf.algo !== "scrypt") {
    throw new SecretBundleError(
      BUNDLE_REFUSAL_CODES.kdfAlgo,
      `kdf algo ${JSON.stringify(kdf.algo)} is not implemented by this build`,
    );
  }
  if (
    !Number.isInteger(kdf.n) ||
    kdf.n <= 0 ||
    !Number.isInteger(kdf.r) ||
    kdf.r <= 0 ||
    !Number.isInteger(kdf.p) ||
    kdf.p <= 0 ||
    !Number.isInteger(kdf.maxmem) ||
    kdf.maxmem <= 0
  ) {
    throw new SecretBundleError(
      BUNDLE_REFUSAL_CODES.malformed,
      "kdf parameters must be positive integers",
    );
  }
  // The same cost-curve bound the keyfile envelope enforces: a crafted
  // bundle's kdf block reaches `deriveWrapKey` verbatim, and an absurd
  // cost is refused by name before scrypt allocates.
  const costRefusal = kdfCostCurveRefusal(kdf as EnvelopeKdfParams);
  if (costRefusal !== null) {
    throw new SecretBundleError(BUNDLE_REFUSAL_CODES.kdfCost, costRefusal);
  }
  const entries = candidate.entries;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
    throw new SecretBundleError(BUNDLE_REFUSAL_CODES.malformed, "missing entries");
  }
  for (const [name, entry] of Object.entries(entries as Record<string, unknown>)) {
    const fields = entry as Partial<SecretBundleEntry> | null;
    if (
      typeof fields !== "object" ||
      fields === null ||
      typeof fields.env_var !== "string" ||
      !Array.isArray(fields.allow) ||
      // Element types are checked here, not at match time: a non-string
      // pattern must never reach the exec allowlist matcher.
      !fields.allow.every((pattern) => typeof pattern === "string") ||
      typeof fields.value !== "object" ||
      fields.value === null ||
      typeof (fields.value as EncryptedValue).ciphertext !== "string" ||
      typeof (fields.value as EncryptedValue).iv !== "string" ||
      typeof (fields.value as EncryptedValue).tag !== "string"
    ) {
      throw new SecretBundleError(
        BUNDLE_REFUSAL_CODES.malformed,
        `entry "${name}" is not a complete bundle entry`,
      );
    }
  }
  return bundle as SecretBundleFile;
}

/** The no-values custody record, the same discipline as the store's ops. */
function auditBundle(
  vault: string,
  ctx: SecretAuditContext,
  action: string,
  details: Record<string, unknown>,
): void {
  appendAuditRecord(joinBrainLog(vault), {
    timestamp: ctx.now.toISOString(),
    actor: ctx.agent,
    action,
    target: "bundle",
    ok: true,
    details,
  });
}

function joinBrainLog(vault: string): string {
  return join(brainDirsForWrite(vault).log, SECRET_CUSTODY_AUDIT_DIR);
}
