/**
 * The claim record of a distillation. A leaf module: the write path
 * (`distill-source.ts`) and the pure quote check (`quote-check.ts`) both
 * depend on it, and neither depends on the other for it.
 */

/**
 * Frontmatter `kind:` marker of a distillation page. Defined here rather
 * than in `distill-source.ts` because the planted-rows audit reads it from
 * inside an import graph that must not run through the distill writer (the
 * writer's graph reaches page-lint, which reaches the doctor, which reads
 * the audit) - `distill-source.ts` re-exports it, so every existing
 * consumer is unchanged.
 */
export const BRAIN_DISTILLATION_KIND = "brain-distillation";

/** One atomic claim distilled from the source, with an optional block ref. */
export interface DistillClaim {
  /** The atomic claim text. */
  readonly text: string;
  /** Block id in the source the claim was drawn from (the `^abc` sigil, id only). */
  readonly block?: string;
}
