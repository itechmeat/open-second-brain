/**
 * The operator exit both write-side trust refusals name (write-side
 * trust, Task 12): the permissions `show` loop, because the fix for a
 * refusal is editing the policy, which is the operator's act - never a
 * fixer's.
 *
 * A LEAF importing nothing, for the same reason
 * `entities/canonical.ts` is: the registry's next-step resolution
 * (`next-step.ts`) reads `diagnostics.ts`, which reaches the doctor
 * checks and from there the signals parser and the disposition layer
 * that refuse with this exit - so a consumer resolving the command
 * through `requireNextStep` at module scope closes an import cycle. The
 * registry's entries are built from this constant, keeping the string at
 * exactly one definition, and every refusal reads it straight from here.
 */
export const WRITE_REFUSAL_NEXT_COMMAND = "o2b brain permissions show";
