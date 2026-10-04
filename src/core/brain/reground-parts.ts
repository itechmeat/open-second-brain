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

/**
 * The frame every non-final part carries, measured at the widest index
 * that can be printed. The total is capped at REGROUND_MAX_PARTS, so the
 * width of `i` and `n` is fixed and the reserve is exact.
 */
const FRAME_RESERVE =
  partHeader(REGROUND_MAX_PARTS, REGROUND_MAX_PARTS).length +
  FRAME_SEPARATOR.length +
  FRAME_SEPARATOR.length +
  partTrailer(REGROUND_MAX_PARTS, REGROUND_MAX_PARTS).length;

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
): RegroundSplit {
  const joined = join(blocks);
  if (joined.length <= ceilingChars) {
    return { parts: [joined], utf16Chars: joined.length, partsDropped: 0, overBudget: false };
  }

  const capacity = Math.max(2, ceilingChars - FRAME_RESERVE);
  const units: Unit[] = [];
  for (const block of blocks) {
    if (block.length === 0) continue;
    pushUnits(units, block, units.length === 0 ? "" : separator, capacity);
  }
  const bodies = pack(units, capacity);

  const kept = bodies.slice(0, REGROUND_MAX_PARTS);
  const partsDropped = bodies.length - kept.length;
  const total = kept.length;
  const parts = kept.map((body, offset) => {
    const index = offset + 1;
    const head = partHeader(index, total) + FRAME_SEPARATOR + body;
    return index < total ? head + FRAME_SEPARATOR + partTrailer(index + 1, total) : head;
  });
  return {
    parts,
    utf16Chars: joined.length,
    partsDropped,
    overBudget: partsDropped > 0 || parts.some((part) => part.length > ceilingChars),
  };
}

/**
 * Break `text` into units no longer than `capacity`, preferring the
 * coarsest boundary that fits: the whole block, then blank-line
 * paragraphs, then lines, and only then a hard cut.
 */
function pushUnits(units: Unit[], text: string, separator: string, capacity: number): void {
  if (text.length <= capacity) {
    units.push({ text, separator });
    return;
  }
  const paragraphs = text.split(BLANK_LINE);
  if (paragraphs.length > 1) {
    paragraphs.forEach((paragraph, i) =>
      pushUnits(units, paragraph, i === 0 ? separator : BLANK_LINE, capacity),
    );
    return;
  }
  const lines = text.split(LINE_SEPARATOR);
  if (lines.length > 1) {
    lines.forEach((line, i) =>
      pushUnits(units, line, i === 0 ? separator : LINE_SEPARATOR, capacity),
    );
    return;
  }
  let rest = text;
  let first = true;
  while (rest.length > 0) {
    const cut = safeCut(rest, capacity);
    units.push({ text: rest.slice(0, cut), separator: first ? separator : "" });
    rest = rest.slice(cut);
    first = false;
  }
}

/** A cut position at most `limit` that never splits a surrogate pair. */
function safeCut(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  const before = text.charCodeAt(limit - 1);
  const isHighSurrogate = before >= 0xd800 && before <= 0xdbff;
  return isHighSurrogate && limit > 1 ? limit - 1 : limit;
}

/** Greedily fill bodies with whole units; a separator at a part boundary is dropped. */
function pack(units: ReadonlyArray<Unit>, capacity: number): string[] {
  const bodies: string[] = [];
  let current = "";
  for (const unit of units) {
    if (current.length === 0) {
      current = unit.text;
    } else if (current.length + unit.separator.length + unit.text.length <= capacity) {
      current += unit.separator + unit.text;
    } else {
      bodies.push(current);
      current = unit.text;
    }
  }
  if (current.length > 0) bodies.push(current);
  return bodies;
}
