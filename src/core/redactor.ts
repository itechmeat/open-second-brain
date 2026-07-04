/**
 * Best-effort secret redactor + text-field normaliser shared across
 * the Brain writers.
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
 * An optional infra-topology pass (`redactInfra`) additionally scrubs
 * bare network coordinates that carry no `key=value` shape — public
 * IPv4/IPv6 literals, `user:pass@host` URL credentials, `host:port`
 * endpoints, and internal hostnames. It is off by default (the key/value
 * passes suffice for receipts) and enabled on the artifact store, which
 * persists full tool payloads where a bare IP or internal FQDN is the
 * most common topology leak. Every infra regex is bounded (no nested
 * unbounded quantifiers), so the pass stays linear on large inputs.
 *
 * Oversized input FAILS CLOSED: rather than silently dropping the tail
 * past the scan window as if it were clean, {@link redactRawOutput}
 * appends {@link SCAN_TRUNCATED_MARKER}. {@link wasScanTruncated} lets a
 * downstream consumer detect that marker and demote/exclude the artifact
 * instead of trusting a partially-scanned payload.
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
 * Maximum input size scanned by `redactRawOutput`. Receipts have no
 * legitimate reason to embed multi-megabyte payloads — a runaway pipe
 * of server logs is the realistic cause of an oversize input. The
 * regex pipeline is linear, so the window is a DoS bound rather than a
 * correctness limit; 1 MiB is wide enough that a secret rarely lands
 * past it, and anything that does trips the fail-closed marker below
 * rather than being dropped as if it were clean.
 */
export const MAX_REDACTOR_INPUT = 1024 * 1024;

/**
 * Stable, machine-detectable token embedded in {@link SCAN_TRUNCATED_MARKER}.
 * {@link wasScanTruncated} matches on this so downstream consumers can
 * demote/exclude a partially-scanned artifact without parsing prose.
 */
const SCAN_TRUNCATED_TOKEN = "***SCAN_TRUNCATED***";

/**
 * Appended when input exceeds the scan window. The tail past the window
 * is dropped *and* flagged: because it was never scanned, the whole
 * payload must be treated as unverified rather than clean.
 */
export const SCAN_TRUNCATED_MARKER =
  `\n\n${SCAN_TRUNCATED_TOKEN} [redactor scan window exceeded (> 1 MiB); the unscanned tail was dropped. ` +
  `This payload was only partially scanned — treat it as unverified and inspect the raw source before sharing.]\n`;

/**
 * True when `text` carries the fail-closed marker appended by
 * {@link redactRawOutput} on oversized input. Consumers use this to
 * demote or exclude an artifact that could not be fully scanned instead
 * of trusting the redactor's output as complete.
 */
export function wasScanTruncated(text: string): boolean {
  return typeof text === "string" && text.includes(SCAN_TRUNCATED_TOKEN);
}

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

// ----- Infra-topology detectors (opt-in via `redactInfra`) ------------------
//
// These scrub network coordinates that carry no key=value shape, so the
// assignment passes above never see them. Every regex uses only bounded
// repetition ({m,n}) — no nested unbounded quantifiers — so the pass is
// linear and cannot be driven into catastrophic backtracking (ReDoS) by
// a large adversarial input.

/** A single dotted-quad octet (0-255), used to compose IPv4 patterns. */
const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
/** A syntactically-valid IPv4 literal (four octets). */
const IPV4 = `${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}`;

// `scheme://user:pass@host` — strip the embedded credentials but keep the
// scheme and `@host` for readability. Run first so the host that follows
// is still available to the host/port passes below.
const BASIC_AUTH_URL_RE = /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/g;

// `ipv4:port` — a reachable service endpoint. Redacted whole regardless of
// whether the address is public or private (the port is what leaks the
// service). Runs before the bare-IPv4 pass so the port form is caught first.
const IPV4_PORT_RE = new RegExp(`\\b${IPV4}:\\d{1,5}\\b`, "g");

// `fqdn:port` — a named service endpoint (`db.example.com:5432`). The final
// label is alphabetic, so this never collides with `ipv4:port`.
const FQDN_PORT_RE =
  /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}:\d{1,5}\b/g;

// Internal hostnames — FQDNs under a private/self-hosted suffix
// (`db.internal`, `svc.cluster.local`, `host.corp`, …). These reveal
// internal topology even without a port.
const INTERNAL_HOST_RE =
  /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+(?:internal|intranet|localdomain|local|lan|corp|home)\b/gi;

