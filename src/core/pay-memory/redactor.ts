/**
 * Best-effort redactor for raw payment-tool output before it lands in a
 * Markdown receipt.
 *
 * Six secret-bearing keys are recognized in four assignment shapes:
 *
 *   key=value                     env-style assignments
 *   key: value                    YAML / log lines / single-line `key: token`
 *   "key": "value"                JSON object entries
 *   Authorization: Bearer <token> HTTP authorization header (special case)
 *
 * Each match keeps the key (and surrounding quoting) and replaces the value
 * with the literal `***REDACTED***`. The transform is intentionally narrow —
 * the receipt body still carries a disclaimer that the agent must visually
 * inspect output before posting it externally.
 */

const PLACEHOLDER = "***REDACTED***";

/**
 * Maximum input size accepted by `redactRawOutput`. Receipts have no
 * legitimate reason to embed multi-megabyte payloads — a runaway pipe of
 * server logs is the realistic cause of an oversize input. Capping at
 * 256 KB keeps the four-pass regex pipeline bounded and avoids a DoS
 * vector for whoever's caller is feeding the redactor.
 */
export const MAX_REDACTOR_INPUT = 256 * 1024;
const TRUNCATION_MARKER =
  "\n\n[…truncated for size; original exceeded 256 KB. Inspect `pay` raw output before sharing.]\n";

/**
 * Canonical list of secret-bearing field names. Each entry is the
 * underscore-separated canonical form; the regex builder below makes
 * `_` and `-` interchangeable and `_` optional, so a single entry
 * `api_key` covers `api_key` / `apikey` / `api-key` automatically. Don't
 * add the visual variants here — they're already covered.
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

// `key: value` outside of JSON quoting. Excludes the `"key": ...` JSON shape
// and the `Authorization: Bearer X` header (handled below). Value runs to end
// of line; quoted values are matched as a unit so we replace just the inside.
const COLON_VALUE_RE = new RegExp(
  `(?<!")\\b(${KEY_PATTERN})(\\s*:\\s*)("[^"]*"|'[^']*'|[^\\r\\n]+)`,
  "gi",
);

// `"key": "value"` JSON entries. Matches the value (string, number, true/false).
const JSON_ENTRY_RE = new RegExp(
  `("(?:${KEY_PATTERN})"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|true|false|null|-?\\d+(?:\\.\\d+)?)`,
  "gi",
);

// `Authorization: Bearer <token>` HTTP header form. The COLON_VALUE_RE above
// already redacts `authorization: ...` lines, but a header on its own line of
// the form `Authorization: Bearer <token>` is so common that we keep the
// "Bearer" prefix human-readable and only replace the token after it.
const BEARER_RE = /\b(Bearer\s+)([A-Za-z0-9._\-+/=]+)/gi;

export function redactRawOutput(text: string): string {
  if (!text) return text;

  let out =
    text.length > MAX_REDACTOR_INPUT
      ? text.slice(0, MAX_REDACTOR_INPUT) + TRUNCATION_MARKER
      : text;

  // Order matters: handle JSON entries first so the COLON_VALUE_RE doesn't
  // also match inside JSON pairs (the negative-lookbehind keeps it off the
  // `"key":` portion, but if we ran COLON_VALUE_RE first, a value like
  // `"token": "abc123"` could be partially mangled).
  out = out.replace(JSON_ENTRY_RE, (_match, keyPart: string, value: string) => {
    if (value.startsWith('"')) return `${keyPart}"${PLACEHOLDER}"`;
    return `${keyPart}${PLACEHOLDER}`;
  });

  out = out.replace(ENV_RE, (_match, key: string, sep: string) => {
    return `${key}${sep}${PLACEHOLDER}`;
  });

  // Bearer headers BEFORE the generic colon rule. Otherwise the
  // `authorization: ...` clause in COLON_VALUE_RE would consume the entire
  // `Bearer <token>` value first, leaving the helpful `Bearer ` prefix
  // stripped from the receipt. Running BEARER_RE first replaces the token
  // alone; the COLON pass below then skips any value that already contains
  // the placeholder so the prefix survives.
  out = out.replace(BEARER_RE, (_match, prefix: string) => `${prefix}${PLACEHOLDER}`);

  out = out.replace(COLON_VALUE_RE, (match, key: string, sep: string, value: string) => {
    // Already-redacted values (e.g. `Authorization: Bearer ***REDACTED***`
    // from the BEARER pass above) are passed through verbatim — re-running
    // the colon rule on them would clobber the `Bearer ` prefix that we
    // intentionally preserved.
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
