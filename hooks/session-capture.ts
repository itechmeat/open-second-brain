#!/usr/bin/env -S bun
/**
 * Runtime lifecycle hook: capture prompt/tool/session observations into
 * Brain without writing hook output back to the runtime. Failures are
 * intentionally silent so a hook problem never blocks the agent.
 */

import { resolveAgentName, resolveVault } from "../src/core/config.ts";
import { captureSessionLifecycleEvent } from "../src/core/brain/session-lifecycle.ts";
import { normalizeHookPayload, readHookInput } from "./lib/stdin.ts";

async function main(): Promise<void> {
  const vault = resolveVault();
  if (vault === null) return;
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
}

main().catch(() => {
  // Never block the runtime on lifecycle capture failures.
});
