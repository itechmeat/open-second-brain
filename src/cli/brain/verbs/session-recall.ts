import {
  coverageSessionRecall,
  describeSessionRecall,
  expandSessionRecall,
  searchSessionRecall,
  SessionCoverageEntityUnknownError,
  SessionCoverageInfeasibleError,
} from "../../../core/brain/session-recall.ts";
import { MINED_KEY_MAX_LENGTH } from "../../../core/brain/link-graph/session-mining.ts";
import { resolveTimeRange } from "../../../core/search/time-range.ts";
import { SearchError } from "../../../core/search/types.ts";
import { CliError, brainVerbContext, parse } from "../helpers.ts";

export async function cmdBrainSessionGrep(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    query: { type: "string" },
    "session-id": { type: "string" },
    limit: { type: "string" },
    "snippet-chars": { type: "string" },
    since: { type: "string" },
    before: { type: "string" },
    operation: { type: "string" },
    "char-budget": { type: "string" },
    "entity-key": { type: "string" },
  });
  const vault = brainVerbContext(flags).vault;
  // Coverage-first selection (t_2c2a883c) rides this verb as an explicit
  // operation; omitted is the historical grep, byte-identical.
  const operation = stringOptional(flags["operation"]) ?? "match";
  if (operation === "coverage") return runSessionGrepCoverage(vault, flags);
  if (operation !== "match") {
    throw new CliError(`brain session-grep: operation must be 'match' or 'coverage'`);
  }
  if (stringOptional(flags["char-budget"]) !== undefined) {
    throw new CliError("brain session-grep: --char-budget applies to --operation coverage only");
  }
  if (stringOptional(flags["entity-key"]) !== undefined) {
    throw new CliError("brain session-grep: --entity-key applies to --operation coverage only");
  }
  // Conversation-chronology bounds (S1): --since / --before parse through
  // the shared time-range grammar; --before maps onto the inclusive upper
  // edge. Absent bounds leave the search unbounded (byte-identical).
  const bounds = sessionGrepBounds(stringOptional(flags["since"]), stringOptional(flags["before"]));
  const result = searchSessionRecall(vault, {
    query: requiredString(flags["query"], "brain session-grep", "--query"),
    ...(stringOptional(flags["session-id"]) !== undefined
      ? { sessionId: stringOptional(flags["session-id"]) }
      : {}),
    ...(positiveIntegerOptional(flags["limit"], "brain session-grep", "--limit") !== undefined
      ? {
          limit: positiveIntegerOptional(flags["limit"], "brain session-grep", "--limit"),
        }
      : {}),
    ...(positiveIntegerOptional(flags["snippet-chars"], "brain session-grep", "--snippet-chars") !==
    undefined
      ? {
          snippetChars: positiveIntegerOptional(
            flags["snippet-chars"],
            "brain session-grep",
            "--snippet-chars",
          ),
        }
      : {}),
    ...(bounds.sinceMs !== null ? { sinceMs: bounds.sinceMs } : {}),
    ...(bounds.untilMs !== null ? { untilMs: bounds.untilMs } : {}),
  });
  writeOutput(result, flags["json"] === true);
  return 0;
}

/**
 * The coverage operation (t_2c2a883c): coverage-first thread selection
 * under --char-budget, with the typed floor-violation infeasibility
 * surfaced as the CLI error it is.
 */
