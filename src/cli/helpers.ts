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
    return Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)));
  }
  return value;
}

// ── Semantic-search state (v0.10.10) ────────────────────────────────────────

const SEMANTIC_HINT_MESSAGE = "run 'o2b search check' for setup steps";

export interface SemanticConfigState {
  readonly semantic_enabled: boolean;
  readonly embedding_key_present: boolean;
  /** True when the operator deliberately turned the search layer off. */
  readonly search_disabled: boolean;
  /**
   * True when semantic search is meaningfully unusable AND search has
   * not been explicitly disabled. Drives the `o2b status` hint line:
   * we do not nag operators who have search switched off outright.
   */
  readonly off: boolean;
  /** Human-friendly one-liner; `null` when `off === false`. */
  readonly hint: string | null;
}

function truthyConfigString(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const s = value.trim().toLowerCase();
  return s === "true" || s === "1";
}

/**
 * Resolve whether semantic search is meaningfully usable for a given
 * flat config map and process environment. Shared by `o2b status`
 * (hint-line render) and `writeSearchInitBlock` (post-init banner).
 */
export function resolveSemanticConfigState(
  configData: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv,
): SemanticConfigState {
  const searchDisabled = configData["search_enabled"] === "false";
  const enabled =
    truthyConfigString(configData["search_semantic_enabled"]) ||
    truthyConfigString(env["OPEN_SECOND_BRAIN_SEARCH_SEMANTIC"]);
  // `discoverConfig().data` is typed `Record<string, string>`, but
  // this helper accepts the wider `unknown`-keyed map for forward
  // compat with future callers; coerce defensively without throwing.
  const cfgKey = configData["embedding_api_key"];
  const envKey = env["OPEN_SECOND_BRAIN_EMBEDDING_KEY"];
  const keyPresent =
    (typeof cfgKey === "string" && cfgKey.trim().length > 0) ||
    (typeof envKey === "string" && envKey.trim().length > 0);
  const off = !searchDisabled && (!enabled || !keyPresent);
  return Object.freeze({
    semantic_enabled: enabled,
    embedding_key_present: keyPresent,
    search_disabled: searchDisabled,
    off,
    hint: off ? SEMANTIC_HINT_MESSAGE : null,
  });
}
