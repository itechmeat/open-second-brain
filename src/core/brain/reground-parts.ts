/**
 * Chunked re-delivery of an oversized SessionStart payload
 * (recall-injection-lifecycle, t_55ee804e).
 *
 * The host persists an `additionalContext` past roughly 10,000 UTF-16
 * units to a file and shows the agent only a preview, so a re-grounding
 * payload that large is silently lost. This splits the joined context
 * into parts that each fit a per-host ceiling: part 1 is emitted by
 * active-inject, parts 2..n are queued and handed out one per event by
 * `reground-deliver`.
 *
 * Pure: no I/O, no clock. Units are JS `.length` (UTF-16 code units),
 * the host's own measure.
 */

/** Parts past this many are dropped and reported, never delivered. */
export const REGROUND_MAX_PARTS = 8;

export interface RegroundSplit {
  /** parts[0] is emitted now; a lone part equals the joined input byte for byte. */
  readonly parts: ReadonlyArray<string>;
  /** Length of the unsplit joined context. */
  readonly utf16Chars: number;
  readonly partsDropped: number;
  /**
   * Length of the joined context's tail the dropped parts held, the
   * separator before it included; 0 when nothing was dropped. A text of the
   * joined context reached the kept parts whole exactly when it ends at
   * least this far from the end.
   */
  readonly droppedChars: number;
  /** Any part longer than the ceiling, or partsDropped > 0. */
  readonly overBudget: boolean;
}

/** The blank-line boundary: the default block separator, and the paragraph one. */
const BLANK_LINE = "\n\n";
const LINE_SEPARATOR = "\n";
/** Between the header, the body and the trailer of a part. */
const FRAME_SEPARATOR = "\n\n";

function partHeader(index: number, total: number): string {
  return `[Open Second Brain context - part ${index} of ${total}]`;
}

function partTrailer(next: number, total: number): string {
  return `(continued in part ${next} of ${total})`;
}

/** Closes the last delivered part when parts past the cap were dropped. */
function truncationTrailer(dropped: number): string {
  return `(context truncated: ${dropped} further part(s) not delivered)`;
}

/**
 * The frame a part carries, measured at its widest: the header at the
 * widest index, and the longer of the continuation trailer and the
 * truncation line at the widest count that can be printed. The total is
 * capped at REGROUND_MAX_PARTS, and every body holds at least one char, so
 * fewer than `joinedChars` parts can be dropped; the reserve bounds every
 * part, the final one included.
 */
function frameReserve(joinedChars: number): number {
  return (
    partHeader(REGROUND_MAX_PARTS, REGROUND_MAX_PARTS).length +
    FRAME_SEPARATOR.length +
    FRAME_SEPARATOR.length +
    Math.max(
      partTrailer(REGROUND_MAX_PARTS, REGROUND_MAX_PARTS).length,
      truncationTrailer(joinedChars).length,
    )
  );
}

/** One indivisible run of text, with the separator that joined it to its predecessor. */
interface Unit {
  readonly text: string;
  readonly separator: string;
}

/**
 * Split `blocks` (standing, scoped, memory, in priority order) into parts
 * of at most `ceilingChars`. `join` is active-inject's own block join, so
 * a payload that fits is returned as one part identical to what the hook
 * emits without this lane; `separator` is the string that join puts
 * between blocks, so the multi-part bodies keep it too.
 */
