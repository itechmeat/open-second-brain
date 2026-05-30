import { defaultConfigPath } from "../../../core/config.ts";
import { planSemanticsBackfill } from "../../../core/brain/semantics-backfill.ts";
import { info, okJson, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainSemanticsBackfill(
  argv: string[],
): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const plan = planSemanticsBackfill(vault);

  if (flags["json"]) {
    okJson({
      dry_run: true,
      count: plan.proposals.length,
      proposals: plan.proposals,
    });
    return 0;
  }

  info(`Semantics backfill dry-run proposals: ${plan.proposals.length}`);
  for (const proposal of plan.proposals) {
    info(
      `  ${proposal.source_id} ${proposal.field}: ${proposal.value} ` +
        `(target ${proposal.target_id}, ${proposal.reason})`,
    );
  }
  return 0;
}
