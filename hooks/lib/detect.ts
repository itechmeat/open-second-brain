/**
 * Tool-name classifiers shared by the PostToolUse reminder and the Stop
 * guardrail. Names match what Claude Code and Codex actually put on the
 * wire (verified against live transcripts under `~/.claude/projects/**`
 * and `~/.codex/sessions/**`).
 *
 * Why a single shared module: the guardrail's correctness rests on
 * counting the same set of names that the PostToolUse reminder fires
 * for, and the same set of names that count as logging. Drifting these
 * lists into separate hook scripts would let the guardrail block on a
 * tool the reminder never warned about, or skip a log call the user
 * actually made.
 */

import type { ToolCall } from "./transcript.ts";

// Canonical tool names that mutate files in either runtime.
//   Claude Code: `Write`, `Edit`, `MultiEdit` (native tools — no
//   `mcp__…__` prefix in transcripts).
//   Codex:       `apply_patch` (custom_tool_call wrapping diffs).
//
// Codex also supports Edit/Write *aliases* in matchers, but the actual
// `name` field in the transcript is always `apply_patch` for file
// edits done through it; we still accept Edit/Write to defend against
// a future runtime that mirrors the matcher alias into the call name.
const NATIVE_ARTIFACT_NAMES = new Set<string>([
  "Write",
  "Edit",
  "MultiEdit",
  "apply_patch",
]);

// Tool-name suffixes that mean "the agent logged this turn", regardless
// of any runtime-injected MCP prefix:
//   Codex:        `event_log_append` (bare; verified live).
//   Claude Code:  `mcp__plugin_open-second-brain_open-second-brain__event_log_append`
//                 (the runtime decorates plugin-provided MCP tools with
//                 `mcp__plugin_<plugin>_<server>__` — verified live in
//                 `~/.claude/projects/-root/*.jsonl`).
//
// We match the trailing `event_log_append` token after either the start
// of the name or a `__` separator so any future prefix change (Claude
// has rebranded this twice in two months) keeps working without an
// emergency patch.
const LOG_NAME_SUFFIX = /(?:^|__)event_log_append$/;

// Bash command substrings that indicate the agent called the CLI
// equivalent of `event_log_append`. We deliberately keep this list
// narrow: anything matched here suppresses the guardrail.
const LOG_BASH_NEEDLES = [
  "o2b append-event",
  "vault-log ", // trailing space distinguishes the CLI from a literal log path
  "o2b mcp", // running the MCP server itself counts as plugin work
];

export function isArtifactToolName(name: string): boolean {
  return NATIVE_ARTIFACT_NAMES.has(name);
}

export function isLogToolName(name: string): boolean {
  return LOG_NAME_SUFFIX.test(name);
}

export interface TurnSummary {
  readonly hadArtifact: boolean;
  readonly hadLog: boolean;
}

export function summarizeTurn(
  toolCalls: readonly ToolCall[],
  bashCommandsThisTurn: readonly string[] = [],
): TurnSummary {
  let hadArtifact = false;
  let hadLog = false;
  for (const tc of toolCalls) {
    if (isArtifactToolName(tc.name)) hadArtifact = true;
    if (isLogToolName(tc.name)) hadLog = true;
  }
  if (!hadLog) {
    for (const cmd of bashCommandsThisTurn) {
      if (LOG_BASH_NEEDLES.some((n) => cmd.includes(n))) {
        hadLog = true;
        break;
      }
    }
  }
  return { hadArtifact, hadLog };
}
