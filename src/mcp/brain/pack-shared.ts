/**
 * The argument and configuration plumbing the pack family shares (task
 * 3.19): the recall-scores pairing key, the error fencing, the context
 * window and model resolution, the delivery disclosure helpers, the
 * receipt options every receipt-writing tool reads, and the configured
 * degradation. Split from `pack-tools.ts`.
 */

import { isAbsolute, relative } from "node:path";
import { resolveModelContextWindowEnvTokens } from "../../core/config.ts";
import { SearchError } from "../../core/search/search-error.ts";
import {
  discloseSpentQuery,
  type BeliefSemanticRelevance,
} from "../../core/brain/belief-semantic.ts";
import { packContext } from "../../core/brain/context-pack.ts";
import { loadBrainConfig } from "../../core/brain/policy.ts";
import { type ContextReceiptOptions } from "../../core/brain/context-receipts.ts";
import {
  resolveModelContextWindowTokens,
  type ResolvedModelWindow,
} from "../../core/brain/model-window.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { searchErrorToMcp } from "../search-tools.ts";
import { coerceBool } from "../coerce.ts";
import { optionalStringArg } from "./shared.ts";

/**
 * The argument name this tool spells its recall scores with.
 *
 * `brain_recall_gate` calls the same argument `scores`; the pairing keyword
 * and the handler's read both take the key from here so this tool's
 * declaration and its enforcement cannot drift onto different names.
 */
export const RECALL_SCORES_ARG_NAME = "recall_scores";

/**
 * Bounded-token vault slice ordered by importance tier then recency.
 * Lets an agent prime its context window under a strict budget.
 */
export function vaultRelative(vault: string, absOrRel: string): string {
  return isAbsolute(absOrRel) ? relative(vault, absOrRel) : absOrRel;
}

/** Run `fn`, answering a SearchError with its stable code on the wire. */
export async function withSearchErrorsOnWire<T>(
  fn: () => Promise<T>,
  refine: (e: SearchError) => SearchError = (e) => e,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SearchError) throw searchErrorToMcp(refine(e));
    throw e;
  }
}

/**
 * The vault's declared `context.window_tokens`; `undefined` when the block
 * is absent or the file cannot be read. Fail-soft on purpose: a broken
 * `_brain.yaml` raises later, where the pack builds, exactly as it always
 * has - the derivation channel must not answer for the operator's config
 * before the real reader does.
 */
export function contextWindowConfigValue(vault: string): number | undefined {
  try {
    return loadBrainConfig(vault).context?.window_tokens;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the model context window for one tool call (t_a567cc12) from
 * the three channels this server owns - the vault's `context:` block, the
 * environment override, and the caller's model hint - in the resolver's
 * precedence (config > env > declared table > `1m` suffix > default).
 *
 * `null` means NOTHING is resolvable: no model hint, no operator block,
 * no env value. Callers refuse on it - the pinned decision is never a
 * silent default budget. A malformed env value raises (an operator typo
 * must not shrink every budget to the default unnoticed); wrap the call
 * where the tool wants that on the wire as INVALID_PARAMS.
 *
 * Only invoked on the derivation path: a call that carries its explicit
 * budget never reads the vault or the environment, so the explicit path
 * behaves byte-identically to before the resolver existed.
 */
export function resolveSurfaceModelWindow(
  vault: string,
  model: string | undefined,
): ResolvedModelWindow | null {
  const operatorWindow = contextWindowConfigValue(vault);
  const envWindow = resolveModelContextWindowEnvTokens();
  if (model === undefined && operatorWindow === undefined && envWindow === undefined) return null;
  return resolveModelContextWindowTokens({
    ...(model !== undefined ? { model } : {}),
    ...(operatorWindow !== undefined ? { operatorWindowTokens: operatorWindow } : {}),
    ...(envWindow !== undefined ? { envWindowTokens: envWindow } : {}),
  });
}

/**
 * The caller's optional `model` id. A whitespace-only or empty value is
 * ABSENT - a blank name is no name - so the derivation answers
 * nothing-resolvable and refuses with the budget message, exactly as a
 * call without `model` does, instead of a model-argument complaint and
 * never a derived default budget. A non-string value stays a caller
 * error.
 */
export function optionalModelArg(tool: string, args: Record<string, unknown>): string | undefined {
  const raw = args["model"];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new MCPError(INVALID_PARAMS, `${tool}: model must be a non-empty string`);
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * A pack refusal raised after the query embed still names that spend. The
 * loader's pre-embed check reads every belief in view, while the pack keeps
 * fewer (no tombstones, chain tips only, and a dimension the query vector
 * decides), so the embed can be paid and the pack refused all the same.
 */
export function discloseSpentPackQuery(
  semantic: BeliefSemanticRelevance | null,
): (e: SearchError) => SearchError {
  return (e) => {
    if (semantic === null || e.code !== "BELIEF_VECTORS_MISSING") return e;
    return discloseSpentQuery(e, semantic.report);
  };
}

/**
 * The `semantic` member of a semantic-mode response: the one ungated
 * spend (the query embed) disclosed beside what the pack could score
 * after the reach filter.
 */
export function semanticReportField(
  loaded: BeliefSemanticRelevance,
  packed: NonNullable<ReturnType<typeof packContext>["semantic"]>,
): Record<string, unknown> {
  return {
    model: loaded.report.model,
    price_source: loaded.report.priceSource,
    query_tokens: loaded.report.queryTokens,
    estimated_usd: loaded.report.estimatedUsd,
    scored: packed.scored,
    unembedded: packed.unembedded,
  };
}

export function receiptOptionsFromArgs(
  tool: string,
  args: Record<string, unknown>,
  trigger: "context_pack" | "pre_compress",
  defaultHost: string,
): ContextReceiptOptions | undefined {
  if (!coerceBool(args, "receipt")) return undefined;
  return {
    host: optionalStringArg(tool, args, "receipt_host") ?? defaultHost,
    trigger,
    ...(optionalStringArg(tool, args, "session_id") !== undefined
      ? { sessionId: optionalStringArg(tool, args, "session_id") }
      : {}),
    ...(optionalStringArg(tool, args, "turn_id") !== undefined
      ? { turnId: optionalStringArg(tool, args, "turn_id") }
      : {}),
  };
}

/** Operator-configured trim strategy (`recall.degradation` in `_brain.yaml`). */
export function configuredDegradation(vault: string): "staged" | undefined {
  try {
    return loadBrainConfig(vault).recall?.degradation === "staged" ? "staged" : undefined;
  } catch {
    return undefined;
  }
}
