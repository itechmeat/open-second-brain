import { resolveGenerationTraceEnabled } from "../../../core/config.ts";
import {
  emitGenerationReport,
  getGenerationReport,
  isGenerationHandoffKind,
  listGenerationReports,
  summarizeGenerationReports,
  type GenerationHandoffKind,
  type GenerationReportFilter,
  type GenerationUsage,
} from "../../../core/brain/generation-reports.ts";
import type { ContinuitySourceRef } from "../../../core/brain/continuity/types.ts";
import { CliError, brainVerbContext, parse } from "../helpers.ts";

export async function cmdBrainGenerationReports(argv: string[]): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  if (subcommand === "record") return recordReport(rest);
  if (subcommand === "list") return listReports(rest);
  if (subcommand === "summary") return summarizeReports(rest);
  if (subcommand === "show") return showReport(rest);
  throw new CliError("brain generation-reports: expected record, list, summary, or show");
}

function recordReport(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    enable: { type: "boolean" },
    ref: { type: "string" },
    agent: { type: "string" },
    prompt: { type: "string" },
    scope: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    "finish-reason": { type: "string" },
    "latency-ms": { type: "string" },
    "input-tokens": { type: "string" },
    "output-tokens": { type: "string" },
    "cached-tokens": { type: "string" },
    "total-tokens": { type: "string" },
    source: { type: "string-array" },
    "created-at": { type: "string" },
  });
  const ctx = brainVerbContext(flags);
  const label = "brain generation-reports record";

  const handoffKind = handoffKindArg(positional[0], label);
  const ref = requireString(flags["ref"], "--ref", label);
  const agent = requireString(flags["agent"], "--agent", label);
  const prompt = requireString(flags["prompt"], "--prompt", label);

  // Opt-in gate: a per-call --enable wins, else the config gate. Off => nothing written.
  const enabled = flags["enable"] === true || resolveGenerationTraceEnabled(ctx.config);

  const usage = buildUsage(flags, label);
  const record = emitGenerationReport(
    ctx.vault,
    {
      handoff: { kind: handoffKind, ref },
      agent,
      prompt,
      ...(strOrUndef(flags["scope"]) !== undefined ? { scope: strOrUndef(flags["scope"]) } : {}),
      ...(strOrUndef(flags["provider"]) !== undefined
        ? { provider: strOrUndef(flags["provider"]) }
        : {}),
      ...(strOrUndef(flags["model"]) !== undefined ? { model: strOrUndef(flags["model"]) } : {}),
      ...(strOrUndef(flags["finish-reason"]) !== undefined
        ? { finishReason: strOrUndef(flags["finish-reason"]) }
        : {}),
      ...(intArg(flags["latency-ms"], "--latency-ms", label) !== undefined
        ? { latencyMs: intArg(flags["latency-ms"], "--latency-ms", label) }
        : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(sourceRefArgs(flags["source"], label).length > 0
        ? { sourceRefs: sourceRefArgs(flags["source"], label) }
        : {}),
      ...(strOrUndef(flags["created-at"]) !== undefined
        ? { createdAt: strOrUndef(flags["created-at"]) }
        : {}),
    },
    enabled,
  );

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          recorded: record !== null,
          ...(record !== null ? { id: record.id } : { reason: "disabled" }),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  if (record === null) {
    process.stdout.write("generation trace disabled; nothing recorded\n");
    return 0;
  }
  process.stdout.write(`recorded generation report ${record.id}\n`);
  return 0;
}

