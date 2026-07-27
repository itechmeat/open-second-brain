/**
 * Shared plumbing for the `o2b search` verbs.
 *
 * # Import convention (load-bearing)
 *
 * Every file under `src/cli/search/verbs/` MUST import shared helpers
 * through this module — never directly from `../../argparse.ts`. The
 * barrel keeps one source of truth for "what is available to a search
 * verb" and lets the helper bodies move between submodules without a
 * cross-cutting import sweep. It mirrors the convention
 * `src/cli/brain/helpers.ts` already establishes for the Brain verbs.
 */

import { defaultConfigPath, resolveVault } from "../../core/config.ts";
import { resolveSearchConfig, type ResolvedSearchConfig } from "../../core/search/index.ts";
import { CliError, type FlagsSchema } from "../argparse.ts";
import type { AdvisoryStream } from "../advisory-rail.ts";

/** Parsed flags shape every search verb receives from `parseFlags`. */
export type SearchVerbFlags = Record<string, string | boolean | string[] | undefined>;

/**
 * The vault-addressing triple every search verb accepts. Spread first in
 * each verb's schema so the declaration order — and therefore the parse —
 * stays what it was when each verb spelled the three out itself.
 */
export const VAULT_FLAGS: FlagsSchema = Object.freeze({
  vault: { type: "string" },
  config: { type: "string" },
  db: { type: "string" },
});

/** A flag's value when it was supplied as a string, `undefined` otherwise. */
export function flagString(flags: SearchVerbFlags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

/** True when the flag was passed; every boolean flag is opt-in. */
export function flagBoolean(flags: SearchVerbFlags, name: string): boolean {
  return flags[name] === true;
}

/**
 * Whether a numeric flag parsed to an integer inside `bounds`.
 *
 * Only the predicate is shared. Each verb words its own bound differently
 * (`--raw-limit must be a positive integer` vs `--limit must be a positive
 * integer, got '<raw>'`) and every one of those strings is part of the CLI
 * contract, so both the message and the `throw` stay at the call site —
 * which is also what keeps each verb's refusal visible where it is made.
 */
export function isIntegerWithin(
  value: number,
  bounds: { readonly min: number; readonly max?: number },
): boolean {
  return (
    Number.isInteger(value) &&
    value >= bounds.min &&
    (bounds.max === undefined || value <= bounds.max)
  );
}

/** The config file this invocation reads: an explicit `--config`, else the default. */
export function resolveConfigPath(flags: SearchVerbFlags): string {
  return flagString(flags, "config") ?? defaultConfigPath();
}

export function resolveConfig(flags: SearchVerbFlags): ResolvedSearchConfig {
  const flagVault = flagString(flags, "vault");
  const configPath = resolveConfigPath(flags);
  const vault = flagVault ?? resolveVault(configPath) ?? null;
  if (!vault) {
    throw new CliError(
      "no vault configured. Pass --vault <path> or run `o2b init --vault <path> ...` first.",
    );
  }
  const dbFlag = flagString(flags, "db");
  const kwFlag = flagString(flags, "keyword-weight");
  const semFlag = flagString(flags, "semantic-weight");
  const concurrencyFlag = flagString(flags, "concurrency");
  const overrides = {
    ...(dbFlag !== undefined ? { dbPath: dbFlag } : {}),
    ...(kwFlag !== undefined ? { keywordWeight: Number(kwFlag) } : {}),
    ...(semFlag !== undefined ? { semanticWeight: Number(semFlag) } : {}),
    ...(concurrencyFlag !== undefined
      ? { semantic: { concurrency: Number(concurrencyFlag) } }
      : {}),
  };
  return resolveSearchConfig({ vault, configPath, overrides });
}

/**
 * Advisory stream for the search verbs that name an exit (no-dead-ends,
 * task 5). `index` and `reindex` reach the same terminal state — an index
 * that now exists and has not been queried — so they name the same exit
 * through the same registry code; `status` names the indexer from the
 * opposite state.
 *
 * The read path is deliberately NOT covered: `search query` self-heals a
 * missing index by building it, and pointing an operator at the indexer
 * there would describe a world that self-heal removed.
 */
export function searchAdvisoryStream(
  argv: ReadonlyArray<string>,
  jsonRequested: boolean,
): AdvisoryStream {
  return { command: "search", argv, jsonRequested };
}

// ── Re-exports (the barrel that verb handlers import from) ──────────────────

export { CliError, parseFlags } from "../argparse.ts";
export type { ResolvedSearchConfig };
