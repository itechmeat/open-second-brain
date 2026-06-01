import { defaultConfigPath } from "../../../core/config.ts";
import {
  evaluateAttentionFlow,
  listAttentionFlows,
  renderAttentionFlow,
} from "../../../core/brain/attention-flows.ts";
import { CliError, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainAttentionFlows(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "list") return list(rest);
  if (sub === "evaluate") return evaluate(rest);
  if (sub === "render") return render(rest);
  throw new CliError(
    "brain attention-flows: expected list, evaluate, or render",
  );
}

function list(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const vault = resolveBrainVault(
    flags["vault"] as string | undefined,
    defaultConfigPath(),
  );
  const flows = listAttentionFlows(vault);
  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify({ total: flows.length, flows }, null, 2) + "\n",
    );
    return 0;
  }
  process.stdout.write(`${flows.length} attention flow(s):\n`);
  for (const flow of flows) {
    process.stdout.write(
      `  ${flow.id}  actions=${flow.actions.join(",") || "-"}\n`,
    );
  }
  return 0;
}

function evaluate(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const flowId = positional[0];
  if (!flowId)
    throw new CliError("brain attention-flows evaluate: flow id is required");
  const vault = resolveBrainVault(
    flags["vault"] as string | undefined,
    defaultConfigPath(),
  );
  const report = evaluateAttentionFlow(vault, flowId);
  if (flags["json"]) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`${report.flow_id}: ${report.title}\n`);
  for (const section of report.sections) {
    process.stdout.write(`  ${section.action}: ${section.items.length}\n`);
  }
  return 0;
}

function render(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const flowId = positional[0];
  if (!flowId)
    throw new CliError("brain attention-flows render: flow id is required");
  const vault = resolveBrainVault(
    flags["vault"] as string | undefined,
    defaultConfigPath(),
  );
  const text = renderAttentionFlow(vault, flowId);
  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify({ flow_id: flowId, text }, null, 2) + "\n",
    );
    return 0;
  }
  process.stdout.write(text);
  return 0;
}
