/**
 * `o2b brain anticipate` - inspect or refresh the anticipatory
 * context cache (continuity-hygiene-freshness suite).
 *
 *   o2b brain anticipate --session <id> [--refresh] [--signal <text>] [--json]
 *
 * Reads the warm cache for the session's lineage root (or a live
 * fallback) and reports `cache_state`. `--refresh` forces a refresh
 * first; the TTL debounce still applies.
 */

import {
  readAnticipatoryContext,
  refreshAnticipatoryCache,
} from "../../../core/brain/anticipatory-cache.ts";
import { loadBrainConfig } from "../../../core/brain/policy.ts";
import { brainVerbContext, fail, parse } from "../helpers.ts";

export async function cmdBrainAnticipate(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    session: { type: "string" },
    refresh: { type: "boolean" },
    signal: { type: "string" },
    json: { type: "boolean" },
  });
  const sessionId = flags["session"] as string | undefined;
  if (sessionId === undefined || sessionId.trim() === "") {
    return fail("usage: o2b brain anticipate --session <id> [--refresh] [--signal <text>]");
  }
  const { vault } = brainVerbContext(flags);

  let ttlSeconds: number | undefined;
  let maxTokens: number | undefined;
  try {
    const anticipatory = loadBrainConfig(vault).anticipatory;
    ttlSeconds = anticipatory?.ttl_seconds;
    maxTokens = anticipatory?.max_tokens;
  } catch {
    // defaults apply
  }
  const now = new Date();
  if (flags["refresh"]) {
    const signal = flags["signal"] as string | undefined;
    refreshAnticipatoryCache(vault, {
      sessionId,
      ...(signal !== undefined && signal.trim() !== "" ? { signalText: signal } : {}),
      now,
      ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    });
  }
  const result = readAnticipatoryContext(vault, {
    sessionId,
    now,
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  });

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(
    `cache: ${result.cache_state} (root ${result.root_session_id}${
      result.generated_at !== undefined ? `, generated ${result.generated_at}` : ""
    })\n`,
  );
  process.stdout.write(
    `items: ${result.context.items.length}, session hits: ${result.context.session_hits.length}\n`,
  );
  for (const item of result.context.items) {
    process.stdout.write(`- [${item.tier}] ${item.id} (${item.tokens} tokens)\n`);
  }
  return 0;
}
