import { defaultConfigPath } from "../../../core/config.ts";
import {
  auditMoc,
  MocAuditError,
} from "../../../core/brain/link-graph/moc-audit.ts";
import { normaliseWikilinkTarget } from "../../../core/brain/wikilink.ts";
import { parse, fail, resolveBrainVault } from "../helpers.ts";

/**
 * `o2b brain moc-audit <hub-id> [--vault PATH] [--json]`
 *
 * Run the per-MOC coverage audit and print the bucketed report.
 * Rejects non-MOC hubs (outbound count + link density below
 * configured thresholds) with a usage error.
 */
export async function cmdBrainMocAudit(argv: string[]): Promise<number> {
  const { positional, flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  const id = positional[0];
  if (!id) return fail("brain moc-audit requires a hub note id");
  const hub = normaliseWikilinkTarget(id);

  let report;
  try {
    report = auditMoc(vault, hub);
  } catch (err) {
    if (err instanceof MocAuditError) return fail(`brain moc-audit: ${err.message}`);
    throw err;
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          hub_id: report.hubId,
          outbound_count: report.outboundCount,
          well_covered: report.wellCovered,
          fragile: report.fragile,
          candidate_missing: report.candidateMissing,
          ...(report.suggestedNext
            ? { suggested_next: report.suggestedNext }
            : {}),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  process.stdout.write(
    `MOC audit for ${report.hubId} (${report.outboundCount} outbound):\n`,
  );
  process.stdout.write(`  well-covered: ${report.wellCovered.length}\n`);
  for (const m of report.wellCovered) {
    process.stdout.write(`    ${m.id}  (backlinks=${m.backlinkCount}, body=${m.bodyChars})\n`);
  }
  process.stdout.write(`  fragile: ${report.fragile.length}\n`);
  for (const m of report.fragile) {
    process.stdout.write(`    ${m.id}  (backlinks=${m.backlinkCount}, body=${m.bodyChars})\n`);
  }
  process.stdout.write(`  candidate-missing: ${report.candidateMissing.length}\n`);
  for (const c of report.candidateMissing) {
    process.stdout.write(`    ${c.id}  (refs=${c.referenceCount})\n`);
  }
  if (report.suggestedNext) {
    process.stdout.write(
      `  suggested-next: ${report.suggestedNext.id} (refs=${report.suggestedNext.referenceCount})\n`,
    );
  }
  return 0;
}
