import { RECALL_CHANNEL, type RecallChannel } from "../brain/recall-telemetry.ts";
import {
  assertMeasuredQuality,
  computeSurfacingKey,
  SURFACING_TIER,
  type SurfacingTier,
} from "./surfacing-key.ts";

export type SurfacingGateReason =
  | "explicit"
  | "duplicate"
  | "empty"
  | "slash_command"
  | "shell_command"
  | "default_retrieve";

export interface SurfacingGateInput {
  readonly prompt: string;
  readonly previousPrompt?: string | null;
  readonly explicit?: boolean;
  /**
   * The transport asking, as {@link RecallChannel}. The STRUCTURAL
   * decision above is channel-independent by construction and never reads
   * this; only {@link evaluateGradedSurfacing} reads it, to calibrate the
   * measured admission. Absent means the gate's own production channel.
   */
  readonly channel?: RecallChannel;
  /**
   * The retrieval's absolute match quality (`RecallResultSet.idfWeightedCoverage`
   * or the adequacy pair's `match_quality`), when a measurement exists.
   * Only {@link evaluateGradedSurfacing} reads this: the structural gate
   * fails open on prompt structure alone and never sees retrieval state.
   * Absent = no measurement was offered; `null` = a measured report that
   * nothing was measurable.
   */
  readonly matchQuality?: number | null;
}

export interface SurfacingGateDecision {
  readonly retrieve: boolean;
  readonly reason: SurfacingGateReason;
}

/** The gate's production channel, assumed when a caller sends none. */
export const SURFACING_GATE_DEFAULT_CHANNEL = RECALL_CHANNEL.mcp;

/**
 * The graded decision: the structural verdict composed with the shared
 * admission key (`surfacing-key.ts`), one shape `{ key, tier, admit,
 * reason }` for every consumer. `reason` is the gate's own vocabulary on
 * the structural outcomes and the tier vocabulary on the measured ones.
 */
export interface GradedSurfacingDecision {
  readonly key: number | null;
  readonly tier: SurfacingTier;
  readonly admit: boolean;
  readonly reason: SurfacingGateReason | SurfacingTier;
}

const SHELL_COMMANDS = new Set([
  "awk",
  "bun",
  "cat",
  "cd",
  "chmod",
  "cp",
  "curl",
  "find",
  "git",
  "grep",
  "ls",
  "mkdir",
  "mv",
  "npm",
  "pnpm",
  "python",
  "rg",
  "rm",
  "sed",
  "touch",
  "yarn",
]);

function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function isSlashCommand(normalized: string): boolean {
  return normalized.startsWith("/") && !normalized.includes(" ");
}

/** A line break (LF or CR) inside the trimmed raw prompt. */
const LINE_BREAK = /[\n\r]/u;

/**
 * Whether the raw prompt spans more than one line. Tested on the raw
 * prompt because normalisation collapses every whitespace run, line
 * breaks included, into one space.
 */
function isMultiLinePrompt(prompt: string): boolean {
  return LINE_BREAK.test(prompt.trim());
}

function isShellOnlyPrompt(normalized: string, multiLine: boolean): boolean {
  if (multiLine || normalized.includes("?")) return false;
  const firstToken = normalized.replace(/^\$\s*/u, "").split(/\s+/u)[0] ?? "";
  return SHELL_COMMANDS.has(firstToken);
}

/**
 * Decide whether a prompt should trigger memory retrieval.
 *
 * Language-agnostic by construction: the gate never inspects prompt
 * words against any natural-language vocabulary, so a prompt in any
 * language is treated identically. Only structural signals suppress
 * retrieval — an empty prompt, a verbatim repeat of the previous one, a
 * slash command, or a one-line shell command (command names, not human
 * language). Everything else FAILS OPEN: we retrieve and let ranking
 * decide relevance, because a missed recall is worse than a cheap
 * no-result search.
 */
export function evaluateSurfacingGate(input: SurfacingGateInput): SurfacingGateDecision {
  if (input.explicit === true) return Object.freeze({ retrieve: true, reason: "explicit" });

  const normalized = normalizePrompt(input.prompt);
  if (normalized.length === 0) return Object.freeze({ retrieve: false, reason: "empty" });

  const previous = input.previousPrompt ? normalizePrompt(input.previousPrompt) : null;
  if (previous !== null && previous === normalized) {
    return Object.freeze({ retrieve: false, reason: "duplicate" });
  }
  if (isSlashCommand(normalized))
    return Object.freeze({ retrieve: false, reason: "slash_command" });
  if (isShellOnlyPrompt(normalized, isMultiLinePrompt(input.prompt))) {
    return Object.freeze({ retrieve: false, reason: "shell_command" });
  }
  return Object.freeze({ retrieve: true, reason: "default_retrieve" });
}

/**
 * The graded projection: the structural short-circuits first, then the
 * shared channel-calibrated admission key over the measured quality.
 *
 * Tiering: an explicit request admits (`explicit`); a structural
 * suppression refuses (`suppressed`, structural reason preserved) and is
 * never ranked, so its key stays null; otherwise the measured quality
 * decides (`admitted` | `below_floor` | `unmeasurable_quality`). With no
 * measurement offered at all, the structural projection's fail-open
 * stands and `reason` records `default_retrieve` so a default admission
 * is never mistaken for a measured one. The binary
 * {@link SurfacingGateDecision} projects out of this shape: `admit` is
 * `retrieve`, `reason` is the same field.
 */
export function evaluateGradedSurfacing(input: SurfacingGateInput): GradedSurfacingDecision {
  const structural = evaluateSurfacingGate(input);
  if (structural.reason === "explicit") {
    // Both "no measurement offered" and "measured, nothing was
    // measurable" grade as null keys on the default branch; the explicit
    // branch treats them the same instead of handing a legitimate null
    // report to the validator as a shape violation.
    const key =
      input.matchQuality === undefined || input.matchQuality === null
        ? null
        : assertMeasuredQuality(input.matchQuality);
    return Object.freeze({
      key,
      tier: SURFACING_TIER.explicit,
      admit: true,
      reason: "explicit",
    });
  }
  if (structural.reason !== "default_retrieve") {
    return Object.freeze({
      key: null,
      tier: SURFACING_TIER.suppressed,
      admit: false,
      reason: structural.reason,
    });
  }
  if (input.matchQuality === undefined) {
    return Object.freeze({
      key: null,
      tier: SURFACING_TIER.admitted,
      admit: true,
      reason: "default_retrieve",
    });
  }
  return computeSurfacingKey({
    matchQuality: input.matchQuality,
    channel: input.channel ?? SURFACING_GATE_DEFAULT_CHANNEL,
  });
}
