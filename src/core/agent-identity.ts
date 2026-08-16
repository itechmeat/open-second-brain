/**
 * Shared agent-identity helpers used by every runtime adapter.
 *
 * Centralises the two pieces of logic that need to stay in sync between
 * the MCP server (`src/mcp/tools.ts`) and the OpenClaw native plugin
 * (`src/openclaw/index.ts`) — and historically have drifted when one was
 * updated without the other:
 *
 *   - `PLACEHOLDER_AGENT_VALUES`: the strings the LLM is most likely to
 *     guess for the `agent` argument when it doesn't actually know its
 *     identity. None of these are useful as a real `@<name>` in the daily
 *     event log.
 *   - `normalizeAgentArgument`: strip a leading `@`, trim whitespace, and
 *     filter against `PLACEHOLDER_AGENT_VALUES` (case-insensitive).
 *     Returns `null` for empty / placeholder inputs so the caller can
 *     fall back to the server-resolved default.
 *   - `delegatedAgentName`: the identity a dispatched sub-agent writes
 *     under, derived from its delegator's name and the id the host
 *     assigned it.
 */

import { createHash } from "node:crypto";

export const PLACEHOLDER_AGENT_VALUES: ReadonlySet<string> = new Set([
  "agent",
  "assistant",
  "ai",
  "ai-assistant",
  "bot",
  "chatbot",
  "claude",
  "claude-code",
  "codex",
  "codex-cli",
  "codex-exec",
  "copilot",
  "gemini",
  "gpt",
  "gpt-4",
  "gpt-5",
  "hermes",
  "llm",
  "model",
  "openai",
  "openclaw",
  "user",
]);

export function normalizeAgentArgument(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).trim().replace(/^@+/, "").trim();
  if (!cleaned) return null;
  // Normalize hyphens / underscores to a single canonical form before the
  // set lookup. The placeholder list stores the hyphenated spelling
  // (`claude-code`, `gpt-4`, …) but agents emit either form interchangeably
  // — without this, `claude_code` or `gpt_4` would slip past the filter.
  const canonical = cleaned.toLowerCase().replace(/_/g, "-");
  if (PLACEHOLDER_AGENT_VALUES.has(canonical)) return null;
  return cleaned;
}

/**
 * Marker segment joining a delegating identity to the sub-agent it
 * dispatched. Kept as one token rather than a separator string so an
 * absent delegator degrades to `sub-<id>` instead of a leading hyphen.
 */
const DELEGATED_NAME_MARKER = "sub";

/** Characters of the host-supplied sub-agent id kept in a delegated name. */
const DELEGATED_ID_SEGMENT_CHARS = 8;

/** Runs of anything outside the canonical name alphabet, collapsed to one `-`. */
const NON_CANONICAL_NAME_RUN_RE = /[^a-z0-9]+/g;

/** Separator characters left at either end of a canonicalised segment. */
const EDGE_SEPARATOR_RE = /^-+|-+$/g;

/**
 * Derive the Brain identity of a sub-agent from the identity that
 * dispatched it and the id the host assigned it.
 *
 * A delegated turn was written by a different agent than the one that
 * opened the session, and the host says so - Claude Code stamps `agentId`
 * and `isSidechain: true` on every sidechain turn, under the PARENT's
 * session id. Collapsing the two onto one name erases the only record of
 * the boundary, which is why the roster could not tell a dispatched
 * worker's contribution from its orchestrator's.
 *
 * The result is a real identity, not a placeholder: it carries the
 * delegator's own name, so `normalizeAgentArgument` accepts it wherever a
 * caller-supplied identity is accepted. The id is canonicalised to the
 * name alphabet and truncated, because a host id is an opaque UUID and the
 * whole of it in a frontmatter field is noise; an id that canonicalises to
 * nothing falls back to a digest of the raw value rather than silently
 * dropping the segment and reading as the delegator itself.
 */
export function delegatedAgentName(delegator: string, subAgentId: string): string {
  const canonical = subAgentId
    .toLowerCase()
    .replace(NON_CANONICAL_NAME_RUN_RE, "-")
    .replace(EDGE_SEPARATOR_RE, "")
    .slice(0, DELEGATED_ID_SEGMENT_CHARS)
    .replace(EDGE_SEPARATOR_RE, "");
  const segment = canonical.length > 0 ? canonical : digestSegment(subAgentId);
  return [delegator.trim(), DELEGATED_NAME_MARKER, segment]
    .filter((part) => part.length > 0)
    .join("-");
}

/** Stable short digest for an id with no character in the name alphabet. */
function digestSegment(subAgentId: string): string {
  return createHash("sha256").update(subAgentId).digest("hex").slice(0, DELEGATED_ID_SEGMENT_CHARS);
}

/**
 * The operator identity template every device follows: `<vendor>-<host>-agent`
 * (e.g. `claude-vps-agent`, `hermes-mac-agent`). Capture group 1 is the host
 * segment, which may itself contain hyphens (`vps-prod`).
 */
const HOST_QUALIFIED_NAME_RE = /^[^-]+-(.+)-agent$/;

/**
 * Derive a runtime's own host-qualified Brain identity from the operator's
 * configured agent name.
 *
 * In a shared multi-device vault (the same Brain synced across, say, a VPS, a
 * dev box, and a Mac) the identity must encode BOTH which runtime wrote an
 * event AND on which device. The operator already names each device with the
 * `<vendor>-<host>-agent` template; a runtime keeps that host segment and
 * substitutes its OWN vendor token (the `runtimeId` argument), so e.g.
 * `claude-vps-agent` becomes `grok-vps-agent` for the grok runtime.
 *
 * This names no other runtime: `runtimeId` is always the caller's own id, and
 * the source vendor token is discarded rather than enumerated. Idempotent when
 * the operator name already carries this runtime's vendor.
 *
 * Names that do not fit the template (no `-agent` suffix, or no host segment)
 * cannot yield a host, so the whole name is prefixed with `<runtimeId>-` to
 * stay unambiguously this runtime's. When no operator name is configured the
 * runtime falls back to its bare id - there is no host to qualify with.
 */
export function deriveRuntimeAgentName(
  runtimeId: string,
  operatorName: string | null | undefined,
): string {
  const base = (operatorName ?? "").trim();
  if (base.length === 0) return runtimeId;
  const match = HOST_QUALIFIED_NAME_RE.exec(base);
  if (match) return `${runtimeId}-${match[1]}-agent`;
  return `${runtimeId}-${base}`;
}
