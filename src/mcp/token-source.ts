/**
 * Where the MCP transport reads the per-agent token map (design D14 item
 * 15, task 2.10): from device config, so a server with no vault still
 * enforces `mcp_tokens_required` and the non-loopback bind rule, with a
 * fallback to the per-vault file every install wrote before the store.
 *
 *  - The device-config copy is `mcp-tokens.json` beside the machine
 *    config file. It has the per-vault file's format and is hash-at-rest
 *    like it (`core/brain/secrets/token-store.ts`); the migration copies
 *    the per-vault file there (D14.15).
 *  - The token map follows the writers (`core/brain/secrets/token-store.ts`):
 *    on a switched machine minting, rotation and revocation write the
 *    device-config copy, so a server reads that copy once it exists (the
 *    per-vault file until the first write on the switch). On an
 *    unswitched machine the writers write the per-vault file and a server
 *    with a vault reads it always; a stale device copy beside it is never
 *    consulted, so a revocation lands on the next request.
 *  - A server with no vault reads the device-config copy when it exists,
 *    and has no tokens otherwise. A rollback takes the copy the migration
 *    made away, so the per-vault file is the token map once more.
 */

import {
  hasAnyAgentTokenAt,
  resolveAgentForTokenAt,
  tokenMapReadPath,
} from "../core/brain/secrets/token-store.ts";

export {
  DEVICE_TOKEN_FILE,
  deviceTokenStorePath,
} from "../core/brain/secrets/device-token-path.ts";

/** What the token map is read for. */
export interface TokenSourceContext {
  /** The vault served, or `null` for none. */
  readonly vault: string | null;
  /** The machine config; its directory holds the device-config token map. */
  readonly configPath?: string | null;
}

/**
 * The token file the transport reads, or `null` when there is none to
 * read: the writers' own rule (`tokenMapReadPath`), with the server's
 * machine config. A mode check that fails throws, and the transport
 * refuses the request rather than read a map a revocation may have missed.
 */
export function tokenSourcePath(context: TokenSourceContext): string | null {
  return tokenMapReadPath(context.vault, context.configPath);
}

/** Whether any agent token is minted in the token map the transport reads. */
export function hasAnyMcpToken(context: TokenSourceContext): boolean {
  const path = tokenSourcePath(context);
  return path !== null && hasAnyAgentTokenAt(path);
}

/** Resolve a presented credential against the token map the transport reads. */
export function resolveMcpToken(
  context: TokenSourceContext,
  presented: string,
): { agent: string; name: string } | null {
  const path = tokenSourcePath(context);
  return path === null ? null : resolveAgentForTokenAt(path, presented);
}
