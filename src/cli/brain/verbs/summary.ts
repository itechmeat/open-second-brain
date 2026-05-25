/**
 * `o2b brain summary` - operator dashboard (v0.10.16). Aggregates
 * doctor, dream (dry-run), verification delta, instruction-file
 * ceiling, and ranked maintenance actions into one output.
 *
 * Defaults to markdown so an operator can paste the report into
 * their notes; `--json` returns the structured envelope for tooling.
 */

import { defaultConfigPath } from "../../../core/config.ts";
import { dream } from "../../../core/brain/dream.ts";
import {
  buildOperatorSummary,
  renderOperatorSummaryMarkdown,
} from "../../../core/brain/trust/operator-summary.ts";
import { parse, fail, okJson, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainSummary(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "skip-dream": { type: "boolean" },
    "top-actions": { type: "string" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  let topActionsN: number | undefined;
  const topRaw = flags["top-actions"] as string | undefined;
  if (topRaw !== undefined) {
    const n = Number(topRaw);
    if (!Number.isInteger(n) || n < 0) {
      return fail(
        `brain summary: --top-actions must be a non-negative integer; got ${topRaw}`,
      );
    }
    topActionsN = n;
  }

  let dreamSummary;
  if (!flags["skip-dream"]) {
    try {
      dreamSummary = dream(vault, { dryRun: true });
    } catch {
      dreamSummary = undefined;
    }
  }

  const summary = buildOperatorSummary(vault, {
    ...(dreamSummary ? { dreamSummary } : {}),
    ...(topActionsN !== undefined ? { topActionsN } : {}),
  });

  if (flags["json"]) {
    okJson({
      trust_verdict: summary.trust_verdict,
      digest_summary: summary.digest_summary,
      doctor_summary: {
        warning_count: summary.doctor_summary.warning_count,
        error_count: summary.doctor_summary.error_count,
      },
      dream_summary: summary.dream_summary,
      verification_delta: {
        summary: summary.verification_delta.summary,
        entries: summary.verification_delta.entries,
      },
      top_actions: summary.top_actions,
      instruction_file_warnings: summary.instruction_file_warnings,
    });
    return 0;
  }

  process.stdout.write(renderOperatorSummaryMarkdown(summary));
  return 0;
}
