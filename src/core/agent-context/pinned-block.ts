/**
 * The pinned-context block of the session start digest (task 4.2):
 * the pinned content, neutralised, fenced as stored agent-authored text
 * and cut so the whole block fits `pinned_max_chars`, charged against
 * the injection budget. A cut block carries no note of its own: it
 * reports what it kept, and the digest ends in one note for every lane
 * it cut (`digest-cut-note.ts`), whose call (`brain_context`) returns the
 * whole pinned context.
 */

import { readPinnedContext } from "../brain/pinned.ts";
import { fenceUntrustedContent, neutralizeUntrustedText } from "../brain/untrusted-source.ts";

export const PINNED_HEADING = "## Pinned context";

export interface PinnedBlock {
  /** The fenced block, "" without pinned context or when not even the heading fits. */
  readonly text: string;
  /** Whether any pinned content was cut. */
  readonly cut: boolean;
  /** Characters of the pinned content the block carries. */
  readonly keptChars: number;
  /** Characters of the whole pinned content, after neutralising. */
  readonly totalChars: number;
}

/** The untrusted-fence origin: pinned context is stored, agent-authored text. */
export const PINNED_ORIGIN = "pinned-context";

function renderPinned(kept: string): string {
  return fenceUntrustedContent(`${PINNED_HEADING}\n\n${kept}`, PINNED_ORIGIN);
}

/**
 * The pinned block, fenced as stored agent-authored text (it reaches a
 * session as context, not as a tool result). The whole block - heading
 * and fence included - fits `maxChars`; a cut keeps the head of the
 * content, at a code point, and every remaining character is content.
 */
export function buildPinnedBlock(input: {
  readonly vault: string | null;
  readonly maxChars: number;
  /** How `maxChars` is measured: the host's unit (UTF-16 by default, UTF-8 bytes for Codex). */
  readonly measure?: (text: string) => number;
}): PinnedBlock {
  const measure = input.measure ?? ((text: string) => text.length);
  const pinned = readPinnedContext(input.vault);
  if (!pinned.present || pinned.content.trim() === "")
    return { text: "", cut: false, keptChars: 0, totalChars: 0 };
  const neutral = neutralizeUntrustedText(pinned.content);
  const whole = renderPinned(neutral);
  const totalChars = neutral.length;
  if (measure(whole) <= input.maxChars)
    return { text: whole, cut: false, keptChars: totalChars, totalChars };
  const chars = [...neutral];
  let kept = Math.max(0, input.maxChars - measure(renderPinned("")));
  for (;;) {
    const head = chars.slice(0, kept).join("");
    const text = renderPinned(head);
    if (measure(text) <= input.maxChars)
      return head.length > 0
        ? { text, cut: true, keptChars: head.length, totalChars }
        : { text: "", cut: true, keptChars: 0, totalChars };
    if (kept === 0) return { text: "", cut: true, keptChars: 0, totalChars };
    // A code point costs at most four bytes (two UTF-16 units), never less than one.
    kept = Math.max(0, kept - Math.max(1, Math.ceil((measure(text) - input.maxChars) / 4)));
  }
}
