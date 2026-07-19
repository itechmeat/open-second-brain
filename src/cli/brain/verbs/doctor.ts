import { resolveSearchConfig } from "../../../core/search/index.ts";
import { runDoctor } from "../../../core/brain/doctor.ts";
import { applyRepair, type RepairOutcome } from "../../../core/brain/diagnostics.ts";
import {
  applyRemediation,
  collectDriftedSlugs,
  collectWidePermissions,
  planRemediation,
} from "../../../core/brain/health/remediation.ts";
import { loadBrainConfigDetailed, resolveHealth } from "../../../core/brain/policy.ts";
import { brainVerbContext, fail, ok, parse, resolveBrainAgent, usageError } from "../helpers.ts";

export async function cmdBrainDoctor(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    strict: { type: "boolean" },
    json: { type: "boolean" },
    remediate: { type: "boolean" },
    repair: { type: "boolean" },
    apply: { type: "boolean" },
    agent: { type: "string" },
    "dry-run": { type: "boolean" },
  });
  const { config, vault } = brainVerbContext(flags);

  // `--apply` is a modifier of `--repair`; on its own it would silently
  // fall through to a read-only doctor run, so reject it up front.
  if (flags["apply"] && !flags["repair"]) {
    return usageError("--apply requires --repair");
  }

  // Guarded repair mode (O2). Opt-in and dry-run by default; `--apply`
  // performs the fixes. `--strict` stays read-only, so it can never be
  // combined with an applying repair. Plain / `--strict` doctor below is
  // untouched and byte-identical when `--repair` is absent.
  if (flags["repair"]) {
    if (flags["strict"] && flags["apply"]) {
      return usageError("cannot combine --strict (read-only) with --repair --apply");
    }
    const dryRun = !flags["apply"];
    try {
      const outcome = applyRepair(vault, {
        dryRun,
        agent: resolveBrainAgent(flags, config),
        configPath: config,
      });
      return renderRepair(outcome, Boolean(flags["json"]));
    } catch (exc) {
      return fail(`repair failed: ${(exc as Error).message ?? exc}`);
    }
  }

  let result;
  try {
    result = runDoctor(vault, {
      strict: Boolean(flags["strict"]),
      dbPath: resolveSearchConfig({ vault, configPath: config ?? undefined }).dbPath,
    });
  } catch (exc) {
    return fail(`doctor failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["remediate"]) {
    // Never auto-repair a vault that has structural errors - those need
    // an operator, and remediation assumes a parseable tree.
    if (result.errors.length > 0) {
      for (const e of result.errors) {
        process.stdout.write(`[ERROR] ${e.code}: ${e.message}${e.path ? ` (${e.path})` : ""}\n`);
      }
      return fail("doctor found errors; remediation aborted");
    }
    try {
      return runRemediate(vault, Boolean(flags["dry-run"]), Boolean(flags["json"]), result);
    } catch (exc) {
      return fail(`remediation failed: ${(exc as Error).message ?? exc}`);
    }
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify({ warnings: result.warnings, errors: result.errors }, null, 2) + "\n",
    );
  } else {
    for (const e of result.errors)
      process.stdout.write(`[ERROR] ${e.code}: ${e.message}${e.path ? ` (${e.path})` : ""}\n`);
    for (const w of result.warnings)
      process.stdout.write(`[WARN]  ${w.code}: ${w.message}${w.path ? ` (${w.path})` : ""}\n`);
    if (result.errors.length === 0 && result.warnings.length === 0) ok("brain doctor: clean");
  }

  if (result.errors.length > 0) return 1;
  if (result.warnings.length > 0 && flags["strict"]) return 2;
  return 0;
}

/**
 * `--remediate [--dry-run]`: build a dependency-ordered plan from the
 * doctor's semantic findings plus content-hash drift, then apply the
 * auto-safe steps (or preview them under `--dry-run`). Needs-review
 * steps are always listed but never applied.
 */
function runRemediate(
  vault: string,
  dryRun: boolean,
  json: boolean,
  result: ReturnType<typeof runDoctor>,
): number {
  let stepCap = 20;
  try {
    stepCap = resolveHealth(loadBrainConfigDetailed(vault).config).remediation_step_cap;
  } catch {
    /* fall back to default cap */
  }

  const sh = result.semantic_health;
  const plan = planRemediation(
    {
      driftedSlugs: collectDriftedSlugs(vault),
      widePermissions: collectWidePermissions(vault),
      contradictions: (sh?.contradictions ?? []).map((c) => ({ aId: c.aId, bId: c.bId })),
      staleClaims: (sh?.staleClaims ?? []).map((s) => ({ id: s.id })),
      conceptGaps: (sh?.conceptGaps ?? []).map((g) => ({ term: g.term })),
    },
    { stepCap },
  );
  const outcome = applyRemediation(vault, plan, { dryRun });

  if (json) {
    process.stdout.write(JSON.stringify({ plan: plan.steps, outcome }, null, 2) + "\n");
    return 0;
  }

  const verb = dryRun ? "would apply" : "applied";
  for (const s of outcome.applied) {
    process.stdout.write(`[${verb}] ${s.code}: ${s.detail}\n`);
  }
  for (const s of outcome.skipped) {
    process.stdout.write(`[skip:${s.classification}] ${s.code}: ${s.detail}\n`);
  }
  ok(
    `remediation ${dryRun ? "dry-run" : "complete"}: ` +
      `${outcome.applied.length} ${verb}, ${outcome.skipped.length} skipped`,
  );
  return 0;
}

/**
 * Render the guarded repair outcome. Dry-run lists what `--apply` would
 * do; apply lists what was done. Needs-review instances and unfixable
 * classes always print with their next-command hint (supplied by the
 * diagnostics-signal definition, never hardcoded here).
 */
function renderRepair(outcome: RepairOutcome, json: boolean): number {
  if (json) {
    process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
    return 0;
  }

  const verb = outcome.dryRun ? "would fix" : "fixed";
  for (const f of outcome.applied) {
    process.stdout.write(`[${verb}] ${f.code}: ${f.detail}\n`);
  }
  for (const r of outcome.needsReview) {
    process.stdout.write(
      `[needs-review] ${r.code}: ${r.detail}${r.reason ? ` (${r.reason})` : ""}\n`,
    );
  }
  for (const u of outcome.unfixable) {
    process.stdout.write(`[not auto-repairable] ${u.code} x${u.count}: run \`${u.nextCommand}\`\n`);
  }
  if (
    outcome.applied.length === 0 &&
    outcome.needsReview.length === 0 &&
    outcome.unfixable.length === 0
  ) {
    ok("brain doctor --repair: nothing to fix");
    return 0;
  }
  ok(
    `repair ${outcome.dryRun ? "dry-run" : "complete"}: ` +
      `${outcome.applied.length} ${verb}, ${outcome.needsReview.length} needs-review, ` +
      `${outcome.unfixable.length} not auto-repairable`,
  );
  return 0;
}
