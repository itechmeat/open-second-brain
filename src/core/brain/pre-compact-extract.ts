/**
 * Pre-compact continuity extraction: the labelled lines a host flushes
 * before a context window is compacted, captured as `pre_compact_extract`
 * continuity records without an LLM call.
 *
 * ## The recognizer is STRUCTURAL, and that is the whole point
 *
 * This used to carry a five-entry English word list (`decision:`,
 * `commitment:`, `outcome:`, `rule:`, `open question:`) - the only prose
 * recognizer left on any write path, and a direct contradiction of the
 * rule its sibling {@link ../brain/fact-extract.ts} states in its own
 * header: we cannot enumerate the world's languages, so a per-language
 * phrase list is a defect, not a feature. A session captured in Russian,
 * Japanese or Arabic extracted NOTHING, and the zero was indistinguishable
 * from "this session recorded no decisions".
 *
 * What is recognised now is the SHAPE of a labelled line - an opening
 * label, a colon, and a body - exactly as {@link ../graph/agent-scope.ts}
 * treats an owner token: an opaque, language-neutral identifier, never a
 * closed enum. The label itself becomes the record's `extract_type`,
 * normalized to one token. English input is byte-identical to before
 * (`Decision:` -> `decision`, `Open question:` -> `open_question`), so
 * nothing downstream that reads those five values changes; every other
 * script now scores on the same structure instead of scoring zero.
 *
 * Precision beats recall, the same trade the sibling extractor makes: the
 * label may only carry letters, digits, spaces, `-` and `_`, must contain
 * at least one letter (so `10:30` is a clock time, not a label), is capped
 * at {@link LABEL_MAX_WORDS} words and {@link LABEL_MAX_CHARS} characters
 * (so a prose sentence ending in a colon is not a label), and a line whose
 * colon belongs to a URI scheme or a Windows path is refused outright.
 */

import { createHash } from "node:crypto";

import {
  appendContinuityRecord,
  buildContinuityRecord,
  listContinuityRecords,
} from "./continuity/store.ts";
import type {
  AppendContinuityRecordInput,
  ContinuityRecord,
  ContinuitySourceRef,
} from "./continuity/types.ts";

export interface PreCompactExtractInput {
  readonly sessionId: string;
  readonly turnStart: string;
  readonly turnEnd: string;
  readonly text: string;
  readonly host?: string;
  readonly createdAt?: string;
  readonly maxChars?: number;
  /**
   * True when this segment was flushed by an interrupted close
   * (SIGHUP/SIGTERM/force-quit/restart-drain). Recorded on the continuity
   * record so an interrupted capture is honestly distinguishable from a clean
   * one. Absent by default - omitted records stay byte-identical (t_c181f92b).
   */
  readonly interrupted?: boolean;
  /**
   * Preview mode (C2 / t_2c6cf3e2). When true, return the candidate
   * records extraction WOULD append WITHOUT touching the vault — no
   * `appendContinuityRecord`, no log event, no dream/retire trigger. Each
   * returned record is built through the SAME `buildContinuityRecord`
   * path the real write uses, so the preview predicts the real extraction
   * byte-for-byte. Absent/false → existing write-committing behavior,
   * byte-identical. Mirrors the `opts.dryRun` idiom in session `import.ts`.
   */
  readonly dryRun?: boolean;
}

export interface PreCompactExtractResult {
  readonly records: ReadonlyArray<ContinuityRecord>;
  readonly errors: ReadonlyArray<string>;
  readonly skipped: number;
}

interface ExtractedLine {
  /** Normalized label token - open vocabulary, never a closed enum. */
  readonly type: string;
  readonly text: string;
  readonly line: number;
}

/**
 * A labelled line: an optional list bullet, a label built only from
 * letters, digits, spaces, `-` and `_`, a colon, and a non-empty body.
 * The label class is what makes this structural rather than lexical -
 * it names no word in any language, only the characters a label may use.
 */
const LABELLED_LINE_RE = /^(?:[-*]\s*)?([\p{L}\p{N} _-]+?)\s*:\s*(\S.*)$/u;

/**
 * Lines whose colon is punctuation inside a locator rather than a label
 * separator. A URI scheme (`https://`, `file:///`) and a Windows drive
 * path (`C:\...`) both parse as `label: body` by shape alone, so they are
 * refused BEFORE the shape test rather than patched afterwards.
 */
const LOCATOR_LINE_RE = /^(?:[-*]\s*)?[\p{L}][\p{L}\p{N}+.-]*:(?:\/\/|\\)/u;