export function splitRegroundParts(
  blocks: ReadonlyArray<string>,
  ceilingChars: number,
  join: (blocks: ReadonlyArray<string>) => string,
  separator: string = BLANK_LINE,
  measure: (text: string) => number = (text) => text.length,
): RegroundSplit {
  const joined = join(blocks);
  if (measure(joined) <= ceilingChars) {
    return {
      parts: [joined],
      utf16Chars: joined.length,
      partsDropped: 0,
      droppedChars: 0,
      overBudget: false,
    };
  }

  const capacity = Math.max(2, ceilingChars - frameReserve(joined.length));
  const units: Unit[] = [];
  for (const block of blocks) {
    if (block.length === 0) continue;
    pushUnits(units, block, units.length === 0 ? "" : separator, capacity, measure);
  }
  const { bodies, ends } = pack(units, capacity, measure);

  const kept = bodies.slice(0, REGROUND_MAX_PARTS);
  const partsDropped = bodies.length - kept.length;
  const droppedChars = partsDropped > 0 ? joined.length - ends[kept.length - 1]! : 0;
  const total = kept.length;
  const parts = kept.map((body, offset) => {
    const index = offset + 1;
    const head = partHeader(index, total) + FRAME_SEPARATOR + body;
    if (index < total) return head + FRAME_SEPARATOR + partTrailer(index + 1, total);
    // A dropped tail is said in the payload itself, so the agent never
    // reads the last part as the whole context.
    return partsDropped > 0 ? head + FRAME_SEPARATOR + truncationTrailer(partsDropped) : head;
  });
  return {
    parts,
    utf16Chars: joined.length,
    partsDropped,
    droppedChars,
    overBudget: partsDropped > 0 || parts.some((part) => measure(part) > ceilingChars),
  };
}

/**
 * Break `text` into units no longer than `capacity`, preferring the
 * coarsest boundary that fits: the whole block, then blank-line
 * paragraphs, then lines, and only then a hard cut.
 */
function pushUnits(
  units: Unit[],
  text: string,
  separator: string,
  capacity: number,
  measure: (text: string) => number,
): void {
  if (measure(text) <= capacity) {
    units.push({ text, separator });
    return;
  }
  const paragraphs = text.split(BLANK_LINE);
  if (paragraphs.length > 1) {
    paragraphs.forEach((paragraph, i) =>
      pushUnits(units, paragraph, i === 0 ? separator : BLANK_LINE, capacity, measure),
    );
    return;
  }
  const lines = text.split(LINE_SEPARATOR);
  if (lines.length > 1) {
    lines.forEach((line, i) =>
      pushUnits(units, line, i === 0 ? separator : LINE_SEPARATOR, capacity, measure),
    );
    return;
  }
  let rest = text;
  let first = true;
  while (rest.length > 0) {
    const cut = safeCut(rest, capacity, measure);
    units.push({ text: rest.slice(0, cut), separator: first ? separator : "" });
    rest = rest.slice(cut);
    first = false;
  }
}

/**
 * A cut position whose head measures at most `limit` (and at least one
 * unit, so the loop always advances) that never splits a surrogate pair.
 */
function safeCut(text: string, limit: number, measure: (text: string) => number): number {
  if (measure(text) <= limit) return text.length;
  let at = Math.min(limit, text.length);
  // Every unit costs at least one of either measure: step down by the overshoot.
  for (;;) {
    const over = measure(text.slice(0, at)) - limit;
    if (over <= 0 || at <= 1) break;
    at = Math.max(1, at - Math.max(1, Math.ceil(over / 3)));
  }
  const before = text.charCodeAt(at - 1);
  const isHighSurrogate = before >= 0xd800 && before <= 0xdbff;
  return isHighSurrogate && at > 1 ? at - 1 : at;
}

/** Packed bodies, and where each one ends in the joined context. */
interface Packed {
  readonly bodies: string[];
  readonly ends: number[];
}

/** Greedily fill bodies with whole units; a separator at a part boundary is dropped. */
function pack(
  units: ReadonlyArray<Unit>,
  capacity: number,
  measure: (text: string) => number,
): Packed {
  const bodies: string[] = [];
  const ends: number[] = [];
  let current = "";
  // The running measure of `current`: separators are ASCII, so their
  // length is their measure.
  let currentSize = 0;
  // The units joined by their separators are the joined context, so this
  // running offset is a position in it.
  let offset = 0;
  for (const unit of units) {
    const size = measure(unit.text);
    if (current.length === 0) {
      current = unit.text;
      currentSize = size;
    } else if (currentSize + unit.separator.length + size <= capacity) {
      current += unit.separator + unit.text;
      currentSize += unit.separator.length + size;
    } else {
      bodies.push(current);
      ends.push(offset);
      current = unit.text;
      currentSize = size;
    }
    offset += unit.separator.length + unit.text.length;
  }
  if (current.length > 0) {
    bodies.push(current);
    ends.push(offset);
  }
  return { bodies, ends };
}
