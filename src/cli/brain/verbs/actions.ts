/**
 * `o2b brain actions` - ranked maintenance action list. Aggregates
 * inputs from {@link findDuplicateCandidates}, {@link lintConsolidate}
 * (dry-run), and {@link computeTokenFootprint}, runs them through
 * {@link scoreActions}, and emits the top-N actionable items ordered
 * by impact descending.
 */

import { findDuplicateCandidates } from "../../../core/brain/page-dedup.ts";
import { lintConsolidate } from "../../../core/brain/lint-consolidate.ts";
import { computeTokenFootprint } from "../../../core/brain/token-footprint.ts";
import { scoreActions, type ActionInputs } from "../../../core/brain/maintenance/action-scorer.ts";
import { brainVerbContext, fail, okJson, parse } from "../helpers.ts";

export async function cmdBrainActions(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "top-n": { type: "string" },
  });
  const { vault } = brainVerbContext(flags);
  const topNRaw = flags["top-n"] as string | undefined;
  let topN = 10;
  if (topNRaw !== undefined) {
    const parsed = Number(topNRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return fail(`brain actions: --top-n must be a positive integer; got ${topNRaw}`);
    }
    topN = parsed;
  }

  const dedup = findDuplicateCandidates(vault);
  const lint = lintConsolidate(vault, { apply: false });
  const footprint = computeTokenFootprint(vault);

  const inputs: ActionInputs = {
    dedupCandidates: dedup.candidates.map((c) => ({
      canonicalId: c.canonical.id,
      secondaryCount: c.secondaries.length,
    })),
    staleByLifecycle: lint.demotions.map((d) => ({
      id: d.id,
      ageDays: d.ageDays,
    })),
    brokenLinks: lint.fixes.map((f) => ({ path: f.path, from: f.from })),
    tokenFootprint: {
      total: footprint.total,
      warnThreshold: footprint.warnThreshold,
    },
  };

  const items = scoreActions(inputs, { topN });

  if (flags["json"]) {
    okJson({ items });
    return 0;
  }

  if (items.length === 0) {
    process.stdout.write("no maintenance actions queued.\n");
    return 0;
  }
  process.stdout.write(`top ${items.length} maintenance action(s):\n`);
  for (const it of items) {
    process.stdout.write(
      `  [${it.category.padEnd(15)}] impact=${String(it.impact).padStart(4)}  ${it.title}\n`,
    );
  }
  return 0;
}
