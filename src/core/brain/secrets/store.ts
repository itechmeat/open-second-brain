/**
 * Capability-gated secret custody store (write-time-integrity-
 * governance, t_0b134404). Secrets live as per-value AES-256-GCM
 * ciphertext in `<vault>/.open-second-brain/secrets/secrets.json`
 * (0600) beside a 0600 keyfile - the vault-local state dir, kept out
 * of git by a marker file and out of a Syncthing folder only by the
 * operator's `.stignore` (see `./sync-exposure.ts`). The public surface never returns
 * plaintext: `setSecret` ingests, `listSecrets` exposes metadata
 * only, `resolveSecretForExec` exists for the exec path alone (env
 * injection into an allowlisted subprocess - exec.ts), and every
 * operation appends a no-values record to
 * `Brain/log/secret-custody/` so custody is auditable from inside
 * the vault.
 */

import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";

import { renameWithRetry } from "../../fs-atomic.ts";
import { appendAuditRecord } from "../../reliability/audit.ts";
import { SECRET_CUSTODY_AUDIT_DIR } from "../audit-dirs.ts";
import { brainDirsForWrite } from "../paths.ts";
import { isoSecond } from "../time.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { decryptValue, encryptValue, loadOrCreateKey, type EncryptedValue } from "./crypto.ts";
import {
  clearHeldKey,
  isEnvelopeFile,
  SecretStoreKeyfileMissingError,
  unlockKeyfile as unlockKeyfileAtPath,
  wrapKeyfile as wrapKeyfileAtPath,
} from "./envelope.ts";
import { restrictToOwner } from "./owner-acl.ts";

export const SECRETS_SCHEMA_VERSION = 1;

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*$/;

interface StoredSecret extends EncryptedValue {
  readonly env_var: string;
  /** Exec allowlist: glob patterns the joined command must match. */
  readonly allow: ReadonlyArray<string>;
  readonly created_at: string;
  readonly last_used_at: string | null;
}

interface SecretsFile {
  readonly version: number;
  readonly secrets: Record<string, StoredSecret>;
}

/** Metadata view - everything except the ciphertext material. */
export interface SecretMetadata {
  readonly name: string;
  readonly env_var: string;
  readonly allow: ReadonlyArray<string>;
  readonly created_at: string;
  readonly last_used_at: string | null;
}

export interface SetSecretInput {
  readonly name: string;
  /** The secret material. Never logged, never returned. */
  readonly value: string;
  /** Env var the exec path injects; defaults to the name upcased. */
  readonly envVar?: string;
  /** Exec allowlist patterns; empty means exec is denied entirely. */
  readonly allow?: ReadonlyArray<string>;
  readonly agent: string;
  readonly now: Date;
}

export interface SecretAuditContext {
  readonly agent: string;
  readonly now: Date;
}

export function secretsDir(vault: string): string {
  return join(vault, ".open-second-brain", "secrets");
}

function storePath(vault: string): string {
  return join(secretsDir(vault), "secrets.json");
}

/** The keyfile path - exported for `./bundle.ts`'s wrap and import paths. */
export function keyPath(vault: string): string {
  return join(secretsDir(vault), "keyfile");
}

/** The name rule `set` enforces, shared with the bundle importer. */
export function isValidSecretName(name: string): boolean {
  return NAME_RE.test(name);
}

/** The env-var rule `set` enforces, shared with the bundle importer. */
export function isValidSecretEnvVar(envVar: string): boolean {
  return ENV_VAR_RE.test(envVar);
}

/**
 * The allow-pattern rule `set` enforces: every pattern trims, and an
 * empty one refuses. Shared with the bundle importer, so an imported
 * entry can never carry an allowlist the store's own writer would have
 * refused - a crafted bundle cannot broaden exec capability into a state
 * `secret set` cannot have produced.
 */
export function normalizeAllowPatterns(patterns: ReadonlyArray<string>): string[] {
  return patterns.map((pattern) => {
    const trimmed = pattern.trim();
    if (trimmed.length === 0) throw new Error("allow pattern must not be empty");
    return trimmed;
  });
}

/**
 * Serialise every read-modify-write of `secrets.json` across
 * processes (CLI + MCP). proper-lockfile with retries, matching the
 * search store's writer-lock discipline; the keyfile creation also
 * creates the directory the lock anchors on. Exported for
 * `./bundle.ts`, whose import path holds the same lock around its own
 * read-collision-write sequence.
 */
