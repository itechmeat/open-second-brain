#!/usr/bin/env -S bun
/**
 * UserPromptSubmit hook: opt-in, cadence-controlled, audited NAV TIER
 * (retrieval-quality-and-context-delivery, D1 / t_2d4f34d7).
 *
 * This is the additive navigation/map tier layered on top of - and entirely
 * separate from - the always-on injection kernel (active-inject /
 * recall-inject), both of which stay behaviorally unchanged. Guarantees:
 *   - OPT-IN: `nav_tier_enabled` (default OFF) is checked first; unset means an
 *     immediate no-op with zero output, so the prompt preamble is byte-identical.
 *   - CADENCE-CONTROLLED: the map injects only when no fresh cadence stamp is
 *     live for this session (first-turn trigger, then at most once per window).
 *     Cadence state lives under the namespaced `osb.nav_tier.*` session-state
 *     key with an explicit epoch-ms expiry.
 *   - STRUCTURAL: the map content is derived from the vault's link graph
 *     (`buildNavmap` -> `graphStats`), never LLM-authored.
 *   - AUDITED: every decision (inject / suppress) writes exactly one structured,
 *     payload-safe audit line recording when, why, and the added char count.
 *   - FAIL-SOFT: any error injects nothing and the session proceeds; a missing
 *     or malformed cadence stamp is treated as "due" (absent), never a throw.
 */

import { join } from "node:path";

import {
  defaultConfigPath,
  resolveNavTierCadenceMinutes,
  resolveNavTierEnabled,
  resolveVault,
} from "../src/core/config.ts";
import { appendAuditRecord } from "../src/core/reliability/audit.ts";
import { buildNavmap, renderNavmap } from "../src/core/brain/navmap.ts";
import {
  decideNavInject,
  navInjectAuditDetails,
  NAV_TIER_CADENCE_MINUTES_DEFAULT,
  type NavInjectDecision,
} from "../src/core/brain/nav-inject.ts";
import { armProcessCeiling, resolveHookCeilingMs } from "./lib/process-ceiling.ts";
import { readHookStamp, writeHookStamp } from "./lib/session-state.ts";
import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import { isContextEventName } from "./lib/context-events.ts";

/** Namespaced cadence stamp key (binding D1 convention). */
const NAV_TIER_STAMP_KEY = "osb.nav_tier.last_injected";

const MINUTE_MS = 60_000;

/**
 * One payload-safe audit line per decision. Never throws (a hung filesystem is
 * exactly when this runs) and never records the navmap content - only the
 * decision kind, reason, and added char count.
 */
function auditDecision(vault: string, decision: NavInjectDecision): void {
  try {
    appendAuditRecord(join(vault, ".open-second-brain", "hook-audit"), {
      timestamp: new Date().toISOString(),
      actor: "nav-inject",
      action: "nav_tier_decision",
      target: "UserPromptSubmit",
      ok: decision.kind === "inject",
      details: navInjectAuditDetails(decision),
    });
  } catch {
    // best-effort: auditing must never disturb the fail-soft contract
  }
}

async function main(): Promise<void> {
  // Fast opt-out FIRST: default OFF means an immediate no-op, no process
  // ceiling armed, no payload read, no output - byte-identical to before.
  if (!resolveNavTierEnabled()) return;

  const disarm = armProcessCeiling({ ceilingMs: resolveHookCeilingMs() });
  try {
    let payload;
    try {
      payload = asHookPayload(await readHookInput());
    } catch {
      return;
    }

    const hookEventName =
      typeof payload.hook_event_name === "string" && payload.hook_event_name.length > 0
        ? payload.hook_event_name
        : "UserPromptSubmit";
    // Default-closed: only an additionalContext-eligible event may emit.
    if (!isContextEventName(hookEventName)) return;

    const vault = resolveVault();
    if (vault === null) return;
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;

    const nowMs = Date.now();
    const cadenceActive = readHookStamp(vault, sessionId, NAV_TIER_STAMP_KEY, nowMs) !== null;

    // Only pay for the navmap build when cadence is actually due.
    let block = "";
    if (!cadenceActive) {
      try {
        const navmap = await buildNavmap(vault, defaultConfigPath());
        block = navmap === null ? "" : renderNavmap(navmap);
      } catch {
        block = "";
      }
    }

    const decision = decideNavInject(block, cadenceActive);
    auditDecision(vault, decision);
    if (decision.kind !== "inject") return;

    // Stamp the cadence window closed before emitting so a crash after write
    // still suppresses re-injection rather than looping.
    const cadenceMinutes = resolveNavTierCadenceMinutes() ?? NAV_TIER_CADENCE_MINUTES_DEFAULT;
    writeHookStamp(vault, sessionId, NAV_TIER_STAMP_KEY, {
      expiresAt: nowMs + cadenceMinutes * MINUTE_MS,
    });

    const out = {
      hookSpecificOutput: {
        hookEventName,
        additionalContext: decision.block,
      },
    };
    process.stdout.write(JSON.stringify(out) + "\n");
  } finally {
    disarm();
  }
}

main().catch(() => {
  // Never crash the runtime; the prompt submission must proceed regardless
  // of any hook misbehaviour.
});
