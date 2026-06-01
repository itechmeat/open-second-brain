import { statSync } from "node:fs";
import { defaultConfigPath, resolveAgentName } from "../../../core/config.ts";
import {
  importSession,
  importSessionPath,
} from "../../../core/brain/sessions/import.ts";
import {
  SessionImportError,
  type SessionAdapterId,
} from "../../../core/brain/sessions/types.ts";
import {
  isSessionAdapterId,
  sessionAdapterFormatChoices,
} from "../../../core/brain/sessions/registry.ts";
import { appendLogEvent } from "../../../core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../core/brain/types.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import {
  parse,
  fail,
  info,
  normalizeFlagString,
  ok,
  okJson,
  resolveBrainVault,
  parseOptionalIsoDate,
  CliError,
} from "../helpers.ts";

export async function cmdBrainImportSession(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    format: { type: "string" },
    since: { type: "string" },
    "dry-run": { type: "boolean" },
    agent: { type: "string" },
    recall: { type: "boolean" },
    "recall-session-id": { type: "string" },
    "recall-summary-group-size": { type: "string" },
    "ingest-scope": { type: "string" },
    "filter-role": { type: "string-array" },
    "filter-text": { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length < 1)
    return fail("brain import-session requires a <path> argument");
  const sessionPath = positional[0]!;
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const explicitAgent = normalizeFlagString(flags["agent"]);
  if (flags["agent"] !== undefined && explicitAgent === null) {
    return fail("--agent must be a non-empty string when provided");
  }
  const agent = explicitAgent ?? resolveAgentName(config);
  const recallSessionId = normalizeFlagString(flags["recall-session-id"]);
  if (flags["recall-session-id"] !== undefined && recallSessionId === null) {
    return fail("--recall-session-id must be a non-empty string when provided");
  }
  const recallSummaryGroupSize = parsePositiveIntegerFlag(
    flags["recall-summary-group-size"],
    "--recall-summary-group-size",
  );
  const ingestScope = normalizeFlagString(
    flags["ingest-scope"] as string | undefined,
  );
  const filterRoles = normalizeRoleFilter(
    flags["filter-role"] as string[] | undefined,
  );
  const filterText = normalizeFlagString(
    flags["filter-text"] as string | undefined,
  );

  const formatRaw = flags["format"] as string | undefined;
  let format: SessionAdapterId | undefined;
  if (formatRaw !== undefined && formatRaw !== "auto") {
    if (!isSessionAdapterId(formatRaw))
      return fail(
        `--format must be one of ${sessionAdapterFormatChoices()}; got ${formatRaw}`,
      );
    format = formatRaw;
  }

  const { value: since, error: sinceErr } = parseOptionalIsoDate(
    flags,
    "since",
  );
  if (sinceErr) return fail(sinceErr);

  let stat;
  try {
    stat = statSync(sessionPath);
  } catch (err) {
    return fail(`cannot stat ${sessionPath}: ${(err as Error).message ?? err}`);
  }

  try {
    const result = stat.isDirectory()
      ? await importSessionPath(vault, sessionPath, {
          agent,
          ...(format ? { format } : {}),
          ...(since ? { since } : {}),
          dryRun: Boolean(flags["dry-run"]),
          recall: Boolean(flags["recall"]),
          ...(recallSessionId !== null ? { recallSessionId } : {}),
          ...(recallSummaryGroupSize !== undefined
            ? { recallSummaryGroupSize: recallSummaryGroupSize }
            : {}),
          ...(ingestScope !== null ? { ingestScope } : {}),
          ...(filterRoles.length > 0 ? { filterRoles } : {}),
          ...(filterText !== null ? { filterTextIncludes: filterText } : {}),
        })
      : {
          files: [
            await importSession(vault, sessionPath, {
              agent,
              ...(format ? { format } : {}),
              ...(since ? { since } : {}),
              dryRun: Boolean(flags["dry-run"]),
              recall: Boolean(flags["recall"]),
              ...(recallSessionId !== null ? { recallSessionId } : {}),
              ...(recallSummaryGroupSize !== undefined
                ? { recallSummaryGroupSize: recallSummaryGroupSize }
                : {}),
              ...(ingestScope !== null ? { ingestScope } : {}),
              ...(filterRoles.length > 0 ? { filterRoles } : {}),
              ...(filterText !== null
                ? { filterTextIncludes: filterText }
                : {}),
            }),
          ],
          warnings: [],
        };

    if (!flags["dry-run"]) {
      for (const f of result.files) {
        try {
          appendLogEvent(vault, {
            timestamp: isoSecond(new Date()),
            eventType: BRAIN_LOG_EVENT_KIND.importSession,
            body: {
              agent,
              file: `[[${f.file}]]`,
              format: f.format,
              turns_scanned: String(f.turns_scanned),
              signals_created: String(f.signals_created),
              signals_deduped: String(f.signals_deduped),
              tool_replays: String(f.tool_replays),
              malformed: String(f.malformed),
            },
          });
        } catch (err) {
          process.stderr.write(
            `warning: append import-session log failed: ${(err as Error).message}\n`,
          );
        }
      }
    }

    if (flags["json"]) {
      okJson({
        files: result.files.map((f) => ({
          file: f.file,
          format: f.format,
          turns_scanned: f.turns_scanned,
          signals_created: f.signals_created,
          signals_deduped: f.signals_deduped,
          tool_replays: f.tool_replays,
          malformed: f.malformed,
          filtered_turns: f.filtered_turns,
          recall_turns_imported: f.recall_turns_imported,
          recall_summary_nodes: f.recall_summary_nodes,
          errors: f.errors,
        })),
        warnings: result.warnings,
      });
    } else {
      for (const f of result.files) {
        ok(`file: ${f.file}`);
        ok(`  format: ${f.format}`);
        ok(`  turns_scanned: ${f.turns_scanned}`);
        ok(`  signals_created: ${f.signals_created}`);
        ok(`  signals_deduped: ${f.signals_deduped}`);
        ok(`  tool_replays: ${f.tool_replays}`);
        ok(`  filtered_turns: ${f.filtered_turns}`);
        if (flags["recall"]) {
          ok(`  recall_turns_imported: ${f.recall_turns_imported}`);
          ok(`  recall_summary_nodes: ${f.recall_summary_nodes}`);
        }
        if (f.malformed > 0) ok(`  malformed: ${f.malformed}`);
        for (const e of f.errors) info(`  error: ${e.path}: ${e.message}`);
      }
      for (const w of result.warnings)
        info(`  warning: ${w.path}: ${w.message}`);
    }
    return 0;
  } catch (exc) {
    if (exc instanceof SessionImportError) {
      process.stderr.write(`error: ${exc.message}\n`);
      if (exc.code === "DETECT_FAIL" || exc.code === "UNKNOWN_FORMAT") return 2;
      return 1;
    }
    return fail(`import-session failed: ${(exc as Error).message ?? exc}`);
  }
}

function normalizeRoleFilter(
  raw: string[] | undefined,
): Array<"user" | "assistant" | "system" | "tool" | "meta"> {
  if (!raw || raw.length === 0) return [];
  const allowed = new Set([
    "user",
    "assistant",
    "system",
    "tool",
    "meta",
  ] as const);
  const out: Array<"user" | "assistant" | "system" | "tool" | "meta"> = [];
  for (const value of raw) {
    const normalized = value.trim().toLowerCase() as
      | "user"
      | "assistant"
      | "system"
      | "tool"
      | "meta";
    if (!allowed.has(normalized)) {
      throw new CliError(`--filter-role contains unsupported value: ${value}`);
    }
    out.push(normalized);
  }
  return [...new Set(out)];
}

function parsePositiveIntegerFlag(
  value: string | boolean | string[] | undefined,
  flag: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new CliError(`${flag} must be a positive integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) throw new CliError(`${flag} must be a positive integer`);
  return parsed;
}