export function withSecretsLock<T>(vault: string, fn: () => T): T {
  loadOrCreateKey(keyPath(vault));
  // The sync lockfile API has no retry option; spin briefly the same
  // way the search store's writer lock does.
  const maxAttempts = 20;
  let release: (() => void) | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts && release === null; attempt++) {
    try {
      release = lockfile.lockSync(secretsDir(vault), { stale: 10_000, realpath: false });
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code !== "ELOCKED") throw exc;
      lastError = exc;
      if (attempt < maxAttempts - 1) Bun.sleepSync(25);
    }
  }
  if (release === null) {
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`another writer holds the secrets store lock: ${msg}`);
  }
  try {
    return fn();
  } finally {
    void release();
  }
}

export function setSecret(vault: string, input: SetSecretInput): SecretMetadata {
  // Vault-identity write guard (context-integrity-gates, Unit J), AHEAD
  // of `loadOrCreateKey`: that call mints a keyfile and creates the 0700
  // state directory, so a guard sitting on the trailing audit append
  // would have already put key material in the wrong vault.
  assertVaultIdentityForWrite(vault);
  const name = input.name.trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new Error(
      `secret name must be a lowercase slug ([a-z0-9_-], starting alphanumeric): ${JSON.stringify(input.name)}`,
    );
  }
  if (input.value.trim().length === 0) {
    throw new Error("secret value must not be empty");
  }
  const envVar = input.envVar ?? name.toUpperCase().replace(/-/g, "_");
  if (!ENV_VAR_RE.test(envVar)) {
    throw new Error(`secret env var must match ${ENV_VAR_RE}: ${JSON.stringify(envVar)}`);
  }
  const allow = normalizeAllowPatterns(input.allow ?? []);

  const key = loadOrCreateKey(keyPath(vault));
  // Custody is a precondition, not a stderr line: on Windows, a keyfile
  // whose ACL restriction failed (a share or FAT volume `icacls` cannot
  // serve, a broken whoami) would hold ciphertext readable by every
  // authenticated account on the volume, and `secret stored` with exit 0
  // would tell the operator the opposite of the truth. `set` refuses and
  // names the repair; `run`/`list` keep their warn-and-continue because
  // the material is already there and the warning is on stderr.
  if (process.platform === "win32") {
    // Every target is asked (no short-circuit) so each failure is named
    // on stderr before the refusal.
    const results = custodyTargets(vault).map(([path, kind]) => restrictToOwner(path, kind));
    if (results.includes(false)) {
      throw new Error(
        `refusing to store the secret: the secrets directory could not be restricted to the ` +
          `current user (${secretsDir(vault)}); resolve the icacls warning above and retry`,
      );
    }
  }
  const { next, existing } = withSecretsLock(vault, () => {
    const file = readStore(vault);
    const current = file.secrets[name];
    const updated: SecretsFile = {
      version: SECRETS_SCHEMA_VERSION,
      secrets: {
        ...file.secrets,
        [name]: {
          ...encryptValue(key, input.value),
          env_var: envVar,
          allow,
          created_at: current?.created_at ?? isoSecond(input.now),
          last_used_at: current?.last_used_at ?? null,
        },
      },
    };
    writeStore(vault, updated);
    return { next: updated, existing: current };
  });
  audit(vault, input, "secret_set", name, {
    env_var: envVar,
    allow,
    replaced: existing !== undefined,
  });
  return toMetadata(name, next.secrets[name]!);
}