/** A label longer than this is prose that happens to end in a colon. */
const LABEL_MAX_CHARS = 32;

/** Likewise: real labels are one to three words ("open question"). */
const LABEL_MAX_WORDS = 3;

const DEFAULT_MAX_CHARS = 40_000;

/**
 * Reduce a raw label to the single token recorded as `extract_type`, or
 * `null` when the candidate is not a label at all.
 *
 * NFC + case-fold + collapse each internal whitespace run to `_`, which is
 * the same normalization {@link ../graph/agent-scope.ts} applies to an
 * owner token, plus the word joiner that keeps `Open question` and
 * `open_question` the same key. At least one letter is required so a clock
 * time (`10:30`) or a numbered list (`1: ...`) is never read as a label.
 */
export function normalizePreCompactLabel(raw: string): string | null {
  const trimmed = raw.normalize("NFC").trim();
  if (trimmed.length === 0 || trimmed.length > LABEL_MAX_CHARS) return null;
  if (!/\p{L}/u.test(trimmed)) return null;
  const words = trimmed.split(/\s+/u);
  if (words.length > LABEL_MAX_WORDS) return null;
  return words.join("_").toLowerCase();
}

export function extractPreCompactRecords(
  vault: string,
  input: PreCompactExtractInput,
): PreCompactExtractResult {
  const errors: string[] = [];
  const records: ContinuityRecord[] = [];
  const sourceRefs = extractSourceRefs(input);
  const boundedText = input.text.slice(0, input.maxChars ?? DEFAULT_MAX_CHARS);
  const extracted = extractLines(sanitizePreCompactText(boundedText));
  const createdAt = input.createdAt ?? new Date().toISOString();
  const host = input.host?.trim();
  // Preview mode reuses the exact record builder but never writes, so the
  // candidate output predicts the real extraction byte-for-byte (C2).
  const persist: (recordInput: AppendContinuityRecordInput) => ContinuityRecord =
    input.dryRun === true
      ? buildContinuityRecord
      : (recordInput) => appendContinuityRecord(vault, recordInput);

  for (const item of extracted) {
    try {
      const contentHash = hash(`${item.type}\n${item.text}`);
      const dedupeKey = [
        input.sessionId,
        input.turnStart,
        input.turnEnd,
        item.type,
        contentHash,
      ].join(":");
      const existing = findExistingExtract(vault, dedupeKey);
      if (existing !== null) {
        records.push(existing);
        continue;
      }
      records.push(
        persist({
          kind: "pre_compact_extract",
          createdAt,
          sourceRefs,
          payload: {
            extract_type: item.type,
            text: item.text,
            line: item.line,
            session_id: input.sessionId,
            turn_start: input.turnStart,
            turn_end: input.turnEnd,
            turn_range: `${input.turnStart}..${input.turnEnd}`,
            ...(host !== undefined && host.length > 0 ? { host } : {}),
            ...(input.interrupted === true ? { interrupted: true } : {}),
            content_hash: contentHash,
            dedupe_key: dedupeKey,
            truncated_input: boundedText.length < input.text.length,
          },
        }),
      );
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return Object.freeze({
    records: Object.freeze(records),
    errors: Object.freeze(errors),
    skipped: extracted.length - records.length,
  });
}

export function sanitizePreCompactText(text: string): string {
  return text
    .replace(/data:[^\s;,]+;base64,[A-Za-z0-9+/=]+/g, "[base64]")
    .replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, "[base64]");
}

function extractLines(text: string): ExtractedLine[] {
  const items: ExtractedLine[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    if (LOCATOR_LINE_RE.test(line)) continue;
    const match = LABELLED_LINE_RE.exec(line);
    if (match === null) continue;
    const type = normalizePreCompactLabel(match[1]!);
    const body = match[2]!.trim();
    if (type === null || body.length === 0) continue;
    items.push({ type, text: body, line: index + 1 });
  }
  return items;
}

function extractSourceRefs(input: PreCompactExtractInput): ReadonlyArray<ContinuitySourceRef> {
  return Object.freeze([
    Object.freeze({ type: "session", id: input.sessionId }),
    Object.freeze({
      type: "turn_range",
      id: `${input.turnStart}..${input.turnEnd}`,
    }),
  ]);
}

function findExistingExtract(vault: string, dedupeKey: string): ContinuityRecord | null {
  return (
    listContinuityRecords(vault, { kind: "pre_compact_extract" }).find(
      (record) => record.payload["dedupe_key"] === dedupeKey,
    ) ?? null
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
