/**
 * Output renderers for `o2b install` / `o2b install --check`.
 *
 * Two surfaces: human-readable text (default) and JSON (`--json`).
 * Both forms describe the same data so the agent can switch on
 * `--json` without losing detail.
 *
 * ## One envelope, because there used to be four
 *
 * This verb has four modes and each built its own `--json` payload. Three
 * declared `schema_version: 1`; apply - the only mode that CHANGES the
 * machine - declared none, and the plan payload was assembled inline in
 * `install.ts` rather than here at all. No test asserted a field name in
 * any of them, while the human `--check` table is pinned byte-for-byte
 * against the `install/<runtime>.md` documents.
 *
 * {@link installJson} is the single exit now, so a payload cannot be
 * emitted without a version, and `tests/cli/install-json-shape.test.ts`
 * pins the key set of all four.
 */

import type { DataOwnership } from "../../core/install/ownership.ts";
import type {
  ApplyResult,
  DetectResult,
  InstallPlan,
  VerifyResult,
} from "../../core/install/types.ts";

/**
 * The version every payload below declares.
 *
 * Still 1 after apply gained the key: the field is ADDITIVE on a payload
 * that previously had no version to compare against, and the three modes
 * that already said 1 describe the same shapes they always did. A consumer
 * pinning `=== 1` keeps working, which a bump would have broken to
 * announce a change that took nothing away.
 */
export const INSTALL_JSON_SCHEMA_VERSION = 1;

/**
 * The machine-readable half of the ownership close.
 *
 * Named once, for the reason `NEXT_COMMAND_KEY` is: the CLI renderer and
 * anything that reads the payload back must not drift on the spelling.
 * NOT `handoff` - that name already means the operator-readable session
 * notes under `Brain/handoffs/`, and one word for two records is how a
 * field becomes unsearchable.
 */
export const DATA_OWNERSHIP_KEY = "data_ownership";

/**
 * Serialise one `--json` payload.
 *
 * The version is prepended here rather than spelled at each call site -
 * the whole reason the apply payload could ship without one.
 */
export function installJson(payload: Readonly<Record<string, unknown>>): string {
  return (
    JSON.stringify({ schema_version: INSTALL_JSON_SCHEMA_VERSION, ...payload }, null, 2) + "\n"
  );
}

export interface DetectTableRow {
  readonly target: string;
  readonly status: string;
  readonly configPath: string | null;
  readonly notes: ReadonlyArray<string>;
}

export function renderDetectTable(rows: ReadonlyArray<DetectResult>): string {
  if (rows.length === 0) return "o2b install — no adapters registered\n";
  const lines: string[] = ["o2b install — detected runtimes", "-".repeat(35)];
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
  const summary = `${rows.length} runtime(s) in registry; ${installed} installed, ${drift} drift, ${notInstalled} not-installed.`;
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
  return installJson({
    targets: rows.map((r) => ({
      target: r.target,
      status: r.status,
      config_path: r.configPath,
      notes: r.notes,
    })),
  });
}

/**
 * The plan payload. It lived inline in `install.ts` and moves here so all
 * four `--json` shapes are readable in one file - the arrangement that
 * would have made the missing version on apply obvious.
 */
export function renderPlanJson(plan: InstallPlan): string {
  return installJson({ plan });
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

/**
 * The apply payload.
 *
 * The version is added BESIDE the result's own fields rather than nesting
 * the result under a key: a consumer reading `.manifest` or
 * `.steps_executed` keeps working and gains a version it never had, which
 * a re-nesting would have broken to announce a change that took nothing
 * away.
 */
export function renderApplyJson(result: ApplyResult, ownership: DataOwnership): string {
  return installJson({ ...result, [DATA_OWNERSHIP_KEY]: ownership });
}

export function renderVerifyTable(rows: ReadonlyArray<VerifyResult>): string {
  if (rows.length === 0) return "o2b install --check — no targets verified\n";
  const lines: string[] = ["o2b install --check", "-".repeat(20)];
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

export function renderVerifyJson(
  rows: ReadonlyArray<VerifyResult>,
  ownership: DataOwnership | null,
): string {
  return installJson({
    targets: rows,
    ...(ownership === null ? {} : { [DATA_OWNERSHIP_KEY]: ownership }),
  });
}
