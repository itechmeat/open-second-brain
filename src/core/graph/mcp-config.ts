/**
 * MCP-config extraction into the graph (typed graph semantics, unit 4).
 *
 * Parses Model Context Protocol server config files found in the vault
 * into a typed landscape - which servers are configured, the packages
 * they pull, and the env-var names they require. Environment VALUES are
 * never read, so no secret can leak into the graph.
 *
 * Discovery is vault-relative and recompute-on-demand (no cache),
 * matching the Brain-layer backlink index. It is NOT folded into the
 * search `links` table: a `.json` config file is not a Markdown
 * document, and the links table keys edges to a `documents` row.
 *
 * Identifiers (server / package / env names) are opaque tokens; nothing
 * here hardcodes a natural-language phrase.
 */

import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

/** The config filenames recognised across common MCP hosts. */
export const MCP_CONFIG_FILENAMES: ReadonlyArray<string> = Object.freeze([
  ".mcp.json",
  "mcp.json",
  "mcp_servers.json",
  "claude_desktop_config.json",
]);

const FILENAME_SET = new Set<string>(MCP_CONFIG_FILENAMES);

/** Directories never descended into during discovery. */
const SKIP_DIRS = new Set<string>([
  ".git",
  ".obsidian",
  ".trash",
  ".stversions",
  "node_modules",
  ".open-second-brain",
]);

/** Commands that take a package reference as their first non-flag argument. */
const PACKAGE_RUNNERS = new Set<string>(["npx", "bunx", "pnpx", "uvx", "pipx"]);
/** Sub-command runners (`<tool> dlx <pkg>`, `<tool> exec <pkg>`). */
const SUBCOMMAND_RUNNERS = new Set<string>(["pnpm", "yarn", "bun", "deno", "uv"]);
const RUNNER_SUBCOMMANDS = new Set<string>(["dlx", "exec", "run", "x"]);

export interface McpServerEntry {
  /** Server key from the config object. */
  readonly name: string;
  /** Vault-relative path of the config file that declared it. */
  readonly source: string;
  /** Package references the server pulls (npm/pip style). Names only. */
  readonly packages: string[];
  /** Env-var NAMES the server requires. Values are never read. */
  readonly env: string[];
}

/** True when `path`'s basename is a recognised MCP config filename. */
export function isMcpConfigFile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return FILENAME_SET.has(base);
}

function serversObject(parsed: unknown): Record<string, unknown> {
  if (typeof parsed !== "object" || parsed === null) return {};
  const obj = parsed as Record<string, unknown>;
  const block = obj["mcpServers"] ?? obj["servers"];
  if (typeof block !== "object" || block === null) return {};
  return block as Record<string, unknown>;
}

function isFlag(arg: string): boolean {
  return arg.startsWith("-");
}

/** First non-flag argument from a runner's args (the package reference). */
function packageFromArgs(command: string, args: string[]): string[] {
  let rest = args;
  if (SUBCOMMAND_RUNNERS.has(command)) {
    // `pnpm dlx <pkg>`, `yarn dlx <pkg>`, `uv tool run <pkg>`, …
    const first = args.find((a) => !isFlag(a));
    if (first === undefined || !RUNNER_SUBCOMMANDS.has(first)) return [];
    rest = args.slice(args.indexOf(first) + 1);
  } else if (!PACKAGE_RUNNERS.has(command)) {
    // A bare binary (node, python, docker, a local path) - no package.
    return [];
  }
  const pkg = rest.find((a) => !isFlag(a));
  return pkg ? [pkg] : [];
}

function parseServer(name: string, def: unknown, source: string): McpServerEntry {
  const packages: string[] = [];
  const env: string[] = [];
  if (typeof def === "object" && def !== null) {
    const d = def as Record<string, unknown>;
    const command = typeof d["command"] === "string" ? (d["command"] as string) : null;
    const args = Array.isArray(d["args"]) ? d["args"].filter((a): a is string => typeof a === "string") : [];
    if (command) packages.push(...packageFromArgs(command, args));
    const envObj = d["env"];
    if (typeof envObj === "object" && envObj !== null) {
      // Keys only - values are deliberately never read.
      env.push(...Object.keys(envObj as Record<string, unknown>));
    }
  }
  return { name, source, packages, env };
}

/** Parse one MCP config file's text into its declared server entries. */
export function parseMcpConfig(jsonText: string, source: string): McpServerEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const servers = serversObject(parsed);
  return Object.entries(servers).map(([name, def]) => parseServer(name, def, source));
}

function findConfigFiles(vault: string): string[] {
  const found: string[] = [];
  const walk = (absDir: string, relDir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(absDir, entry.name), rel);
      } else if (entry.isFile() && FILENAME_SET.has(entry.name)) {
        found.push(rel);
      }
    }
  };
  try {
    if (!statSync(vault).isDirectory()) return [];
  } catch {
    return [];
  }
  walk(vault, "");
  return found.sort();
}

export interface McpLandscape {
  readonly servers: McpServerEntry[];
}

/**
 * Scan the vault for MCP config files and return the configured server
 * landscape. Recompute-on-demand; never throws on a malformed or
 * unreadable file (those contribute nothing).
 */
export function buildMcpLandscape(vault: string): McpLandscape {
  const servers: McpServerEntry[] = [];
  for (const rel of findConfigFiles(vault)) {
    let text: string;
    try {
      text = readFileSync(join(vault, rel), "utf8");
    } catch {
      continue;
    }
    servers.push(...parseMcpConfig(text, rel));
  }
  return { servers };
}
