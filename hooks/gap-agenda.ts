#!/usr/bin/env -S bun
/**
 * SessionStart hook: opt-in knowledge-gap agenda (theme A, t_67d38036).
 *
 * When `gap_loop_enabled` is set (default OFF), renders the open recall-gap
 * task notes as a compact agenda and injects it as `additionalContext` so
 * the agent starts the session aware of the recurring gaps still unresolved.
 * The agenda is rendered through the shared session-start activity helper.
 *
 * Flag off is an immediate no-op with zero output, keeping the session
 * preamble byte-identical. Fail-open: the hook arms the shared process
 * ceiling and exits 0 on every path.
 */

import { resolveGapLoopEnabled, resolveVault } from "../src/core/config.ts";
import { renderGapAgenda } from "../src/core/brain/gaps/gap-loop.ts";
import { armProcessCeiling, resolveHookCeilingMs } from "./lib/process-ceiling.ts";
import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import { isContextEventName } from "./lib/context-events.ts";

async function main(): Promise<void> {
  // Fast opt-out FIRST: default OFF means an immediate no-op, no output.
  if (!resolveGapLoopEnabled()) return;

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
        : "SessionStart";
    // Default-closed: only an additionalContext-eligible event may emit.
    if (!isContextEventName(hookEventName)) return;

    const vault = resolveVault();
    if (vault === null) return;

    const agenda = renderGapAgenda(vault, new Date());
    if (agenda.length === 0) return;

    const out = {
      hookSpecificOutput: {
        hookEventName,
        additionalContext: agenda,
      },
    };
    process.stdout.write(JSON.stringify(out) + "\n");
  } finally {
    disarm();
  }
}

main().catch(() => {
  // Never crash the runtime; the session start must proceed regardless.
});
