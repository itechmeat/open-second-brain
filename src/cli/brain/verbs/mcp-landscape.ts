import { buildMcpLandscape } from "../../../core/graph/mcp-config.ts";
import { brainVerbContext, parse } from "../helpers.ts";

export async function cmdBrainMcpLandscape(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);

  const landscape = buildMcpLandscape(vault);

  if (flags["json"]) {
    process.stdout.write(JSON.stringify({ servers: landscape.servers }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`MCP servers configured in vault: ${landscape.servers.length}\n`);
  for (const s of landscape.servers) {
    process.stdout.write(`  ${s.name}  (${s.source})\n`);
    if (s.packages.length > 0) process.stdout.write(`    packages: ${s.packages.join(", ")}\n`);
    if (s.env.length > 0) process.stdout.write(`    env: ${s.env.join(", ")}\n`);
  }
  return 0;
}
