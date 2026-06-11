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

// Canonical tool names that mutate files across runtimes.
//   Claude Code: `Write`, `Edit`, `MultiEdit` (native tools — no
//   `mcp__…__` prefix in transcripts).
//   Codex:       `apply_patch` (custom_tool_call wrapping diffs).
//   Grok Build:  `search_replace` (grok's own file-edit tool, the name
//                it aliases Claude's Edit/Write/MultiEdit to and the name
//                that appears in its hook payload and session transcript).
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
  "search_replace",
]);

// Tool-name suffixes that count as "the agent logged this turn",
// regardless of any runtime-injected MCP prefix.
//
// §32 (v0.10.8) retires `event_log_append` and adds `brain_note` as
// the third Brain-native writer (narrative milestones that fit
// neither feedback nor apply-evidence). The set is now
// `brain_feedback` / `brain_apply_evidence` / `brain_note`; any of
// them landing in a turn that produced a durable artifact clears the
// stop guardrail.
//
// Names appear bare in Codex transcripts and decorated as
// `mcp__plugin_<plugin>_<server>__<name>` or `mcp__<server>__<name>`
// in Claude Code transcripts. The regex anchors on either string
// start or a `__` separator so a future prefix change keeps working
// without an emergency patch.
const BRAIN_EVENT_NAME_SUFFIX = /(?:^|__)(brain_feedback|brain_apply_evidence|brain_note)$/;

// Bash command shape that counts as a brain-event call from the CLI.
// Keep this anchored to command boundaries rather than raw substrings:
// generated text like `echo "o2b brain note ..."` must not suppress the
// guardrail. Spawning the MCP server (`o2b mcp …`) does NOT log on its
// own, so it stays out of the matcher — only the explicit event-emitting
// commands are in.
//
// §32 (v0.10.8) drops `o2b append-event` and `vault-log` — those
// still work for human / cron use, but they target the deprecated
// `Daily/` surface and no longer count as a Brain-side event.
const SHELL_ASSIGNMENT = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)`;
const BRAIN_EVENT_BASH_COMMAND_RE = new RegExp(
  String.raw`^(?:env\s+(?:${SHELL_ASSIGNMENT}\s+)*)?(?:${SHELL_ASSIGNMENT}\s+)*o2b\s+brain\s+(?:apply-evidence|feedback|note)(?:\s|$)`,
);

function splitShellCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === "\\") {
        const next = command[i + 1];
        if (next !== undefined) {
          current += next;
          i += 1;
        }
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "\\") {
      // Outside-quotes backslash escapes the next character. Preserve
      // both so an escaped separator (`echo \; o2b brain note ...`)
      // does not split the segment.
      current += ch;
      const next = command[i + 1];
      if (next !== undefined) {
        current += next;
        i += 1;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|") {
      segments.push(current);
      current = "";
      if (command[i + 1] === ch) i += 1;
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

export function isArtifactToolName(name: string): boolean {
  return NATIVE_ARTIFACT_NAMES.has(name);
}

/**
 * True when `name` is one of the three brain-event tools (or a
 * runtime-decorated form thereof). §32 (v0.10.8) replaces the
 * v0.10.6 set: `event_log_append` is retired; `brain_note` is added.
 */
export function isBrainEventToolName(name: string): boolean {
  return BRAIN_EVENT_NAME_SUFFIX.test(name);
}

export interface TurnSummary {
  readonly hadArtifact: boolean;
  /**
   * True when any of `brain_feedback`, `brain_apply_evidence`, or
   * `brain_note` (MCP call or CLI invocation) landed in this turn.
   * §32 (v0.10.8): `event_log_append` no longer counts.
   */
  readonly hadBrainEvent: boolean;
}

export function summarizeTurn(
  toolCalls: readonly ToolCall[],
  bashCommandsThisTurn: readonly string[] = [],
): TurnSummary {
  let hadArtifact = false;
  let hadBrainEvent = false;
  for (const tc of toolCalls) {
    if (isArtifactToolName(tc.name)) hadArtifact = true;
    if (isBrainEventToolName(tc.name)) hadBrainEvent = true;
  }
  if (!hadBrainEvent) {
    for (const cmd of bashCommandsThisTurn) {
      if (
        splitShellCommandSegments(cmd).some((segment) =>
          BRAIN_EVENT_BASH_COMMAND_RE.test(segment.trim()),
        )
      ) {
        hadBrainEvent = true;
        break;
      }
    }
  }
  return { hadArtifact, hadBrainEvent };
}

// ---- Runtime detection (§4-tail) ---------------------------------------

/**
 * Which runtime is invoking the hook. `unknown` is the fail-safe and
 * renders byte-identical reminder text to the v0.10.4 baseline, so
 * a future runtime that breaks both signals never crashes the hook.
 */
export type HookRuntime = "claudecode" | "codex" | "grok" | "unknown";

const CLAUDE_TRANSCRIPT_NEEDLES = ["/.claude/projects/", "/.claude/sessions/"] as const;
const CODEX_TRANSCRIPT_NEEDLE = "/.codex/sessions/";

/**
 * Infer the runtime from a hook payload by shape. First-hit wins,
 * order matches the design doc:
 *
 *   1. Grok: camelCase payload shape (`hookEventName` / `workspaceRoot`) or a
 *      `GROK_*` hook env var. Grok ships no `transcript_path` and uses
 *      camelCase keys Claude/Codex never send, so this is unambiguous.
 *   2. `transcript_path` substring (`/.claude/projects/`, `/.claude/sessions/`).
 *   3. `transcript_path` substring (`/.codex/sessions/`).
 *   4. Claude Code distinctive triple (`session_id` + `cwd` + `tool_use_id`).
 *   5. Codex apply_patch shape (`tool_name === "apply_patch"` with
 *      a patch body in `tool_input.input`).
 *   6. `"unknown"`.
 *
 * `normalizeHookPayload` preserves grok's original camelCase keys, so this
 * works whether it runs before or after normalization. Malformed payloads
 * (`null`, primitives, missing fields, wrong types) resolve to `"unknown"`
 * without throwing — the hook never crashes on detection.
 */
export function detectHookRuntime(
  payload: unknown,
  env: Record<string, string | undefined> = process.env,
): HookRuntime {
  if (payload === null || typeof payload !== "object") return "unknown";
  const p = payload as Record<string, unknown>;

  if (typeof p["hookEventName"] === "string" || typeof p["workspaceRoot"] === "string") {
    return "grok";
  }
  if (env["GROK_HOOK_EVENT"] || env["GROK_SESSION_ID"] || env["GROK_WORKSPACE_ROOT"]) {
    return "grok";
  }

  const tp = p["transcript_path"];
  if (typeof tp === "string") {
    if (CLAUDE_TRANSCRIPT_NEEDLES.some((n) => tp.includes(n))) {
      return "claudecode";
    }
    if (tp.includes(CODEX_TRANSCRIPT_NEEDLE)) return "codex";
  }

  if (
    typeof p["session_id"] === "string" &&
    typeof p["cwd"] === "string" &&
    typeof p["tool_use_id"] === "string"
  ) {
    return "claudecode";
  }

  if (p["tool_name"] === "apply_patch") {
    const ti = p["tool_input"];
    if (ti !== null && typeof ti === "object") {
      const input = (ti as Record<string, unknown>)["input"];
      if (typeof input === "string" && input.includes("*** Begin Patch")) {
        return "codex";
      }
    }
  }

  return "unknown";
}
