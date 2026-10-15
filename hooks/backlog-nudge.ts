#!/usr/bin/env -S bun
/**
 * SessionStart hook: opt-in undistilled backlog nudge (session-mining-economy,
 * t_0358af42).
 *
 * When `backlog_nudge_enabled` is set (default OFF), reports how many
 * imported sessions have never been distilled, as ONE `additionalContext`
 * line, so the agent starts the session aware of the backlog still waiting.
 * The count comes from the vault-side mining census
 * (`src/core/brain/sessions/mining-census.ts`), which reads the import
 * ledger joined to the mining record and never hashes a source log - the
 * honest count is affordable inside this hook's budget.
 *
 * The nudge is change-keyed, not timed: the line is injected when the
 * undistilled count differs from the count injected last (state:
 * hooks/lib/backlog-nudge-state.ts, one overwrite-only file beside the
 * hygiene digest). An unchanged backlog is never re-nagged, and a drained
 * backlog is recorded without being announced - a line that says there is
 * nothing to do is the noise this hook exists to avoid.
 *
 * Under the deadline the hook degrades to silence, never to a fabricated
 * number: the census runs under the process ceiling's cooperative
 * safeguard, and a census that cannot verify its ledgers names the failure
 * on stderr and injects nothing.
 *
 * Flag off is an immediate no-op with zero output, keeping the session
 * preamble byte-identical. Fail-open: the hook arms the shared process
 * ceiling and exits 0 on every path.
 */

import { resolveBacklogNudgeEnabled, resolveVault } from "../src/core/config.ts";
import { isContextEventName } from "./lib/context-events.ts";
import {
  armProcessCeiling,
  ceilingSafeguard,
  resolveHookCeilingMs,
} from "./lib/process-ceiling.ts";
import { backlogNudgeCountMatches, writeBacklogNudgeCount } from "./lib/backlog-nudge-state.ts";
import { asHookPayload, readHookInput } from "./lib/stdin.ts";

async function main(): Promise<void> {
  // Fast opt-out FIRST: default OFF means an immediate no-op, no output.
  if (!resolveBacklogNudgeEnabled()) return;

  const ceilingMs = resolveHookCeilingMs();
  const disarm = armProcessCeiling({ ceilingMs });
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

    // Loaded only here, after every gate: the census and its ledger chain
    // are the one heavy import, and a flag-off session start pays nothing
    // for them (the hygiene-digest hook's lazy-load precedent).
    const { buildMiningCensus } = await import("../src/core/brain/sessions/mining-census.ts");
    let count: number;
    try {
      count = buildMiningCensus(vault, { safeguard: ceilingSafeguard(ceilingMs) }).undistilled;
    } catch (err) {
      // Never block, never guess: a census that cannot verify its ledgers
      // says why and injects nothing.
      process.stderr.write(
        `backlog-nudge: the backlog census failed: ${(err as Error).message ?? String(err)}\n`,
      );
      return;
    }

    // Changed-count gate. A missing or corrupt state file compares unequal,
    // so the next eligible session emits again (lose-not-duplicate).
    if (backlogNudgeCountMatches(vault, count)) return;

    // A drained backlog is recorded, not announced.
    if (count <= 0) {
      writeBacklogNudgeCount(vault, count);
      return;
    }

    const sessions = count === 1 ? "session" : "sessions";
    const line =
      `Open Second Brain session backlog: ${count} imported ${sessions} not yet distilled. ` +
      "Run 'o2b brain import-session --status' for the per-runtime breakdown.";
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: line } }) + "\n",
    );

    // The state lands AFTER the emit: a crash in between loses the dedupe
    // and the next eligible session emits again, rather than never.
    writeBacklogNudgeCount(vault, count);
  } finally {
    disarm();
  }
}

main().catch(() => {
  // Never crash the runtime; the session start must proceed regardless.
});
