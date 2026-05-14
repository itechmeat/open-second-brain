#!/usr/bin/env -S bun
/**
 * PostToolUse hook: emits a soft reminder after Write / Edit /
 * MultiEdit / apply_patch so the agent considers calling
 * `event_log_append` before its final reply.
 *
 * Contract (identical for Claude Code and Codex):
 *   stdin: hook payload JSON with `tool_name`, `tool_input`.
 *   stdout: JSON of the shape
 *     {
 *       "hookSpecificOutput": {
 *         "hookEventName": "PostToolUse",
 *         "additionalContext": "<reminder text>"
 *       }
 *     }
 *   Both runtimes inject `additionalContext` as developer-side
 *   context for the next model call.
 *
 * Quiet on unrelated tools: if the tool name isn't in the artifact
 * set, exit 0 with no output. The matcher in `hooks.json` should
 * already filter most of those out — this is belt-and-suspenders.
 *
 * Quiet on failures: we never block the agent here. If we crash, we
 * exit 0 so the turn proceeds; the Stop guardrail is the gating hook.
 */

import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import { isArtifactToolName } from "./lib/detect.ts";
import { postWriteReminder } from "./lib/messages.ts";

async function main(): Promise<void> {
  let payload;
  try {
    payload = asHookPayload(await readHookInput());
  } catch {
    return;
  }

  const toolName = payload.tool_name;
  if (typeof toolName !== "string" || !isArtifactToolName(toolName)) return;

  // Skip on failed edits: the spec is "after a file-mutating tool
  // SUCCEEDS, remind about logging". Claude Code's `tool_response`
  // carries `is_error: true` on a failed Write/Edit; Codex's
  // `function_call_output` records success differently and is not
  // surfaced here, so we only gate on the Claude shape.
  if (isToolResponseError(payload.tool_response)) return;

  const filePath = extractFilePath(payload.tool_input);
  const text = postWriteReminder({ toolName, filePath });

  const out = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: text,
    },
  };
  process.stdout.write(JSON.stringify(out) + "\n");
}

function isToolResponseError(response: unknown): boolean {
  if (response === null || typeof response !== "object") return false;
  const r = response as Record<string, unknown>;
  return r.is_error === true || r.success === false;
}

function extractFilePath(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  // Claude Code: Write / Edit / MultiEdit all carry `file_path`.
  if (typeof o.file_path === "string") return o.file_path;
  // Codex apply_patch: the patch body is in `input` as a string; we
  // can extract the first `*** Update File:` or `*** Add File:` line.
  if (typeof o.input === "string") {
    const m = /\*\*\* (?:Update File|Add File|Delete File): ([^\n]+)/.exec(o.input);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

main().catch(() => {
  // Never block on hook crash.
});
