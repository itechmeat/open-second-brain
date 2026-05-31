export type SurfacingGateReason =
  | "explicit"
  | "memory_question"
  | "uncertain_question"
  | "duplicate"
  | "empty"
  | "greeting"
  | "slash_command"
  | "shell_command"
  | "no_recall_intent";

export interface SurfacingGateInput {
  readonly prompt: string;
  readonly previousPrompt?: string | null;
  readonly explicit?: boolean;
}

export interface SurfacingGateDecision {
  readonly retrieve: boolean;
  readonly reason: SurfacingGateReason;
}

const GREETINGS = new Set([
  "hello",
  "hi",
  "hey",
  "привет",
  "здравствуй",
  "здравствуйте",
  "добрый день",
]);

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

const MEMORY_PATTERNS = [
  /\b(remember|recall|memory|context|notes?|decid(?:e|ed)|decision|search|find)\b/iu,
  /\b(what did we|where did we|when did we|have we|did we)\b/iu,
  /\b(помнишь|вспомни|найди|контекст|решили|обсуждали|заметки)\b/iu,
];

function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function isGreeting(normalized: string): boolean {
  const stripped = normalized.replace(/[!.?]+$/u, "");
  return GREETINGS.has(stripped);
}

function isSlashCommand(normalized: string): boolean {
  return normalized.startsWith("/") && !normalized.includes(" ");
}

function isShellOnlyPrompt(normalized: string): boolean {
  if (normalized.includes("?") || normalized.includes("\n")) return false;
  const firstToken = normalized.replace(/^\$\s*/u, "").split(/\s+/u)[0] ?? "";
  return SHELL_COMMANDS.has(firstToken);
}

function hasMemoryIntent(normalized: string): boolean {
  return MEMORY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function evaluateSurfacingGate(input: SurfacingGateInput): SurfacingGateDecision {
  if (input.explicit === true) return Object.freeze({ retrieve: true, reason: "explicit" });

  const normalized = normalizePrompt(input.prompt);
  if (normalized.length === 0) return Object.freeze({ retrieve: false, reason: "empty" });

  const previous = input.previousPrompt ? normalizePrompt(input.previousPrompt) : null;
  if (previous !== null && previous === normalized) {
    return Object.freeze({ retrieve: false, reason: "duplicate" });
  }
  if (isGreeting(normalized)) return Object.freeze({ retrieve: false, reason: "greeting" });
  if (isSlashCommand(normalized))
    return Object.freeze({ retrieve: false, reason: "slash_command" });
  if (isShellOnlyPrompt(normalized)) {
    return Object.freeze({ retrieve: false, reason: "shell_command" });
  }
  if (hasMemoryIntent(normalized)) {
    return Object.freeze({ retrieve: true, reason: "memory_question" });
  }
  if (normalized.endsWith("?") && normalized.length >= 60) {
    return Object.freeze({ retrieve: true, reason: "uncertain_question" });
  }
  return Object.freeze({ retrieve: false, reason: "no_recall_intent" });
}
