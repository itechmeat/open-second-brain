#!/usr/bin/env -S bun
/**
 * SessionStart hook: keep the human view current without a manual command
 * (design D7; `src/core/view/auto-render.ts`).
 *
 * On the view writer device it runs one render pass, at most once an hour,
 * inside a time budget well under the hook ceiling; every other machine
 * reads only the view writer records and stops. A machine without a brain
 * store, or without a device id, does nothing. The pass writes only
 * changed bytes and skips reading a page whose file is as the writer left
 * it, so the usual session start costs a `stat` per page.
 *
 * Fail-open: nothing is printed to the agent, a failure or a budget that
 * ran out is one line in the device-local hook audit (the vault's when no
 * store is open), and every path exits 0.
 */

import { appendAuditRecord } from "../src/core/reliability/audit.ts";
import { hookAuditDir } from "../src/core/brain/paths.ts";
import { resolveVault } from "../src/core/config.ts";
import {
  autoViewAudit,
  deviceHookAuditDir,
  runAutoViewPass,
  type AutoViewResult,
} from "../src/core/view/auto-render.ts";
import { armProcessCeiling, resolveHookCeilingMs } from "./lib/process-ceiling.ts";
import { readHookInput } from "./lib/stdin.ts";

const HOOK = "view-render";

function audit(action: string, ok: boolean, details: Record<string, unknown>): void {
  try {
    const deviceDir = deviceHookAuditDir();
    const vault = deviceDir === null ? resolveVault() : null;
    const dir = deviceDir ?? (vault !== null ? hookAuditDir(vault) : null);
    if (dir === null) return;
    appendAuditRecord(dir, {
      timestamp: new Date().toISOString(),
      actor: HOOK,
      action,
      target: HOOK,
      ok,
      details: { hook: HOOK, ...details },
    });
  } catch {
    // best-effort
  }
}

function needsAudit(result: AutoViewResult): boolean {
  if (result.status === "error" || result.status === "incomplete-read") return true;
  return (
    result.status === "rendered" &&
    result.pages.some((p) => p.status !== "written" && p.status !== "unchanged")
  );
}

async function main(): Promise<void> {
  const ceilingMs = resolveHookCeilingMs();
  const disarm = armProcessCeiling({
    ceilingMs,
    onExpire: () => audit("hook_ceiling_exceeded", false, { ceiling_ms: ceilingMs }),
  });
  try {
    try {
      await readHookInput();
    } catch {
      // the payload carries nothing this hook needs
    }
    const result = runAutoViewPass({
      trigger: "session-start",
      budgetMs: Math.floor(ceilingMs / 2),
    });
    if (result !== null && needsAudit(result)) audit("view_render", ...autoViewAudit(result));
  } finally {
    disarm();
  }
}

main().catch((err) => {
  audit("view_render", false, { status: "error", error: (err as Error)?.message ?? String(err) });
});
