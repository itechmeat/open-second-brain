/**
 * Strip-and-note JSON parsing for model-answer payloads (t_dac8bf7e).
 *
 * The four model-answer verbs (`extract-signals`, `design-note`,
 * `skill-proposals page-draft`, `distill`) receive JSON that a calling
 * model produced. Reasoning models wrap that JSON in a leading
 * `<think>...</think>` block; a bare `JSON.parse` refuses it and the
 * operator gets a generic "fix your JSON" for a payload whose JSON part
 * is fine.
 *
 * This module is the one shared parser: try the plain parse first; only
 * on failure strip ONE leading `<think>` block - unwrapping a wholly
 * fenced body per the `decision-model/llm-emulation.ts` precedent - and
 * retry. Every strip is REPORTED: the result carries the strip fact
 * (`kind`, `prefixChars`) so the surface can name it on the success
 * envelope. The strip never rescues genuinely malformed JSON: a payload
 * that still does not parse after the strip keeps a named error whose
 * message says the strip was attempted, and a payload with no leading
 * think block keeps the plain refusal. No I/O; pure text in, verdict out.
 */

export const THINK_BLOCK_STRIP_KIND = "think_block";
export const FENCED_THINK_BLOCK_STRIP_KIND = "fenced_think_block";

export type PayloadStripKind = typeof THINK_BLOCK_STRIP_KIND | typeof FENCED_THINK_BLOCK_STRIP_KIND;

/** The fact that a leading think block had to be stripped before parsing. */
export interface PayloadStrip {
  readonly kind: PayloadStripKind;
  /** Characters removed from the head of the input before the JSON body. */
  readonly prefixChars: number;
}

export class PayloadJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadJsonError";
  }
}

/** The refusal a bare `JSON.parse` produced before this module existed. */
export const PAYLOAD_UNPARSEABLE_MESSAGE = "payload must be valid JSON";

/** Appended when a strip was attempted and the remainder still refused. */
const STRIP_STILL_UNPARSEABLE_SUFFIX =
  " (a leading <think> block was stripped; the remainder still did not parse)";

/** The operator-facing strip fact, for a result envelope's `note` key. */
const STRIP_NOTE_BASE = "leading <think> block stripped before JSON parse";

export interface ParsedPayload {
  readonly payload: unknown;
  /** Present only when a leading think block had to be stripped. */
  readonly strip?: PayloadStrip;
}

/** One LEADING think block, whitespace tolerated ahead of it. */
const LEADING_THINK_BLOCK = /^\s*<think>[\s\S]*?<\/think>/;

/**
 * A body wholly wrapped in one code fence, the
 * `decision-model/llm-emulation.ts` replyObject precedent verbatim.
 */
const WHOLLY_FENCED = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

const UNPARSEABLE: unique symbol = Symbol("payload-json.unparseable");

function tryParse(text: string): unknown | typeof UNPARSEABLE {
  try {
    return JSON.parse(text);
  } catch {
    return UNPARSEABLE;
  }
}

/**
 * Parse a model-answer payload, stripping one leading `<think>` block when
 * - and only when - the plain parse fails. Throws {@link PayloadJsonError}
 * with the plain message when nothing was stripped, and with the message
 * naming the strip attempt when the stripped remainder still did not parse.
 */
export function parsePayloadJson(raw: string): ParsedPayload {
  try {
    return { payload: JSON.parse(raw) };
  } catch {
    // Only now may the strip fire; a payload the plain parse accepts is
    // handed through untouched, think blocks and all.
  }
  const stripped = LEADING_THINK_BLOCK.exec(raw);
  if (stripped === null) {
    return refuseWithoutStrip();
  }
  const thinkChars = stripped[0].length;
  const body = raw.slice(thinkChars);
  const direct = tryParse(body);
  if (direct !== UNPARSEABLE) {
    return stripSucceeded({ kind: THINK_BLOCK_STRIP_KIND, prefixChars: thinkChars }, direct);
  }
  const fenced = WHOLLY_FENCED.exec(body);
  if (fenced !== null) {
    const inner = fenced[1]!;
    const innerParsed = tryParse(inner);
    if (innerParsed !== UNPARSEABLE) {
      // prefixChars counts everything removed before the JSON body: the
      // think block plus the fence opener. The closing fence is a suffix,
      // not a prefix, and is not counted.
      const prefixChars = thinkChars + body.indexOf(inner);
      return stripSucceeded({ kind: FENCED_THINK_BLOCK_STRIP_KIND, prefixChars }, innerParsed);
    }
  }
  throw new PayloadJsonError(PAYLOAD_UNPARSEABLE_MESSAGE + STRIP_STILL_UNPARSEABLE_SUFFIX);
}

function refuseWithoutStrip(): never {
  throw new PayloadJsonError(PAYLOAD_UNPARSEABLE_MESSAGE);
}

function stripSucceeded(strip: PayloadStrip, payload: unknown): ParsedPayload {
  return { payload, strip };
}

/** The `note` value a surface puts on its success envelope when a strip happened. */
export function payloadStripNote(strip: PayloadStrip): string {
  return `${STRIP_NOTE_BASE} (kind=${strip.kind}, prefix_chars=${strip.prefixChars})`;
}
