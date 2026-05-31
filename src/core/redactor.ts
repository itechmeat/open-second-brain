/**
 * Best-effort secret redactor + text-field normaliser shared across
 * Pay Memory and Brain writers.
 *
 * The redactor catches six secret-bearing keys in four assignment
 * shapes:
 *
 *   key=value                     env-style assignments
 *   key: value                    YAML / log lines / single-line `key: token`
 *   "key": "value"                JSON object entries
 *   Authorization: Bearer <token> HTTP authorization header (special case)
 *
 * Each match keeps the key (and surrounding quoting) and replaces the
 * value with the literal `***REDACTED***`. The transform is
 * intentionally narrow — receipts and signals carry a disclaimer that
 * the agent must visually inspect output before posting externally.
 *
 * `normaliseTextField` is the shared input sanitiser for fields that
 * land in YAML frontmatter or single-line Markdown bullets. It strips
 * C0 control characters (except `\n` and `\t`), folds the unicode line
 * separators `U+2028` / `U+2029` to `\n`, NFC-normalises, and caps
 * length to `maxLen`. The function never throws — out-of-spec input
 * is silently coerced into something safe to persist. A misrecorded
 * signal is worse than a missed one (the dream pass picks up patterns
 * from repeats); a YAML-poisoning signal is worse than either.
 */

const PLACEHOLDER = "***REDACTED***";

export const PRIVATE_REGION_PLACEHOLDER = "***PRIVATE***";

/**
 * Maximum input size accepted by `redactRawOutput`. Receipts have no
 * legitimate reason to embed multi-megabyte payloads — a runaway pipe
 * of server logs is the realistic cause of an oversize input. Capping
 * at 256 KB keeps the four-pass regex pipeline bounded and avoids a
 * DoS vector for whoever's caller is feeding the redactor.
 */
export const MAX_REDACTOR_INPUT = 256 * 1024;
const TRUNCATION_MARKER =
  "\n\n[…truncated for size; original exceeded 256 KB. Inspect raw output before sharing.]\n";

const PRIVATE_OPEN_TAG_RE = /<private\b[^>]*>/gi;
const PRIVATE_CLOSE_TAG_RE = /<\/private>/gi;

/**
 * Canonical list of secret-bearing field names. Each entry is the
 * underscore-separated canonical form; the regex builder below makes
 * `_` and `-` interchangeable and `_` optional, so a single entry
 * `api_key` covers `api_key` / `apikey` / `api-key` automatically.
 * Don't add the visual variants here — they're already covered.
 */
export const SECRET_KEYS: ReadonlyArray<string> = [
  "api_key",
  "token",
  "access_token",
  "refresh_token",
  "bearer",
  "secret",
  "client_secret",
  "authorization",
  "private_key",
  "password",
  "passwd",
  "pwd",
  "credential",
  "credentials",
  "session_token",
];

const KEY_PATTERN = SECRET_KEYS.map((k) => k.replace(/[-_]/g, "[-_]?")).join("|");

// `key=value` (env-style): value runs to whitespace or end of line.
const ENV_RE = new RegExp(`\\b(${KEY_PATTERN})(\\s*=\\s*)([^\\s\\r\\n]+)`, "gi");

// `key: value` outside of JSON quoting. Excludes the `"key": ...` JSON
// shape and the `Authorization: Bearer X` header (handled below).
const COLON_VALUE_RE = new RegExp(
  `(?<!")\\b(${KEY_PATTERN})(\\s*:\\s*)("[^"]*"|'[^']*'|[^\\r\\n]+)`,
  "gi",
);

// `"key": "value"` JSON entries.
const JSON_ENTRY_RE = new RegExp(
  `("(?:${KEY_PATTERN})"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|true|false|null|-?\\d+(?:\\.\\d+)?)`,
  "gi",
);

// `Authorization: Bearer <token>` header. COLON_VALUE_RE already
// redacts `authorization: ...` lines, but the canonical HTTP header is
// common enough that we preserve the `Bearer ` prefix for readability
// and only replace the token portion.
const BEARER_RE = /\b(Bearer\s+)([A-Za-z0-9._\-+/=]+)/gi;

export function stripPrivateRegions(text: string): string {
  if (!text) return text;

  let output = "";
  let cursor = 0;
  PRIVATE_OPEN_TAG_RE.lastIndex = 0;
  PRIVATE_CLOSE_TAG_RE.lastIndex = 0;

  while (cursor < text.length) {
    PRIVATE_OPEN_TAG_RE.lastIndex = cursor;
    const openMatch = PRIVATE_OPEN_TAG_RE.exec(text);
    if (!openMatch) {
      output += text.slice(cursor);
      break;
    }

    output += text.slice(cursor, openMatch.index);
    output += PRIVATE_REGION_PLACEHOLDER;

    let depth = 1;
    let scan = PRIVATE_OPEN_TAG_RE.lastIndex;
    while (depth > 0) {
      PRIVATE_OPEN_TAG_RE.lastIndex = scan;
      PRIVATE_CLOSE_TAG_RE.lastIndex = scan;
      const nextOpen = PRIVATE_OPEN_TAG_RE.exec(text);
      const nextClose = PRIVATE_CLOSE_TAG_RE.exec(text);
      if (!nextClose) return output;

      if (nextOpen && nextOpen.index < nextClose.index) {
        depth += 1;
        scan = PRIVATE_OPEN_TAG_RE.lastIndex;
      } else {
        depth -= 1;
        scan = PRIVATE_CLOSE_TAG_RE.lastIndex;
      }
    }
    cursor = scan;
  }

  return output;
}

