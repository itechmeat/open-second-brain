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

/**
 * The settings exist but cannot be read: `_brain.yaml` cannot be opened,
 * or a shared `settings` shard of the store cannot be read or has gone
 * since this machine read it. Unlike an absent or invalid file, the
 * values in force are unknown, so a protection that reads a setting (a
 * capture exclusion) fails closed on this error (design D14).
 */
export class BrainSettingsUnreadableError extends BrainConfigError {
  constructor(message: string, source: string | null) {
    super(message, null, source);
    this.name = "BrainSettingsUnreadableError";
  }
}
