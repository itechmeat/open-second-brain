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
