/**
 * Renderers for `o2b brain upgrade` plan output (text + JSON).
 *
 * Pure projection of {@link UpgradePlan} into stdout — no I/O on the
 * vault, no flag parsing. The verb handler (`./verbs/upgrade.ts`)
 * calls these after `planUpgrade()` returns.
 */

import type { UpgradeFilePlan, UpgradePlan } from "../../core/brain/upgrade.ts";
import { info, ok } from "../output.ts";

// The moved implementation keeps a local binding (printUpgradePlanText
// calls it directly) and the re-export below keeps helpers.ts working.
import { renderUnifiedDiff } from "../../core/diff.ts";

export function renderUpgradePlanJson(plan: UpgradePlan): {
  pending: number;
  errors: number;
  files: ReadonlyArray<{
    path: string;
    status: UpgradeFilePlan["status"];
    before_size: number;
    after_size: number;
    error?: string;
  }>;
} {
  return {
    pending: plan.pending,
    errors: plan.errors,
    files: plan.files.map((f) => ({
      path: f.path,
      status: f.status,
      // An absent file (`before: null`) reports 0, as before the split.
      before_size: f.before?.length ?? 0,
      after_size: f.after.length,
      ...(f.error ? { error: f.error } : {}),
    })),
  };
}

export function printUpgradePlanText(plan: UpgradePlan): void {
  for (const f of plan.files) {
    if (f.status === "noop") {
      ok(`  ${f.path}: up to date`);
      continue;
    }
    if (f.status === "error") {
      info(`  ${f.path}: ERROR ${f.error}`);
      continue;
    }
    const from = f.before === null ? "absent" : String(f.before.length);
    info(`  ${f.path}: update (${from} → ${f.after.length} bytes)`);
    info(renderUnifiedDiff(f.before ?? "", f.after, f.path));
  }
  if (plan.pending === 0 && plan.errors === 0) {
    ok("upgrade: all managed files match the current release.");
  } else if (plan.pending > 0) {
    ok(`upgrade: ${plan.pending} pending update(s); re-run with --apply --yes when ready.`);
  }
}

/**
 * Minimal unified-diff renderer used by both `upgrade` (per-file diff)
 * and `rollback --dry-run` (snapshot vs live) — and, since t_b6bcd984,
 * by every guarded write lane. The implementation moved to the core
 * leaf src/core/diff.ts; the import above keeps the local caller here
 * working and the re-export keeps helpers.ts working.
 */
export { renderUnifiedDiff };