export function listSecrets(vault: string): SecretMetadata[] {
  const file = readStore(vault);
  return Object.entries(file.secrets)
    .map(([name, stored]) => toMetadata(name, stored))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

export function removeSecret(vault: string, name: string, ctx: SecretAuditContext): boolean {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const normalized = name.trim().toLowerCase();
  const removed = withSecretsLock(vault, () => {
    const file = readStore(vault);
    if (file.secrets[normalized] === undefined) return false;
    const secrets = { ...file.secrets };
    delete secrets[normalized];
    writeStore(vault, { version: SECRETS_SCHEMA_VERSION, secrets });
    return true;
  });
  if (removed) audit(vault, ctx, "secret_removed", normalized, {});
  return removed;
}

export interface ResolvedSecret {
  readonly name: string;
  readonly env_var: string;
  readonly allow: ReadonlyArray<string>;
  /** The decrypted material - exec-path use only, never log it. */
  readonly value: string;
}

/**
 * Decrypt one secret for the exec path. THE ONLY reader of secret
 * material; everything it returns must go straight into a subprocess
 * env and nowhere else. Audited as `secret_resolved_for_exec`.
 *
 * READ-SHAPED BUT A WRITER. It stamps `last_used_at` through
 * {@link touchLastUsed} and appends a custody record, so it carries the
 * vault-identity guard like any other writer. The guard is at the top,
 * ahead of `loadOrCreateKey`, which would otherwise mint a keyfile in
 * the wrong store before the refusal.
 */
export function resolveSecretForExec(
  vault: string,
  name: string,
  ctx: SecretAuditContext = { agent: "cli", now: new Date() },
): ResolvedSecret {
  assertVaultIdentityForWrite(vault);
  const file = readStore(vault);
  const normalized = name.trim().toLowerCase();
  const stored = file.secrets[normalized];
  if (stored === undefined) {
    // No enumeration on this path: `list` is the discovery surface and it
    // returns metadata only by design. An error that names the stored
    // set would hand the same metadata to every caller that can spell a
    // wrong name, including ones a narrow allowlist was meant to keep
    // out of the inventory.
    throw new Error(`unknown secret "${normalized}"`);
  }
  const key = loadOrCreateKey(keyPath(vault));
  const value = decryptValue(key, stored);
  touchLastUsed(vault, normalized, ctx.now);
  audit(vault, ctx, "secret_resolved_for_exec", normalized, { env_var: stored.env_var });
  return { name: normalized, env_var: stored.env_var, allow: stored.allow, value };
}

/**
 * Decrypt one secret WITHOUT the exec path's write half: no `last_used_at`
 * stamp, no custody audit record, no vault-identity guard (it writes
 * nothing). The read-only resolve the config-side secret resolver composes
 * with (t_e5807974): a config read must not take the write path, and it
 * must not look like an exec. Same shape as the exec resolve's answer, so
 * a consumer sees one secret record either way.
 *
 * A name the store holds under a locked envelope surfaces the named
 * locked-store refusal, and a store whose keyfile is MISSING while entries
 * survive surfaces the named missing-keyfile refusal - never a silent
 * fallback in either case, which would hide the store's real state from
 * the caller. The missing-keyfile refusal is also what keeps this resolve
 * read-only in fact and not just in name: `loadOrCreateKey` would mint a
 * fresh key over the surviving ciphertext, silently orphaning every
 * stored value. An unknown name fails with the same no-enumeration error
 * the exec resolve uses.
 */
export function resolveSecretReadOnly(vault: string, name: string): ResolvedSecret {
  const file = readStore(vault);
  const normalized = name.trim().toLowerCase();
  const stored = file.secrets[normalized];
  if (stored === undefined) {
    // Same discipline as {@link resolveSecretForExec}: `list` is the
    // discovery surface, so a wrong name learns nothing.
    throw new Error(`unknown secret "${normalized}"`);
  }
  const kp = keyPath(vault);
  if (!existsSync(kp)) throw new SecretStoreKeyfileMissingError(kp);
  const key = loadOrCreateKey(kp);
  return {
    name: normalized,
    env_var: stored.env_var,
    allow: stored.allow,
    value: decryptValue(key, stored),
  };
}

/**
 * Unlock the store's wrapped keyfile for THIS PROCESS: verify the
 * passphrase, hold the DEK in the envelope module's memory-only holder,
 * and land the no-values custody record. On a store whose keyfile is
 * still raw, this IS the opt-in: the raw 32 bytes are wrapped under the
 * passphrase on first unlock, so unlocking is what creates the envelope.
 *
 * The passphrase is never persisted, logged, or audited, and a lost
 * passphrase is unrecoverable - the verb's help says so in plain terms.
 */
export function unlockSecretKeyfile(
  vault: string,
  passphrase: string,
  ctx: SecretAuditContext,
): void {
  // Guard ahead of the first byte: the wrap below replaces the keyfile.
  assertVaultIdentityForWrite(vault);
  const kp = keyPath(vault);
  const wrapped = isEnvelopeFile(kp);
  if (wrapped) {
    unlockKeyfileAtPath(kp, passphrase);
  } else {
    // The wrap replaces the only copy of the DEK, so it serialises
    // through the same writer lock every other read-modify-write of the
    // custody directory takes: two concurrent first-unlocks must not
    // interleave on the tmp path the swap writes. The shape check runs
    // again UNDER the lock, so the loser of the race finds the envelope
    // the winner just wrote and takes the unlock path instead of minting
    // over it.
    withSecretsLock(vault, () => {
      if (!isEnvelopeFile(kp)) wrapKeyfileAtPath(kp, passphrase, loadOrCreateKey(kp));
    });
    // The wrap wrote the envelope but held nothing: verify-and-hold the
    // key here, so the first unlock leaves THIS process unlocked - an
    // unlock that left the process locked would fail the very remedy the
    // locked-store refusal names.
    unlockKeyfileAtPath(kp, passphrase);
  }
  audit(vault, ctx, "secret_unlocked", "keyfile", { keyfile_was_wrapped: wrapped });
}

/**
 * Lock: clear this process's held key and land the no-values custody
 * record. Strictly process-local - there is no daemon, so every other
 * CLI invocation and the MCP server were already locked. A store whose
 * keyfile was never wrapped has nothing to lock, and saying `secret
 * locked` there would record a protection that does not exist, so it
 * refuses by name.
 */
export function lockSecretKeyfile(vault: string, ctx: SecretAuditContext): void {
  assertVaultIdentityForWrite(vault);
  const kp = keyPath(vault);
  if (!isEnvelopeFile(kp)) {
    throw new Error(`secret lock: the keyfile is not passphrase-wrapped, nothing to lock: ${kp}`);
  }
  clearHeldKey(kp);
  audit(vault, ctx, "secret_locked", "keyfile", {});
}

/**
 * The paths whose owner-only protection `set` requires before it stores
 * material: the directory and the keyfile, which `loadOrCreateKey` has
 * just ensured exist, and the ciphertext store ONLY when it already
 * exists. On a fresh vault the store is created by the write that
 * follows and inherits the directory's owner-only entry; asking `icacls`
 * to reset a file that is not there fails, which made the first `secret
 * set` in every fresh vault refuse on Windows.
 */
export function custodyTargets(
  vault: string,
): ReadonlyArray<readonly [string, "file" | "directory"]> {
  const targets: Array<readonly [string, "file" | "directory"]> = [
    [secretsDir(vault), "directory"],
    [keyPath(vault), "file"],
  ];
  if (existsSync(storePath(vault))) targets.push([storePath(vault), "file"]);
  return targets;
}

// ----- Internals -------------------------------------------------------------

function toMetadata(name: string, stored: StoredSecret): SecretMetadata {
  return {
    name,
    env_var: stored.env_var,
    allow: stored.allow,
    created_at: stored.created_at,
    last_used_at: stored.last_used_at,
  };
}

export function readStore(vault: string): SecretsFile {
  const path = storePath(vault);
  if (!existsSync(path)) return { version: SECRETS_SCHEMA_VERSION, secrets: {} };
  // Windows: a store that came in with a copied vault may carry an ACL
  // of its own; the ones this module writes inherit the directory's.
  restrictToOwner(path, "file");
  // The POSIX mirror (audit M8): mode bits are set only when this module
  // writes the store, so one restored by a copy or a tar keeps whatever
  // mode it arrived with. Warn-and-continue, like the keyfile beside it.
  if (process.platform !== "win32") {
    try {
      if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
    } catch (err) {
      process.stderr.write(
        `warning: could not re-apply owner-only mode to the secrets store: ` +
          `${path}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== SECRETS_SCHEMA_VERSION
  ) {
    throw new Error(`secrets store is corrupt or from a newer version: ${path}`);
  }
  const secrets = (parsed as { secrets?: unknown }).secrets;
  if (secrets === null || typeof secrets !== "object" || Array.isArray(secrets)) {
    throw new Error(`secrets store is corrupt: ${path}`);
  }
  return {
    version: SECRETS_SCHEMA_VERSION,
    secrets: { ...(secrets as Record<string, StoredSecret>) },
  };
}

export function writeStore(vault: string, file: SecretsFile): void {
  // Key creation also creates the 0700 directory.
  loadOrCreateKey(keyPath(vault));
  const path = storePath(vault);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  renameWithRetry(tmp, path);
}

/**
 * Stamp `last_used_at`. Private, and reached only from
 * {@link resolveSecretForExec}, which carries the vault-identity guard
 * at its entry point - the assertion is not repeated here so there stays
 * exactly one guard per public entry point.
 */
function touchLastUsed(vault: string, name: string, now: Date): void {
  // Re-read under the lock: the snapshot the resolver decrypted from
  // may be stale by the time the usage stamp lands.
  withSecretsLock(vault, () => {
    const file = readStore(vault);
    const stored = file.secrets[name];
    if (stored === undefined) return;
    writeStore(vault, {
      version: SECRETS_SCHEMA_VERSION,
      secrets: { ...file.secrets, [name]: { ...stored, last_used_at: isoSecond(now) } },
    });
  });
}

function audit(
  vault: string,
  ctx: SecretAuditContext,
  action: string,
  name: string,
  details: Record<string, unknown>,
): void {
  appendAuditRecord(join(brainDirsForWrite(vault).log, SECRET_CUSTODY_AUDIT_DIR), {
    timestamp: ctx.now.toISOString(),
    actor: ctx.agent,
    action,
    target: name,
    ok: true,
    details,
  });
}
