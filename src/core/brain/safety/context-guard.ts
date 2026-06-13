import { wrapUntrustedSource } from "../untrusted-source.ts";

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

export interface ContextSafetyReport {
  readonly filtered: boolean;
  readonly trusted: boolean;
  readonly reasons: ReadonlyArray<ContextSafetyReason>;
}

export interface ContextGuardSource {
  readonly id?: string;
  readonly path?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ContextGuardOptions {
  readonly source?: ContextGuardSource;
  readonly trust?: "trusted-instruction";
  /**
   * Language-agnostic structural containment (Unit 1). When true, an
   * untrusted snippet is wrapped in a provenance-carrying
   * `<untrusted_source>` delimiter and structurally neutralized instead
   * of being matched against the English-only injection blocklist and
   * blanked to a placeholder. Lossless: the content survives as
   * delimited data the model is told to treat as untrusted, and the
   * treatment is identical for every human language. Default off, so a
   * caller that does not opt in is byte-identical to the legacy guard.
   */
  readonly delimitUntrusted?: boolean;
  /**
   * Vault-relative provenance path stamped into the delimiter when
   * {@link delimitUntrusted} is set. Separate from `source.path` (which
   * may be an absolute on-disk path used in safety reasons) so enabling
   * structural mode never alters the legacy reason payload.
   */
  readonly provenancePath?: string;
}

export interface GuardedContextSnippet {
  readonly safeText: string;
  readonly filtered: boolean;
  readonly trusted: boolean;
  readonly reasons: ReadonlyArray<ContextSafetyReason>;
}

export function contextSafetyReport(
  snippet: GuardedContextSnippet,
): ContextSafetyReport | undefined {
  if (!snippet.filtered && !snippet.trusted) return undefined;
  return Object.freeze({
    filtered: snippet.filtered,
    trusted: snippet.trusted,
    reasons: snippet.reasons,
  });
}

interface DetectionPattern {
  readonly code: ContextSafetyReasonCode;
  readonly message: string;
  readonly pattern: RegExp;
}

const ZERO_WIDTH_RE = /\u200B|\u200C|\u200D|\uFEFF/g;
const SPACE_RE = /\s+/g;
const HORIZONTAL_SPACE_RE = /[^\S\r\n]+/g;

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

  // Structural containment (Unit 1): wrap-and-neutralize instead of the
  // English-only blocklist. Language-agnostic and lossless - the content
  // is preserved as delimited data rather than blanked out.
  if (opts.delimitUntrusted) {
    return Object.freeze({
      safeText: wrapUntrustedSource(text, { path: opts.provenancePath ?? opts.source?.path ?? "" }),
      filtered: false,
      trusted: false,
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
  const lineAware = normaliseForDelimiterDetection(text);
  const normalised = normaliseForTextDetection(text);
  const reasons: ContextSafetyReason[] = [];
  for (const pattern of DELIMITER_PATTERNS) {
    if (pattern.pattern.test(lineAware)) {
      reasons.push(reason(pattern.code, pattern.message, source));
    }
  }
  for (const pattern of TEXT_PATTERNS) {
    if (pattern.pattern.test(normalised)) {
      reasons.push(reason(pattern.code, pattern.message, source));
    }
  }
  return reasons;
}

function normaliseForTextDetection(text: string): string {
  return text
    .normalize("NFKC")
    .replace(ZERO_WIDTH_RE, "")
    .toLowerCase()
    .replace(SPACE_RE, " ")
    .trim();
}

function normaliseForDelimiterDetection(text: string): string {
  return text
    .normalize("NFKC")
    .replace(ZERO_WIDTH_RE, "")
    .toLowerCase()
    .replace(HORIZONTAL_SPACE_RE, " ")
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
