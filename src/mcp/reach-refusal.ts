/**
 * Why a caller-supplied transport reach is REFUSED instead of honoured.
 *
 * The reach a request arrived at decides whether a page reserved against
 * remote reads may be answered (`src/core/graph/transport-reach.ts`). It
 * is minted by the transport, because the transport is the only party
 * that holds the fact - and the moment a caller could name it, the
 * boundary would be a request parameter and the reservation would mean
 * nothing.
 *
 * This is the same rule `./owner-scope-refusal.ts` states once for owner
 * identity, applied to reach: an identity - or a trust level - echoed
 * back from the request is not one. Refused rather than silently ignored,
 * because a dropped argument answers a question nobody asked; refused
 * rather than narrowed behind the caller's back, because the caller would
 * then believe it had read what it asked for.
 *
 * The rule does NOT depend on a tool's schema. `./argument-guard.ts`
 * refuses arguments a CLOSED schema does not declare, which would already
 * cover most of this - but only for the closed ones, and only with a
 * message about a typo. A reach arriving from a caller is not a typo, and
 * the surfaces that would be worth attacking are exactly the ones a
 * future open schema would leave uncovered.
 *
 * Comparison is over a normalised name (case-folded, separators dropped),
 * so `reach`, `Reach`, `transport_reach`, `transport-reach` and
 * `transportReach` are one argument rather than five holes. `disclosure`
 * is deliberately NOT reserved: it is the progressive result-depth mode
 * on the recall surfaces and has nothing to do with this boundary.
 */

import { INVALID_PARAMS, MCPError } from "./protocol.ts";
import type { ToolDefinition } from "./tool-contract.ts";

/** The refusal token, named in the message and carried in `data`. */
export const REACH_REFUSAL = "caller-supplied-reach";

/**
 * The argument names this server will not read a reach from, in their
 * canonical spelling. Every case and separator variant of these normalises
 * onto the same key - see {@link normalizeArgumentName}.
 */
export const RESERVED_REACH_ARGUMENTS: ReadonlyArray<string> = Object.freeze([
  "reach",
  "transport_reach",
]);

/** Case-folded, separator-free form, so one name is not five holes. */
function normalizeArgumentName(name: string): string {
  return name.normalize("NFC").toLowerCase().replaceAll(/[_-]/g, "");
}

const RESERVED_KEYS: ReadonlySet<string> = new Set(
  RESERVED_REACH_ARGUMENTS.map(normalizeArgumentName),
);

/** The structured payload attached to the refusal, for machine callers. */
export interface CallerSuppliedReachData {
  readonly tool: string;
  /** The caller's own spellings, in the caller's own key order. */
  readonly refused_arguments: ReadonlyArray<string>;
  readonly reserved_argument_names: ReadonlyArray<string>;
}

/**
 * Every argument the caller sent that names the transport reach, in the
 * caller's own spelling and key order. Empty is the ordinary case.
 */
export function findCallerSuppliedReach(args: Record<string, unknown>): ReadonlyArray<string> {
  return Object.freeze(
    Object.keys(args).filter((k) => RESERVED_KEYS.has(normalizeArgumentName(k))),
  );
}

/** What the caller is told to do instead, once, so the fix is in hand. */
const MINTING_RULE =
  "the transport that accepted this request mints it - stdio and the CLI run inside a " +
  "process the caller already started on this host, and an HTTP bind mints it from whether " +
  "that bind is loopback";

/**
 * Refuse a call carrying a reach-shaped argument.
 *
 * Runs BEFORE the unknown-argument gate on the same seam, so a caller
 * naming the boundary is told about the boundary rather than offered a
 * spelling suggestion for it.
 */
export function assertNoCallerSuppliedReach(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): void {
  const refused = findCallerSuppliedReach(args);
  if (refused.length === 0) return;
  const noun = refused.length === 1 ? "argument" : "arguments";
  const message =
    `${tool.name}: ${noun} ${refused.map((n) => `'${n}'`).join(", ")} refused ` +
    `(${REACH_REFUSAL}): the transport reach is never read from a request, because a trust ` +
    `claim echoed back from the caller is not a trust claim. Instead, ${MINTING_RULE}. ` +
    `Remove the ${noun}; there is no request-side way to widen what this transport established.`;
  const data: CallerSuppliedReachData = Object.freeze({
    tool: tool.name,
    refused_arguments: refused,
    reserved_argument_names: RESERVED_REACH_ARGUMENTS,
  });
  throw new MCPError(INVALID_PARAMS, message, data);
}
