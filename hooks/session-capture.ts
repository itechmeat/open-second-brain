#!/usr/bin/env -S bun
/**
 * Runtime lifecycle hook: capture prompt/tool/session observations into
 * Brain without writing hook output back to the runtime. Failures are
 * intentionally silent so a hook problem never blocks the agent.
 */

import { join } from "node:path";

import { resolveAgentName, resolveVault } from "../src/core/config.ts";
import { captureSessionLifecycleEvent } from "../src/core/brain/session-lifecycle.ts";
import {
  armProcessCeiling,
  resolveHookCeilingMs,
} from "../src/core/reliability/process-ceiling.ts";
import { appendAuditRecord } from "../src/core/reliability/audit.ts";
import { normalizeHookPayload, readHookInput } from "./lib/stdin.ts";

async function main(): Promise<void> {
  // Arm the process self-watchdog so a hung capture (stalled read, slow
  // continuity append) self-terminates at the ceiling instead of orphaning
  // the hook process or blocking the host agent.
  let auditVault: string | null = null;
  const disarm = armProcessCeiling({
    ceilingMs: resolveHookCeilingMs(),
    label: "session-capture",
    onExpire: () => {
      if (auditVault === null) return;
      try {
        appendAuditRecord(join(auditVault, ".open-second-brain", "hook-audit"), {
          timestamp: new Date().toISOString(),
          actor: "session-capture",
          action: "hook_ceiling_exceeded",
          target: "session-capture",
          ok: false,
          details: { hook: "session-capture" },
        });
      } catch {
        // best-effort
      }
    },
  });
  try {
    const vault = resolveVault();
    if (vault === null) return;
    auditVault = vault;
    let payload: unknown;
    try {
      payload = await readHookInput();
    } catch {
      payload = null;
    }
    // Normalize grok's camelCase payload to the internal snake_case shape so the
    // lifecycle capture reads the same fields it does for Claude Code and Codex.
    await captureSessionLifecycleEvent(vault, normalizeHookPayload(payload), {
      agent: resolveAgentName(),
    });
  } finally {
    disarm();
  }
}

main().catch(() => {
  // Never block the runtime on lifecycle capture failures.
});
