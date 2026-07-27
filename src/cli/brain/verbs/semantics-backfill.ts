import { planSemanticsBackfill } from "../../../core/brain/semantics-backfill.ts";
import { brainVerbContext, info, okJson, parse } from "../helpers.ts";

export async function cmdBrainSemanticsBackfill(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);
  const plan = planSemanticsBackfill(vault);

  if (flags["json"]) {
    okJson({
      dry_run: true,
      count: plan.proposals.length,
      proposals: plan.proposals,
    });
    return 0;
  }

  // An empty proposal list names no forward exit, deliberately. This verb is
  // dry-run only and has no apply path, so there is no command to name; and
  // no proposals means the inverse-edge invariant it previews already holds,
  // which is an answer rather than a degraded state.
  info(`Semantics backfill dry-run proposals: ${plan.proposals.length}`);
  for (const proposal of plan.proposals) {
    info(
      `  ${proposal.source_id} ${proposal.field}: ${proposal.value} ` +
        `(target ${proposal.target_id}, ${proposal.reason})`,
    );
  }
  return 0;
}
