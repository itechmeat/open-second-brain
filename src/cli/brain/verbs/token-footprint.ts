/**
 * `o2b brain token-footprint` - report vault token size per category
 * with an optional warn threshold. Default output is a one-line
 * summary plus a per-category table; `--json` emits the full report
 * for programmatic consumers (cron digests, dashboards).
 */

import { computeTokenFootprint } from "../../../core/brain/token-footprint.ts";
import { brainVerbContext, fail, okJson, parse } from "../helpers.ts";

export async function cmdBrainTokenFootprint(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "warn-threshold": { type: "string" },
  });
  const { vault } = brainVerbContext(flags);
  const overrideRaw = flags["warn-threshold"] as string | undefined;
  let warnThreshold: number | undefined;
  if (overrideRaw !== undefined) {
    const parsed = Number(overrideRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return fail(
        `brain token-footprint: --warn-threshold must be a positive integer; got ${overrideRaw}`,
      );
    }
    warnThreshold = parsed;
  }

  const report = computeTokenFootprint(vault, {
    ...(warnThreshold !== undefined ? { warnThreshold } : {}),
    envWarnThreshold: process.env["BRAIN_TOKEN_WARN_THRESHOLD"],
  });

  if (flags["json"]) {
    okJson({
      total: report.total,
      files: report.files,
      warn_threshold: report.warnThreshold,
      exceeded: report.exceeded,
      by_category: report.byCategory.map((c) => ({
        name: c.name,
        tokens: c.tokens,
        files: c.files,
      })),
    });
    return 0;
  }

  process.stdout.write(`total tokens: ${report.total} (across ${report.files} file(s))\n`);
  process.stdout.write(`warn threshold: ${report.warnThreshold}\n`);
  if (report.exceeded) {
    process.stdout.write(`WARN: vault exceeds ${report.warnThreshold} tokens\n`);
  }
  process.stdout.write("\nby category:\n");
  for (const c of report.byCategory) {
    process.stdout.write(
      `  ${c.name.padEnd(12)} ${String(c.tokens).padStart(10)} tokens  (${c.files} file(s))\n`,
    );
  }
  return 0;
}
