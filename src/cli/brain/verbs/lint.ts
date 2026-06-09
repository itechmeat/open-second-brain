/**
 * `o2b brain lint --consolidate` - read-only structural drift scan
 * with optional `--apply` mode that rewrites the smallest possible
 * fix per finding.
 */

import { lintConsolidate } from "../../../core/brain/lint-consolidate.ts";
import { brainVerbContext, fail, okJson, parse } from "../helpers.ts";

export async function cmdBrainLint(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    consolidate: { type: "boolean" },
    apply: { type: "boolean" },
    yes: { type: "boolean" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);

  if (!flags["consolidate"]) {
    return fail("brain lint requires --consolidate (no other modes yet)");
  }

  const apply = Boolean(flags["apply"]);
  if (apply && !flags["yes"] && (flags["json"] || !process.stdin.isTTY)) {
    return fail("brain lint --apply requires --yes in non-interactive mode");
  }

  const report = lintConsolidate(vault, { apply });

  if (flags["json"]) {
    okJson({
      scanned: report.scanned,
      applied: report.applied,
      files_written: report.filesWritten,
      fixes: report.fixes,
      demotions: report.demotions,
    });
    return 0;
  }

  process.stdout.write(
    `scanned: ${report.scanned} file(s); ${report.applied ? "apply" : "dry-run"}\n`,
  );
  process.stdout.write(`fixes: ${report.fixes.length}\n`);
  for (const f of report.fixes) {
    process.stdout.write(`  ${f.path}: [[${f.from}]] -> [[${f.to}]]\n`);
  }
  process.stdout.write(`demotions: ${report.demotions.length}\n`);
  for (const d of report.demotions) {
    process.stdout.write(`  ${d.id} (age=${d.ageDays}d) -> draft\n`);
  }
  if (report.applied) {
    process.stdout.write(`files written: ${report.filesWritten}\n`);
  } else if (report.fixes.length + report.demotions.length > 0) {
    process.stdout.write("\nre-run with --apply --yes to write changes.\n");
  }
  return 0;
}
