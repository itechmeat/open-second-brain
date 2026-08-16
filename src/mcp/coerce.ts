/**
 * Shared coercion helpers for MCP tool handlers.
 *
 * Used by tools.ts, brain-tools.ts, and search-tools.ts to validate
 * and cast incoming JSON-RPC arguments. All helpers throw `MCPError`
 * with `INVALID_PARAMS` on bad input.
 */

import { refuseOwnerScopeRequest } from "./owner-scope-refusal.ts";
import { INVALID_PARAMS, MCPError } from "./protocol.ts";

export function coerceStr(
  args: Record<string, unknown>,
  key: string,
  required = true,
  defaultValue: string | null = null,
): string | null {
  const value = args[key];
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    if (required) throw new MCPError(INVALID_PARAMS, `missing required argument: ${key}`);
    return defaultValue;
  }
  if (typeof value !== "string")
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a string`);
  return value;
}

export function coerceStrList(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a list of strings`);
  }
  return [...value] as string[];
}

export function coerceInt(
  args: Record<string, unknown>,
  key: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const value = args[key] ?? defaultValue;
  if (typeof value === "boolean" || typeof value !== "number" || !Number.isInteger(value)) {
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be an integer`);
  }
  if (value < min || value > max) {
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be between ${min} and ${max}`);
  }
  return value;
}

export function coerceBool(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean")
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a boolean`);
  return value;
}

export function coerceBoolOptional(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  if (!(key in args)) return undefined;
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean")
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a boolean`);
  return v;
}

export function coerceStringOptional(
  args: Record<string, unknown>,
  key: string,
  maxLen: number,
): string | undefined {
  if (!(key in args)) return undefined;
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string")
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a string`);
  if (v.length > maxLen)
    throw new MCPError(INVALID_PARAMS, `argument '${key}' exceeds ${maxLen} characters`);
  return v;
}

/**
 * Input-schema fragment for the owner-scope argument
 * (context-integrity-gates, Unit A). Declared once so eleven tools
 * cannot grow eleven descriptions of the same argument.
 */
export const AGENT_SCOPE_ARG_NAME = "agent_scope";

/** Longest accepted owner token; an agent name, not a document. */
const AGENT_SCOPE_MAX_LEN = 128;

export const AGENT_SCOPE_SCHEMA = Object.freeze({
  type: "string",
  description:
    "Optional agent-ownership scope; shared (ownerless) memories always match, owner-tagged memories only their owner. Absent = no ownership filtering.",
});

/**
 * Read the owner scope a content-returning tool was called with - the
 * ONE reader of {@link AGENT_SCOPE_ARG_NAME} in this tree, asserted by
 * `tests/mcp/owner-scope-refusal.test.ts`. A tool that spells the
 * argument itself would opt out of the identity check below, which is
 * the class of defect this seam exists to make impossible.
 *
 * `fallbackToServerIdentity` is for the GATED preference-backed
 * surfaces: with no explicit argument they scope to the process's own
 * agent identity, which is what makes `owner_scope_delivery: fail`
 * effective for clients that never pass the argument. It is safe there
 * and only there, because those surfaces filter nothing until the
 * operator sets the gate. The ungated search-backed surfaces pass
 * `false`, so an omitted argument keeps them byte-identical.
 *
 * An EXPLICIT argument is checked against the server-resolved identity
 * under `owner_scope_delivery: fail` and refused when it names another
 * owner - see {@link refuseOwnerScopeRequest} for why refusing beats
 * narrowing. `ctx.agentName` is read only on that path and only when a
 * scope was supplied, so a call that asks for nothing costs nothing and
 * a vault that never opted in is untouched.
 */
export function coerceAgentScope(
  ctx: { readonly vault: string; readonly agentName?: string },
  args: Record<string, unknown>,
  fallbackToServerIdentity: boolean,
): string | undefined {
  const explicit = coerceStringOptional(args, AGENT_SCOPE_ARG_NAME, AGENT_SCOPE_MAX_LEN);
  if (explicit === undefined) return fallbackToServerIdentity ? ctx.agentName : undefined;
  const refused = refuseOwnerScopeRequest(ctx.vault, {
    argument: AGENT_SCOPE_ARG_NAME,
    requested: explicit,
    identity: ctx.agentName,
  });
  if (refused !== null) throw new MCPError(INVALID_PARAMS, refused.message);
  return explicit;
}

/** Longest accepted recall-score array; a top-k list, not a corpus. */
const RECALL_SCORES_MAX_ITEMS = 200;

export const MATCH_QUALITY_ARG_NAME = "match_quality";

/**
 * Input-schema fragments for the two arguments an adequacy verdict needs.
 * Declared once, beside {@link AGENT_SCOPE_SCHEMA}, because the two tools
 * that accept them spelled the score parser out twice already and the
 * second argument would have made it three descriptions of one contract.
 */
export const RECALL_SCORES_SCHEMA = Object.freeze({
  type: "array",
  maxItems: RECALL_SCORES_MAX_ITEMS,
  items: { type: "number" },
  description:
    "Optional top-k recall scores; requires `match_quality`. Together they add an adequacy verdict: sufficient/proceed, weak/re_recall, insufficient/abstain.",
});

/**
 * The companion argument's fragment, parameterised for the same reason
 * {@link recallAdequacyPairing} is.
 *
 * This description used to be a frozen constant naming "scores", which is
 * the gate's spelling and not the context pack's. Prose is what a
 * schema-driven client reads when it wants to know WHICH argument to send
 * alongside, and `additionalProperties: false` refuses the wrong one - so a
 * shared sentence naming one tool's key is the same defect as a pairing
 * hard-keyed on it, one layer softer. Both now say the key of the tool they
 * are attached to.
 *
 * The sentence is budgeted for the LONGEST key it will be handed:
 * `PROPERTY_DESCRIPTION_MAX` is 160 and `registry-guard` grants no
 * exemptions, so prose that fits under `scores` can still overflow under
 * `recall_scores`. Six characters of key are six characters of budget.
 */
export function matchQualitySchema(scoresKey: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: "number",
    minimum: 0,
    maximum: 1,
    description:
      `Absolute match quality in [0,1]: a search outcome's \`idf_weighted_coverage\`. ` +
      `Required with \`${scoresKey}\`; the adequacy level reads this, never a score.`,
  });
}

