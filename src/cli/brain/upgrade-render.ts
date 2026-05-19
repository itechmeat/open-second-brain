/**
 * Renderers for `o2b brain upgrade` plan output (text + JSON).
 *
 * Pure projection of {@link UpgradePlan} into stdout — no I/O on the
 * vault, no flag parsing. The verb handler (`./verbs/upgrade.ts`)
 * calls these after `planUpgrade()` returns.
 */

import type { UpgradeFilePlan, UpgradePlan } from "../../core/brain/upgrade.ts";
import { info, ok } from "../output.ts";

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
      before_size: f.before.length,
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
    info(`  ${f.path}: update (${f.before.length} → ${f.after.length} bytes)`);
    info(renderUnifiedDiff(f.before, f.after, f.path));
  }
  if (plan.pending === 0 && plan.errors === 0) {
    ok("upgrade: all managed files match the current release.");
  } else if (plan.pending > 0) {
    ok(
      `upgrade: ${plan.pending} pending update(s); ` +
        `re-run with --apply --yes when ready.`,
    );
  }
}

/**
 * Minimal unified-diff renderer used by both `upgrade` (per-file diff)
 * and `rollback --dry-run` (snapshot vs live). The implementation
 * trims matching prefix / suffix and prints the changed window — it
 * is not a drop-in replacement for GNU diff, but it is deterministic
 * and dependency-free.
 */
export function renderUnifiedDiff(before: string, after: string, label: string): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  const lines: string[] = [`--- ${label} (live)`, `+++ ${label} (release)`];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length;
  let tailB = b.length;
  while (
    tailA > head &&
    tailB > head &&
    a[tailA - 1] === b[tailB - 1]
  ) {
    tailA--;
    tailB--;
  }
  if (head > 0) {
    lines.push(`@@ context: ${head} matching line(s) above @@`);
  }
  for (let i = head; i < tailA; i++) lines.push(`- ${a[i]}`);
  for (let i = head; i < tailB; i++) lines.push(`+ ${b[i]}`);
  if (tailA < a.length || tailB < b.length) {
    const tailCount = Math.max(a.length - tailA, b.length - tailB);
    lines.push(`@@ context: ${tailCount} matching line(s) below @@`);
  }
  return lines.join("\n");
}
