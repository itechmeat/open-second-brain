import { existsSync } from "node:fs";
import { atomicWriteFileSync } from "../../../core/fs-atomic.ts";
import {
  EXPORT_FORMAT,
  EXPORT_FORMATS,
  exportPreferencesJson,
  exportPreferencesLlmsTxt,
  isExportFormat,
  type ExportFormat,
} from "../../../core/brain/export.ts";
import {
  streamTranscriptConversations,
  type TranscriptExportOptions,
  type TranscriptExportSummary,
} from "../../../core/brain/export-transcripts.ts";
import {
  EGRESS_OUTCOME,
  EGRESS_REDACTION_NOTICE,
  redactForEgress,
} from "../../../core/egress/guard.ts";
import {
  brainVerbContext,
  fail,
  ok,
  parse,
  parseOptionalIsoDate,
  usageError,
  type BrainVerbFlags,
} from "../helpers.ts";

/**
 * `o2b brain export --format <format> [--out <file>] [--force]`.
 *
 * Three formats, one dispatch: {@link EXPORT_FORMAT} is the key set of
 * {@link FORMAT_HANDLERS}, so a format the vocabulary declares and nobody
 * implemented does not compile. The verb used to compare the raw argv
 * string against two inline literals while the type that named them sat
 * unimported in the core module.
 *
 * Every format goes through the shared egress guard (registry entry
 * `brain-export`), and the asymmetry between them is deliberate:
 * a tree is redacted and serialised AFTERWARDS, so a principle or a
 * transcript line containing a quote cannot disturb the document, while
 * llms-txt is already text and is redacted as text.
 */
const EGRESS_SITE = "brain-export";

/**
 * What one format produced. Three arms, because a format can fail two ways
 * that are not the same exit code: an argument the operator must fix (2)
 * and a payload the boundary refused (1). Collapsing them would report a
 * missing flag as a redaction failure.
 */
type FormatOutcome =
  | { readonly kind: "body"; readonly body: string; readonly redacted: boolean }
  | { readonly kind: "usage"; readonly detail: string }
  | { readonly kind: "refused"; readonly detail: string };

/** Lift an egress verdict over already-composed bytes into an outcome. */
function released(body: string, redacted: boolean): FormatOutcome {
  return { kind: "body", body, redacted };
}

async function exportJson(flags: BrainVerbFlags): Promise<FormatOutcome> {
  const { vault } = brainVerbContext(flags);
  const verdict = redactForEgress(EGRESS_SITE, exportPreferencesJson(vault));
  if (verdict.outcome !== EGRESS_OUTCOME.released) {
    return { kind: "refused", detail: verdict.detail };
  }
  return released(JSON.stringify(verdict.payload) + "\n", verdict.redacted);
}

async function exportLlmsTxt(flags: BrainVerbFlags): Promise<FormatOutcome> {
  const { vault } = brainVerbContext(flags);
  const verdict = redactForEgress(EGRESS_SITE, exportPreferencesLlmsTxt(vault));
  if (verdict.outcome !== EGRESS_OUTCOME.released) {
    return { kind: "refused", detail: verdict.detail };
  }
  return released(verdict.payload, verdict.redacted);
}

/** `--since` / `--until` as instants, or the operator's error. */
function windowOf(flags: BrainVerbFlags): { since?: Date; until?: Date } | string {
  const since = parseOptionalIsoDate(flags, "since");
  if (since.error !== null) return since.error;
  const until = parseOptionalIsoDate(flags, "until");
  if (until.error !== null) return until.error;
  return {
    ...(since.value !== null ? { since: since.value } : {}),
    ...(until.value !== null ? { until: until.value } : {}),
  };
}

/**
 * The transcript corpus, one JSONL conversation record per line.
 *
 * No vault is resolved: the corpus lives in the runtimes' own session
 * directories, and a format that never reads a vault must not refuse for
 * the want of one.
 *
 * Each record is guarded on its own rather than the corpus as a whole. A
 * per-record scan is what keeps one oversized turn from putting a whole
 * machine's transcripts past the redactor's scan window, and it is what
 * lets the refusal name the conversation the operator has to fix.
 */
