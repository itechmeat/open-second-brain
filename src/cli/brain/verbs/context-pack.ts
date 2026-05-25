/**
 * `o2b brain context-pack` - return the highest-tier, most recent
 * vault slice that fits under a caller-specified token budget.
 * Intended for agents priming a context window without manual page
 * curation. `--query <q>` adds a case/Unicode-insensitive substring
 * filter on topic + principle.
 */

import { defaultConfigPath } from "../../../core/config.ts";
import { packContext } from "../../../core/brain/context-pack.ts";
import { parse, fail, okJson, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainContextPack(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "max-tokens": { type: "string" },
    query: { type: "string" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  const maxTokensRaw = flags["max-tokens"] as string | undefined;
  if (!maxTokensRaw) {
    return fail("brain context-pack: --max-tokens <n> is required");
  }
  const maxTokens = Number.parseInt(maxTokensRaw, 10);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return fail(`brain context-pack: --max-tokens must be a positive integer; got ${maxTokensRaw}`);
  }

  const report = packContext(vault, {
    maxTokens,
    ...(flags["query"] ? { query: flags["query"] as string } : {}),
  });

  if (flags["json"]) {
    okJson({
      max_tokens: report.maxTokens,
      tokens_used: report.tokensUsed,
      items: report.items.map((i) => ({
        id: i.id,
        path: i.path,
        tier: i.tier,
        tokens: i.tokens,
      })),
      skipped: report.skipped,
    });
    return 0;
  }

  process.stdout.write(`tokens used: ${report.tokensUsed} / ${report.maxTokens}\n`);
  process.stdout.write(`pages included: ${report.items.length}\n`);
  process.stdout.write(`pages skipped: ${report.skipped.length}\n\n`);
  for (const i of report.items) {
    process.stdout.write(`[${i.tier}] ${i.id} (${i.tokens} tokens)\n`);
  }
  return 0;
}