/**
 * "Both or neither", said in the schema rather than only in the refusal.
 *
 * {@link coerceRecallAdequacyInput} answers an incomplete pair with
 * INVALID_PARAMS, and until this keyword landed the pairing appeared in no
 * `required` array anywhere, so the only way a client could discover it was
 * to make the call the server refuses.
 *
 * Parameterised by the scores key, and living beside the enforcement rather
 * than inside one tool, because the two tools that enforce this spell the
 * key differently - `scores` on `brain_recall_gate`, `recall_scores` on
 * `brain_context_pack`. A pairing hard-keyed on one of those names is a
 * declaration only the first tool can use, which is how the second shipped
 * enforcing a rule it never declared. The declaration and the refusal now
 * read the same key from the same place.
 *
 * `dependentRequired` is the one keyword that states "both or neither"
 * declaratively; neither argument can sit in `required`, since both are
 * optional on their own. A client on a draft that predates the keyword
 * ignores it, which is why {@link RECALL_SCORES_SCHEMA} says it in prose too.
 */
export function recallAdequacyPairing(
  scoresKey: string,
): Readonly<Record<string, ReadonlyArray<string>>> {
  return Object.freeze({
    [scoresKey]: Object.freeze([MATCH_QUALITY_ARG_NAME]),
    [MATCH_QUALITY_ARG_NAME]: Object.freeze([scoresKey]),
  });
}

/**
 * One recall attempt as {@link assessRecallAdequacy} reads it, or
 * `undefined` when the caller asked for no verdict.
 *
 * The two arguments stand or fall together. Scores without a quality
 * cannot be graded - the level is decided by the quality alone - and
 * inventing one from the scores is exactly the substitution this release
 * removes, so an incomplete pair is refused rather than half-honoured.
 */
export function coerceRecallAdequacyInput(
  tool: string,
  args: Record<string, unknown>,
  scoresKey: string,
): { readonly matchQuality: number; readonly scores: ReadonlyArray<number> } | undefined {
  const rawScores = args[scoresKey];
  const rawQuality = args[MATCH_QUALITY_ARG_NAME];
  const hasScores = rawScores !== undefined && rawScores !== null;
  const hasQuality = rawQuality !== undefined && rawQuality !== null;
  if (!hasScores && !hasQuality) return undefined;
  if (!hasScores || !hasQuality) {
    throw new MCPError(
      INVALID_PARAMS,
      `${tool}: '${scoresKey}' and '${MATCH_QUALITY_ARG_NAME}' must be given together; ` +
        `the adequacy level is decided by ${MATCH_QUALITY_ARG_NAME} and cannot be derived from scores`,
    );
  }
  if (!Array.isArray(rawScores)) {
    throw new MCPError(INVALID_PARAMS, `${tool}: '${scoresKey}' must be an array of numbers`);
  }
  if (rawScores.length > RECALL_SCORES_MAX_ITEMS) {
    throw new MCPError(
      INVALID_PARAMS,
      `${tool}: '${scoresKey}' must not exceed ${RECALL_SCORES_MAX_ITEMS} items`,
    );
  }
  for (const item of rawScores) {
    if (typeof item !== "number") {
      throw new MCPError(INVALID_PARAMS, `${tool}: '${scoresKey}' must contain only numbers`);
    }
  }
  if (typeof rawQuality !== "number" || !Number.isFinite(rawQuality)) {
    throw new MCPError(
      INVALID_PARAMS,
      `${tool}: '${MATCH_QUALITY_ARG_NAME}' must be a finite number`,
    );
  }
  if (rawQuality < 0 || rawQuality > 1) {
    throw new MCPError(
      INVALID_PARAMS,
      `${tool}: '${MATCH_QUALITY_ARG_NAME}' must be in [0,1]; got ${rawQuality}`,
    );
  }
  return { matchQuality: rawQuality, scores: rawScores as ReadonlyArray<number> };
}

export function coerceIsoDate(args: Record<string, unknown>, key: string): Date | null {
  const raw = coerceStr(args, key, false);
  if (raw === null) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime()))
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a valid ISO-8601 timestamp`);
  return d;
}

export function coerceFormat(args: Record<string, unknown>, key = "format"): "markdown" | "json" {
  const raw = coerceStr(args, key, false);
  if (raw === null) return "markdown";
  if (raw !== "markdown" && raw !== "json") {
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be 'markdown' or 'json'`);
  }
  return raw;
}
