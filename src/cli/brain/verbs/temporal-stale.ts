import { defaultConfigPath } from "../../../core/config.ts";
import { buildTimelineIndex } from "../../../core/brain/temporal/build-index.ts";
import { findStaleEntries } from "../../../core/brain/temporal/stale-watch.ts";
import { loadTemporalConfigSafe } from "../../../core/brain/policy.ts";
import { parse, resolveBrainVault } from "../helpers.ts";

/**
 * `o2b brain stale [--vault PATH] [--json]`
 *
 * Pure structural staleness report. Thresholds come from the
 * `temporal:` block in `_brain.yaml` (defaults apply when the block
 * is absent).
 */
export async function cmdBrainStale(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  const cfg = loadTemporalConfigSafe(vault);
  const index = buildTimelineIndex(vault, {});
  const report = findStaleEntries(index, vault, cfg);

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    `Stale entries (pref >= ${cfg.stale_pref_days}d, signal >= ${cfg.stale_signal_days}d, log >= ${cfg.stale_log_days}d):\n`,
  );
  process.stdout.write(`  preferences: ${report.stalePreferences.length}\n`);
  for (const p of report.stalePreferences) {
    process.stdout.write(`    ${p.prefId}  age=${p.ageDays}d  ${p.path}\n`);
  }
  process.stdout.write(`  signals: ${report.staleSignals.length}\n`);
  for (const s of report.staleSignals) {
    process.stdout.write(`    ${s.signalId}  age=${s.ageDays}d  ${s.path}\n`);
  }
  process.stdout.write(`  log files: ${report.staleLogFiles.length}\n`);
  for (const l of report.staleLogFiles) {
    process.stdout.write(`    ${l.path}  age=${l.ageDays}d\n`);
  }
  return 0;
}
