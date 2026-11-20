/**
 * The searchable text of one brain store record (design D5).
 *
 * A record body is any JSON object, so the text is built generically: a
 * title from the first descriptive string field, then every scalar of the
 * body as a `key: value` line (nested objects flattened with dotted keys,
 * bounded in depth and length), then one line of envelope metadata so a
 * query for the kind, the stream or the agent finds the record too. The
 * result goes through the ordinary markdown chunker, so a long body is
 * split the same way a long note is.
 *
 * Values are agent and model text and often hold markdown of their own. A
 * value line that would open a heading or a code fence is escaped, so a
 * body can never fake a heading path or swallow the lines after it.
 *
 * Bookkeeping that no query recalls is left out: the `migrated` mark an
 * imported record carries (the legacy item, its checksum and its vault),
 * and the digests the product itself writes into a body, each by its
 * field name and exact length ({@link PRODUCT_DIGESTS}). Any other hex
 * value (a git commit id in a decision, a checksum a note quotes) stays
 * searchable.
 * On a migrated store those were most of each record's text: every digest
 * was cut into dozens of entity rows and filled the full-text and trigram
 * tables, four times the size of the legacy index of the same content.
 */

import type { StoreRecord } from "../../store/envelope.ts";
import { MIGRATED_FIELD } from "../../store-migration/migration-records.ts";

/** Body fields tried, in order, for the record's title. */
const TITLE_FIELDS = ["title", "summary", "principle", "decision", "text", "message"] as const;

/** Longest title kept, in characters. */
const TITLE_MAX_CHARS = 120;

/** Nesting depth flattened into `key: value` lines. */
const MAX_DEPTH = 3;

/** Longest rendered body, in characters; the rest is cut. */
const BODY_MAX_CHARS = 64 * 1024;

export interface RecordText {
  readonly title: string;
  readonly content: string;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function titleOf(record: StoreRecord, pending: boolean): string {
  if (!pending) {
    for (const field of TITLE_FIELDS) {
      const value = record.body[field];
      if (typeof value === "string" && value.trim() !== "") {
        const line = oneLine(value);
        return line.length > TITLE_MAX_CHARS ? `${line.slice(0, TITLE_MAX_CHARS - 1)}…` : line;
      }
    }
  }
  return record.kind;
}

/**
 * The digests the product writes into record bodies, by field name (the
 * last segment of the flattened key) and the exact number of hex
 * characters it writes there:
 *  - `h` and `prev`: the Brain log's hash chain (`LOG_CHAIN_FIELDS` in
 *    `brain/log.ts`), sha256, 64;
 *  - `vault_id`: the vault identity marker's id (`brain/vault-identity.ts`,
 *    16 random bytes), 32.
 * A value of another length, or under another name, is not one of them.
 */
export const PRODUCT_DIGESTS: ReadonlyMap<string, number> = new Map([
  ["h", 64],
  ["prev", 64],
  ["vault_id", 32],
]);

const HEX_RE = /^[0-9a-f]+$/;

/** Whether `value` under the flattened `key` is one of {@link PRODUCT_DIGESTS}. */
function isProductDigest(key: string, value: string): boolean {
  const field = key.slice(key.lastIndexOf(".") + 1);
  return PRODUCT_DIGESTS.get(field) === value.length && HEX_RE.test(value);
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** A line the chunker would read as a heading or a fence when it starts a line. */
const STRUCTURAL_LINE_RE = /^(?:#|```|~~~)/;

/** `text` with every line that would open a heading or a fence escaped. */
function inert(text: string): string {
  return text
    .split("\n")
    .map((line) => (STRUCTURAL_LINE_RE.test(line) ? `\\${line}` : line))
    .join("\n");
}

/** Rendered lines and the characters still allowed. */
interface Sink {
  readonly lines: string[];
  left: number;
}

function emit(sink: Sink, line: string): void {
  if (sink.left <= 0) return;
  const kept = line.length > sink.left ? line.slice(0, sink.left) : line;
  sink.lines.push(kept);
  sink.left -= kept.length + 1;
}

function flatten(value: unknown, key: string, depth: number, sink: Sink): void {
  if (sink.left <= 0) return;
  const scalar = scalarText(value);
  if (scalar !== null) {
    if (typeof value === "string" && isProductDigest(key, value)) return;
    emit(sink, inert(`${key}: ${scalar}`));
    return;
  }
  if (Array.isArray(value)) {
    const scalars = value.map(scalarText).filter((s): s is string => s !== null);
    if (scalars.length > 0) emit(sink, inert(`${key}: ${scalars.join(", ")}`));
    if (depth < MAX_DEPTH) {
      value.forEach((item, i) => {
        if (typeof item === "object" && item !== null)
          flatten(item, `${key}.${i}`, depth + 1, sink);
      });
    }
    return;
  }
  if (typeof value === "object" && value !== null && depth < MAX_DEPTH) {
    for (const [k, v] of Object.entries(value)) {
      if (depth === 0 && k === MIGRATED_FIELD) continue;
      flatten(v, key === "" ? k : `${key}.${k}`, depth + 1, sink);
    }
  }
}

/** Title and markdown content of `record`; `pending` marks a blob body not yet delivered. */
export function renderRecordText(
  record: StoreRecord,
  stream: string,
  pending: boolean,
): RecordText {
  const title = titleOf(record, pending);
  // The budget stops the walk itself, so a huge body is never rendered whole.
  const sink: Sink = { lines: [], left: BODY_MAX_CHARS };
  if (!pending) flatten(record.body, "", 0, sink);
  const body = sink.lines.join("\n");
  const meta = [
    `kind: ${record.kind}`,
    `stream: ${stream}`,
    ...(record.scope !== null ? [`scope: ${record.scope}`] : []),
    ...(record.topic !== null ? [`topic: ${record.topic}`] : []),
    `agent: ${record.agent}`,
    `device: ${record.device}`,
  ].join("\n");
  const content = [`# ${title}`, pending ? "(body not delivered yet)" : body, meta]
    .filter((part) => part !== "")
    .join("\n\n");
  return { title, content: `${content}\n` };
}