export interface RedactRawOutputOptions {
  /**
   * Maximum input length before the truncation guard fires. Defaults to
   * {@link MAX_REDACTOR_INPUT} (256 KiB) - the right cap for receipts,
   * where a multi-megabyte payload is a runaway log pipe. Callers that
   * must redact-without-losing-data (the MCP artifact store, whose whole
   * job is to preserve the full payload for later fetch) pass
   * `Number.POSITIVE_INFINITY` to disable truncation while still scrubbing
   * secrets.
   */
  readonly maxInput?: number;
}

export function redactRawOutput(text: string, opts: RedactRawOutputOptions = {}): string {
  if (!text) return text;

  const maxInput = opts.maxInput ?? MAX_REDACTOR_INPUT;
  let out = text.length > maxInput ? text.slice(0, maxInput) + TRUNCATION_MARKER : text;

  out = stripPrivateRegions(out);

  // Order matters: handle JSON entries first so the COLON_VALUE_RE
  // doesn't also match inside JSON pairs (the negative-lookbehind
  // keeps it off the `"key":` portion, but if we ran COLON_VALUE_RE
  // first, a value like `"token": "abc123"` could be partially
  // mangled).
  out = out.replace(JSON_ENTRY_RE, (_match, keyPart: string, value: string) => {
    if (value.startsWith('"')) return `${keyPart}"${PLACEHOLDER}"`;
    return `${keyPart}${PLACEHOLDER}`;
  });

  out = out.replace(ENV_RE, (_match, key: string, sep: string) => {
    return `${key}${sep}${PLACEHOLDER}`;
  });

  // Bearer headers BEFORE the generic colon rule.
  out = out.replace(BEARER_RE, (_match, prefix: string) => `${prefix}${PLACEHOLDER}`);

  out = out.replace(COLON_VALUE_RE, (match, key: string, sep: string, value: string) => {
    if (value.includes(PLACEHOLDER)) return match;
    if (value.startsWith('"') && value.endsWith('"')) {
      return `${key}${sep}"${PLACEHOLDER}"`;
    }
    if (value.startsWith("'") && value.endsWith("'")) {
      return `${key}${sep}'${PLACEHOLDER}'`;
    }
    return `${key}${sep}${PLACEHOLDER}`;
  });

  return out;
}

// ----- Text-field normaliser ------------------------------------------------

/**
 * C0 control characters (U+0000…U+001F) are illegal in YAML scalars
 * except for `\t` (`	`) and `\n` (`
`). U+007F (DEL) is
 * similarly hazardous. Strip everything in that range outside the
 * two allowed control bytes — those are what we encounter in normal
 * text and want to preserve verbatim.
 */
const FORBIDDEN_C0_RE = /[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g;

/**
 * The Unicode line separator (U+2028) and paragraph separator
 * (U+2029) are technically legal but render as line breaks in most
 * editors and confuse one-line YAML scalars. Fold both to `\n` so
 * a downstream Markdown reader sees normal line breaks.
 */
const UNICODE_LINE_SEP_RE = /[\u2028\u2029]/g;

export interface NormaliseTextFieldOptions {
  /** Hard upper bound on output length in UTF-16 code units. */
  readonly maxLen: number;
  /**
   * When `true`, also strip newlines and tabs — appropriate for
   * single-line fields like `principle` or `scope` where a stray
   * newline would corrupt the YAML scalar.
   */
  readonly singleLine?: boolean;
}

/**
 * Normalise a free-form text field for safe persistence in Brain
 * frontmatter or apply-evidence log payloads. Never throws — invalid
 * input is coerced to a safe shape (empty string for non-strings,
 * truncation for over-length input).
 *
 * Pipeline:
 *   1. Coerce non-string to empty.
 *   2. Strip forbidden C0 controls (everything except `\t`/`\n`).
 *   3. Fold U+2028 / U+2029 to `\n`.
 *   4. If `singleLine`, collapse `\n`/`\r`/`\t` runs to a single space.
 *   5. NFC-normalise so combining characters don't trip the length cap.
 *   6. Truncate to `maxLen`.
 *
 * Trim is left to the caller — the writer for a given field decides
 * whether leading / trailing whitespace is significant.
 */
export function normaliseTextField(value: unknown, opts: NormaliseTextFieldOptions): string {
  if (typeof value !== "string") return "";
  let s = value.replace(FORBIDDEN_C0_RE, "");
  s = s.replace(UNICODE_LINE_SEP_RE, "\n");
  if (opts.singleLine) {
    s = s.replace(/[\r\n\t]+/g, " ");
  } else {
    // Normalise CRLF to LF so multi-line fields don't carry Windows
    // line endings into YAML or Markdown.
    s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }
  s = s.normalize("NFC");
  if (s.length > opts.maxLen) {
    s = s.slice(0, opts.maxLen);
  }
  return s;
}

/**
 * Convenience: redact + normalise in one call. Used by the Brain
 * writers (`writeSignal`, `appendApplyEvidence`) to keep field
 * sanitisation consistent across surfaces.
 */
export function sanitiseTextField(value: unknown, opts: NormaliseTextFieldOptions): string {
  if (typeof value !== "string") return "";
  return normaliseTextField(redactRawOutput(value), opts);
}
