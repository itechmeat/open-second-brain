/**
 * Brain CLI verb-handler facade.
 *
 * # Import convention (load-bearing)
 *
 * Every file under `src/cli/brain/verbs/` MUST import shared helpers
 * through this module — never directly from `../argparse.ts`,
 * `../output.ts`, `../coerce.ts`, or `../helpers.ts`. The barrel
 * keeps one source of truth for "what is available to a brain verb"
 * and lets the helper bodies move between submodules without a
 * cross-cutting import sweep.
 *
 * # Layout
 *
 *   - `./help-text.ts`        — `BRAIN_HELP` + per-verb `VERB_HELP`.
 *   - `./upgrade-render.ts`   — `renderUpgradePlanJson`,
 *                               `printUpgradePlanText`,
 *                               `renderUnifiedDiff`.
 *   - `./query-render.ts`     — text renderers for `brain query`.
 *   - `./rollback-prompt.ts`  — `diffSummary`, `readSingleLine`.
 *
 * Vault resolution and the `parse` flag-parsing wrapper stay in this
 * file because they are tiny and called by every verb.
 */

import {
  defaultConfigPath,
  resolveAgentName,
  resolveTimezone,
  resolveVault,
} from "../../core/config.ts";
import { formatLocalTimestamp } from "../../core/brain/present-time.ts";
import { isoSecond } from "../../core/brain/time.ts";

import { CliError, parseFlags, type FlagsSchema } from "../argparse.ts";
import { NO_VAULT_ERROR, normalizeFlagString } from "../helpers.ts";

// ── Vault resolution ────────────────────────────────────────────────────────

export function resolveBrainVault(flagVal: string | undefined, configPath: string | null): string {
  // Mirror `requireVault` in `../helpers.ts`: explicit `--vault ""`
  // is a user error, not an excuse to fall through to `resolveVault`.
  const explicit = normalizeFlagString(flagVal);
  if (flagVal !== undefined && explicit === null) {
    throw new CliError(NO_VAULT_ERROR);
  }
  const vault = explicit ?? resolveVault(configPath ?? undefined);
  if (vault === null || vault === undefined) {
    throw new CliError(NO_VAULT_ERROR);
  }
  return vault;
}

// ── Verb context ────────────────────────────────────────────────────────────

/** Parsed flags shape every Brain verb receives from {@link parse}. */
export type BrainVerbFlags = Record<string, string | boolean | string[] | undefined>;

export interface BrainVerbContext {
  readonly config: string;
  readonly vault: string;
}

/**
 * Resolve the (config, vault) pair every Brain verb needs.
 *
 * Call it exactly where the verb used to resolve the vault — flag
 * validation that must precede vault resolution (and its error
 * output) stays ahead of this call, so verb output is unchanged.
 * Throws `CliError` for a missing or explicitly empty vault, same as
 * {@link resolveBrainVault}.
 */
export function brainVerbContext(flags: BrainVerbFlags): BrainVerbContext {
  const config = defaultConfigPath();
  return { config, vault: resolveBrainVault(flags["vault"] as string | undefined, config) };
}

/** Acting agent name: an explicit `--agent` flag wins over the config. */
export function resolveBrainAgent(flags: BrainVerbFlags, config: string): string {
  return (flags["agent"] as string | undefined) ?? resolveAgentName(config);
}

// ── Flag-parsing wrapper ────────────────────────────────────────────────────

export function parse(
  argv: ReadonlyArray<string>,
  schema: FlagsSchema,
): {
  flags: Record<string, string | boolean | string[] | undefined>;
  positional: string[];
} {
  return parseFlags(argv, schema);
}

// ── Re-exports (the barrel that verb handlers import from) ──────────────────

export { CliError } from "../argparse.ts";
export { fail, info, ok, okJson } from "../output.ts";
export { ISO_8601_RE, parseOptionalIsoDate } from "../coerce.ts";
export { NO_VAULT_ERROR, normalizeFlagString } from "../helpers.ts";

export { BRAIN_HELP, VERB_HELP } from "./help-text.ts";
export {
  renderUpgradePlanJson,
  printUpgradePlanText,
  renderUnifiedDiff,
} from "./upgrade-render.ts";
export {
  renderQueryPreferenceText,
  renderQueryTopicText,
  renderQueryLogText,
} from "./query-render.ts";
export { diffSummary, readSingleLine, type DiffSummary } from "./rollback-prompt.ts";

/**
 * Timezone presentation (t_2ccadc6a): additive `timezone` +
 * `local_time` fields for JSON envelopes when the operator configured
 * an IANA zone; empty object (byte-identical output) otherwise.
 */
export function localTimeFields(configPath: string | null): Record<string, string> {
  const tz = resolveTimezone(configPath ?? undefined);
  if (tz === null) return {};
  return { timezone: tz, local_time: formatLocalTimestamp(isoSecond(new Date()), tz) };
}
