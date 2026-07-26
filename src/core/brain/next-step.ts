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