function listReports(argv: string[]): number {
  const { flags } = parseReadFlags(argv);
  const vault = brainVerbContext(flags).vault;
  const reports = listGenerationReports(vault, readFilter(flags, "brain generation-reports list"));

  if (flags["json"]) {
    process.stdout.write(JSON.stringify({ total: reports.length, reports }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`${reports.length} generation report(s):\n`);
  for (const report of reports) {
    const payload = report.payload;
    const handoff = (payload["handoff"] ?? {}) as Record<string, unknown>;
    const usage = payload["usage"] as Record<string, unknown> | undefined;
    process.stdout.write(
      `  ${report.createdAt}  ${report.id}  ${handoff["kind"] ?? "unknown"}  agent=${payload["agent"] ?? "-"}  reported_tokens=${usage?.["total_tokens"] ?? "-"}\n`,
    );
  }
  return 0;
}

function summarizeReports(argv: string[]): number {
  const { flags } = parseReadFlags(argv);
  const vault = brainVerbContext(flags).vault;
  const summary = summarizeGenerationReports(
    vault,
    readFilter(flags, "brain generation-reports summary"),
  );
  if (flags["json"]) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`reports: ${summary.total}\n`);
  process.stdout.write(`by handoff kind: ${JSON.stringify(summary.by_handoff_kind)}\n`);
  process.stdout.write(`local estimate tokens: ${summary.local_estimate_tokens}\n`);
  process.stdout.write(
    `reported (${summary.reported_count}): ${JSON.stringify(summary.reported_tokens)}\n`,
  );
  process.stdout.write(`linked paths: ${Object.keys(summary.by_path).length}\n`);
  return 0;
}

function showReport(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const id = strOrUndef(positional[0]);
  if (id === undefined) throw new CliError("brain generation-reports show: report id is required");
  const vault = brainVerbContext(flags).vault;
  const report = getGenerationReport(vault, id);
  if (report === null) {
    throw new CliError(`brain generation-reports show: report not found: ${id}`);
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return 0;
}

function parseReadFlags(argv: string[]): {
  readonly flags: Record<string, string | boolean | string[] | undefined>;
} {
  return parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    handoff: { type: "string" },
    agent: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    limit: { type: "string" },
  });
}

function readFilter(
  flags: Record<string, string | boolean | string[] | undefined>,
  label: string,
): GenerationReportFilter {
  const handoffRaw = strOrUndef(flags["handoff"]);
  if (handoffRaw !== undefined && !isGenerationHandoffKind(handoffRaw)) {
    throw new CliError(`${label}: --handoff must be write_session, context_pack, or dream_stage`);
  }
  const limit = intArg(flags["limit"], "--limit", label);
  return {
    ...(handoffRaw !== undefined ? { handoffKind: handoffRaw as GenerationHandoffKind } : {}),
    ...(strOrUndef(flags["agent"]) !== undefined ? { agent: strOrUndef(flags["agent"]) } : {}),
    ...(strOrUndef(flags["since"]) !== undefined ? { since: strOrUndef(flags["since"]) } : {}),
    ...(strOrUndef(flags["until"]) !== undefined ? { until: strOrUndef(flags["until"]) } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function buildUsage(
  flags: Record<string, string | boolean | string[] | undefined>,
  label: string,
): GenerationUsage | undefined {
  const input = intArg(flags["input-tokens"], "--input-tokens", label);
  const output = intArg(flags["output-tokens"], "--output-tokens", label);
  const cached = intArg(flags["cached-tokens"], "--cached-tokens", label);
  const total = intArg(flags["total-tokens"], "--total-tokens", label);
  const usage: GenerationUsage = {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cached !== undefined ? { cachedTokens: cached } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function sourceRefArgs(
  raw: string | boolean | string[] | undefined,
  label: string,
): ReadonlyArray<ContinuitySourceRef> {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const trimmed = entry.trim();
    if (trimmed.length === 0) throw new CliError(`${label}: --source entry must not be empty`);
    // Form: "<id>" or "<id>=<path>".
    const eq = trimmed.indexOf("=");
    if (eq < 0) return { id: trimmed };
    const id = trimmed.slice(0, eq).trim();
    const path = trimmed.slice(eq + 1).trim();
    if (id.length === 0) throw new CliError(`${label}: --source id must not be empty`);
    return path.length > 0 ? { id, path } : { id };
  });
}

function handoffKindArg(raw: string | undefined, label: string): GenerationHandoffKind {
  const value = strOrUndef(raw);
  if (value === undefined) {
    throw new CliError(
      `${label}: handoff kind is required (write_session|context_pack|dream_stage)`,
    );
  }
  if (!isGenerationHandoffKind(value)) {
    throw new CliError(`${label}: unknown handoff kind '${value}'`);
  }
  return value;
}

function requireString(
  raw: string | boolean | string[] | undefined,
  flag: string,
  label: string,
): string {
  const value = strOrUndef(raw);
  if (value === undefined) throw new CliError(`${label}: ${flag} is required`);
  return value;
}

function intArg(
  raw: string | boolean | string[] | undefined,
  flag: string,
  label: string,
): number | undefined {
  const value = strOrUndef(raw);
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) {
    throw new CliError(`${label}: ${flag} must be a non-negative integer`);
  }
  return Number.parseInt(value, 10);
}

function strOrUndef(value: string | boolean | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
