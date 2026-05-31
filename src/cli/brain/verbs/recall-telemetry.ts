import { defaultConfigPath } from "../../../core/config.ts";
import {
  isRecallTelemetryMode,
  isRecallTelemetryStatus,
  listRecallTelemetry,
  summarizeRecallTelemetry,
} from "../../../core/brain/recall-telemetry.ts";
import { CliError, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainRecallTelemetry(argv: string[]): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  if (subcommand === "list") return listTelemetry(rest);
  if (subcommand === "summary") return summarizeTelemetry(rest);
  throw new CliError("brain recall-telemetry: expected list or summary");
}

function listTelemetry(argv: string[]): number {
  const { flags } = parseTelemetryFlags(argv);
  const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());
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
  const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());
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
  });
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
