/**
 * The pinned-context block of the session start digest (task 4.2):
 * the pinned content, neutralised, fenced as stored agent-authored text
 * and cut so the whole block fits `pinned_max_chars`, charged against
 * the injection budget. The read action named in the
 * cut line is `brain_pinned_context` (the MCP tool that returns the
 * whole pinned context).
 */

import { readPinnedContext } from "../brain/pinned.ts";
import { fenceUntrustedContent, neutralizeUntrustedText } from "../brain/untrusted-source.ts";

export const PINNED_HEADING = "## Pinned context";

export const PINNED_READ_COMMAND = "brain_pinned_context";

export interface PinnedBlock {
  /** The fenced block, "" without pinned context or when not even the heading fits. */
  readonly text: string;
  /** Whether any pinned content was cut. */
  readonly cut: boolean;
}

/** The untrusted-fence origin: pinned context is stored, agent-authored text. */
export const PINNED_ORIGIN = "pinned-context";

function renderPinned(kept: string, line: string | null): string {
  const body = `${PINNED_HEADING}\n\n${kept}${line === null ? "" : `\n\n${line}`}`;
  return fenceUntrustedContent(body, PINNED_ORIGIN);
}

/**
 * The pinned block, fenced as stored agent-authored text (it reaches a
 * session as context, not as a tool result). The whole block - heading,
 * fence and cut line included - fits `maxChars`.
 */
export function buildPinnedBlock(input: {
  readonly vault: string | null;
  readonly maxChars: number;
}): PinnedBlock {
  const pinned = readPinnedContext(input.vault);
  if (!pinned.present || pinned.content.trim() === "") return { text: "", cut: false };
  const neutral = neutralizeUntrustedText(pinned.content);
  const chars = [...neutral];
  const whole = renderPinned(neutral, null);
  if (whole.length <= input.maxChars) return { text: whole, cut: false };
  const line = (kept: number): string =>
    `_Pinned context cut to budget: kept ${kept} of ${chars.length} characters. Read it all with \`${PINNED_READ_COMMAND}\`._`;
  let kept = Math.max(0, input.maxChars - renderPinned("", line(0)).length);
  for (;;) {
    const text = renderPinned(chars.slice(0, kept).join(""), line(kept));
    if (text.length <= input.maxChars)
      return kept > 0 ? { text, cut: true } : { text: "", cut: true };
    if (kept === 0) return { text: "", cut: true };
    kept = Math.max(0, kept - (text.length - input.maxChars));
  }
}
