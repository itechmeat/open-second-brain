/**
 * The claim record of a distillation. A leaf module: the write path
 * (`distill-source.ts`) and the pure quote check (`quote-check.ts`) both
 * depend on it, and neither depends on the other for it.
 */

/** One atomic claim distilled from the source, with an optional block ref. */
export interface DistillClaim {
  /** The atomic claim text. */
  readonly text: string;
  /** Block id in the source the claim was drawn from (the `^abc` sigil, id only). */
  readonly block?: string;
}
