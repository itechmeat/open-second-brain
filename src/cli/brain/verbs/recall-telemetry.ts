import {
  isRecallTelemetryMode,
  isRecallTelemetryStatus,
  listRecallTelemetry,
  summarizeRecallTelemetry,
} from "../../../core/brain/recall-telemetry.ts";
import { listGateTelemetry, summarizeGateTelemetry } from "../../../core/brain/gate-telemetry.ts";
import { computeMemoryCostMeter } from "../../../core/brain/memory-cost-meter.ts";
import { CliError, brainVerbContext, parse } from "../helpers.ts";

export async function cmdBrainRecallTelemetry(argv: string[]): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  if (subcommand === "list") return listTelemetry(rest);
  if (subcommand === "summary") return summarizeTelemetry(rest);
  // Gate-decision telemetry (Workspace Insight Suite, t_65036e02).
  if (subcommand === "gate-list") return listGate(rest);
  if (subcommand === "gate-summary") return summarizeGate(rest);
  // Write-vs-read cost meter (memory cost meter).
  if (subcommand === "cost") return costMeter(rest);
  throw new CliError(
    "brain recall-telemetry: expected list, summary, gate-list, gate-summary, or cost",
  );
}

function listTelemetry(argv: string[]): number {
  const { flags } = parseTelemetryFlags(argv);
  const vault = brainVerbContext(flags).vault;
  const filter = telemetryFilter(flags, "brain recall-telemetry list");
  const records = listRecallTelemetry(vault, filter);

  if (flags["json"]) {
    process.stdout.write(JSON.stringify({ total: records.length, records }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`${records.length} recall telemetry record(s):\n`);
  for (const record of records) {
    process.stdout.write(
      `  ${record.createdAt}  ${record.id}  ${record.payload["mode"] ?? "unknown"}  ${record.payload["status"] ?? "unknown"}  results=${record.payload["result_count"] ?? "?"}\n`,
    );
  }
  return 0;
}

function summarizeTelemetry(argv: string[]): number {
  const { flags } = parseTelemetryFlags(argv);
  const vault = brainVerbContext(flags).vault;
  const summary = summarizeRecallTelemetry(
    vault,
    telemetryFilter(flags, "brain recall-telemetry summary"),
  );

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`records: ${summary.total}\n`);
  process.stdout.write(`total results: ${summary.total_results}\n`);
  process.stdout.write(`empty runs: ${summary.empty_runs}\n`);
  process.stdout.write(`by mode: ${JSON.stringify(summary.by_mode)}\n`);
  process.stdout.write(`by status: ${JSON.stringify(summary.by_status)}\n`);
  process.stdout.write(`gaps: ${JSON.stringify(summary.gap_counts)}\n`);
  return 0;
}

function rejectRecallOnlyFlags(
  flags: Record<string, string | boolean | string[] | undefined>,
  command: string,
  alsoReject: ReadonlyArray<string> = [],
): void {
  // Gate records have no mode/status dimensions - dropping these
  // silently would hand back unfiltered results.
  for (const name of ["mode", "status", ...alsoReject]) {
    if (flags[name] !== undefined) {
      throw new CliError(`${command}: --${name} is not supported for gate telemetry`);
    }
  }
}

function listGate(argv: string[]): number {
  const { flags } = parseTelemetryFlags(argv);
  rejectRecallOnlyFlags(flags, "brain recall-telemetry gate-list");
  const vault = brainVerbContext(flags).vault;
  const filter = telemetryFilter(flags, "brain recall-telemetry gate-list");
  const records = listGateTelemetry(vault, {
    ...(filter.host !== undefined ? { host: filter.host } : {}),
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
    ...(filter.limit !== undefined ? { limit: filter.limit } : {}),
  });
  if (flags["json"]) {
    process.stdout.write(JSON.stringify({ total: records.length, records }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`${records.length} gate decision(s):\n`);
  for (const record of records) {
    process.stdout.write(
      `  ${record.createdAt}  ${record.payload["decision"]}  ${record.payload["reason"]}  host=${record.payload["host"] ?? "?"}\n`,
    );
  }
  return 0;
}

function summarizeGate(argv: string[]): number {
  const { flags } = parseTelemetryFlags(argv);
  rejectRecallOnlyFlags(flags, "brain recall-telemetry gate-summary", ["limit"]);
  const vault = brainVerbContext(flags).vault;
  const filter = telemetryFilter(flags, "brain recall-telemetry gate-summary");
  const summary = summarizeGateTelemetry(vault, {
    ...(filter.host !== undefined ? { host: filter.host } : {}),
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
  });
  if (flags["json"]) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`decisions: ${summary.total}\n`);
  process.stdout.write(`retrieved: ${summary.retrieved}\n`);
  process.stdout.write(`skipped: ${summary.skipped}\n`);
  process.stdout.write(`by reason: ${JSON.stringify(summary.by_reason)}\n`);
  return 0;
}

function costMeter(argv: string[]): number {
  const { flags } = parseTelemetryFlags(argv);
  // The cost meter is period-based; mode/status/host/limit filter recall
  // records only and have no write-side analogue, so reject them rather
  // than silently ignore.
  for (const name of ["mode", "status", "host", "limit"]) {
    if (flags[name] !== undefined) {
      throw new CliError(
        `brain recall-telemetry cost: --${name} is not supported for the cost meter`,
      );
    }
  }
  const vault = brainVerbContext(flags).vault;
  const since = trimOrUndefined(flags["since"]);
  const until = trimOrUndefined(flags["until"]);
  // Parse each numeric weight once; the cost meter omits undefined weights
  // so the module applies its own defaults.
  const writeCost = parseNonNegativeNumber(
    trimOrUndefined(flags["write-cost"]),
    "brain recall-telemetry cost",
    "--write-cost",
  );
  const readCost = parseNonNegativeNumber(
    trimOrUndefined(flags["read-cost"]),
    "brain recall-telemetry cost",
    "--read-cost",
  );
  const writeHeavyRatio = parseNonNegativeNumber(
    trimOrUndefined(flags["write-heavy-ratio"]),
    "brain recall-telemetry cost",
    "--write-heavy-ratio",
  );
  const meter = computeMemoryCostMeter(vault, {
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    weights: { write: writeCost, read: readCost },
    ...(writeHeavyRatio !== undefined ? { writeHeavyRatio } : {}),
  });

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(meter, null, 2) + "\n");
    return 0;
  }

  const ratio = meter.write_read_ratio === null ? "n/a (no reads)" : meter.write_read_ratio;
  process.stdout.write(`writes: ${meter.writes.total}\n`);
  process.stdout.write(`reads: ${meter.reads.total}\n`);
  process.stdout.write(`write/read ratio: ${ratio}\n`);
  process.stdout.write(`write-heavy: ${meter.write_heavy ? "yes" : "no"}\n`);
  process.stdout.write(`by write kind: ${JSON.stringify(meter.writes.by_kind)}\n`);
  process.stdout.write(`by read mode: ${JSON.stringify(meter.reads.by_mode)}\n`);
  process.stdout.write(
    `cost (write=${meter.weights.write}, read=${meter.weights.read}): ` +
      `write=${meter.cost.write} read=${meter.cost.read} total=${meter.cost.total}\n`,
  );
  return 0;
}

