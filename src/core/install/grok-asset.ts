/**
 * Grok Build install artifacts, resolved at install time with ABSOLUTE
 * commands.
 *
 * Verified against live grok 0.2.45 (debug log of a real session): grok spawns
 * MCP servers and hook scripts with a restricted PATH that excludes
 * `~/.local/bin`, so a bare `o2b` / `o2b-hook` command fails with ENOENT and no
 * tools/hooks load. The working form is an absolute command - the bun binary
 * (`process.execPath`) running the repo's entry points by absolute path:
 *
 *   - MCP servers go into `~/.grok/config.toml` `[mcp_servers.*]` (grok's
 *     primary, highest-priority source): `bun run <repo>/src/cli/main.ts mcp …`.
 *   - Lifecycle hooks go into `~/.grok/hooks/open-second-brain.json` (grok's
 *     native, always-trusted hooks dir; plugin-provided hooks are NOT
 *     discovered in-session): `bun run <repo>/hooks/<name>.ts`.
 *
 * Both are grok-native sources, not Claude-compat impersonation.
 */

import { join } from "node:path";

import { OSB_KEY_FULL, OSB_KEY_WRITER } from "./json-merge.ts";
import type { GrokMcpEntry } from "./grok-config.ts";
import type { McpPayload } from "./types.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const MAIN_TS = join(REPO_ROOT, "src", "cli", "main.ts");

/** The bun binary currently running this process - an absolute path. */
function bunBin(): string {
  return process.execPath;
}

export const GROK_HOOKS_FILENAME = "open-second-brain.json";

/**
 * The two MCP server tables to write into `config.toml`, derived from the
 * canonical payload: same `args` and `env`, but the command becomes
 * `bun run <repo>/src/cli/main.ts` (absolute) instead of the PATH-resolved
 * `o2b`, so grok can spawn it in a session.
 */
export function grokMcpServers(payload: McpPayload): Record<string, GrokMcpEntry> {
  const toEntry = (args: ReadonlyArray<string>, env?: Readonly<Record<string, string>>) => ({
    command: bunBin(),
    args: ["run", MAIN_TS, ...args],
    ...(env && Object.keys(env).length > 0 ? { env: { ...env } } : {}),
  });
  return {
    [OSB_KEY_FULL]: toEntry(payload.full.args, payload.full.env),
    [OSB_KEY_WRITER]: toEntry(payload.writer.args, payload.writer.env),
  };
}

/** Build the absolute hook command for a hooks/<name>.ts entry point. */
function hookCommand(name: string): string {
  return `${bunBin()} run ${join(REPO_ROOT, "hooks", `${name}.ts`)}`;
}

interface HookGroupSpec {
  readonly matcher?: string;
  readonly hooks: ReadonlyArray<string>;
}

/**
 * Event -> hook mapping, mirroring the Claude Code plugin's behaviour with
 * grok's rules: lifecycle events (SessionStart, UserPromptSubmit, Stop,
 * SessionEnd) reject a `matcher`, so they carry none; PostToolUse keeps a
 * matcher and lists grok's `search_replace` alongside the Claude tool names.
 */
const HOOK_SPEC: ReadonlyArray<{ event: string; groups: ReadonlyArray<HookGroupSpec> }> = [
  { event: "SessionStart", groups: [{ hooks: ["active-inject", "session-capture"] }] },
  { event: "UserPromptSubmit", groups: [{ hooks: ["session-capture"] }] },
  {
    event: "PostToolUse",
    groups: [
      { matcher: "brain_feedback", hooks: ["session-capture"] },
      {
        matcher: "Write|Edit|MultiEdit|apply_patch|search_replace",
        hooks: ["post-write-reminder"],
      },
    ],
  },
  { event: "Stop", groups: [{ hooks: ["session-capture", "stop-log-guardrail"] }] },
  { event: "SessionEnd", groups: [{ hooks: ["session-capture"] }] },
  { event: "PostCompact", groups: [{ hooks: ["active-inject", "session-capture"] }] },
];

/**
 * The `~/.grok/hooks/open-second-brain.json` content, with absolute bun
 * commands. Generated at install time (machine-specific paths), so `verify`
 * compares the installed file against this exact output.
 */
export function grokHooksJson(): string {
  const hooks: Record<string, unknown[]> = {};
  for (const { event, groups } of HOOK_SPEC) {
    hooks[event] = groups.map((g) => ({
      ...(g.matcher !== undefined ? { matcher: g.matcher } : {}),
      hooks: g.hooks.map((name) => ({
        type: "command",
        command: hookCommand(name),
        timeout: 10,
      })),
    }));
  }
  return JSON.stringify({ hooks }, null, 2) + "\n";
}
