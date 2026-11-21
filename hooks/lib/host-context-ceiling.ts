/**
 * The most text one hook may hand the host as context in one invocation.
 *
 * Claude Code caps a hook's `additionalContext` (and its `systemMessage`
 * and plain stdout) at 10,000 characters. It measures each string on its
 * own, even when several hooks run for the same event, so the cap is per
 * hook invocation, not per event. A longer value is not cut: it is saved
 * to a file in the session directory and the model gets the file path and
 * a preview of the first 2,000 characters, and is not asked to read the
 * file. The cap has no setting to raise it. So a session-start digest of
 * 13,600 characters reaches the model as a path and a preview, and the
 * active preferences in it are lost.
 *
 * Codex caps it too, in another unit: a SessionStart (or PreToolUse,
 * PostToolUse, UserPromptSubmit, SubagentStart) hook's context whose
 * approximate token count - UTF-8 bytes divided by four, rounded up -
 * exceeds 2,500 is saved to a file, and the model gets a head and tail
 * preview and the file path (`codex-rs/hooks/src/output_spill.rs`,
 * `DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT`, release 0.169.0). That is 10,000
 * UTF-8 bytes, and non-ASCII text costs two or three bytes a character,
 * so a payload under the character ceiling can still spill there.
 *
 * The ceiling here is the cap less 10% (the margin the split re-delivery
 * default `REGROUND_PART_CHARS_DEFAULT` already keeps), measured in each
 * host's own unit ({@link hostMeasureFor}): JS `.length` (UTF-16 code
 * units) for Claude Code and every host without a known cap, UTF-8 bytes
 * for Codex.
 *
 * Every hook that emits context fits its whole payload - every block,
 * header, notice and fence it joins - under this ceiling. The ones that
 * assemble large context (the session-start digest) budget their blocks
 * against it; {@link fitHostContext} is the last guard every emitter
 * applies, so no future block can push a payload past the cap unseen.
 */

import { UNTRUSTED_SOURCE_TAG } from "../../src/core/brain/untrusted-source.ts";
import { detectHookRuntime } from "./detect.ts";

/** How a host measures the context a hook hands it. */
export type HostMeasure = (text: string) => number;

/** UTF-16 code units: Claude Code's measure, and the default. */
export const utf16Length: HostMeasure = (text) => text.length;

const UTF8 = new TextEncoder();

/** UTF-8 bytes: the unit Codex's token approximation counts. */
export const utf8Bytes: HostMeasure = (text) => UTF8.encode(text).length;

/**
 * The measure the ceiling is applied in for a host: UTF-8 bytes for Codex
 * (ceil(bytes / 4) tokens against its 2,500-token default), UTF-16 code
 * units for every other host. A byte count is never below the UTF-16
 * count, so a payload within the byte ceiling is within both.
 */
export function hostMeasureFor(runtime: string): HostMeasure {
  return runtime === "codex" ? utf8Bytes : utf16Length;
}

/** The host's documented per-hook context cap, in characters. */
export const HOST_CONTEXT_CAP_CHARS = 10_000;

/** The ceiling every hook's emitted context stays under: the cap less 10%. */
export const HOST_CONTEXT_CEILING_CHARS = 9_000;

const FENCE_OPEN = `<${UNTRUSTED_SOURCE_TAG} `;
const FENCE_CLOSE = `</${UNTRUSTED_SOURCE_TAG}>`;

/** Opening words of the notice a cut payload ends with. */
const CUT_NOTICE_OPEN = "_Injection truncated to budget:";

/** The notice a cut payload ends with. */
function cutNotice(kept: number, total: number, pointer: string): string {
  return `${CUT_NOTICE_OPEN} kept ${kept} of ${total} characters to fit the host's context limit.${pointer}_`;
}

/**
 * `text` when it fits `ceiling`; otherwise its head, cut at the last line
 * break that leaves room for the notice, and the notice naming how much
 * was kept. `pointer` is the sentence the notice ends with, telling the
 * model where the rest is (for example the `brain_context` tool); it is
 * empty when there is nowhere to point.
 */
export function fitHostContext(
  text: string,
  pointer = "",
  ceiling: number = HOST_CONTEXT_CEILING_CHARS,
  measure: HostMeasure = utf16Length,
): string {
  return fitHostContextCut(text, pointer, ceiling, measure).text;
}

/**
 * {@link fitHostContext} under the ceiling of the host that sent
 * `payload`, in that host's measure ({@link hostMeasureFor}): the last
 * guard every hook applies to the context it emits.
 */
export function fitHostContextFor(payload: unknown, text: string, pointer = ""): string {
  return fitHostContext(
    text,
    pointer,
    HOST_CONTEXT_CEILING_CHARS,
    hostMeasureFor(detectHookRuntime(payload)),
  );
}

/** What {@link fitHostContextCut} emits, and how much of the input it kept. */
export interface HostContextCut {
  /** The text to emit: the input when it fits, else its head and the notice. */
  readonly text: string;
  /**
   * How many characters of the input, from its start, the emitted text
   * carries: the whole length when nothing was cut. A caller that records
   * what it delivered (a ledger of the notes the payload carried) reads
   * every part of the input at or past this offset as not delivered.
   */
  readonly kept: number;
}

/** {@link fitHostContext}, and how much of `text` it kept. */
export function fitHostContextCut(
  text: string,
  pointer = "",
  ceiling: number = HOST_CONTEXT_CEILING_CHARS,
  measure: HostMeasure = utf16Length,
): HostContextCut {
  if (measure(text) <= ceiling) return { text, kept: text.length };
  // The kept count has as many digits as the total at most; room is kept
  // for the closing fence a cut inside an untrusted-source fence needs.
  // The notice and the fence are ASCII, so their length is their measure.
  const reserve = cutNotice(text.length, text.length, pointer).length + 2 + FENCE_CLOSE.length + 1;
  const room = headWithin(text, Math.max(0, ceiling - reserve), measure);
  const lineEnd = text.lastIndexOf("\n", room);
  let head = (
    lineEnd > room / 2 ? text.slice(0, lineEnd) : text.slice(0, codePointCut(text, room))
  ).trimEnd();
  const kept = head.length;
  // A cut inside a fence closes it, so the vault text it holds never runs
  // on past its delimiter into the notice or whatever the host adds next.
  if (head.lastIndexOf(FENCE_OPEN) > head.lastIndexOf(FENCE_CLOSE))
    head = `${head}\n${FENCE_CLOSE}`;
  return { text: `${head}\n\n${cutNotice(kept, text.length, pointer)}`, kept };
}

/**
 * The most UTF-16 code units of `text`, from its start, whose measure is
 * at most `limit`. With the UTF-16 measure that is `limit` itself; with
 * the byte measure every unit costs at least one byte, so the search
 * starts at `limit` and steps down by the overshoot.
 */
function headWithin(text: string, limit: number, measure: HostMeasure): number {
  let at = Math.min(limit, text.length);
  for (;;) {
    const over = measure(text.slice(0, at)) - limit;
    if (over <= 0 || at === 0) return at;
    // A unit costs at most three bytes, and never less than one.
    at = Math.max(0, at - Math.max(1, Math.ceil(over / 3)));
  }
}

/**
 * `at`, or one less when `at` falls between the two halves of a
 * surrogate pair: a cut never leaves a lone high surrogate at the end of
 * the head, which the host would get as a broken character.
 */
function codePointCut(text: string, at: number): number {
  if (at <= 0 || at >= text.length) return at;
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  const splitsPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  return splitsPair ? at - 1 : at;
}
