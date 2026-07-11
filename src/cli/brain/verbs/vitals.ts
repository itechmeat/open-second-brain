/**
 * `o2b brain vitals` — print the aggregate governance health
 * scorecard (domain diversity, connectivity index, orphan
 * preferences, gap pressure) and record one `vault_vitals` metric.
 * Read-only over `Brain/preferences/`; reuses `runDoctor`'s
 * concept-gap count for `gap_pressure` rather than recomputing it.
 *
 * Exit codes: 0 on success, 1 on an operational failure, 2 on usage
 * errors.
 */

import { computeVaultVitals } from "../../../core/brain/vitals.ts";
import { appendMetric } from "../../../core/brain/metrics.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { brainVerbContext, fail, ok, okJson, parse } from "../helpers.ts";

const USAGE = "usage: o2b brain vitals [--orphan-threshold N] [--vault <path>] [--json]";

export async function cmdBrainVitals(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    "orphan-threshold": { type: "string" },
    json: { type: "boolean" },
  });
  const asJson = flags["json"] === true;
  if (positional.length !== 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const orphanThreshold = parsePositiveInt(flags["orphan-threshold"] as string | undefined);
  if (orphanThreshold === false) {
    process.stderr.write("brain vitals: --orphan-threshold must be a positive integer\n");
    return 2;
  }

  const { vault } = brainVerbContext(flags);

  try {
    const report = computeVaultVitals(
      vault,
      orphanThreshold !== undefined ? { orphanThreshold } : {},
    );

    try {
      appendMetric(vault, {
        surface: "vault_vitals",
        runAt: isoSecond(new Date()),
        payload: {
          preferences_scanned: report.preferences_scanned,
          domain_diversity: report.domain_diversity,
          connectivity_index: report.connectivity_index,
          orphan_count: report.orphan_preferences.length,
          gap_pressure: report.gap_pressure,
        },
      });
    } catch {
      // Metrics are observability, not correctness.
    }

    if (asJson) {
      okJson({
        preferences_scanned: report.preferences_scanned,
        domain_diversity: report.domain_diversity,
        connectivity_index: report.connectivity_index,
        gap_pressure: report.gap_pressure,
        orphan_preferences: report.orphan_preferences,
        scope_distribution: report.scope_distribution,
      });
      return 0;
    }

    ok(`vitals: ${report.preferences_scanned} confirmed preference(s) scanned`);
    ok(`  domain_diversity:   ${report.domain_diversity}`);
    ok(`  connectivity_index: ${report.connectivity_index}`);
    ok(`  gap_pressure:       ${report.gap_pressure}`);
    ok(`  orphan_preferences: ${report.orphan_preferences.length}`);
    for (const o of report.orphan_preferences) {
      ok(`    [[${o.id}]] evidence=${o.evidence_count}${o.scope ? ` scope=${o.scope}` : ""}`);
    }
    ok("  scope_distribution:");
    for (const s of report.scope_distribution) {
      ok(`    ${s.scope}: ${s.count}`);
    }
    return 0;
  } catch (exc) {
    return fail(`vitals failed: ${(exc as Error).message ?? exc}`);
  }
}

function parsePositiveInt(raw: string | undefined): number | undefined | false {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : false;
}
