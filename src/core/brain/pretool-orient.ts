/**
 * Pure decision core for the opt-in strict PreToolUse read-block hook
 * (retrieval-quality-and-context-delivery, D2 / t_36b0fd8d).
 *
 * Intent: nudge an agent to query the brain search surface before it re-reads
 * raw vault files. With the strict flag on and no "recently oriented" stamp,
 * the FIRST raw vault-file read of a session is denied once (with a redirect
 * to the search surface), after which the hook downgrades to a soft nudge for
 * the rest of the session. Any brain query/search refreshes the orientation
 * stamp, which suppresses the block entirely.
 *
 * Two hard rules from the spec are encoded here:
 *   1. "Raw vault-file read" detection is STRUCTURAL: it turns on the tool
 *      call's file path resolving inside the configured vault root. The tool
 *      name is used only as an exact read-vs-mutate discriminator (an exact
 *      allowlist, never a loose/substring match), so a Write/Edit inside the
 *      vault is never blocked and a Read outside the vault is never blocked.
 *   2. Every failure path fails OPEN. A non-Claude-Code harness never receives
 *      a hard block (`deny`); the hook wrapper additionally maps unreadable
 *      state, malformed stamps, and a missing vault to `allow`. Fail-open here
 *      means "allow the action and record the reason", an explicit decision -
 *      never a swallowed error.
 *
 * The core is I/O-free: the caller resolves the runtime, the stamps, and the
 * vault root, so this stays deterministic and unit-testable.
 */

import { resolve, sep } from "node:path";

/** Redirect shown when the first raw vault read is denied. */
export const ORIENT_DENY_MESSAGE =
  "Strict orientation is on: query the brain search surface (brain_search / brain_query, or `o2b search`) before reading raw vault files. This first raw read is blocked once - run a brain search to orient, then retry the read.";

/** Soft reminder shown on subsequent raw reads after the one-time block. */
export const ORIENT_NUDGE_MESSAGE =
  "Reminder: prefer the brain search surface (brain_search / brain_query) over raw vault reads - a brain query orients you and suppresses this reminder.";

/**
 * Exact set of tool names that read a single file. Membership (not a loose
 * substring test) is what distinguishes a raw READ from a mutate; the
 * load-bearing structural signal is still the in-vault path below.
 */
const READ_TOOL_NAMES: ReadonlySet<string> = new Set(["Read"]);

/** Keys under which a tool's file-path argument may appear. */
const FILE_PATH_KEYS: ReadonlyArray<string> = ["file_path", "path"];

/**
 * Tool-name suffixes that count as querying the brain search surface. Anchored
 * on either string start or a `__` separator so a runtime-injected MCP prefix
 * (`mcp__plugin_<plugin>_<server>__brain_search`) still matches. EXACT-suffix
 * membership, not a loose substring test.
 */
const BRAIN_SEARCH_NAME_SUFFIX =
  /(?:^|__)(brain_search|brain_query|second_brain_query|brain_search_expand|brain_search_by_source|brain_context_pack)$/;

/** The one harness that receives a hard block; every other harness fails open. */
const CLAUDE_CODE_RUNTIME = "claudecode";

/**
 * True when `name` is one of the brain search/query tools (or a
 * runtime-decorated form thereof): querying the brain search surface is exactly
 * the orientation the read block wants to encourage, so it refreshes the stamp.
 */
export function isBrainSearchToolName(name: string): boolean {
  return BRAIN_SEARCH_NAME_SUFFIX.test(name);
}

export interface OrientInput {
  /**
   * Detected hook runtime label (e.g. from the hook layer's runtime detector).
   * Only `"claudecode"` receives a hard block; any other value fails open.
   */
  readonly runtime: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  /** Absolute configured vault root; a read resolving inside it is "raw". */
  readonly vaultRoot: string;
  /** True when the `osb.oriented.recent` stamp is live. */
  readonly isOriented: boolean;
  /** True when the `osb.oriented.blocked` stamp is live (block already fired). */
  readonly alreadyBlocked: boolean;
}

export type OrientDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "refresh_orientation" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "nudge"; readonly reason: string };

/** Extract a file-path argument from a tool input object, if present. */
function extractFilePath(toolInput: unknown): string | null {
  if (toolInput === null || typeof toolInput !== "object" || Array.isArray(toolInput)) {
    return null;
  }
  const record = toolInput as Record<string, unknown>;
  for (const key of FILE_PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * True when this tool call is a raw read of a file inside the vault root.
 * Structural: an exact read-tool name AND a file path that resolves to the
 * vault root or below it. A resolved path equal to the root, or prefixed by
 * `root + sep`, is inside; a sibling directory sharing a name prefix is not.
 */
function isRawVaultRead(input: OrientInput): boolean {
  if (!READ_TOOL_NAMES.has(input.toolName)) return false;
  const raw = extractFilePath(input.toolInput);
  if (raw === null) return false;
  const resolved = resolve(raw);
  const root = resolve(input.vaultRoot);
  return resolved === root || resolved.startsWith(root + sep);
}

/**
 * Decide what to do for one PreToolUse call. Orientation refresh takes
 * priority; then non-raw-read calls and oriented sessions allow; then the
 * one-time deny / soft-nudge ladder applies only to a Claude Code harness -
 * every other harness fails open.
 */
export function decideOrient(input: OrientInput): OrientDecision {
  if (isBrainSearchToolName(input.toolName)) {
    return Object.freeze({ kind: "refresh_orientation" });
  }
  if (!isRawVaultRead(input)) return Object.freeze({ kind: "allow" });
  if (input.isOriented) return Object.freeze({ kind: "allow" });
  // Other harnesses stay nudge-only / fail-open: never a hard block.
  if (input.runtime !== CLAUDE_CODE_RUNTIME) return Object.freeze({ kind: "allow" });
  if (!input.alreadyBlocked) {
    return Object.freeze({ kind: "deny", reason: ORIENT_DENY_MESSAGE });
  }
  return Object.freeze({ kind: "nudge", reason: ORIENT_NUDGE_MESSAGE });
}
