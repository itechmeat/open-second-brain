/**
 * `o2b mcp token` (write-side-trust, Task 14).
 *
 * The management sub-dispatcher riding the `mcp` command: mint, rotate,
 * revoke, and list the named per-agent MCP tokens. This is the store's
 * operator surface - the transport reads the same store per request, so
 * a rotation or revocation here lands on a running server's NEXT
 * request with no restart.
 *
 *   o2b mcp token mint --agent codex [--name mcp_token_codex]
 *   o2b mcp token rotate --name mcp_token_codex
 *   o2b mcp token revoke --name mcp_token_codex
 *   o2b mcp token list
 *
 * The material of a mint or rotation is printed exactly once with a
 * shown-once notice; `list` prints metadata only, because the store
 * holds only hashes and prefixes. Exit codes follow the same table
 * style as the install verbs: 0 ok, 1 runtime (unknown name, refused
 * mint), 2 usage (bad verb, missing flag, no vault).
 */

import { defaultConfigPath, resolveVault } from "../../core/config.ts";
import { VAULT_NOT_CONFIGURED_REASON } from "../../core/install/env.ts";
import {
  isValidMcpTokenName,
  listAgentTokens,
  McpTokenStoreError,
  mintAgentToken,
  revokeAgentToken,
  rotateAgentToken,
} from "../../core/brain/secrets/token-store.ts";
import { CliError, parseFlags } from "../argparse.ts";

/** Every code this dispatcher can return, named once. */
export const TOKEN_EXIT = Object.freeze({
  ok: 0,
  runtimeError: 1,
  usage: 2,
} as const);

export const MCP_TOKEN_VERBS: ReadonlyArray<string> = Object.freeze([
  "mint",
  "rotate",
  "revoke",
  "list",
]);

const SHOWN_ONCE_NOTICE =
  "Copy it now; reference it from the agent's environment or a $secret:NAME store entry. " +
  "Never a harness config file.";

function usage(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return TOKEN_EXIT.usage;
}

function storeFailure(e: unknown): number {
  if (e instanceof McpTokenStoreError) {
    process.stderr.write(`error: ${e.message}\n`);
    return TOKEN_EXIT.runtimeError;
  }
  throw e;
}

/** One parsed verb's flags, exactly the value shapes `parseFlags` produces. */
type TokenFlags = Map<string, string | boolean | string[] | undefined>;

/** The vault the verb acts on: `--vault`, else the canonical resolver. */
function vaultFromFlags(flags: TokenFlags): string {
  const config = (flags.get("config") as string | undefined) ?? defaultConfigPath();
  return (flags.get("vault") as string | undefined) ?? resolveVault(config) ?? "";
}

/**
 * The verb's own flag parser: one pass over argv with the verb's whole
 * schema (its flags plus the vault-addressing pair), so an unknown flag
 * is a named refusal and the vault is read from the SAME parse - a
 * second narrow parse would re-see the verb's flags and reject them.
 */
function parseVerbFlags(
  argv: string[],
  schema: Record<string, { type: "string" | "boolean" }>,
): TokenFlags {
  const { flags, positional } = parseFlags(argv, {
    ...schema,
    vault: { type: "string" },
    config: { type: "string" },
  });
  if (positional.length > 0) {
    throw new CliError(`does not accept positional arguments: ${positional.join(" ")}`);
  }
  return new Map(Object.entries(flags));
}

export async function handleMcpTokenCommand(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.length === 0) {
    return usage(`o2b mcp token requires a verb: ${MCP_TOKEN_VERBS.join(", ")}`);
  }
  const verb = argv[0]!;
  const rest = argv.slice(1);
  switch (verb) {
    case "mint":
      return tokenMint(rest);
    case "rotate":
      return tokenRotate(rest);
    case "revoke":
      return tokenRevoke(rest);
    case "list":
      return tokenList(rest);
    default:
      return usage(
        `unknown mcp token verb: ${verb}. Expected one of: ${MCP_TOKEN_VERBS.join(", ")}`,
      );
  }
}

