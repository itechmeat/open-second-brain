import { describe, expect, test } from "bun:test";

import { deriveRuntimeAgentName, normalizeAgentArgument } from "../../src/core/agent-identity.ts";

describe("deriveRuntimeAgentName", () => {
  test("keeps the host segment and substitutes the runtime's own vendor token", () => {
    expect(deriveRuntimeAgentName("grok", "claude-dev-agent")).toBe("grok-dev-agent");
    expect(deriveRuntimeAgentName("grok", "hermes-vps-agent")).toBe("grok-vps-agent");
    expect(deriveRuntimeAgentName("opencode", "claude-mac-agent")).toBe("opencode-mac-agent");
    expect(deriveRuntimeAgentName("codex", "claude-vps-agent")).toBe("codex-vps-agent");
  });

  test("preserves a multi-segment host", () => {
    expect(deriveRuntimeAgentName("grok", "claude-vps-prod-agent")).toBe("grok-vps-prod-agent");
  });

  test("is idempotent when the operator name already uses the runtime's vendor", () => {
    expect(deriveRuntimeAgentName("grok", "grok-dev-agent")).toBe("grok-dev-agent");
  });

  test("prefixes names that do not fit the <vendor>-<host>-agent template", () => {
    // No `-agent` suffix, or no host segment: cannot extract a host, so the
    // whole name is prefixed with the runtime id to stay unambiguous.
    expect(deriveRuntimeAgentName("grok", "mybrain")).toBe("grok-mybrain");
    expect(deriveRuntimeAgentName("grok", "claude-vps")).toBe("grok-claude-vps");
    expect(deriveRuntimeAgentName("grok", "agent")).toBe("grok-agent");
  });

  test("falls back to the bare runtime id when no operator name is configured", () => {
    expect(deriveRuntimeAgentName("grok", null)).toBe("grok");
    expect(deriveRuntimeAgentName("grok", undefined)).toBe("grok");
    expect(deriveRuntimeAgentName("grok", "")).toBe("grok");
    expect(deriveRuntimeAgentName("grok", "   ")).toBe("grok");
  });

  test("trims surrounding whitespace before deriving", () => {
    expect(deriveRuntimeAgentName("grok", "  claude-dev-agent  ")).toBe("grok-dev-agent");
  });

  test("names no other runtime: the vendor token is always the caller's own id", () => {
    // Whatever vendor the operator name carries, the result vendor is the
    // runtimeId argument - the function never echoes the source vendor.
    for (const operator of ["claude-dev-agent", "hermes-dev-agent", "codex-dev-agent"]) {
      expect(deriveRuntimeAgentName("grok", operator)).toBe("grok-dev-agent");
    }
  });
});

describe("normalizeAgentArgument", () => {
  test("strips a leading @ and trims", () => {
    expect(normalizeAgentArgument("@claude-dev-agent")).toBe("claude-dev-agent");
    expect(normalizeAgentArgument("  grok-vps-agent ")).toBe("grok-vps-agent");
  });

  test("returns null for empty and placeholder values", () => {
    expect(normalizeAgentArgument(null)).toBeNull();
    expect(normalizeAgentArgument("")).toBeNull();
    expect(normalizeAgentArgument("agent")).toBeNull();
    expect(normalizeAgentArgument("claude")).toBeNull();
    expect(normalizeAgentArgument("claude_code")).toBeNull();
  });
});
