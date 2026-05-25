/**
 * `o2b brain page-dedup` - scan the vault for pages that share a
 * normalised dedup key and (optionally) merge them.
 *
 * Default mode is read-only listing. `--apply` performs the merge
 * for every reported candidate: writes `merged_into:` on each
 * secondary and rewrites `[[<secondary>]]` references across the
 * vault to point at the canonical page.
 */

import { defaultConfigPath } from "../../../core/config.ts";
import {
  findDuplicateCandidates,
  mergePage,
} from "../../../core/brain/page-dedup.ts";
import { parse, fail, okJson, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainPageDedup(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    apply: { type: "boolean" },
    json: { type: "boolean" },
    yes: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  const apply = Boolean(flags["apply"]);
  if (apply && !flags["yes"] && (flags["json"] || !process.stdin.isTTY)) {
    return fail(
      "brain page-dedup --apply requires --yes in non-interactive mode",
    );
  }

  const report = findDuplicateCandidates(vault);

  if (!apply) {
    if (flags["json"]) {
      okJson({
        scanned: report.scanned,
        candidates: report.candidates.map((c) => ({
          key: c.key,
          canonical: c.canonical.id,
          secondaries: c.secondaries.map((s) => s.id),
        })),
      });
      return 0;
    }
    process.stdout.write(`pages scanned: ${report.scanned}\n`);
    process.stdout.write(`duplicate clusters: ${report.candidates.length}\n`);
    for (const c of report.candidates) {
      process.stdout.write(
        `\ncanonical: ${c.canonical.id}  (topic: ${c.canonical.topic})\n`,
      );
      for (const s of c.secondaries) {
        process.stdout.write(`  -> ${s.id}\n`);
      }
    }
    if (report.candidates.length === 0) {
      process.stdout.write("no duplicate clusters detected.\n");
    } else {
      process.stdout.write("\nre-run with --apply --yes to merge.\n");
    }
    return 0;
  }

  let mergedCount = 0;
  let wikilinksTouched = 0;
  for (const c of report.candidates) {
    for (const s of c.secondaries) {
      const res = mergePage(vault, s.id, c.canonical.id);
      mergedCount++;
      wikilinksTouched += res.wikilinksUpdated;
    }
  }

  if (flags["json"]) {
    okJson({
      scanned: report.scanned,
      clusters: report.candidates.length,
      merged: mergedCount,
      wikilinks_updated: wikilinksTouched,
    });
    return 0;
  }
  process.stdout.write(`merged ${mergedCount} page(s) into canonicals.\n`);
  process.stdout.write(`wikilinks updated: ${wikilinksTouched}\n`);
  return 0;
}
