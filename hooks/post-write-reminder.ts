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

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import { detectHookRuntime, isArtifactToolName } from "./lib/detect.ts";
import { postWriteNudge, postWriteReminder } from "./lib/messages.ts";

/** Markers older than this are pruned opportunistically. */
const MARKER_TTL_MS = 48 * 3600 * 1000;

function markerStateDir(): string {
  const override = process.env["O2B_REMINDER_STATE_DIR"];
  return override && override.length > 0 ? override : join(tmpdir(), "o2b-reminder-markers");
}

/**
 * Record that the full reminder was shown for `sessionId`; returns
 * true when a marker already existed (steady state). Best-effort and
 * fail-soft: any IO problem reports "not seen yet", so the caller
 * falls back to the full reminder - over-reminding is safer than
 * never teaching the contract.
 */
function sessionAlreadyReminded(sessionId: string): boolean {
  try {
    const dir = markerStateDir();
    const name = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
    // "." and ".." survive the character filter but resolve to the
    // state dir / its parent - treat them as "no usable session id".
    if (/^\.{1,2}$/.test(name)) return false;
    const marker = join(dir, name);
    if (existsSync(marker)) return true;
    mkdirSync(dir, { recursive: true });
    pruneStaleMarkers(dir);
    writeFileSync(marker, "", "utf8");
    return false;
  } catch {
    return false;
  }
}

function pruneStaleMarkers(dir: string): void {
  try {
    const cutoff = Date.now() - MARKER_TTL_MS;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
      } catch {
        // a vanished marker is fine
      }
    }
  } catch {
    // pruning is opportunistic
  }
}

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
  const runtime = detectHookRuntime(payload);

  // Session cadence (token-diet, t_9cc4f400): the full reminder
  // teaches the contract once per Claude Code session; afterwards a
  // <= 200-char nudge keeps the per-edit cost negligible. Codex
  // `codex exec` is one-shot, so steady state never applies there;
  // unknown runtimes and absent session ids stay on the full text.
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  const steadyState =
    runtime === "claudecode" && sessionId.length > 0 && sessionAlreadyReminded(sessionId);

  const text = steadyState ? postWriteNudge() : postWriteReminder({ toolName, filePath, runtime });

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
