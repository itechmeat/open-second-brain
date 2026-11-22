import type { InstallTargetId } from "../runtime/host-facts.ts";

export interface PluginHostKind {
  readonly kind: "plugin";
  readonly step: string;
  readonly guide: string;
}

export type HostKind = { readonly kind: "adapter" } | PluginHostKind | { readonly kind: "print" };

export type SetupHostId = InstallTargetId | "claude-code" | "hermes" | "openclaw" | "zcode";

const pluginStep = (host: string, guide: string): PluginHostKind => ({
  kind: "plugin",
  step: `Install Open Second Brain through the ${host} plugin system. See ${guide}.`,
  guide,
});

export const HOST_KINDS: Readonly<Record<SetupHostId, HostKind>> = Object.freeze({
  aider: { kind: "adapter" },
  codex: { kind: "adapter" },
  "copilot-cli": { kind: "adapter" },
  cursor: { kind: "adapter" },
  "gemini-cli": { kind: "adapter" },
  generic: { kind: "print" },
  grok: { kind: "adapter" },
  kiro: { kind: "adapter" },
  opencode: { kind: "adapter" },
  pi: { kind: "adapter" },
  "claude-code": pluginStep("Claude Code", "install/claudecode.md"),
  hermes: pluginStep("Hermes", "install/hermes.md"),
  openclaw: pluginStep("OpenClaw", "install/openclaw.md"),
  zcode: pluginStep("ZCode", "install/zcode.md"),
});
