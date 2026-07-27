/**
 * Strict next-step resolution over {@link DIAGNOSTIC_SIGNALS} (no-dead-ends,
 * task 1).
 *
 * This module is the read surface every NEW forward-pointer consumer uses.
 * It exists because `resolveSignal` is deliberately lenient: for an
 * unregistered code it fabricates a generic `o2b brain doctor` hint, which
 * is exactly the "plausible value invented to keep a code path quiet" this
 * release removes. The strict lookup here never invents a command - an
 * unregistered code is absent, and the caller decides what to do about it.
 *
 * There is NO second registry: {@link DIAGNOSTIC_SIGNALS} already models an
 * issue class plus its structural CLI string, so this module only narrows
 * that record to what a next-step renderer needs and refuses to guess.
 */

import { DIAGNOSTIC_SIGNALS, type DiagnosticSignal } from "./diagnostics.ts";

/**
 * A resolved forward pointer: the code that produced it, its human label,
 * and the exact structural command to run next. Derived from
 * {@link DiagnosticSignal} rather than redeclared, so the two shapes cannot
 * drift; `autoRepairable` is deliberately excluded because rendering a next
 * step never depends on whether a fixer exists.
 */
export type NextStep = Readonly<Pick<DiagnosticSignal, "code" | "issueClass" | "nextCommand">>;

/**
 * Resolve `code` to its registered next step, or `null` when no signal is
 * registered for it. `null` is the absent result rather than a sentinel
 * record because that is this codebase's established "nothing to report"
 * return (see the write-conflict advisory and the profile lookups), and
 * because any record-shaped absent value would have to carry a command
 * field - the one thing this function must never invent.
 */
export function resolveNextStep(code: string): NextStep | null {
  const signal = DIAGNOSTIC_SIGNALS.get(code);
  if (signal === undefined) return null;
  return Object.freeze({
    code: signal.code,
    issueClass: signal.issueClass,
    nextCommand: signal.nextCommand,
  });
}

/** A code whose next step a caller requires, but which is unregistered. */
export class UnregisteredNextStepError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(
      `no diagnostic signal is registered for code ${JSON.stringify(code)}; ` +
        "add an entry to DIAGNOSTIC_SIGNALS naming the command that resolves it",
    );
    this.name = "UnregisteredNextStepError";
    this.code = code;
  }
}

/**
 * The registered next step for `code`, or {@link UnregisteredNextStepError}.
 *
 * For the callers that must NAME a command - a refusal whose whole value is
 * telling the operator what to run - absence is not a case to handle, it is
 * a registry that has drifted. Those callers resolve at module scope, so the
 * drift fails at import rather than inside the failure path it was meant to
 * explain. Mirrors `requireRepairCapability` in `applier-capability.ts`.
 */
export function requireNextStep(code: string): NextStep {
  const step = resolveNextStep(code);
  if (step === null) throw new UnregisteredNextStepError(code);
  return step;
}

/**
 * The additive JSON key every machine-readable surface carries a next
 * step in. Named once here because the CLI `--json` renderers and their
 * MCP twins must not drift on the spelling: a consumer that learns the
 * key from one surface reads it on the other.
 */
export const NEXT_COMMAND_KEY = "next_command";

/** The field a resolved code contributes, spread into an issue record. */
export type NextCommandField = { readonly [NEXT_COMMAND_KEY]?: string };

/** Absent case: an unregistered code contributes no key whatsoever. */
const NO_NEXT_COMMAND: NextCommandField = Object.freeze({});

/**
 * Resolve `code` into the object to spread onto a machine-readable issue
 * record. An unregistered code yields the empty object, so the key is
 * ABSENT rather than present-and-null - a null would be a value a
 * consumer has to interpret, and the honest statement is that this code
 * has no registered exit.
 */
export function nextCommandField(code: string): NextCommandField {
  const step = resolveNextStep(code);
  if (step === null) return NO_NEXT_COMMAND;
  return Object.freeze({ [NEXT_COMMAND_KEY]: step.nextCommand });
}