function runSessionGrepCoverage(
  vault: string,
  flags: Record<string, string | boolean | string[] | undefined>,
): number {
  for (const inapplicable of ["query", "since", "before", "limit", "snippet-chars"] as const) {
    if (flags[inapplicable] !== undefined) {
      throw new CliError(
        `brain session-grep: --${inapplicable} is not applicable to --operation coverage; it filters the match operation`,
      );
    }
  }
  const charBudget = positiveIntegerOptional(
    flags["char-budget"],
    "brain session-grep",
    "--char-budget",
  );
  if (charBudget === undefined) {
    throw new CliError("brain session-grep: --char-budget is required for --operation coverage");
  }
  // The miner's own cap, for parity with the MCP tool: mined keys run to
  // MINED_KEY_MAX_LENGTH, so a 129-200 character URL or path key can seed
  // coverage here, and a longer one is refused by name instead of being
  // silently unmatchable against every mined row.
  const entityKey = stringOptional(flags["entity-key"]);
  if (entityKey !== undefined && entityKey.length > MINED_KEY_MAX_LENGTH) {
    throw new CliError(
      `brain session-grep: --entity-key must be at most ${MINED_KEY_MAX_LENGTH} characters`,
    );
  }
  let result;
  try {
    result = coverageSessionRecall(vault, {
      ...(stringOptional(flags["session-id"]) !== undefined
        ? { sessionId: stringOptional(flags["session-id"]) }
        : {}),
      ...(entityKey !== undefined ? { entityKey } : {}),
      charBudget,
    });
  } catch (exc) {
    if (exc instanceof SessionCoverageInfeasibleError) throw new CliError(exc.message);
    if (exc instanceof SessionCoverageEntityUnknownError) throw new CliError(exc.message);
    throw exc;
  }
  writeOutput(result, flags["json"] === true);
  return 0;
}

function sessionGrepBounds(
  since: string | undefined,
  before: string | undefined,
): { sinceMs: number | null; untilMs: number | null } {
  if (since === undefined && before === undefined) return { sinceMs: null, untilMs: null };
  try {
    return resolveTimeRange(
      {
        ...(since !== undefined ? { since } : {}),
        ...(before !== undefined ? { until: before } : {}),
      },
      Date.now(),
    );
  } catch (exc) {
    if (exc instanceof SearchError) throw new CliError(exc.message);
    throw exc;
  }
}

export async function cmdBrainSessionDescribe(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "session-id": { type: "string" },
    topics: { type: "boolean" },
  });
  const vault = brainVerbContext(flags).vault;
  const result = describeSessionRecall(vault, {
    sessionId: requiredString(flags["session-id"], "brain session-describe", "--session-id"),
    ...(flags["topics"] === true ? { topics: true } : {}),
  });
  writeOutput(result, flags["json"] === true);
  return 0;
}

export async function cmdBrainSessionExpand(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "raw-limit": { type: "string" },
    cursor: { type: "string" },
  });
  const vault = brainVerbContext(flags).vault;
  const id = positional[0];
  if (id === undefined) throw new CliError("brain session-expand: record id is required");
  const result = expandSessionRecall(vault, {
    id,
    ...(positiveIntegerOptional(flags["raw-limit"], "brain session-expand", "--raw-limit") !==
    undefined
      ? {
          rawLimit: positiveIntegerOptional(
            flags["raw-limit"],
            "brain session-expand",
            "--raw-limit",
          ),
        }
      : {}),
    ...(stringOptional(flags["cursor"]) !== undefined
      ? { cursor: stringOptional(flags["cursor"]) }
      : {}),
  });
  writeOutput(result, flags["json"] === true);
  return 0;
}

function requiredString(
  value: string | boolean | string[] | undefined,
  command: string,
  flag: string,
): string {
  const parsed = stringOptional(value);
  if (parsed === undefined) throw new CliError(`${command}: ${flag} is required`);
  return parsed;
}

function stringOptional(value: string | boolean | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function positiveIntegerOptional(
  value: string | boolean | string[] | undefined,
  command: string,
  flag: string,
): number | undefined {
  const parsed = stringOptional(value);
  if (parsed === undefined) return undefined;
  if (!/^[0-9]+$/.test(parsed))
    throw new CliError(`${command}: ${flag} must be a positive integer`);
  const number = Number.parseInt(parsed, 10);
  if (number < 1) throw new CliError(`${command}: ${flag} must be a positive integer`);
  return number;
}

function writeOutput(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
