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
 */

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
