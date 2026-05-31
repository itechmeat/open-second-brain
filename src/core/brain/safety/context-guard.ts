export const CONTEXT_GUARD_PLACEHOLDER =
  "[Open Second Brain context withheld: prompt-injection-like content]";

export type ContextSafetyReasonCode =
  | "prompt_injection.instruction_override"
  | "prompt_injection.delimiter_spoof"
  | "prompt_injection.secret_exfiltration"
  | "prompt_injection.metadata";

export interface ContextSafetyReason {
  readonly code: ContextSafetyReasonCode;
  readonly message: string;
  readonly sourceId?: string;
  readonly sourcePath?: string;
  readonly field?: string;
}

export interface ContextGuardSource {
  readonly id?: string;
  readonly path?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ContextGuardOptions {
  readonly source?: ContextGuardSource;
  readonly trust?: "trusted-instruction";
}

export interface GuardedContextSnippet {
  readonly safeText: string;
  readonly filtered: boolean;
  readonly trusted: boolean;
  readonly reasons: ReadonlyArray<ContextSafetyReason>;
}

interface DetectionPattern {
  readonly code: ContextSafetyReasonCode;
  readonly message: string;
  readonly pattern: RegExp;
}

const ZERO_WIDTH_RE = /\u200B|\u200C|\u200D|\uFEFF/g;
const SPACE_RE = /\s+/g;

const TEXT_PATTERNS: ReadonlyArray<DetectionPattern> = Object.freeze([
  {
    code: "prompt_injection.instruction_override",
    message: "Text asks the agent to ignore or override prior instructions.",
    pattern:
      /\b(ignore|disregard|forget|override)\s+(all\s+)?(previous|prior|earlier|system|developer)\s+instructions?\b/,
  },
  {
    code: "prompt_injection.instruction_override",
    message: "Text attempts to redefine the active agent role or authority.",
    pattern: /\byou\s+are\s+now\s+(the\s+)?(system|developer|admin|root)\b/,
  },
  {
    code: "prompt_injection.instruction_override",
    message: "Text asks the agent to follow only the injected message.",
    pattern: /\bfollow\s+only\s+(this|the)\s+(message|instruction|prompt)\b/,
  },
  {
    code: "prompt_injection.secret_exfiltration",
    message: "Text asks the agent to reveal hidden prompts or secrets.",
    pattern:
      /\b(reveal|print|show|dump|exfiltrate)\s+.*\b(system\s+prompt|hidden\s+prompt|secrets?|tokens?)\b/,
  },
]);

const DELIMITER_PATTERNS: ReadonlyArray<DetectionPattern> = Object.freeze([
  {
    code: "prompt_injection.delimiter_spoof",
    message: "Text contains a fenced role block that resembles a prompt boundary.",
    pattern: /(^|\n)```\s*(system|developer|assistant|user)\b/,
  },
  {
    code: "prompt_injection.delimiter_spoof",
    message: "Text contains XML-like role delimiters that resemble a prompt boundary.",
    pattern: /<\/?\s*(system|developer|assistant|user)\s*>/,
  },
]);

export function guardBrainContextSnippet(
  text: string,
  opts: ContextGuardOptions = {},
): GuardedContextSnippet {
  if (opts.trust === "trusted-instruction") {
    return Object.freeze({
      safeText: text,
      filtered: false,
      trusted: true,
      reasons: Object.freeze([]),
    });
  }

  const reasons = [...detectText(text, opts.source), ...detectMetadata(opts.source)];
  return Object.freeze({
    safeText: reasons.length > 0 ? CONTEXT_GUARD_PLACEHOLDER : text,
    filtered: reasons.length > 0,
    trusted: false,
    reasons: Object.freeze(reasons),
  });
}

function detectMetadata(source: ContextGuardSource | undefined): ContextSafetyReason[] {
  const metadata = source?.metadata;
  if (!metadata) return [];

  const reasons: ContextSafetyReason[] = [];
  for (const [field, raw] of Object.entries(metadata)) {
    for (const value of metadataStrings(raw)) {
      if (detectText(value, source).length > 0) {
        reasons.push(
          reason(
            "prompt_injection.metadata",
            "Metadata contains prompt-injection-like instructions.",
            source,
            field,
          ),
        );
        break;
      }
    }
  }
  return reasons;
}

function detectText(text: string, source: ContextGuardSource | undefined): ContextSafetyReason[] {
  if (!text) return [];
  const normalised = normaliseForDetection(text);
  const reasons: ContextSafetyReason[] = [];
  for (const pattern of [...DELIMITER_PATTERNS, ...TEXT_PATTERNS]) {
    if (pattern.pattern.test(normalised)) {
      reasons.push(reason(pattern.code, pattern.message, source));
    }
  }
  return reasons;
}

function normaliseForDetection(text: string): string {
  return text
    .normalize("NFKC")
    .replace(ZERO_WIDTH_RE, "")
    .toLowerCase()
    .replace(SPACE_RE, " ")
    .trim();
}

function metadataStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function reason(
  code: ContextSafetyReasonCode,
  message: string,
  source: ContextGuardSource | undefined,
  field?: string,
): ContextSafetyReason {
  return Object.freeze({
    code,
    message,
    ...(source?.id ? { sourceId: source.id } : {}),
    ...(source?.path ? { sourcePath: source.path } : {}),
    ...(field ? { field } : {}),
  });
}
