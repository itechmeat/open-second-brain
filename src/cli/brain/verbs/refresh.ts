/**
 * `o2b brain refresh` - targeted recompile of stale derived pages
 * (continuity-hygiene-freshness suite).
 *
 *   o2b brain refresh --stale [--dry-run] [--json]
 *
 * Re-derives only pages whose recorded sources changed (handoff notes
 * re-derive in place from their transcript), stages orphan cleanup
 * into Brain/.snapshots, and leaves unknown pipelines as `manual`.
 * `--dry-run` previews the plan with zero writes.
 */

import { executeRecompile, planRecompile } from "../../../core/brain/recompile.ts";
import { brainVerbContext, fail, parse, resolveBrainAgent } from "../helpers.ts";

export async function cmdBrainRefresh(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    agent: { type: "string" },
    stale: { type: "boolean" },
    "dry-run": { type: "boolean" },
    json: { type: "boolean" },
  });
  if (!flags["stale"]) {
    return fail("usage: o2b brain refresh --stale [--dry-run] [--json]");
  }
  const { config, vault } = brainVerbContext(flags);

  let plan;
  let result;
  try {
    plan = planRecompile(vault);
    result = await executeRecompile(vault, plan, {
      dryRun: Boolean(flags["dry-run"]),
      agent: resolveBrainAgent(flags, config),
      now: new Date(),
    });
  } catch (exc) {
    return fail(`refresh failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    process.stdout.write(JSON.stringify({ plan, result }, null, 2) + "\n");
    return result.errors.length === 0 ? 0 : 1;
  }

  if (plan.entries.length === 0) {
    process.stdout.write("nothing to refresh: every tracked page is fresh\n");
    return 0;
  }
  for (const entry of plan.entries) {
    process.stdout.write(`${entry.kind}: ${entry.page}\n    ${entry.reason}\n`);
  }
  if (result.dry_run) {
    process.stdout.write(`dry run: ${plan.entries.length} entr(y/ies) planned, nothing written\n`);
    return 0;
  }
  process.stdout.write(
    `rederived ${result.rederived.length}, archived ${result.archived.length}, manual ${result.manual.length}\n`,
  );
  for (const error of result.errors) {
    process.stdout.write(`error on ${error.page}: ${error.message}\n`);
  }
  return result.errors.length === 0 ? 0 : 1;
}
