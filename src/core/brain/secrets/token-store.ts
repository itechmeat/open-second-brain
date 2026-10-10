/**
 * Named per-agent MCP token store (write-side-trust, Task 3).
 *
 * One operator-minted credential per agent, so an HTTP caller's identity
 * comes from what it PRESENTS rather than from process config. The
 * store is hash-at-rest by design decision (t_85059d6d), not custody
 * ciphertext: `sha256(tokenMaterial)` sits beside a non-secret prefix in
 * `<vault>/.open-second-brain/secrets/mcp-tokens.json` (0600, owner ACL
 * on Windows through the custody targets beside `secrets.json`), and a
 * plaintext-equivalent token never exists after the mint answer returns
 * it exactly once. Verification therefore never needs the passphrase
 * envelope - locking the custody store must not be an authentication
 * outage, which is the property the ciphertext design could not give.
 *
 * Every mint, rotation and revocation appends a no-values record to the
 * secret-custody audit, the same trail `secrets.json` writes. Names are
 * `mcp_token_<slug>` - underscores only - so a `$secret:NAME` reference
 * (whose grammar admits no dashes) can address them. Reads go through an
 * mtime cache, so a rotation or revocation performed by another process
 * (the CLI) takes effect on this one's next resolve without a restart.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { renameWithRetry } from "../../fs-atomic.ts";
import { appendAuditRecord } from "../../reliability/audit.ts";
import { SECRET_CUSTODY_AUDIT_DIR } from "../audit-dirs.ts";
import { brainDirsForWrite } from "../paths.ts";
import { isoSecond } from "../time.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { restrictToOwner } from "./owner-acl.ts";
import { tokenStorePath, withSecretsLock } from "./store.ts";

export const MCP_TOKENS_SCHEMA_VERSION = 1;

/** How much of the material the non-secret display prefix keeps. */
export const TOKEN_PREFIX_LENGTH = 12;

/** The material prefix: short, recognisable in a config, not a secret. */
const MATERIAL_PREFIX = "osbt_";

/**
 * `mcp_token_<slug>` - underscores only, lowercase, so the name is a
 * legal `$secret:NAME` body (no dashes) and a legal env-var tail.
 */
const TOKEN_NAME_RE = /^mcp_token_[a-z0-9_]+$/;

export type McpTokenStatus = "active" | "revoked";

/** The stored view of one token. No member ever carries the material. */
export interface McpTokenRecord {
  name: string;
  agent: string;
  status: McpTokenStatus;
  /** sha256(tokenMaterial), hex - the at-rest form, verified constant-time. */
  token_hash: string;
  /** A non-secret cut of the material front, for listings. */
  token_prefix: string;
  created_at: string;
  rotated_at?: string;
}

interface TokenStoreFile {
  readonly version: number;
  readonly tokens: Record<string, McpTokenRecord>;
}

export class McpTokenStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpTokenStoreError";
  }
}

const EMPTY_STORE: TokenStoreFile = Object.freeze({
  version: MCP_TOKENS_SCHEMA_VERSION,
  tokens: Object.freeze({}),
});

/** The name rule mint/rotate/revoke enforce. */
export function isValidMcpTokenName(name: string): boolean {
  return TOKEN_NAME_RE.test(name);
}

// ----- Writers ---------------------------------------------------------------

/**
 * Mint one named token for `agent`. The material rides the RETURN VALUE
 * exactly once - print it, or lose it - and only the hash is persisted.
 * An existing name (active or revoked) refuses with a message naming
 * rotate: a second mint over a live name would silently orphan a
 * credential some agent still holds.
 */
export function mintAgentToken(
  vault: string,
  name: string,
  agent: string,
): { tokenMaterial: string; record: McpTokenRecord } {
  assertVaultIdentityForWrite(vault);
  const cleanName = validatedName(name);
  const cleanAgent = validatedAgent(agent);
  const tokenMaterial = mintMaterial();
  const record: McpTokenRecord = {
    name: cleanName,
    agent: cleanAgent,
    status: "active",
    token_hash: hashOf(tokenMaterial),
    token_prefix: tokenMaterial.slice(0, TOKEN_PREFIX_LENGTH),
    created_at: isoSecond(),
  };
  withSecretsLock(vault, () => {
    const file = readTokenStore(vault);
    if (file.tokens[cleanName] !== undefined) {
      throw new McpTokenStoreError(
        `token ${JSON.stringify(cleanName)} already exists; use rotate to replace its material`,
      );
    }
    writeTokenStore(vault, {
      version: MCP_TOKENS_SCHEMA_VERSION,
      tokens: { ...file.tokens, [cleanName]: record },
    });
  });
  auditToken(vault, "mcp_token_minted", cleanName, { agent: cleanAgent });
  return { tokenMaterial, record };
}

