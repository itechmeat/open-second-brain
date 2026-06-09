export type SurfacingGateReason =
  | "explicit"
  | "duplicate"
  | "empty"
  | "slash_command"
  | "shell_command"
  | "default_retrieve";

export interface SurfacingGateInput {
  readonly prompt: string;
  readonly previousPrompt?: string | null;
  readonly explicit?: boolean;
}

export interface SurfacingGateDecision {
  readonly retrieve: boolean;
  readonly reason: SurfacingGateReason;
}

const SHELL_COMMANDS = new Set([
  "awk",
  "bun",
  "cat",
  "cd",
  "chmod",
  "cp",
  "curl",
  "find",
  "git",
  "grep",
  "ls",
  "mkdir",
  "mv",
  "npm",
  "pnpm",
  "python",
  "rg",
  "rm",
  "sed",
  "touch",
  "yarn",
]);

function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function isSlashCommand(normalized: string): boolean {
  return normalized.startsWith("/") && !normalized.includes(" ");
}

function isShellOnlyPrompt(normalized: string): boolean {
  if (normalized.includes("?") || normalized.includes("\n")) return false;
  const firstToken = normalized.replace(/^\$\s*/u, "").split(/\s+/u)[0] ?? "";
  return SHELL_COMMANDS.has(firstToken);
}

/**
 * Decide whether a prompt should trigger memory retrieval.
 *
 * Language-agnostic by construction: the gate never inspects prompt
 * words against any natural-language vocabulary, so a prompt in any
 * language is treated identically. Only structural signals suppress
 * retrieval — an empty prompt, a verbatim repeat of the previous one, a
 * slash command, or a single shell command (command names, not human
 * language). Everything else FAILS OPEN: we retrieve and let ranking
 * decide relevance, because a missed recall is worse than a cheap
 * no-result search.
 */
export function evaluateSurfacingGate(input: SurfacingGateInput): SurfacingGateDecision {
  if (input.explicit === true) return Object.freeze({ retrieve: true, reason: "explicit" });

  const normalized = normalizePrompt(input.prompt);
  if (normalized.length === 0) return Object.freeze({ retrieve: false, reason: "empty" });

  const previous = input.previousPrompt ? normalizePrompt(input.previousPrompt) : null;
  if (previous !== null && previous === normalized) {
    return Object.freeze({ retrieve: false, reason: "duplicate" });
  }
  if (isSlashCommand(normalized))
    return Object.freeze({ retrieve: false, reason: "slash_command" });
  if (isShellOnlyPrompt(normalized)) {
    return Object.freeze({ retrieve: false, reason: "shell_command" });
  }
  return Object.freeze({ retrieve: true, reason: "default_retrieve" });
}
