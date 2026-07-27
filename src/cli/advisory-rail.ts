/**
 * The advisory emission rail (no-dead-ends, task 2).
 *
 * Every forward-pointer line the CLI prints - "here is the command that
 * moves this forward" - passes through this module, and through nothing
 * else. It exists because that line is two decisions, and both were
 * previously taken per verb, differently:
 *
 *   1. WHAT to say. The rail takes a diagnostic CODE and resolves it
 *      through `resolveNextStep`, so the command is the registry's
 *      structural CLI string. There is deliberately no parameter through
 *      which a caller can supply a command or a sentence: prose cannot
 *      enter this surface, and an unregistered code produces an explicit
 *      absent result rather than an invented hint.
 *   2. WHETHER it is legal to say it here. Twelve top-level commands
 *      render their own JSON, and their stdout is a payload a caller
 *      parses; one stray advisory line breaks it. Everything else is
 *      wrapped by `withJsonFallback`, whose envelope buffers stdout, so a
 *      line there is harmless. The rail asks `ownsInternalJson` rather
 *      than leaving each verb to remember which family it is in.
 *
 * The caller supplies `jsonRequested` from its own PARSED flags, never
 * from a raw-argv scan: a positional whose text happens to contain the
 * flag would otherwise silence a legitimate human-path advisory.
 *
 * Suppression is not a drop. A suppressed emission still returns the
 * resolved `NextStep`, so a JSON verb carries it as a field in its own
 * payload - which is where it belongs on that stream.
 */

import { resolveNextStep, type NextStep } from "../core/brain/next-step.ts";

import { ownsInternalJson } from "./json-helpers.ts";
import { info } from "./output.ts";

/** Structural label prefixed to every advisory line. */
const NEXT_STEP_LABEL = "next:";

/** The output stream an emission is being considered for. */
export interface AdvisoryStream {
  /** Top-level `o2b` command, e.g. `brain`. */
  readonly command: string;
  /** Argv tail after the top-level command, as `main` dispatched it. */
  readonly argv: ReadonlyArray<string>;
  /**
   * Whether the caller asked for JSON, read from the verb's PARSED flags.
   * Never a raw-argv scan - see the module docblock.
   */
  readonly jsonRequested: boolean;
}

/** Why an emission did or did not reach stdout. Every case is named. */
export const ADVISORY_OUTCOME = Object.freeze({
  /** The line was written to stdout. */
  emitted: "emitted",
  /** Stdout is a machine-parsed payload; the line stayed off it. */
  suppressedMachineStream: "suppressed-machine-stream",
  /** No signal is registered for the code, so there is no command to name. */
  unregisteredCode: "unregistered-code",
} as const);

export type AdvisoryOutcome = (typeof ADVISORY_OUTCOME)[keyof typeof ADVISORY_OUTCOME];

/** What one rail call did, in full. */
export interface AdvisoryEmission {
  /**
   * The code this call was made for, echoed back. Load-bearing for the
   * unregistered outcome: without it a caller learns that one of its
   * codes has no exit but not WHICH, and the batch form's contract of
   * reporting such codes "by name" would be unmeetable.
   */
  readonly code: string;
  readonly outcome: AdvisoryOutcome;
  /** The resolved step, or `null` iff the code is unregistered. */
  readonly nextStep: NextStep | null;
  /** The exact line written, or `null` when nothing was written. */
  readonly line: string | null;
}

/**
 * True when an advisory line may be written to stdout for `stream`. False
 * only when the caller asked for JSON from a command that renders its own:
 * the envelope-wrapped family buffers stdout, so a line there is safe.
 */
export function advisoryIsLegal(stream: AdvisoryStream): boolean {
  if (!stream.jsonRequested) return true;
  return !ownsInternalJson(stream.command, stream.argv);
}

/** Render `step` as the one-line form the human surfaces print. */
export function renderNextStepLine(step: NextStep): string {
  return `${NEXT_STEP_LABEL} ${step.nextCommand}`;
}

/**
 * Resolve `code` and, if the stream allows it, print its next-step line.
 *
 * Never throws: an unregistered code is a caller that has not registered
 * its diagnostic yet, not a crash, and the doctor surfaces must be able to
 * report such an issue without inventing a command for it. The outcome
 * distinguishes that case from a suppressed one, so neither is silent.
 */
export function emitNextStep(code: string, stream: AdvisoryStream): AdvisoryEmission {
  const nextStep = resolveNextStep(code);
  if (nextStep === null) {
    return Object.freeze({
      code,
      outcome: ADVISORY_OUTCOME.unregisteredCode,
      nextStep: null,
      line: null,
    });
  }
  if (!advisoryIsLegal(stream)) {
    return Object.freeze({
      code,
      outcome: ADVISORY_OUTCOME.suppressedMachineStream,
      nextStep,
      line: null,
    });
  }
  const line = renderNextStepLine(nextStep);
  info(line);
  return Object.freeze({ code, outcome: ADVISORY_OUTCOME.emitted, nextStep, line });
}

/**
 * Batch form: emit the DISTINCT next steps for `codes`, in the order
 * their commands first appear.
 *
 * A diagnosis surface reports issues, not exits, and the two are not one
 * to one: two hundred broken wikilinks share a single repair command,
 * and two different codes can share one too. Emitting per issue would
 * bury the answer in repetition, so the de-duplication rule lives here
 * rather than in each verb that reports a batch - the rail already owns
 * what reaches stdout, and one rule cannot drift from itself.
 *
 * De-duplication is keyed on the resolved COMMAND, not on the code,
 * because the caller acts on commands. Unregistered codes are returned
 * once each so the caller can still see, by name, which of its issues
 * has no registered exit; they never print.
 */
export function emitNextSteps(
  codes: Iterable<string>,
  stream: AdvisoryStream,
): ReadonlyArray<AdvisoryEmission> {
  const seenCommands = new Set<string>();
  const seenUnregistered = new Set<string>();
  const emissions: AdvisoryEmission[] = [];
  for (const code of codes) {
    const resolved = resolveNextStep(code);
    if (resolved === null) {
      if (seenUnregistered.has(code)) continue;
      seenUnregistered.add(code);
    } else {
      if (seenCommands.has(resolved.nextCommand)) continue;
      seenCommands.add(resolved.nextCommand);
    }
    emissions.push(emitNextStep(code, stream));
  }
  return Object.freeze(emissions);
}