async function exportTranscripts(flags: BrainVerbFlags): Promise<FormatOutcome> {
  const source = flags["transcripts"] as string | undefined;
  if (source === undefined || source.trim() === "") {
    return {
      kind: "usage",
      detail:
        `--format ${EXPORT_FORMAT.transcriptsJsonl} requires --transcripts <file|dir> naming ` +
        "the session logs to export; this build has no machine-wide transcript discovery",
    };
  }
  const window = windowOf(flags);
  if (typeof window === "string") return { kind: "usage", detail: window };

  const options: TranscriptExportOptions = {
    source,
    ...window,
    ...(typeof flags["runtime"] === "string" ? { runtime: flags["runtime"] } : {}),
  };

  const lines: string[] = [];
  let redacted = false;
  let summary: TranscriptExportSummary;
  const records = streamTranscriptConversations(options);
  for (;;) {
    // The corpus is read one conversation at a time, and the summary rides
    // out as the generator's return value - `for await` would discard it.
    // oxlint-disable-next-line no-await-in-loop
    const step = await records.next();
    if (step.done === true) {
      summary = step.value;
      break;
    }
    const verdict = redactForEgress(EGRESS_SITE, step.value);
    if (verdict.outcome !== EGRESS_OUTCOME.released) {
      // Abandoning the generator here leaks nothing: a record is yielded
      // only after its own transcript has been read to the end, so the
      // suspended frame sits between files with none of them open.
      return { kind: "refused", detail: `${step.value.session_id}: ${verdict.detail}` };
    }
    lines.push(JSON.stringify(verdict.payload));
    redacted = redacted || verdict.redacted;
  }

  if (lines.length === 0) {
    // An empty file under exit 0 reads like a machine that recorded
    // nothing. Say what was looked at and which filter emptied it.
    process.stderr.write(
      `note: no conversation matched; ${summary.scanned} transcript file(s) scanned, ` +
        `${summary.other_runtime} from another runtime, ${summary.outside_window} outside ` +
        `the window, ${summary.no_messages} with no exportable turn\n`,
    );
  }
  return released(lines.length === 0 ? "" : lines.join("\n") + "\n", redacted);
}

/**
 * One handler per declared format. Typed by the vocabulary, so the table
 * and the `--format` guard cannot disagree about what this verb supports.
 */
const FORMAT_HANDLERS: Readonly<
  Record<ExportFormat, (flags: BrainVerbFlags) => Promise<FormatOutcome>>
> = Object.freeze({
  [EXPORT_FORMAT.json]: exportJson,
  [EXPORT_FORMAT.llmsTxt]: exportLlmsTxt,
  [EXPORT_FORMAT.transcriptsJsonl]: exportTranscripts,
});

export async function cmdBrainExport(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    format: { type: "string" },
    transcripts: { type: "string" },
    runtime: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    out: { type: "string" },
    force: { type: "boolean" },
  });
  const format = flags["format"];
  if (!isExportFormat(format)) {
    return usageError(`--format is required and must be one of ${EXPORT_FORMATS.join("|")}`);
  }

  let outcome: FormatOutcome;
  try {
    outcome = await FORMAT_HANDLERS[format](flags);
  } catch (exc) {
    return fail(`export failed: ${(exc as Error).message ?? exc}`);
  }
  if (outcome.kind === "usage") return usageError(outcome.detail);
  if (outcome.kind === "refused") return fail(outcome.detail);
  const { body, redacted } = outcome;

  const outPath = flags["out"] as string | undefined;
  if (outPath === undefined) {
    process.stdout.write(body);
    if (redacted) process.stderr.write(EGRESS_REDACTION_NOTICE);
    return 0;
  }
  if (existsSync(outPath) && !flags["force"])
    return fail(`${outPath} exists; pass --force to overwrite`);
  try {
    atomicWriteFileSync(outPath, body);
  } catch (exc) {
    return fail(`failed to write ${outPath}: ${(exc as Error).message ?? exc}`);
  }
  ok(`wrote ${outPath}`);
  if (redacted) process.stderr.write(EGRESS_REDACTION_NOTICE);
  return 0;
}
