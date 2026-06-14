/**
 * `o2b brain continuity export` (Memory Observability Suite,
 * t_51959aeb): read-only trajectory export of the continuity store as
 * ATOF JSONL or ATIF v1.7 documents. Mapping decisions live in
 * docs/brainstorm/memory-observability-suite/atof-atif-mapping.md.
 *
 * Privacy: the exporter consumes the continuity read-model, which
 * drops `private` records and never un-masks redacted text. No new
 * emission paths - this verb only reads JSONL and writes export files
 * into `--out`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadNormalizedContinuityRecords } from "../../../core/brain/continuity/read-model.ts";
import {
  deriveUsageSignals,
  rankByUsageDecay,
} from "../../../core/brain/continuity/usage-signal.ts";
import { renderAtofEvents } from "../../../core/brain/continuity/export-atof.ts";
import {
  countSessionlessRecords,
  renderAtifTrajectories,
} from "../../../core/brain/continuity/export-atif.ts";
import packageJson from "../../../../package.json" with { type: "json" };
import { brainVerbContext, fail, parse, usageError } from "../helpers.ts";

const CLI_VERSION: string = packageJson.version;

const USAGE =
  "usage: o2b brain continuity export --format atof|atif [--session <id>] [--month YYYY-MM] [--out <dir>] [--json]\n" +
  "       o2b brain continuity rank [--kind <kind>] [--limit N] [--json]";

export async function cmdBrainContinuity(argv: string[]): Promise<number> {
  const subcommand = argv[0];
  if (subcommand === "export") return exportContinuity(argv.slice(1));
  if (subcommand === "rank") return rankContinuity(argv.slice(1));
  return fail(USAGE);
}

function exportContinuity(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    format: { type: "string" },
    session: { type: "string" },
    month: { type: "string" },
    out: { type: "string" },
    json: { type: "boolean" },
  });
  const format = typeof flags["format"] === "string" ? flags["format"].trim() : "";
  if (format !== "atof" && format !== "atif") return fail(USAGE);
  const month = typeof flags["month"] === "string" ? flags["month"].trim() : undefined;
  if (month !== undefined && !/^\d{4}-\d{2}$/.test(month)) {
    return fail("brain continuity export: --month must look like YYYY-MM");
  }
  const session = typeof flags["session"] === "string" ? flags["session"].trim() : undefined;
  const outDir = resolve(typeof flags["out"] === "string" ? flags["out"].trim() : ".");

  const vault = brainVerbContext(flags).vault;
  const records = loadNormalizedContinuityRecords(vault, {
    ...(session !== undefined && session !== "" ? { sessionId: session } : {}),
    ...(month !== undefined ? { since: `${month}-01`, until: `${month}-31T23:59:59.999Z` } : {}),
  });

  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  let skippedSessionless = 0;
  if (format === "atof") {
    const lines = renderAtofEvents(records);
    const path = join(outDir, `o2b-continuity-${month ?? "all"}.atof.jsonl`);
    writeFileSync(path, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
    written.push(path);
  } else {
    skippedSessionless = countSessionlessRecords(records);
    for (const trajectory of renderAtifTrajectories(records, { agentVersion: CLI_VERSION })) {
      const path = join(outDir, `o2b-continuity-${safeName(trajectory.session_id)}.atif.json`);
      writeFileSync(path, `${JSON.stringify(trajectory, null, 2)}\n`, "utf8");
      written.push(path);
    }
  }

  if (flags["json"] === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          format,
          records: records.length,
          skipped_sessionless: skippedSessionless,
          files: written,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  process.stdout.write(`exported ${records.length} record(s) as ${format}\n`);
  for (const path of written) process.stdout.write(`  ${path}\n`);
  if (skippedSessionless > 0) {
    process.stdout.write(`  skipped ${skippedSessionless} record(s) without a session id\n`);
  }
  return 0;
}

const DEFAULT_RANK_KIND = "pre_compact_extract";
const DEFAULT_RANK_LIMIT = 20;

/**
 * `o2b brain continuity rank`: list working-memory continuity records
 * ordered by usage-driven decay weight (freshest and most-recalled
 * first, stale and untouched last). Read-only; the store is never
 * mutated. Default scope is the `pre_compact_extract` working-memory
 * kind; `--kind <k>` narrows to another kind and `--all` ranks every
 * kind.
 */
function rankContinuity(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    kind: { type: "string" },
    limit: { type: "string" },
    all: { type: "boolean" },
    json: { type: "boolean" },
  });

  const all = flags["all"] === true;
  const kind = typeof flags["kind"] === "string" ? flags["kind"].trim() : DEFAULT_RANK_KIND;
  let limit = DEFAULT_RANK_LIMIT;
  if (typeof flags["limit"] === "string") {
    const parsed = Number(flags["limit"]);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return usageError("brain continuity rank: --limit must be a positive integer");
    }
    limit = parsed;
  }

  const vault = brainVerbContext(flags).vault;
  const records = loadNormalizedContinuityRecords(vault, all ? {} : { kind });
  const signals = deriveUsageSignals(vault);
  const ranked = rankByUsageDecay(records, signals, Date.now()).slice(0, limit);

  if (flags["json"] === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          scope: all ? "all" : kind,
          total: records.length,
          ranked: ranked.map((entry) => ({
            id: entry.record.id,
            kind: entry.record.kind,
            created_at: entry.record.createdAt,
            weight: entry.weight,
            access_count: entry.accessCount,
            last_access_at:
              entry.lastAccessAtMs !== null ? new Date(entry.lastAccessAtMs).toISOString() : null,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (ranked.length === 0) {
    process.stdout.write(`no ${all ? "" : `${kind} `}continuity records to rank\n`);
    return 0;
  }
  process.stdout.write(`ranked ${ranked.length} of ${records.length} record(s) by usage decay\n`);
  for (const entry of ranked) {
    const lastAccess =
      entry.lastAccessAtMs !== null ? new Date(entry.lastAccessAtMs).toISOString() : "never";
    const preview = previewText(entry.record.payload);
    process.stdout.write(
      `  ${entry.weight.toFixed(3)}  ${entry.record.kind}  uses=${entry.accessCount}  last=${lastAccess}${preview}\n`,
    );
  }
  return 0;
}

function previewText(payload: Readonly<Record<string, unknown>>): string {
  const text = payload["text"];
  if (typeof text !== "string" || text.length === 0) return "";
  const trimmed = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  return `  ${trimmed.replace(/\s+/g, " ")}`;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}
