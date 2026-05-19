/**
 * Shared CLI utilities used across subcommand modules.
 */

import { resolveVault } from "../core/config.ts";

export const NO_VAULT_ERROR =
  "error: no vault configured. Pass --vault <path> explicitly, " +
  "set VAULT_DIR in the environment, or run " +
  "`o2b init --vault <path> ...` first to persist a default.";

export class NoVaultConfiguredError extends Error {
  constructor() {
    super(NO_VAULT_ERROR);
    this.name = "NoVaultConfiguredError";
  }
}

/**
 * Normalise a CLI flag value into a trimmed non-empty string, or
 * `null` when the user did not supply something usable.
 *
 * Callers receive `null` for any of: `undefined`, non-string values
 * (boolean / array — `parseFlags` can produce these for misconfigured
 * schemas), the empty string, and whitespace-only strings.
 *
 * This is the load-bearing guard that prevents `--agent ""`,
 * `--vault "   "`, `--id $UNSET_VAR`, etc. from being treated as
 * authoritative user input and silently producing malformed
 * artefacts (`@` identities, vault paths pointing at the CWD,
 * unparseable preference ids). Every verb that reads a string flag
 * should normalise through this helper before falling back to
 * config-driven defaults.
 */
export function normalizeFlagString(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function requireVault(flagVal: string | undefined, configPath: string | null): string {
  // Explicit `--vault ""` / `"  "` is a user error, not an excuse to
  // fall through to `resolveVault` — treat it the same as the no-vault
  // case so the operator sees a clean error instead of commands
  // operating against an unintended relative path.
  const explicit = normalizeFlagString(flagVal);
  if (flagVal !== undefined && explicit === null) {
    throw new NoVaultConfiguredError();
  }
  const vault = explicit ?? resolveVault(configPath ?? undefined);
  if (vault === null || vault === undefined) {
    throw new NoVaultConfiguredError();
  }
  return vault;
}

export function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  }
  return value;
}
