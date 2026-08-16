import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
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
  type TranscriptConversation,
  type TranscriptExportOptions,
  type TranscriptExportSummary,
} from "../../../core/brain/export-transcripts.ts";
import {
  EGRESS_OUTCOME,
  EGRESS_REDACTION_NOTICE,
  redactForEgress,
  type EgressRefused,
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
 * What one format produced. Four arms.
 *
 * A format can fail two ways that are not the same exit code: an argument
 * the operator must fix (2) and a payload the boundary refused (1).
 * Collapsing those would report a missing flag as a redaction failure.
 *
 * And a format can produce its bytes two ways. `body` is the whole answer
 * in memory, which is right for the preference forms - they are bounded by
 * the vault's rule set. `spooled` names a file the handler has already
 * written record by record, which is what the transcript corpus needs and
 * what the memory bound below is about; the caller renames it into place
 * or streams it to stdout rather than ever holding it.
 */
type FormatOutcome =
  | { readonly kind: "body"; readonly body: string; readonly redacted: boolean }
  | { readonly kind: "spooled"; readonly spool: string; readonly redacted: boolean }
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
 * The tree location `redactStructured` reports for a conversation's own
 * name. Top-level key, so the location is the key itself.
 */
const SESSION_ID_LOCATION = "session_id";

/**
 * How a refusal names the conversation it refused, WITHOUT writing the
 * thing it refused to write.
 *
 * `session_id` is the transcript's basename. Prefixing the guard's
 * sentence with it was right for the ordinary case - a secret-shaped turn
 * id inside an ordinarily-named file - and was a leak in the case the
 * guard exists for: when the FILENAME is the secret-shaped identifier,
 * this line printed it to stderr, into CI logs and shell scrollback, on
 * the one code path whose entire purpose is not letting it out. The
 * guard's own message is careful about exactly this and says so:
 * "(Locations, not values: the identifier is the secret.)"
 *
 * So the name is printed only when the name is not what was refused, and
 * otherwise the conversation is identified by two facts that are not
 * identifiers - the runtime that wrote it and the instant it started.
 * Those locate one file in a session store without naming it, which is
 * what an operator needs to go and rename it.
 */
function refusalPrefix(record: TranscriptConversation, verdict: EgressRefused): string {
  if (!verdict.secretIdentifiers.includes(SESSION_ID_LOCATION)) return record.session_id;
  return (
    `the ${record.runtime} conversation starting ${record.started_at} ` +
    "(its filename is itself the secret-shaped identifier, so it is not printed here)"
  );
}

/**
 * Where the corpus is written while it is being scanned.
 *
 * A sibling of `--out` when there is one, so the finishing `rename(2)` is
 * within one filesystem and therefore atomic; otherwise the system temp
 * directory, since a stdout run has no target directory to borrow.
 */
function spoolPathFor(outPath: string | undefined): string {
  const unique = `o2b-transcripts-${process.pid}-${crypto.randomUUID()}.partial`;
  return outPath === undefined ? join(tmpdir(), unique) : join(dirname(outPath), `.${unique}`);
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
 *
 * ## Two guarantees that pull against each other, and how both are kept
 *
 * The producer streams: `streamTranscriptConversations` holds one
 * conversation at a time and says so. This consumer used to collect every
 * released record into an array and `join` it, which put the whole corpus
 * in memory twice over and made the producer's bound meaningless - by
 * construction linear in the corpus, against the 596 MB store
 * `discover.ts` cites as its sizing case.
 *
 * The obvious fix - write each line as it is released - would trade that
 * for the other guarantee: a refusal must leave nothing written, which is
 * what lets the operator treat a refused export as an export that did not
 * happen. Writing straight to `--out` or to stdout breaks it, because the
 * guard cannot refuse a record it has not reached yet.
 *
 * So each released record is written immediately, to a SPOOL file the
 * operator never named. A refusal deletes the spool and nothing else has
 * been touched; a completed scan renames it into `--out` (one atomic
 * `rename(2)`, no copy) or streams it to stdout a chunk at a time. Peak
 * memory is one conversation plus one chunk, and "a refusal writes
 * nothing" is still literally true of every path the operator can see.
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

  const spool = spoolPathFor(flags["out"] as string | undefined);
  // `wx`: a spool path that already exists is somebody else's file, and
  // truncating it would be this verb destroying data it never named.
  const handle = openSync(spool, "wx");
  let outcome: SpoolOutcome;
  try {
    outcome = await spoolTranscriptCorpus(streamTranscriptConversations(options), (line) => {
      writeSync(handle, line);
    });
  } finally {
    closeSync(handle);
  }
  if (outcome.kind === "refused") {
    // A refusal writes nothing the operator can see: the spool is the only
    // file that exists, it was never named, and it goes now.
    unlinkSync(spool);
    return { kind: "refused", detail: outcome.detail };
  }
  if (outcome.written === 0) reportEmptyCorpus(outcome.summary);
  return { kind: "spooled", spool, redacted: outcome.redacted };
}

/** What the spooling loop produced. */
export type SpoolOutcome =
  | {
      readonly kind: "written";
      readonly written: number;
      readonly redacted: boolean;
      readonly summary: TranscriptExportSummary;
    }
  | { readonly kind: "refused"; readonly detail: string };

/**
 * Guard each conversation and hand the released one straight to `write`.
 *
 * Exported for the one property that cannot be observed from outside the
 * process and is the whole point of the loop: record N is written BEFORE
 * record N+1 is asked for. Peak RSS was tried as the instrument and does
 * not discriminate - `sessions/streaming-memory.test.ts` says why at
 * length, and the same held here (a 63 MB corpus grew peak resident set
 * by ~66 MB whether the records were spooled or buffered, because what
 * dominates is uncollected `JSON.parse` garbage rather than anything the
 * loop retains). The interleaving is the property; the memory profile is
 * its consequence, and the property is exact where the consequence is
 * noise.
 *
 * `write` takes the serialised line rather than a file handle so the test
 * can be the observer, and so this function never learns where the bytes
 * go - the spool, the rename and the refusal cleanup all stay with the
 * caller that owns them.
 *
 * A throw out of `records` propagates: the caller closes the handle in a
 * `finally` and the walk's own refusals (an unrecognised transcript, an
 * unreadable directory) are already typed and named.
 */
export async function spoolTranscriptCorpus(
  records: AsyncGenerator<TranscriptConversation, TranscriptExportSummary>,
  write: (line: string) => void,
): Promise<SpoolOutcome> {
  let written = 0;
  let redacted = false;
  for (;;) {
    // The corpus is read one conversation at a time, and the summary rides
    // out as the generator's return value - `for await` would discard it.
    // oxlint-disable-next-line no-await-in-loop
    const step = await records.next();
    if (step.done === true) return { kind: "written", written, redacted, summary: step.value };
    // `foreignIdentifiers`: this record's `session_id` and `turn_id` were
    // named by whichever harness wrote the transcript, so the guard's
    // default "an id is a long mixed run by construction" narrowing - an
    // argument about ids this vault generates - does not hold for them.
    const verdict = redactForEgress(EGRESS_SITE, step.value, { foreignIdentifiers: true });
    if (verdict.outcome !== EGRESS_OUTCOME.released) {
      // Abandoning the generator here leaks nothing: a record is yielded
      // only after its own transcript has been read to the end, so the
      // suspended frame sits between files with none of them open.
      return {
        kind: "refused",
        detail: `${refusalPrefix(step.value, verdict)}: ${verdict.detail}`,
      };
    }
    write(`${JSON.stringify(verdict.payload)}\n`);
    written += 1;
    redacted = redacted || verdict.redacted;
  }
}

/**
 * An empty file under exit 0 reads like a machine that recorded nothing.
 * Say what was looked at and which filter emptied it - every scanned file
 * is on exactly one of these counters, so the numbers add up to `scanned`
 * and the operator can see which one to change.
 */
function reportEmptyCorpus(summary: TranscriptExportSummary): void {
  process.stderr.write(
    `note: no conversation matched; ${summary.scanned} transcript file(s) scanned, ` +
      `${summary.other_runtime} from another runtime, ${summary.outside_window} outside ` +
      `the window, ${summary.no_messages} with no exportable turn, ` +
      `${summary.empty} empty\n`,
  );
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

  const outPath = flags["out"] as string | undefined;
  // Asked BEFORE the handler runs, not after. This check used to sit at
  // the very end, so `--out` naming an existing file read, hashed and
  // redacted a whole machine's transcripts and then refused over a flag
  // that was knowable from argv alone. An argument error is cheap to
  // report and must not be paid for with the work it invalidates.
  if (outPath !== undefined && existsSync(outPath) && !flags["force"]) {
    return fail(`${outPath} exists; pass --force to overwrite`);
  }

  let outcome: FormatOutcome;
  try {
    outcome = await FORMAT_HANDLERS[format](flags);
  } catch (exc) {
    return fail(`export failed: ${(exc as Error).message ?? exc}`);
  }
  if (outcome.kind === "usage") return usageError(outcome.detail);
  if (outcome.kind === "refused") return fail(outcome.detail);

  const code =
    outcome.kind === "spooled"
      ? deliverSpool(outcome.spool, outPath)
      : deliverBody(outcome.body, outPath);
  if (code === 0 && outcome.redacted) process.stderr.write(EGRESS_REDACTION_NOTICE);
  return code;
}

/** A composed answer, to stdout or to `--out`. */
function deliverBody(body: string, outPath: string | undefined): number {
  if (outPath === undefined) {
    process.stdout.write(body);
    return 0;
  }
  try {
    atomicWriteFileSync(outPath, body);
  } catch (exc) {
    return fail(`failed to write ${outPath}: ${(exc as Error).message ?? exc}`);
  }
  ok(`wrote ${outPath}`);
  return 0;
}

/**
 * A spooled answer, moved into place or streamed out - and never read
 * whole, which is the whole point of it having been spooled.
 *
 * `rename(2)` into `--out` is the same atomic publish `atomicWriteFileSync`
 * performs, minus the copy: the spool was written as a sibling for exactly
 * this. The stdout path has no rename available, so it copies through a
 * fixed-size buffer; a `StringDecoder` carries any multi-byte character
 * that straddles a chunk boundary rather than emitting U+FFFD, the same
 * care `read-lines.ts` takes one layer down.
 */
function deliverSpool(spool: string, outPath: string | undefined): number {
  try {
    if (outPath !== undefined) {
      renameSync(spool, outPath);
      ok(`wrote ${outPath}`);
      return 0;
    }
    pipeToStdout(spool);
    return 0;
  } catch (exc) {
    return fail(`failed to write ${outPath ?? "stdout"}: ${(exc as Error).message ?? exc}`);
  } finally {
    // A rename consumed the spool; a stdout run and a failed rename did
    // not, and neither may leave a stray file behind.
    if (existsSync(spool)) unlinkSync(spool);
  }
}

/** Bytes moved per read when the spool is copied to stdout. */
const SPOOL_CHUNK_BYTES = 256 * 1024;

function pipeToStdout(spool: string): void {
  const fd = openSync(spool, "r");
  const decoder = new StringDecoder("utf8");
  try {
    const buffer = Buffer.allocUnsafe(SPOOL_CHUNK_BYTES);
    for (;;) {
      const read = readSync(fd, buffer, 0, SPOOL_CHUNK_BYTES, null);
      if (read === 0) break;
      process.stdout.write(decoder.write(buffer.subarray(0, read)));
    }
    const tail = decoder.end();
    if (tail !== "") process.stdout.write(tail);
  } finally {
    closeSync(fd);
  }
}