function parseTelemetryFlags(argv: string[]): {
  readonly flags: Record<string, string | boolean | string[] | undefined>;
} {
  return parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    mode: { type: "string" },
    status: { type: "string" },
    host: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    limit: { type: "string" },
    "write-cost": { type: "string" },
    "read-cost": { type: "string" },
    "write-heavy-ratio": { type: "string" },
  });
}

function parseNonNegativeNumber(
  value: string | undefined,
  label: string,
  flag: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliError(`${label}: ${flag} must be a non-negative number`);
  }
  return parsed;
}

function telemetryFilter(
  flags: Record<string, string | boolean | string[] | undefined>,
  label: string,
): {
  readonly mode?: ReturnType<typeof modeFlag>;
  readonly status?: ReturnType<typeof statusFlag>;
  readonly host?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
} {
  return {
    ...(modeFlag(flags["mode"], label) !== undefined
      ? { mode: modeFlag(flags["mode"], label) }
      : {}),
    ...(statusFlag(flags["status"], label) !== undefined
      ? { status: statusFlag(flags["status"], label) }
      : {}),
    ...(trimOrUndefined(flags["host"]) !== undefined
      ? { host: trimOrUndefined(flags["host"]) }
      : {}),
    ...(trimOrUndefined(flags["since"]) !== undefined
      ? { since: trimOrUndefined(flags["since"]) }
      : {}),
    ...(trimOrUndefined(flags["until"]) !== undefined
      ? { until: trimOrUndefined(flags["until"]) }
      : {}),
    ...(parsePositiveInteger(trimOrUndefined(flags["limit"]), label, "--limit") !== undefined
      ? {
          limit: parsePositiveInteger(trimOrUndefined(flags["limit"]), label, "--limit"),
        }
      : {}),
  };
}

function modeFlag(raw: string | boolean | string[] | undefined, label: string) {
  const value = trimOrUndefined(raw);
  if (value === undefined) return undefined;
  if (!isRecallTelemetryMode(value)) {
    throw new CliError(`${label}: --mode must be search, context_pack, or pre_compress`);
  }
  return value;
}

function statusFlag(raw: string | boolean | string[] | undefined, label: string) {
  const value = trimOrUndefined(raw);
  if (value === undefined) return undefined;
  if (!isRecallTelemetryStatus(value)) {
    throw new CliError(`${label}: --status must be ok, empty, error, or timeout`);
  }
  return value;
}

function parsePositiveInteger(
  value: string | undefined,
  label: string,
  flag: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) {
    throw new CliError(`${label}: ${flag} must be a positive integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) throw new CliError(`${label}: ${flag} must be a positive integer`);
  return parsed;
}

function trimOrUndefined(value: string | boolean | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