function tokenMint(argv: string[]): number {
  let flags: TokenFlags;
  try {
    flags = parseVerbFlags(argv, {
      agent: { type: "string" },
      name: { type: "string" },
      vault: { type: "string" },
      config: { type: "string" },
    });
  } catch (e) {
    if (e instanceof CliError) return usage(e.message);
    throw e;
  }
  const vault = vaultFromFlags(flags);
  if (vault === "") return usage(`o2b mcp token mint: ${VAULT_NOT_CONFIGURED_REASON}`);
  const agent = (flags.get("agent") as string | undefined)?.trim() ?? "";
  if (agent === "") return usage("o2b mcp token mint requires --agent <name>");
  const explicitName = (flags.get("name") as string | undefined)?.trim() ?? "";
  const name = explicitName !== "" ? explicitName : deriveTokenName(agent);
  if (!isValidMcpTokenName(name)) {
    return usage(
      `token name must be mcp_token_<slug> (lowercase [a-z0-9_]), got: ${JSON.stringify(name)}`,
    );
  }
  let tokenMaterial: string;
  let record: ReturnType<typeof mintAgentToken>["record"];
  try {
    ({ tokenMaterial, record } = mintAgentToken(vault, name, agent));
  } catch (e) {
    return storeFailure(e);
  }
  process.stdout.write(
    `token: ${record.name} minted for agent ${JSON.stringify(record.agent)} - ` +
      "shown exactly once, stored only as a hash\n" +
      `  ${tokenMaterial}\n` +
      `  ${SHOWN_ONCE_NOTICE}\n`,
  );
  return TOKEN_EXIT.ok;
}

function tokenRotate(argv: string[]): number {
  let flags: TokenFlags;
  try {
    flags = parseVerbFlags(argv, {
      name: { type: "string" },
      vault: { type: "string" },
      config: { type: "string" },
    });
  } catch (e) {
    if (e instanceof CliError) return usage(e.message);
    throw e;
  }
  const vault = vaultFromFlags(flags);
  if (vault === "") return usage(`o2b mcp token rotate: ${VAULT_NOT_CONFIGURED_REASON}`);
  const name = (flags.get("name") as string | undefined)?.trim() ?? "";
  if (name === "") return usage("o2b mcp token rotate requires --name <mcp_token_...>");
  let tokenMaterial: string;
  let record: ReturnType<typeof rotateAgentToken>["record"];
  try {
    ({ tokenMaterial, record } = rotateAgentToken(vault, name));
  } catch (e) {
    return storeFailure(e);
  }
  process.stdout.write(
    `token: ${record.name} rotated for agent ${JSON.stringify(record.agent)} - the previous ` +
      "material stops authenticating on the next request; the new material is shown exactly " +
      "once, stored only as a hash\n" +
      `  ${tokenMaterial}\n` +
      `  ${SHOWN_ONCE_NOTICE}\n`,
  );
  return TOKEN_EXIT.ok;
}

function tokenRevoke(argv: string[]): number {
  let flags: TokenFlags;
  try {
    flags = parseVerbFlags(argv, {
      name: { type: "string" },
      vault: { type: "string" },
      config: { type: "string" },
    });
  } catch (e) {
    if (e instanceof CliError) return usage(e.message);
    throw e;
  }
  const vault = vaultFromFlags(flags);
  if (vault === "") return usage(`o2b mcp token revoke: ${VAULT_NOT_CONFIGURED_REASON}`);
  const name = (flags.get("name") as string | undefined)?.trim() ?? "";
  if (name === "") return usage("o2b mcp token revoke requires --name <mcp_token_...>");
  let revoked: boolean;
  try {
    revoked = revokeAgentToken(vault, name);
  } catch (e) {
    return storeFailure(e);
  }
  if (!revoked) {
    process.stderr.write(`error: token ${JSON.stringify(name)} not found or already revoked\n`);
    return TOKEN_EXIT.runtimeError;
  }
  process.stdout.write(
    `token: ${name} revoked; the material stops authenticating on the next request\n`,
  );
  return TOKEN_EXIT.ok;
}

function tokenList(argv: string[]): number {
  let flags: TokenFlags;
  try {
    flags = parseVerbFlags(argv, {
      vault: { type: "string" },
      config: { type: "string" },
    });
  } catch (e) {
    if (e instanceof CliError) return usage(e.message);
    throw e;
  }
  const vault = vaultFromFlags(flags);
  if (vault === "") return usage(`o2b mcp token list: ${VAULT_NOT_CONFIGURED_REASON}`);
  const records = listAgentTokens(vault);
  if (records.length === 0) {
    process.stdout.write("tokens: no tokens minted\n");
    return TOKEN_EXIT.ok;
  }
  const width = Math.max(...records.map((r) => r.name.length));
  const lines = records.map((r) => {
    const rotated = r.rotated_at !== undefined ? ` rotated ${r.rotated_at}` : "";
    return (
      `  ${r.name.padEnd(width)}  ${r.status.padEnd(7)}  ${r.agent}  ${r.token_prefix}  ` +
      `created ${r.created_at}${rotated}`
    );
  });
  process.stdout.write(`tokens (${records.length})\n${lines.join("\n")}\n`);
  return TOKEN_EXIT.ok;
}

/** `mcp_token_<slug>`: the agent name lowercased, non-grammar runs dashed to underscores. */
function deriveTokenName(agent: string): string {
  return `mcp_token_${agent.toLowerCase().replaceAll(/[^a-z0-9_]+/g, "_")}`;
}
