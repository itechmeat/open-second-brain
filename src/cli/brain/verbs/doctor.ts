import { defaultConfigPath } from "../../../core/config.ts";
import { runDoctor } from "../../../core/brain/doctor.ts";
import {
  applyRemediation,
  collectDriftedSlugs,
  planRemediation,
} from "../../../core/brain/health/remediation.ts";
import { loadBrainConfigDetailed, resolveHealth } from "../../../core/brain/policy.ts";
import { parse, fail, ok, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainDoctor(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    strict: { type: "boolean" },
    json: { type: "boolean" },
    remediate: { type: "boolean" },
    "dry-run": { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  let result;
  try { result = runDoctor(vault, { strict: Boolean(flags["strict"]) }); }
  catch (exc) { return fail(`doctor failed: ${(exc as Error).message ?? exc}`); }

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
    process.stdout.write(JSON.stringify({ warnings: result.warnings, errors: result.errors }, null, 2) + "\n");
  } else {
    for (const e of result.errors) process.stdout.write(`[ERROR] ${e.code}: ${e.message}${e.path ? ` (${e.path})` : ""}\n`);
    for (const w of result.warnings) process.stdout.write(`[WARN]  ${w.code}: ${w.message}${w.path ? ` (${w.path})` : ""}\n`);
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
  } catch { /* fall back to default cap */ }

  const sh = result.semantic_health;
  const plan = planRemediation(
    {
      driftedSlugs: collectDriftedSlugs(vault),
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