/**
 * Re-mint the material under an existing name: new hash, new prefix,
 * `rotated_at` stamped, `created_at` kept. The old material stops
 * resolving on the NEXT resolve (the mtime cache re-reads), so a server
 * process needs no restart. A revoked record refuses - revocation is
 * terminal; mint a new name to start over.
 */
export function rotateAgentToken(
  vault: string,
  name: string,
): { tokenMaterial: string; record: McpTokenRecord } {
  assertVaultIdentityForWrite(vault);
  const cleanName = validatedName(name);
  const tokenMaterial = mintMaterial();
  let agent = "";
  withSecretsLock(vault, () => {
    const file = readTokenStore(vault);
    const existing = file.tokens[cleanName];
    if (existing === undefined) {
      throw new McpTokenStoreError(`unknown token: ${JSON.stringify(cleanName)}`);
    }
    if (existing.status === "revoked") {
      throw new McpTokenStoreError(
        `token ${JSON.stringify(cleanName)} is revoked; mint a new name instead of rotating it`,
      );
    }
    agent = existing.agent;
    writeTokenStore(vault, {
      version: MCP_TOKENS_SCHEMA_VERSION,
      tokens: {
        ...file.tokens,
        [cleanName]: {
          ...existing,
          token_hash: hashOf(tokenMaterial),
          token_prefix: tokenMaterial.slice(0, TOKEN_PREFIX_LENGTH),
          rotated_at: isoSecond(),
        },
      },
    });
  });
  auditToken(vault, "mcp_token_rotated", cleanName, { agent, replaced: true });
  return {
    tokenMaterial,
    record: readTokenStore(vault).tokens[cleanName]!,
  };
}

/** Revoke one token: the record stays (history), the material stops resolving. */
export function revokeAgentToken(vault: string, name: string): boolean {
  assertVaultIdentityForWrite(vault);
  const cleanName = validatedName(name);
  let revoked = false;
  let agent = "";
  withSecretsLock(vault, () => {
    const file = readTokenStore(vault);
    const existing = file.tokens[cleanName];
    if (existing === undefined || existing.status === "revoked") return;
    agent = existing.agent;
    writeTokenStore(vault, {
      version: MCP_TOKENS_SCHEMA_VERSION,
      tokens: { ...file.tokens, [cleanName]: { ...existing, status: "revoked" } },
    });
    revoked = true;
  });
  if (revoked) auditToken(vault, "mcp_token_revoked", cleanName, { agent });
  return revoked;
}

// ----- Readers ---------------------------------------------------------------

