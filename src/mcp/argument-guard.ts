/**
 * Unknown-argument gate (evidence-at-the-boundary, task C3).
 *
 * All 108 advertised tools declare `additionalProperties: false` and the
 * server enforced it on none. `tools/call` checked that the name was a
 * string and the arguments were a non-array object, then handed the raw
 * record to the handler, which read the keys it knew about and ignored
 * the rest. So `{"quiery": "x"}` on `brain_search` came back as a normal
 * success envelope computed entirely from defaults, and the single place
 * the unknown key was observed was a telemetry field (`argKeys`) that the
 * caller never sees. A silently ignored argument is the worst kind of
 * fallback: it produces an answer to a question nobody asked.
 *
 * This module is the request-path half of the pair. Its test-time twin,
 * `./registry-guard.ts`, is what makes the read below safe: the closure
 * flag is READ from each schema rather than assumed, and the completeness
 * audit is what guarantees the read never lands on an open one.
 *
 * The suggestion is pure string distance over the schema's own property
 * names (`core/text/nearest-name.ts`) - never a curated synonym table,
 * which would encode one language's habits and go stale on the first
 * rename.
 *
 * RECORDED LIMIT: top-level closure only. Fifteen nested object nodes in
 * the live table declare `additionalProperties: false` of their own -
 * `usage` on `brain_generation_reports`, the `operations` entries, the
 * `entities` and `relations` entries - and this gate does not enforce
 * them. That is a stated boundary, not a fallback pretending to work: a
 * nested unknown key still reaches the handler unremarked, exactly as it
 * did before. Widening the gate means walking the argument tree against
 * the schema tree, which is a validator, and this is not one.
 */

import { nearestName } from "../core/text/nearest-name.ts";
import { INVALID_PARAMS, MCPError } from "./protocol.ts";
import type { ToolDefinition } from "./tool-contract.ts";

/** One argument the caller sent that the tool never declared. */
export interface UnknownArgument {
  readonly name: string;
  /** The declared name it is closest to, when one is close enough. */
  readonly suggestion?: string;
}

/** The structured payload attached to the refusal, for machine callers. */
export interface UnknownArgumentData {
  readonly tool: string;
  readonly unknown_arguments: ReadonlyArray<UnknownArgument>;
  /** Every argument the tool does declare, sorted, so the fix is in hand. */
  readonly declared_arguments: ReadonlyArray<string>;
}

/** What the caller is told when no declared name is near enough to name. */
const NO_CLOSE_MATCH = "no close match";

/**
 * The names one schema declares, or undefined when the schema does not
 * close itself over them.
 *
 * Own keys only: `name in properties` walks the prototype chain, so an
 * argument called `constructor` or `toString` would be treated as
 * declared by a schema that declares nothing of the sort.
 */
function declaredArgumentNames(schema: unknown): ReadonlyArray<string> | undefined {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const node = schema as Record<string, unknown>;
  // The closure is read, never assumed. An open schema accepts extra
  // arguments by its own declaration, and refusing them would break a
  // contract this server publishes.
  if (node["additionalProperties"] !== false) return undefined;
  const properties = node["properties"];
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    return undefined;
  }
  return Object.keys(properties);
}

/**
 * Every argument the caller sent that `schema` does not declare, in the
 * caller's own key order, each with a suggestion where the distance
 * supports one. Empty for a schema that is not closed at the top level.
 */
export function findUnknownArguments(
  schema: unknown,
  args: Record<string, unknown>,
): ReadonlyArray<UnknownArgument> {
  const declared = declaredArgumentNames(schema);
  if (declared === undefined) return Object.freeze([]);
  const known = new Set(declared);
  const unknown: UnknownArgument[] = [];
  for (const name of Object.keys(args)) {
    if (known.has(name)) continue;
    const suggestion = nearestName(name, declared);
    unknown.push(Object.freeze(suggestion === undefined ? { name } : { name, suggestion }));
  }
  return Object.freeze(unknown);
}

/** `'quiery' (did you mean 'query'?)` or the honest absence of one. */
function renderUnknown(entry: UnknownArgument): string {
  return entry.suggestion === undefined
    ? `'${entry.name}' (${NO_CLOSE_MATCH})`
    : `'${entry.name}' (did you mean '${entry.suggestion}'?)`;
}

/**
 * Refuse a call carrying arguments the tool never declared.
 *
 * Every undeclared argument is named in one message - reporting only the
 * first would send the caller round the loop once per typo - and the same
 * list rides along as structured `data`, which `MCPError` carries and the
 * JSON-RPC error response already forwards.
 */
export function assertKnownArguments(tool: ToolDefinition, args: Record<string, unknown>): void {
  const unknown = findUnknownArguments(tool.inputSchema, args);
  if (unknown.length === 0) return;
  const declared = declaredArgumentNames(tool.inputSchema) ?? [];
  const noun = unknown.length === 1 ? "unknown argument" : "unknown arguments";
  const message =
    `${tool.name}: ${noun} ${unknown.map(renderUnknown).join(", ")}. ` +
    `This tool's inputSchema declares the ${declared.length} argument names it accepts.`;
  const data: UnknownArgumentData = Object.freeze({
    tool: tool.name,
    unknown_arguments: unknown,
    declared_arguments: Object.freeze(declared.toSorted()),
  });
  throw new MCPError(INVALID_PARAMS, message, data);
}
