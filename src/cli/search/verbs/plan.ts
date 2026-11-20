/**
 * `o2b search plan` — the graph-index query pre-pass: which notes a read
 * would touch, how many hops away they are, and why they were shortlisted,
 * without reading them.
 */

import { planRead } from "../../../core/search/index.ts";
import { CLI_TRANSPORT_REACH } from "../../transport-reach.ts";
import {
  CliError,
  flagBoolean,
  flagString,
  isIntegerWithin,
  parseFlags,
  resolveConfig,
  VAULT_FLAGS,
} from "../helpers.ts";

const DEFAULT_MAX_HOPS = "2";
const DEFAULT_SHORTLIST_LIMIT = "10";

export async function cmdSearchPlan(argv: ReadonlyArray<string>): Promise<number> {
  const { flags, positional } = parseFlags(argv, {
    ...VAULT_FLAGS,
    hops: { type: "string", default: DEFAULT_MAX_HOPS },
    limit: { type: "string", default: DEFAULT_SHORTLIST_LIMIT },
    "index-only": { type: "boolean" },
    visibility: { type: "string-array" },
    "agent-scope": { type: "string" },
    json: { type: "boolean" },
  });
  const query = positional.join(" ").trim();
  if (query === "")
    throw new CliError('usage: o2b search plan "<query>" [--index-only] [--hops N]');
  const cfg = resolveConfig(flags);
  const visibility = flags["visibility"] as string[] | undefined;
  const agentScope = flagString(flags, "agent-scope");
  const maxHops = Number(flags["hops"] ?? DEFAULT_MAX_HOPS);
  const shortlistLimit = Number(flags["limit"] ?? DEFAULT_SHORTLIST_LIMIT);
  if (!isIntegerWithin(maxHops, { min: 0 })) {
    throw new CliError(`--hops must be a non-negative integer, got '${flags["hops"]}'`);
  }
  if (!isIntegerWithin(shortlistLimit, { min: 1 })) {
    throw new CliError(`--limit must be a positive integer, got '${flags["limit"]}'`);
  }
  const plan = await planRead(cfg, query, {
    indexOnly: flagBoolean(flags, "index-only"),
    maxHops,
    shortlistLimit,
    // The planner withholds what `o2b search` withholds from the same
    // caller: the operator's CLI reach, and the scopes the flags name.
    filters: {
      transportReach: CLI_TRANSPORT_REACH,
      ...(visibility !== undefined && visibility.length > 0 ? { visibility } : {}),
      ...(agentScope !== undefined ? { agentScope } : {}),
    },
  });
  if (flagBoolean(flags, "json")) {
    process.stdout.write(JSON.stringify(plan) + "\n");
    return 0;
  }
  process.stdout.write(`${plan.mode} (notes read: ${plan.notesRead})\n`);
  if (plan.shortlist.length === 0) {
    process.stdout.write("  no candidates\n");
    return 0;
  }
  for (const e of plan.shortlist) {
    const title = e.title ?? "(untitled)";
    process.stdout.write(
      `  ${e.path}  "${title}"  hops=${e.hops} degree=${e.degree} [${e.reasons.join(",")}]\n`,
    );
  }
  return 0;
}