/** Every record, sorted by name. Metadata only - never the material. */
export function listAgentTokens(vault: string): McpTokenRecord[] {
  return Object.values(readTokenStore(vault).tokens).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * Whether any token is minted at all - the non-empty-map half of the
 * transport's `mcp_tokens_required` enforcement and of the non-loopback
 * bind rule. Read behind the same mtime cache as
 * {@link resolveAgentForToken}, so minting the first token tightens a
 * running server without a restart.
 */
export function hasAnyAgentToken(vault: string): boolean {
  return activeHashIndex(vault).size > 0;
}

/**
 * Resolve a presented credential to its agent, or null when nothing
 * active matches. The presented material is hashed and compared against
 * every stored hash with timingSafeEqual (fixed 32-byte digests), so no
 * byte of a wrong answer leaks through early exit. The store is read
 * behind an mtime cache, which is what lets a CLI-side rotation take
 * effect here on the next request without a restart.
 */
export function resolveAgentForToken(
  vault: string,
  presented: string,
): { agent: string; name: string } | null {
  if (typeof presented !== "string" || presented.length === 0) return null;
  const index = activeHashIndex(vault);
  const digest = hashOf(presented);
  for (const [storedHash, entry] of index) {
    if (timingSafeEqual(Buffer.from(storedHash, "hex"), Buffer.from(digest, "hex"))) {
      return { agent: entry.agent, name: entry.name };
    }
  }
  return null;
}

// ----- Store file ------------------------------------------------------------

function validatedName(name: string): string {
  const trimmed = name.trim();
  if (!TOKEN_NAME_RE.test(trimmed)) {
    throw new McpTokenStoreError(
      `token name must be mcp_token_<slug> (lowercase [a-z0-9_]): ${JSON.stringify(name)}`,
    );
  }
  return trimmed;
}

function validatedAgent(agent: string): string {
  const trimmed = agent.trim();
  if (trimmed.length === 0) throw new McpTokenStoreError("token agent must not be empty");
  return trimmed;
}

function mintMaterial(): string {
  return `${MATERIAL_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function hashOf(material: string): string {
  return createHash("sha256").update(material).digest("hex");
}

function readTokenStore(vault: string): TokenStoreFile {
  const path = tokenStorePath(vault);
  if (!existsSync(path)) return EMPTY_STORE;
  // Same custody posture as `secrets.json`: a store that arrived by copy
  // keeps whatever ACL it came with, and the read re-applies owner-only.
  if (process.platform === "win32") restrictToOwner(path, "file");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== MCP_TOKENS_SCHEMA_VERSION
  ) {
    throw new McpTokenStoreError(`MCP token store is corrupt or from a newer version: ${path}`);
  }
  const tokens = (parsed as { tokens?: unknown }).tokens;
  if (tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) {
    throw new McpTokenStoreError(`MCP token store is corrupt: ${path}`);
  }
  const records: Record<string, McpTokenRecord> = {};
  for (const [key, value] of Object.entries(tokens as Record<string, unknown>)) {
    const record = value as Partial<McpTokenRecord> | null;
    if (
      record === null ||
      typeof record !== "object" ||
      typeof record.name !== "string" ||
      typeof record.agent !== "string" ||
      (record.status !== "active" && record.status !== "revoked") ||
      typeof record.token_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.token_hash)
    ) {
      throw new McpTokenStoreError(
        `MCP token store entry ${JSON.stringify(key)} is corrupt: ${path}`,
      );
    }
    records[key] = record as McpTokenRecord;
  }
  return { version: MCP_TOKENS_SCHEMA_VERSION, tokens: records };
}

function writeTokenStore(vault: string, file: TokenStoreFile): void {
  const path = tokenStorePath(vault);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  renameWithRetry(tmp, path);
  // The writer is the one reader whose cache must not survive its own
  // write: dropping the entry makes the next resolve re-stat, so an
  // in-process rotation takes effect even where the filesystem's mtime
  // granularity would have shown the old entry as fresh.
  cacheByPath.delete(path);
}

// ----- mtime cache -----------------------------------------------------------

interface CacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly index: ReadonlyMap<string, { agent: string; name: string }>;
}

/** The active-token hash index per store path, refreshed when the file changes. */
const cacheByPath = new Map<string, CacheEntry>();

const EMPTY_INDEX: ReadonlyMap<string, { agent: string; name: string }> = new Map();

function activeHashIndex(vault: string): ReadonlyMap<string, { agent: string; name: string }> {
  const path = tokenStorePath(vault);
  if (!existsSync(path)) {
    cacheByPath.delete(path);
    return EMPTY_INDEX;
  }
  const stats = statSync(path);
  const cached = cacheByPath.get(path);
  if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.index;
  }
  const index = new Map<string, { agent: string; name: string }>();
  for (const record of Object.values(readTokenStore(vault).tokens)) {
    if (record.status !== "active") continue;
    index.set(record.token_hash, { agent: record.agent, name: record.name });
  }
  cacheByPath.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, index });
  return index;
}

// ----- Audit -----------------------------------------------------------------

function auditToken(
  vault: string,
  action: "mcp_token_minted" | "mcp_token_rotated" | "mcp_token_revoked",
  name: string,
  details: Record<string, unknown>,
): void {
  appendAuditRecord(join(brainDirsForWrite(vault).log, SECRET_CUSTODY_AUDIT_DIR), {
    timestamp: new Date().toISOString(),
    actor: "cli",
    action,
    target: name,
    ok: true,
    details,
  });
}
