/**
 * Output renderers for `o2b install` / `o2b install --check`.
 *
 * Two surfaces: human-readable text (default) and JSON (`--json`).
 * Both forms describe the same data so the agent can switch on
 * `--json` without losing detail.
 */

import type {
  ApplyResult,
  DetectResult,
  InstallPlan,
  VerifyResult,
} from "../../core/install/types.ts";

export interface DetectTableRow {
  readonly target: string;
  readonly status: string;
  readonly configPath: string | null;
  readonly notes: ReadonlyArray<string>;
}

export function renderDetectTable(rows: ReadonlyArray<DetectResult>): string {
  if (rows.length === 0) return "o2b install — no adapters registered\n";
  const lines: string[] = [
    "o2b install — detected runtimes",
    "-".repeat(35),
  ];
  let installed = 0;
  let drift = 0;
  let notInstalled = 0;
  for (const r of rows) {
    const status = r.status.padEnd(14);
    const target = r.target.padEnd(14);
    const where = r.configPath ?? "";
    lines.push(`  ${target}${status}${where}`);
    if (r.notes.length > 0) {
      for (const n of r.notes) lines.push(`                              ${n}`);
    }
    if (r.status === "installed") installed += 1;
    else if (r.status === "drift") drift += 1;
    else if (r.status === "not-installed") notInstalled += 1;
  }
  lines.push("");
  const summary =
    `${rows.length} runtime(s) in registry; ${installed} installed, ${drift} drift, ${notInstalled} not-installed.`;
  lines.push(summary);
  if (drift > 0 || notInstalled > 0) {
    lines.push("");
    lines.push("To install or repair, run:");
    for (const r of rows) {
      if (r.status === "drift" || r.status === "not-installed") {
        lines.push(`  o2b install --target ${r.target} --apply`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function renderDetectJson(rows: ReadonlyArray<DetectResult>): string {
  const payload = {
    schema_version: 1,
    targets: rows.map((r) => ({
      target: r.target,
      status: r.status,
      config_path: r.configPath,
      notes: r.notes,
    })),
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

export function renderPlan(plan: InstallPlan): string {
  const lines: string[] = [];
  lines.push(`o2b install --target ${plan.target} — plan (dry-run; pass --apply to execute)`);
  lines.push("-".repeat(60));
  for (const [i, step] of plan.steps.entries()) {
    lines.push(`  step ${i + 1}: [${step.kind}] ${step.preview}`);
    if (step.path) lines.push(`             path: ${step.path}`);
  }
  if (plan.postNotes.length > 0) {
    lines.push("");
    lines.push("Post-install notes:");
    for (const n of plan.postNotes) lines.push(`  - ${n}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderApplyResult(result: ApplyResult): string {
  const m = result.manifest;
  const lines: string[] = [];
  lines.push(`o2b install --target ${result.target} --apply — done`);
  lines.push(`  operation:   ${m.operation}`);
  lines.push(`  config path: ${m.config_path ?? "(none)"}`);
  if (m.owned_keys?.length) {
    lines.push(`  owned keys:`);
    for (const k of m.owned_keys) lines.push(`    - ${k}`);
  }
  if (m.owned_paths?.length) {
    lines.push(`  owned paths:`);
    for (const p of m.owned_paths) lines.push(`    - ${p}`);
  }
  lines.push(`  applied at:  ${m.applied_at}`);
  lines.push(`  steps:       ${result.steps_executed}`);
  lines.push("");
  return lines.join("\n");
}

export function renderApplyJson(result: ApplyResult): string {
  return JSON.stringify(result, null, 2) + "\n";
}

export function renderVerifyTable(rows: ReadonlyArray<VerifyResult>): string {
  if (rows.length === 0) return "o2b install --check — no targets verified\n";
  const lines: string[] = [
    "o2b install --check",
    "-".repeat(20),
  ];
  for (const v of rows) {
    const status = v.status.padEnd(18);
    lines.push(`  ${v.target.padEnd(14)}${status}${v.details.join("; ")}`);
    if (v.fix_hint) {
      lines.push(`                              fix: ${v.fix_hint}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function renderVerifyJson(rows: ReadonlyArray<VerifyResult>): string {
  return JSON.stringify({ schema_version: 1, targets: rows }, null, 2) + "\n";
}
