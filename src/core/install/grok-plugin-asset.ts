/**
 * Bundled Grok Build plugin asset.
 *
 * The grok plugin is a small static tree under
 * `plugins/grok/open-second-brain/` (`plugin.json`, `.mcp.json`,
 * `hooks/hooks.json`). The install adapter copies these committed files
 * verbatim into the install location; `verify` compares the installed copy
 * against them. They are formatted by the project formatter like any other
 * committed file, so they are the canonical bytes.
 *
 * To keep the grok MCP and hook wiring from silently drifting away from the
 * canonical Claude plugin sources (`./.mcp.json`, `./hooks/hooks.json` at the
 * repo root), this module also exposes the EXPECTED grok shape as the Claude
 * sources put through an explicit transform. `tests/plugins/grok-plugin.test.ts`
 * asserts the committed files match that transform (semantically), the same
 * source-of-truth-plus-guard model the version-sync script uses. The
 * `plugin.json` version is mirrored from `package.json` by
 * `scripts/sync-version.ts`.
 *
 * Why the transform diverges from the Claude sources (verified against grok
 * 0.2.45 bundled docs):
 * - A thin plugin cannot embed `scripts/o2b` (o2b needs the whole repo), so
 *   the MCP `command` resolves `o2b` from PATH instead of
 *   `${CLAUDE_PLUGIN_ROOT}/scripts/o2b`, and Claude-only keys such as
 *   `alwaysLoad` are dropped. `o2b mcp` resolves the vault from the persisted
 *   config, so the entry stays vault-agnostic.
 * - Grok rejects a `matcher` on the lifecycle events SessionStart, SessionEnd,
 *   Stop, and UserPromptSubmit, so the transform strips it there.
 * - Grok aliases the Claude file-mutating tool names to `search_replace`, so
 *   the PostToolUse matcher gains that alternative. Hook commands are otherwise
 *   identical: their `$CLAUDE_PLUGIN_ROOT`-then-PATH fallback resolves
 *   `o2b-hook` under grok (which sets the `CLAUDE_PLUGIN_ROOT` alias).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import packageJson from "../../../package.json";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

export const GROK_PLUGIN_DIR_NAME = "open-second-brain";

/** The committed plugin tree, relative to {@link grokPluginSourceDir}. */
export const GROK_PLUGIN_REL_PATHS = Object.freeze([
  "plugin.json",
  ".mcp.json",
  "hooks/hooks.json",
]);

/** Events on which grok rejects a `matcher` (passive lifecycle events). */
const MATCHER_REJECTING_EVENTS = new Set([
  "SessionStart",
  "SessionEnd",
  "Stop",
  "UserPromptSubmit",
]);

/** grok's aliased name for the Claude file-mutating tools (Edit/Write/MultiEdit). */
const GROK_FILE_MUTATING_ALIAS = "search_replace";

/** Absolute path to the committed grok plugin source tree. */
export function grokPluginSourceDir(): string {
  return join(REPO_ROOT, "plugins", "grok", GROK_PLUGIN_DIR_NAME);
}

function readRepoJson(relPath: string): Record<string, unknown> {
  const raw = readFileSync(join(REPO_ROOT, relPath), "utf8");
  const parsed: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`grok-plugin-asset: ${relPath} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Expected `plugin.json` content. Mirrors the fields of the Claude plugin
 * manifest so the two stay recognizable, with the version from `package.json`.
 */
export function expectedManifest(): Record<string, unknown> {
  return {
    name: GROK_PLUGIN_DIR_NAME,
    version: packageJson.version,
    description: "Open Second Brain: agent-owned Markdown second brain for Grok Build.",
    author: { name: "Open Second Brain contributors" },
    license: "MIT",
    homepage: "https://github.com/itechmeat/open-second-brain",
    repository: "https://github.com/itechmeat/open-second-brain",
    keywords: ["second-brain", "obsidian", "agents", "skills", "event-log", "mcp"],
  };
}

/**
 * Expected `.mcp.json` content: the canonical `./.mcp.json` with each server's
 * `command` resolved from PATH and Claude-only keys dropped.
 */
export function expectedMcp(): Record<string, unknown> {
  const servers = readRepoJson(".mcp.json")["mcpServers"];
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error("grok-plugin-asset: .mcp.json has no mcpServers object");
  }
  const rendered: Record<string, { command: string; args: string[] }> = {};
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`grok-plugin-asset: .mcp.json server '${name}' is not an object`);
    }
    const args = (entry as Record<string, unknown>)["args"];
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
      throw new Error(`grok-plugin-asset: .mcp.json server '${name}' has no string args array`);
    }
    rendered[name] = { command: "o2b", args: [...(args as string[])] };
  }
  return { mcpServers: rendered };
}

interface HookGroup {
  matcher?: string;
  hooks: unknown[];
}

/**
 * Expected `hooks/hooks.json` content: the canonical `./hooks/hooks.json` with
 * the `matcher` stripped on events where grok rejects one and grok's
 * `search_replace` alias added to the PostToolUse file-mutating matcher.
 */
export function expectedHooks(): Record<string, unknown> {
  const hooks = readRepoJson("hooks/hooks.json")["hooks"];
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error("grok-plugin-asset: hooks/hooks.json has no hooks object");
  }
  const rendered: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      throw new Error(`grok-plugin-asset: hooks event '${event}' is not an array`);
    }
    rendered[event] = (groups as HookGroup[]).map((group) => transformHookGroup(event, group));
  }
  return { hooks: rendered };
}

function transformHookGroup(event: string, group: HookGroup): HookGroup {
  const { matcher, ...rest } = group;
  if (MATCHER_REJECTING_EVENTS.has(event)) {
    return { ...rest };
  }
  if (event === "PostToolUse" && matcher !== undefined && matcher.includes("Write")) {
    return { matcher: addGrokAlias(matcher), ...rest };
  }
  return matcher === undefined ? { ...rest } : { matcher, ...rest };
}

function addGrokAlias(matcher: string): string {
  const parts = matcher.split("|");
  return parts.includes(GROK_FILE_MUTATING_ALIAS)
    ? matcher
    : [...parts, GROK_FILE_MUTATING_ALIAS].join("|");
}

export interface GrokPluginFile {
  readonly relPath: string;
  readonly content: string;
}

/**
 * The committed plugin files (verbatim bytes) the install adapter copies into
 * the install location and `verify` compares against.
 */
export function readGrokPluginFiles(): GrokPluginFile[] {
  const dir = grokPluginSourceDir();
  return GROK_PLUGIN_REL_PATHS.map((relPath) => ({
    relPath,
    content: readFileSync(join(dir, relPath), "utf8"),
  }));
}
