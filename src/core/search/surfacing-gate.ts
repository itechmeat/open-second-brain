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

/** A line break (LF or CR) inside the trimmed raw prompt. */
const LINE_BREAK = /[\n\r]/u;

/**
 * Whether the raw prompt spans more than one line. Tested on the raw
 * prompt because normalisation collapses every whitespace run, line
 * breaks included, into one space.
 */
function isMultiLinePrompt(prompt: string): boolean {
  return LINE_BREAK.test(prompt.trim());
}

function isShellOnlyPrompt(normalized: string, multiLine: boolean): boolean {
  if (multiLine || normalized.includes("?")) return false;
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
 * slash command, or a one-line shell command (command names, not human
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
  if (isShellOnlyPrompt(normalized, isMultiLinePrompt(input.prompt))) {
    return Object.freeze({ retrieve: false, reason: "shell_command" });
  }
  return Object.freeze({ retrieve: true, reason: "default_retrieve" });
}
