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
    lanes: { type: "boolean" },
    telemetry: { type: "boolean" },
    "telemetry-host": { type: "string" },
    "session-id": { type: "string" },
    "turn-id": { type: "string" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  const maxTokensRaw = flags["max-tokens"] as string | undefined;
  if (!maxTokensRaw) {
    return fail("brain context-pack: --max-tokens <n> is required");
  }
  // Strict integer parsing - `Number()` rejects partial numeric
  // strings like "12abc" that `parseInt` would silently accept.
  const maxTokens = Number(maxTokensRaw);
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    return fail(`brain context-pack: --max-tokens must be a positive integer; got ${maxTokensRaw}`);
  }

  const report = packContext(vault, {
    maxTokens,
    ...(flags["query"] ? { query: flags["query"] as string } : {}),
    ...(flags["lanes"] === true ? { includeLanes: true } : {}),
    ...(flags["telemetry"] === true
      ? {
          telemetry: {
            host: trimOrDefault(flags["telemetry-host"], "cli"),
            ...(trimOrUndefined(flags["session-id"]) !== undefined
              ? { sessionId: trimOrUndefined(flags["session-id"]) }
              : {}),
            ...(trimOrUndefined(flags["turn-id"]) !== undefined
              ? { turnId: trimOrUndefined(flags["turn-id"]) }
              : {}),
          },
        }
      : {}),
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
      ...(report.telemetryId ? { telemetry_id: report.telemetryId } : {}),
      ...(report.lanes ? { lanes: report.lanes } : {}),
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

function trimOrDefault(value: string | boolean | string[] | undefined, fallback: string): string {
  return trimOrUndefined(value) ?? fallback;
}

function trimOrUndefined(value: string | boolean | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