// Bare IPv6 literals: either a full 8-group address or any `::`-compressed
// form. Requiring `::` or 8 groups keeps `HH:MM:SS`-style timestamps (only
// two colons, no `::`) from being mistaken for an address. Every quantifier
// is bounded.
const IPV6_RE = new RegExp(
  "(?<![\\w:.])(?:" +
    // full 8 groups
    "(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}" +
    "|" +
    // `::`-compressed with leading groups (e.g. 2001:db8::1, fe80::)
    "(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{0,4}" +
    "|" +
    // leading `::` (e.g. ::1, ::ffff:1.2.3.4-style prefix)
    "::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}" +
    ")(?![\\w:.])",
  "g",
);

// Bare IPv4 literal not part of a longer dotted run (excludes version
// strings like `1.2.3.4.5` and `v1.2.3`). Public-only: the callback skips
// private/reserved ranges.
const IPV4_BARE_RE = new RegExp(`(?<![\\w.])${IPV4}(?![\\w.])`, "g");

/** RFC 1918 / loopback / link-local / CGNAT / multicast+reserved IPv4. */
function isPrivateOrReservedIPv4(ip: string): boolean {
  const octets = ip.split(".");
  const a = Number.parseInt(octets[0] ?? "", 10);
  const b = Number.parseInt(octets[1] ?? "", 10);
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast + reserved (224+)
  return false;
}

/** Loopback / unspecified / link-local (fe80::/10) / unique-local (fc00::/7). */
function isPrivateOrReservedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (/^fe[89ab]/.test(lower)) return true; // link-local
  if (/^f[cd]/.test(lower)) return true; // unique-local
  return false;
}

function redactInfraTopology(text: string): string {
  let out = text.replace(BASIC_AUTH_URL_RE, (_m, scheme: string) => `${scheme}${PLACEHOLDER}@`);
  out = out.replace(IPV4_PORT_RE, PLACEHOLDER);
  out = out.replace(FQDN_PORT_RE, PLACEHOLDER);
  out = out.replace(INTERNAL_HOST_RE, PLACEHOLDER);
  out = out.replace(IPV6_RE, (match: string) =>
    isPrivateOrReservedIPv6(match) ? match : PLACEHOLDER,
  );
  out = out.replace(IPV4_BARE_RE, (match: string) =>
    isPrivateOrReservedIPv4(match) ? match : PLACEHOLDER,
  );
  return out;
}

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
  /**
   * Known secret values to scrub verbatim (write-time-integrity-
   * governance, secret custody): every literal occurrence is replaced
   * before the pattern passes run, so a credential injected into a
   * subprocess env can never travel back through captured output even
   * when no key=value shape surrounds it.
   */
  readonly literals?: ReadonlyArray<string>;
  /**
   * When `true`, also run the infra-topology pass (public IPv4/IPv6,
   * `user:pass@host` URL credentials, `host:port` endpoints, internal
   * hostnames). Off by default — the key/value passes suffice for
   * receipts, and blanket IP/host redaction would mangle legitimate
   * prose. Enabled on the artifact store, whose full tool payloads are
   * where a bare coordinate is the likeliest topology leak.
   */
  readonly redactInfra?: boolean;
}

export function redactRawOutput(text: string, opts: RedactRawOutputOptions = {}): string {
  if (!text) return text;

  // Scrub known literals BEFORE the truncation guard: a secret value
  // straddling the cut boundary must not survive as a partial
  // fragment in the kept prefix.
  let out = text;
  for (const literal of opts.literals ?? []) {
    if (literal.length === 0) continue;
    out = out.split(literal).join(PLACEHOLDER);
  }

  // Fail closed on oversized input: scan the prefix that fits the window,
  // drop the unscanned tail, and flag the result so a downstream consumer
  // treats it as unverified rather than trusting it as fully scanned.
  const maxInput = opts.maxInput ?? MAX_REDACTOR_INPUT;
  if (out.length > maxInput) out = out.slice(0, maxInput) + SCAN_TRUNCATED_MARKER;

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

  // Infra-topology pass last: it runs on values the key/value passes
  // already left untouched (bare coordinates), and any value they redacted
  // is now a placeholder with no IP/host shape left to match.
  if (opts.redactInfra) out = redactInfraTopology(out);

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
