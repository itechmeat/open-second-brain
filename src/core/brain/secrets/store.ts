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
import { brainDirsForWrite } from "../paths.ts";
import { isoSecond } from "../time.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { decryptValue, encryptValue, loadOrCreateKey, type EncryptedValue } from "./crypto.ts";
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

function keyPath(vault: string): string {
  return join(secretsDir(vault), "keyfile");
}

/**
 * Serialise every read-modify-write of `secrets.json` across
 * processes (CLI + MCP). proper-lockfile with retries, matching the
 * search store's writer-lock discipline; the keyfile creation also
 * creates the directory the lock anchors on.
 */
function withSecretsLock<T>(vault: string, fn: () => T): T {
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
  const allow = (input.allow ?? []).map((pattern) => {
    const trimmed = pattern.trim();
    if (trimmed.length === 0) throw new Error("allow pattern must not be empty");
    return trimmed;
  });

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

function readStore(vault: string): SecretsFile {
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

function writeStore(vault: string, file: SecretsFile): void {
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
  appendAuditRecord(join(brainDirsForWrite(vault).log, "secret-custody"), {
    timestamp: ctx.now.toISOString(),
    actor: ctx.agent,
    action,
    target: name,
    ok: true,
    details,
  });
}
