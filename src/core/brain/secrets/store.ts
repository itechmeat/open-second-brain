/**
 * Capability-gated secret custody store (write-time-integrity-
 * governance, t_0b134404). Secrets live as per-value AES-256-GCM
 * ciphertext in `<vault>/.open-second-brain/secrets/secrets.json`
 * (0600) beside a 0600 keyfile - the vault-local state dir, never
 * synced as vault content. The public surface never returns
 * plaintext: `setSecret` ingests, `listSecrets` exposes metadata
 * only, `resolveSecretForExec` exists for the exec path alone (env
 * injection into an allowlisted subprocess - exec.ts), and every
 * operation appends a no-values record to
 * `Brain/log/secret-custody/` so custody is auditable from inside
 * the vault.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";

import { appendAuditRecord } from "../../reliability/audit.ts";
import { brainDirs } from "../paths.ts";
import { decryptValue, encryptValue, loadOrCreateKey, type EncryptedValue } from "./crypto.ts";

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
 */
export function resolveSecretForExec(
  vault: string,
  name: string,
  ctx: SecretAuditContext = { agent: "cli", now: new Date() },
): ResolvedSecret {
  const file = readStore(vault);
  const normalized = name.trim().toLowerCase();
  const stored = file.secrets[normalized];
  if (stored === undefined) {
    const names = Object.keys(file.secrets).toSorted();
    throw new Error(
      `unknown secret "${normalized}" - stored: ${names.length === 0 ? "(none)" : names.join(", ")}`,
    );
  }
  const key = loadOrCreateKey(keyPath(vault));
  const value = decryptValue(key, stored);
  touchLastUsed(vault, normalized, ctx.now);
  audit(vault, ctx, "secret_resolved_for_exec", normalized, { env_var: stored.env_var });
  return { name: normalized, env_var: stored.env_var, allow: stored.allow, value };
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
  renameSync(tmp, path);
}

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
  appendAuditRecord(join(brainDirs(vault).log, "secret-custody"), {
    timestamp: ctx.now.toISOString(),
    actor: ctx.agent,
    action,
    target: name,
    ok: true,
    details,
  });
}

function isoSecond(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
