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
import { emitContextReceipt } from "../src/core/brain/context-receipts.ts";
import { estimateTokens } from "../src/core/brain/text/tokenizer.ts";
import type { InjectContextSource } from "../src/core/brain/inject-failopen.ts";

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
    const meter: InjectionMeter = { sources: [], budgetChars: null };
    const { context, source } = await loadInjectContextFailOpen({
      vault,
      key: "active",
      assemble: () => assembleActiveContext(vault, meter),
      audit: (degradedSource) =>
        auditHook(vault, "inject_failopen_degraded", {
          hook: "active-inject",
          source: degradedSource,
        }),
    });
    if (context.length === 0) return;

    const out = {
      hookSpecificOutput: {
        hookEventName,
        additionalContext: context,
      },
    };
    process.stdout.write(JSON.stringify(out) + "\n");

    // Measure LAST, so the injected context is already on stdout before the
    // meter can spend a millisecond of the ceiling. See recordInjectionSize.
    recordInjectionSize(vault, { hookEventName, loaderSource: source, context, meter });
  } finally {
    disarm();
  }
}

// ----- injection-size meter (context-integrity-gates, Unit H) --------------

/**
 * One injected sub-body, captured while it is still a separate string.
 *
 * `assembleActiveContext` joins its parts and returns one string, so this
 * is the only point at which per-source attribution exists at all. The
 * name is a stable structural identifier, never derived from content.
 */
interface InjectionSource {
  readonly name: string;
  readonly text: string;
}

/** Mutable accumulator threaded through the assembly, read after it returns. */
interface InjectionMeter {
  readonly sources: InjectionSource[];
  /** The `inject_budget_chars` the budgeted sub-bodies were charged against. */
  budgetChars: number | null;
}

/** Sub-body identifiers recorded per injection. Structural, not content-derived. */
const SOURCE_RUNTIME_NOTICES = "runtime-notices";
const SOURCE_ACTIVE_BODY = "active-body";
const SOURCE_LESSONS_BODY = "lessons-body";

const UTF8 = new TextEncoder();

function byteLength(text: string): number {
  return UTF8.encode(text).length;
}

interface RecordInjectionSizeInput {
  readonly hookEventName: string;
  readonly loaderSource: InjectContextSource;
  readonly context: string;
  readonly meter: InjectionMeter;
}

/**
 * Record what this hook actually injected: total bytes and tokens, plus
 * per-source attribution when the assembly is what got emitted.
 *
 * SCOPE. This measures THIS hook only. `gap-agenda`, `recall-inject`, and
 * `nav-inject` are separate processes with their own `additionalContext`,
 * so the session preamble as a whole is larger than any figure recorded
 * here and cannot be assembled from inside this process.
 *
 * ATTRIBUTION. The measurement is taken after the fail-open loader
 * returns, so it describes the emitted bytes rather than the attempted
 * ones. When the loader degraded to its last-good cache the sub-bodies in
 * `meter` were never emitted (assembly threw), so the record says
 * `sources_measured: false` and carries no items - a per-source breakdown
 * of zeros would be a finding that never happened.
 *
 * FAIL-SOFT. The whole body sits in one try/catch. The receipt sink takes
 * a continuity-store lock and writes to disk; contention, a read-only
 * vault, or a directory that is really a file must not become a new
 * failure surface on the SessionStart path. Nothing here can change the
 * hook's exit code, and the injected context is already on stdout by the
 * time this runs.
 */
function recordInjectionSize(vault: string, input: RecordInjectionSizeInput): void {
  try {
    const measured = input.loaderSource === "fresh";
    const totalBytes = byteLength(input.context);
    emitContextReceipt(vault, {
      options: { host: "hook", trigger: "session_inject" },
      items: measured
        ? input.meter.sources.map((source) => ({
            id: source.name,
            bytes: byteLength(source.text),
            tokens: estimateTokens(source.text),
          }))
        : [],
      finalText: input.context,
      ...(input.meter.budgetChars !== null && measured
        ? {
            budget: {
              inject_budget_chars: input.meter.budgetChars,
              // Both budgeted sub-bodies are charged against the SAME
              // configured ceiling, so the effective ceiling is this
              // count times `inject_budget_chars`. Recorded as two
              // numbers rather than implied by one.
              budgeted_source_count: budgetedSourceCount(input.meter),
            },
          }
        : {}),
      extra: {
        injection: {
          hook_event: input.hookEventName,
          loader_source: input.loaderSource,
          sources_measured: measured,
          total_bytes: totalBytes,
          total_tokens: estimateTokens(input.context),
        },
      },
    });
  } catch {
    // The meter is diagnostics. A failure to record must never disturb an
    // injection that already succeeded.
  }
}

/** How many recorded sources were charged against `inject_budget_chars`. */
function budgetedSourceCount(meter: InjectionMeter): number {
  return meter.sources.filter(
    (source) => source.name === SOURCE_ACTIVE_BODY || source.name === SOURCE_LESSONS_BODY,
  ).length;
}

/**
 * Assemble the injected context body. Returns an empty string when there is
 * legitimately nothing to inject (no active.md, empty body); throws on a
 * genuine read error so the fail-open loader degrades to the last-good cache.
 *
 * Every non-empty sub-body is recorded into `meter` as it is produced -
 * the join below is where per-source attribution stops existing.
 */
function assembleActiveContext(vault: string, meter: InjectionMeter): string {
  // Runtime-state notices ride the same injection surface as active.md so the
  // agent is proactively aware of a degraded/transient condition (semantic
  // search fell back to lexical, index missing/rebuilding, read-only vault)
  // without a diagnostic round-trip. Best-effort and computed with no network;
  // an empty list keeps the injected body byte-identical to before.
  const noticesBlock = renderRuntimeNotices(collectRuntimeNotices(vault));
  if (noticesBlock.length > 0) {
    meter.sources.push({ name: SOURCE_RUNTIME_NOTICES, text: noticesBlock });
  }

  const activePath = brainActivePath(vault);
  const activeBody = existsSync(activePath) ? readActiveBody(vault, activePath, meter) : "";

  const parts = [noticesBlock, activeBody].filter((p) => p.length > 0);
  return parts.join("\n\n");
}

/**
 * Read + budget the active.md / lessons.md body. Returns an empty string when
 * the body is empty; throws on a genuine read error (permissions, fs stall) so
 * the fail-open loader degrades to the last-good cache.
 */
function readActiveBody(vault: string, activePath: string, meter: InjectionMeter): string {
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
  meter.budgetChars = budget;

  // Auto-load the lessons digest alongside active.md so the agent gets
  // the unified, signed, recency-scored corpus (preferences + dead-ends)
  // on the same SessionStart surface. Fail-soft and budgeted separately:
  // a missing / unreadable / oversized lessons file must never disturb
  // the active-preferences injection above.
  const lessonsBody = readLessonsBody(brainLessonsPath(vault), budget);

  const budgetedActive = budgetActiveBody(trimmed, budget);
  meter.sources.push({ name: SOURCE_ACTIVE_BODY, text: budgetedActive });
  if (lessonsBody !== null) {
    meter.sources.push({ name: SOURCE_LESSONS_BODY, text: lessonsBody });
  }

  return lessonsBody === null ? budgetedActive : `${budgetedActive}\n\n${lessonsBody}`;
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
