/**
 * Pure one-line hygiene digest composer
 * (context-injection-pipeline, lane B, task B1).
 *
 * Folds a hygiene scan's eligible findings plus the index-backed
 * dangling-link count into ONE line for the Stop channel, under the same
 * one-line discipline as `STOP_GUARDRAIL_TEXT` (hooks/lib/messages.ts):
 * Claude Code renders the text in the user's transcript and Codex turns
 * it into a continuation prompt, so every extra line is operator-facing
 * noise on each guarded turn.
 *
 * The module is deliberately import-light: only the hygiene type
 * vocabulary comes in, so the hook can statically import the composer
 * and still stay cheap when the feature flag is off - the detectors and
 * the search index are loaded lazily by the hook, after the gates.
 *
 * Zero eligible content composes to `null`, which the hook renders as
 * silence: silence is the steady state, never an "all clear".
 *
 * Wording, ordering and the length cap are named constants. The line is
 * machine-composed display text and every part of it a reader sees is
 * decided here, once.
 */

import {
  HYGIENE_DETECTOR_IDS,
  type HygieneDetectorId,
  type HygieneFinding,
  type HygieneSeverity,
} from "../../src/core/brain/hygiene/types.ts";

/**
 * The line's opening words, naming the subsystem in full. The display
 * contract spells "Open Second Brain"; the abbreviation is never
 * composed into operator-visible text.
 */
export const HYGIENE_DIGEST_PREFIX = "Open Second Brain hygiene:";

/**
 * The pointer to the pull surfaces behind the line's counts. The digest
 * names counts, never targets - the details live behind these commands.
 * TWO surfaces, because the line reports two kinds of counts: the CLI
 * scan lists the detector findings, while the dangling-link count is
 * measured from the search index and reported only by the MCP
 * `brain_hygiene` tool - a pointer to the scan alone would lead the
 * reader to a surface where that number never appears.
 */
export const HYGIENE_DIGEST_POINTER =
  "run o2b brain hygiene scan for the findings; the brain_hygiene tool reports the dangling links";

/**
 * Hard ceiling on the composed line, in UTF-16 code units, mirroring the
 * `STOP_GUARDRAIL_TEXT` rationale: the text rides a continuation prompt
 * on one runtime and a transcript line on another. A pathological
 * finding population degrades by dropping whole count segments, never by
 * pushing past the cap.
 */
export const HYGIENE_DIGEST_MAX_CHARS = 300;

/**
 * Severities loud enough to surface at turn end. `info` findings never
 * emit: an informational note is not a maintenance cue, and the steady
 * state of the channel is silence.
 */
export const HYGIENE_DIGEST_SEVERITIES: ReadonlyArray<HygieneSeverity> = Object.freeze([
  "warning",
  "action",
]);

/** Joins the count segments. */
const SEGMENT_JOIN = ", ";

/** Separates the counts from the pointer. */
const POINTER_JOIN = " \u2014 ";

/** Label of the index-backed dangling-link count, always the last segment. */
const DANGLING_LINKS_LABEL = "dangling links";

export interface HygieneDigestInput {
  readonly findings: ReadonlyArray<HygieneFinding>;
  /**
   * Dangling-link count from the search-index measurement; `null` when
   * the measurement was not taken (no index, partial resolution). An
   * unmeasured count is never flattened into a zero.
   */
  readonly danglingLinks: number | null;
}

/** Findings for one detector that meet the severity bar. */
function eligibleCount(
  findings: ReadonlyArray<HygieneFinding>,
  detector: HygieneDetectorId,
): number {
  let count = 0;
  for (const finding of findings) {
    if (finding.detector === detector && HYGIENE_DIGEST_SEVERITIES.includes(finding.severity)) {
      count += 1;
    }
  }
  return count;
}

function composeLine(segments: ReadonlyArray<string>): string {
  return `${HYGIENE_DIGEST_PREFIX} ${segments.join(SEGMENT_JOIN)}${POINTER_JOIN}${HYGIENE_DIGEST_POINTER}`;
}

/**
 * Compose the one-line digest, or `null` when nothing is eligible.
 *
 * `maxChars` is the hard ceiling the degradation loop keeps the line
 * under; it defaults to {@link HYGIENE_DIGEST_MAX_CHARS} and production
 * callers never pass it. The parameter exists because the default cap
 * is only approachable by a pathological population today, which would
 * otherwise leave the degrade-by-dropping behavior unverifiable.
 *
 * Deterministic and pure: counts are taken per detector in
 * `HYGIENE_DETECTOR_IDS` order regardless of the findings' input order,
 * the dangling-link count is appended last, and identical input composes
 * byte-identical output.
 */
export function composeHygieneDigest(
  input: HygieneDigestInput,
  maxChars: number = HYGIENE_DIGEST_MAX_CHARS,
): string | null {
  const segments: string[] = [];
  for (const detector of HYGIENE_DETECTOR_IDS) {
    const count = eligibleCount(input.findings, detector);
    if (count > 0) segments.push(`${count} ${detector}`);
  }
  if (input.danglingLinks !== null && input.danglingLinks > 0) {
    segments.push(`${input.danglingLinks} ${DANGLING_LINKS_LABEL}`);
  }
  if (segments.length === 0) return null;
  // A pathological population must still render as one short line: drop
  // whole segments from the end (the dangling count first) until the
  // line fits. The floor - prefix plus pointer - is a fixed handful of
  // words far under the cap, so the loop always terminates on a roomy
  // line without ever slicing mid-word.
  for (let keep = segments.length; keep > 0; keep -= 1) {
    const line = composeLine(segments.slice(0, keep));
    if (line.length <= maxChars) return line;
  }
  return composeLine([]);
}
