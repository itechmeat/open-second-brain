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
import { parseFrontmatterText } from "../src/core/vault.ts";
import { brainActivePath, brainLessonsPath } from "../src/core/brain/paths.ts";
import { budgetActiveBody } from "../src/core/brain/active-budget.ts";
import { INJECT_BUDGET_CHARS_DEFAULT, loadBrainConfig } from "../src/core/brain/policy.ts";
import { healCliSymlinks } from "../src/cli/install-cli.ts";
import { ensureVaultCurrent } from "../src/core/maintenance/ensure-current.ts";
import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import { isContextEventName } from "./lib/context-events.ts";

async function main(): Promise<void> {
  let payload;
  try {
    payload = asHookPayload(await readHookInput());
  } catch {
    return;
  }

  // The hook is registered separately for each event; the payload's
  // `hook_event_name` tells us which one fired. Default to
  // `SessionStart` only when the field is missing entirely (e.g. an
  // empty stdin payload, or a runtime that doesn't populate the name).
  const hookEventName =
    typeof payload.hook_event_name === "string" && payload.hook_event_name.length > 0
      ? payload.hook_event_name
      : "SessionStart";

  // Default-closed allowlist: only event names whose output schema
  // accepts `additionalContext` may produce stdout. Emitting under
  // any other name (PostCompact included) is rejected by the runtime
  // and echoes the full payload back as a validation error - the
  // post-compaction path is the SessionStart `compact` matcher.
  if (!isContextEventName(hookEventName)) return;

  // Self-heal the ~/.local/bin CLI symlinks on SessionStart only: a plugin
  // update can leave them dangling or pointing at an old version. Runs from
  // the current checkout (resolved via $CLAUDE_PLUGIN_ROOT); strictly
  // best-effort, and gated to SessionStart so PostCompact does not trigger
  // avoidable filesystem side effects. Never affects the injection below.
  if (hookEventName === "SessionStart") {
    try {
      healCliSymlinks();
    } catch {
      // ignore — opportunistic; must never disrupt the session
    }
  }

  const vault = resolveVault();
  if (vault === null) return;

  // Hands-off post-upgrade maintenance on SessionStart: migrate a stale
  // _brain.yaml/_BRAIN.md and rebuild a stale/missing search index (the
  // reindex runs detached so it survives this short-lived hook). Best-effort,
  // never blocks injection. In background mode the synchronous part (brain
  // upgrade + spawning the reindex) completes before this awaits.
  if (hookEventName === "SessionStart") {
    // Fire-and-forget: never put maintenance on the hook's critical path.
    // background:true spawns the reindex detached; we do not await the result.
    void ensureVaultCurrent(vault, { background: true }).catch(() => {
      // opportunistic; must never disrupt the session
    });
  }

  const activePath = brainActivePath(vault);
  if (!existsSync(activePath)) return;

  let body: string;
  try {
    body = readFileSync(activePath, "utf8");
  } catch {
    return;
  }

  // Drop the `kind: brain-active / generated_at` frontmatter - it
  // carries no signal for the agent, only provenance for tooling.
  const [, fmBody] = parseFrontmatterText(body);
  const trimmed = fmBody.trim();
  if (trimmed.length === 0) return;

  // Injection budget (token-diet): a large preference set must not
  // flood the session preamble. Config errors fall back to the
  // default budget - the hook is fail-soft by contract.
  let budget = INJECT_BUDGET_CHARS_DEFAULT;
  try {
    const cfg = loadBrainConfig(vault);
    if (cfg.active?.inject_budget_chars !== undefined) {
      budget = cfg.active.inject_budget_chars;
    }
  } catch {
    // intentional fallback - a corrupted _brain.yaml is doctor's job
  }

  // Auto-load the lessons digest alongside active.md so the agent gets
  // the unified, signed, recency-scored corpus (preferences + dead-ends)
  // on the same SessionStart surface. Fail-soft and budgeted separately:
  // a missing / unreadable / oversized lessons file must never disturb
  // the active-preferences injection above.
  const lessonsBody = readLessonsBody(brainLessonsPath(vault), budget);

  const additionalContext =
    lessonsBody === null
      ? budgetActiveBody(trimmed, budget)
      : `${budgetActiveBody(trimmed, budget)}\n\n${lessonsBody}`;

  const out = {
    hookSpecificOutput: {
      hookEventName,
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(out) + "\n");
}

/**
 * Read and budget the `Brain/lessons.md` body for injection. Returns
 * `null` on any failure mode (missing file, unreadable, empty body) so
 * the caller falls back to injecting active.md alone.
 */
function readLessonsBody(lessonsPath: string, budget: number): string | null {
  if (!existsSync(lessonsPath)) return null;
  try {
    const raw = readFileSync(lessonsPath, "utf8");
    const [, body] = parseFrontmatterText(raw);
    const trimmed = body.trim();
    if (trimmed.length === 0) return null;
    return budgetActiveBody(trimmed, budget);
  } catch {
    return null;
  }
}

main().catch(() => {
  // Never crash the runtime; the session start should proceed
  // regardless of any hook misbehaviour.
});
