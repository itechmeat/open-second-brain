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
import { join } from "node:path";

import { resolveVault } from "../src/core/config.ts";
import { parseFrontmatterText } from "../src/core/vault.ts";
import { brainActivePath, brainLessonsPath } from "../src/core/brain/paths.ts";
import { budgetActiveBody } from "../src/core/brain/active-budget.ts";
import { INJECT_BUDGET_CHARS_DEFAULT, loadBrainConfig } from "../src/core/brain/policy.ts";
import { healCliSymlinks } from "../src/cli/install-cli.ts";
import { ensureVaultCurrent } from "../src/core/maintenance/ensure-current.ts";
import { armProcessCeiling, resolveHookCeilingMs } from "./lib/process-ceiling.ts";
import { appendAuditRecord } from "../src/core/reliability/audit.ts";
import { loadInjectContextFailOpen } from "../src/core/brain/inject-failopen.ts";
import { collectRuntimeNotices, renderRuntimeNotices } from "../src/core/brain/runtime-notices.ts";
import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import { isContextEventName } from "./lib/context-events.ts";

/**
 * Best-effort hook audit line. Never throws: a failure to record must never
 * disturb the fail-soft hook contract, and a hung filesystem is exactly when
 * this runs, so it is wrapped defensively.
 */
function auditHook(vault: string | null, action: string, details: Record<string, unknown>): void {
  if (vault === null) return;
  try {
    appendAuditRecord(join(vault, ".open-second-brain", "hook-audit"), {
      timestamp: new Date().toISOString(),
      actor: "active-inject",
      action,
      target: "SessionStart",
      ok: false,
      details,
    });
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  // Arm the process self-watchdog first so a hang anywhere below (vault
  // resolution, a stalled read, an overrunning assembly) still self-terminates
  // at the ceiling with a clean exit instead of orphaning the hook process.
  let auditVault: string | null = null;
  const disarm = armProcessCeiling({
    ceilingMs: resolveHookCeilingMs(),
    onExpire: () => auditHook(auditVault, "hook_ceiling_exceeded", { hook: "active-inject" }),
  });
  try {
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
    auditVault = vault;

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

    // Fail-open context load: assemble the injected body inside a guard that
    // degrades to the last-good cache (or empty) on any error, never emitting
    // a partial or poisoned payload. A successful non-empty body refreshes the
    // last-good snapshot.
    const { context } = await loadInjectContextFailOpen({
      vault,
      key: "active",
      assemble: () => assembleActiveContext(vault),
      audit: (source) =>
        auditHook(vault, "inject_failopen_degraded", { hook: "active-inject", source }),
    });
    if (context.length === 0) return;

    const out = {
      hookSpecificOutput: {
        hookEventName,
        additionalContext: context,
      },
    };
    process.stdout.write(JSON.stringify(out) + "\n");
  } finally {
    disarm();
  }
}

/**
 * Assemble the injected context body. Returns an empty string when there is
 * legitimately nothing to inject (no active.md, empty body); throws on a
 * genuine read error so the fail-open loader degrades to the last-good cache.
 */
function assembleActiveContext(vault: string): string {
  // Runtime-state notices ride the same injection surface as active.md so the
  // agent is proactively aware of a degraded/transient condition (semantic
  // search fell back to lexical, index missing/rebuilding, read-only vault)
  // without a diagnostic round-trip. Best-effort and computed with no network;
  // an empty list keeps the injected body byte-identical to before.
  const noticesBlock = renderRuntimeNotices(collectRuntimeNotices(vault));

  const activePath = brainActivePath(vault);
  const activeBody = existsSync(activePath) ? readActiveBody(vault, activePath) : "";

  const parts = [noticesBlock, activeBody].filter((p) => p.length > 0);
  return parts.join("\n\n");
}

/**
 * Read + budget the active.md / lessons.md body. Returns an empty string when
 * the body is empty; throws on a genuine read error (permissions, fs stall) so
 * the fail-open loader degrades to the last-good cache.
 */
function readActiveBody(vault: string, activePath: string): string {
  const body = readFileSync(activePath, "utf8");

  // Drop the `kind: brain-active / generated_at` frontmatter - it
  // carries no signal for the agent, only provenance for tooling.
  const [, fmBody] = parseFrontmatterText(body);
  const trimmed = fmBody.trim();
  if (trimmed.length === 0) return "";

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

  return lessonsBody === null
    ? budgetActiveBody(trimmed, budget)
    : `${budgetActiveBody(trimmed, budget)}\n\n${lessonsBody}`;
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
