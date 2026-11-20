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
 * The ceiling here is that cap less 10% (the margin the split re-delivery
 * default `REGROUND_PART_CHARS_DEFAULT` already keeps). Codex documents no
 * cap of its own; the repository applies the same number to it, and to
 * every other host, rather than guess a larger one. Units are JS
 * `.length` (UTF-16 code units), the host's own measure.
 *
 * Every hook that emits context fits its whole payload - every block,
 * header, notice and fence it joins - under this ceiling. The ones that
 * assemble large context (the session-start digest) budget their blocks
 * against it; {@link fitHostContext} is the last guard every emitter
 * applies, so no future block can push a payload past the cap unseen.
 */

import { UNTRUSTED_SOURCE_TAG } from "../../src/core/brain/untrusted-source.ts";

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
): string {
  return fitHostContextCut(text, pointer, ceiling).text;
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
): HostContextCut {
  if (text.length <= ceiling) return { text, kept: text.length };
  // The kept count has as many digits as the total at most; room is kept
  // for the closing fence a cut inside an untrusted-source fence needs.
  const reserve = cutNotice(text.length, text.length, pointer).length + 2 + FENCE_CLOSE.length + 1;
  const room = Math.max(0, ceiling - reserve);
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
