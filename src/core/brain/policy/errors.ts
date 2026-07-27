/**
 * Failure and warning vocabulary for `Brain/_brain.yaml`.
 *
 * Kept apart from every validator so the rest of the config layer can
 * raise and collect diagnostics without importing the parsing machinery,
 * and so the rendered message format has exactly one definition.
 */

/**
 * Warnings collected during validation. Forward-compat tolerates unknown
 * top-level keys but surfaces them so a typo doesn't go unnoticed.
 */
export interface BrainConfigLoadWarning {
  readonly path: string;
  readonly message: string;
}

export class BrainConfigError extends Error {
  /**
   * Dotted field path that caused the failure (`dream.candidate_threshold`,
   * `schema_version`, …). `null` for top-level type errors.
   */
  readonly field: string | null;
  readonly source: string | null;

  constructor(message: string, field: string | null, source: string | null) {
    super(
      field
        ? `${source ?? "<config>"}: ${field}: ${message}`
        : `${source ?? "<config>"}: ${message}`,
    );
    this.name = "BrainConfigError";
    this.field = field;
    this.source = source;
  }
}
