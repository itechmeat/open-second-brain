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

export type PreCompactExtractType =
  | "decision"
  | "commitment"
  | "outcome"
  | "rule"
  | "open_question";

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
  readonly type: PreCompactExtractType;
  readonly text: string;
  readonly line: number;
}

const LABELS: ReadonlyArray<readonly [RegExp, PreCompactExtractType]> = Object.freeze([
  [/^(?:[-*]\s*)?decision\s*:\s*(.+)$/i, "decision"],
  [/^(?:[-*]\s*)?commitment\s*:\s*(.+)$/i, "commitment"],
  [/^(?:[-*]\s*)?outcome\s*:\s*(.+)$/i, "outcome"],
  [/^(?:[-*]\s*)?rule\s*:\s*(.+)$/i, "rule"],
  [/^(?:[-*]\s*)?open\s+question\s*:\s*(.+)$/i, "open_question"],
]);

const DEFAULT_MAX_CHARS = 40_000;

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
    for (const [pattern, type] of LABELS) {
      const match = pattern.exec(line);
      const value = match?.[1]?.trim();
      if (value !== undefined && value.length > 0) {
        items.push({ type, text: value, line: index + 1 });
        break;
      }
    }
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
