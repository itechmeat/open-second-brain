#!/usr/bin/env -S bun
/**
 * SessionStart / PostCompact hook: inject the current `Brain/active.md`
 * digest as `additionalContext` so the agent sees the live set of
 * confirmed and quarantined preferences without explicitly calling
 * `brain_query` first.
 *
 * Contract (identical for Claude Code and Codex):
 *   stdin: hook payload JSON. The vault path is resolved from the
 *     persisted Open Second Brain config (env `VAULT_DIR` → config
 *     `vault:` field), not from the payload — both runtimes route the
 *     hook through the same `o2b-hook` PATH-shim, so this stays
 *     runtime-agnostic.
 *   stdout: JSON of the shape
 *     {
 *       "hookSpecificOutput": {
 *         "hookEventName": "SessionStart" | "PostCompact",
 *         "additionalContext": "<rendered Brain/active.md body>"
 *       }
 *     }
 *
 * Quiet on every failure mode (no config, no vault, no `Brain/active.md`,
 * malformed payload, missing file): the hook exits 0 with no output and
 * the runtime proceeds as if the hook never ran. A SessionStart that
 * silently fails is far less harmful than one that aborts the session
 * with a stderr trace. The agent simply does not get the per-session
 * preferences nudge — exactly the v0.9.0 behaviour.
 */

import { existsSync, readFileSync } from "node:fs";

import { resolveVault } from "../src/core/config.ts";
import { brainActivePath } from "../src/core/brain/paths.ts";
import { asHookPayload, readHookInput } from "./lib/stdin.ts";

async function main(): Promise<void> {
  let payload;
  try {
    payload = asHookPayload(await readHookInput());
  } catch {
    return;
  }

  // The hook is registered separately for each event; the payload's
  // `hook_event_name` tells us which one fired. Echo the same name
  // back unchanged so the runtime correlates request and response
  // — including any future event we have not yet enumerated here.
  // Default to `SessionStart` only when the field is missing entirely
  // (e.g. an empty stdin payload, or a runtime that doesn't populate
  // the name); a coerced unknown value would silently misreport
  // which event fired.
  const hookEventName =
    typeof payload.hook_event_name === "string" && payload.hook_event_name.length > 0
      ? payload.hook_event_name
      : "SessionStart";

  const vault = resolveVault();
  if (vault === null) return;

  const activePath = brainActivePath(vault);
  if (!existsSync(activePath)) return;

  let body: string;
  try {
    body = readFileSync(activePath, "utf8");
  } catch {
    return;
  }

  const trimmed = body.trim();
  if (trimmed.length === 0) return;

  const out = {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: trimmed,
    },
  };
  process.stdout.write(JSON.stringify(out) + "\n");
}

main().catch(() => {
  // Never crash the runtime; the session start should proceed
  // regardless of any hook misbehaviour.
});
