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

export function requireVault(flagVal: string | undefined, configPath: string | null): string {
  const vault = flagVal ?? resolveVault(configPath ?? undefined);
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
