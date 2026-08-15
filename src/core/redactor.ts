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
 * downstream consumer holding only bytes off disk detect that marker and
 * demote/exclude the artifact instead of trusting a partially-scanned
 * payload. A caller that RAN the scan reads truncation from
 * {@link scanRawOutput} instead - content is free to quote the marker,
 * so the text is not evidence about the scan that produced it.
 *
 * `redactStructured` is the tree form, used at the export boundary and by
 * every surface that hands a configuration mapping outside the vault. It
 * redacts each string leaf and replaces any value whose KEY NAME declares
 * a credential, because a serialised document cannot be scanned safely -
 * the `key: value` pass runs to end of line and would eat a closing JSON
 * quote - and because a bare token leaf carries no assignment shape for
 * the value passes to see.
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

/**
 * The single replacement token every redaction in this project emits.
 * Exported because it is now the ONE spelling: `src/core/config.ts` used
 * to carry a private `redactMapping` that wrote `[REDACTED]` instead,
 * matched five substrings against key names only, and never looked at a
 * value - three answers to "is this a secret" where there should be one.
 * That copy was collapsed into {@link redactStructured}, and its callers
 * onto this token.
 */
export const REDACTION_PLACEHOLDER = "***REDACTED***";

const PLACEHOLDER = REDACTION_PLACEHOLDER;

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

/**
 * Credential field-identifier fragments matched ONLY against a mapping's
 * key NAME, never against free text. `key` lives here rather than in
 * {@link SECRET_KEYS} because a bare `key: value` line in prose is not a
 * credential assignment and redacting every one of them would mangle
 * ordinary text, while a configuration entry whose identifier contains
 * `key` (`openai_key`, `keyfile`, `signing_key`) reliably is one. It is a
 * field identifier, not a prose word - the same class as every other
 * literal in this module.
 */
const SECRET_KEY_NAME_FRAGMENTS: ReadonlyArray<string> = ["key"];

/**
 * Matches anywhere inside an identifier, because configuration keys
 * compose (`telegram_bot_token`, `openrouter_api_key`).
 */
const SECRET_KEY_NAME_RE = new RegExp(
  `(?:${KEY_PATTERN}|${SECRET_KEY_NAME_FRAGMENTS.join("|")})`,
  "i",
);

/**
 * True when a mapping key's NAME declares its value to be a credential.
 * Takes `unknown` so a key read back off disk needs no pre-check.
 */
export function isSecretKeyName(name: unknown): boolean {
  return typeof name === "string" && SECRET_KEY_NAME_RE.test(name);
}

// `key=value` (env-style): value runs to whitespace or end of line.
const ENV_RE = new RegExp(`\\b(${KEY_PATTERN})(\\s*=\\s*)([^\\s\\r\\n]+)`, "gi");

// `key: value` outside of JSON quoting. Excludes the `"key": ...` JSON
// shape and the `Authorization: Bearer X` header (handled below).
//
// The separator is horizontal whitespace ONLY. With `\s*` it matched
// across a newline, so `password:\nnext_key: kept` read the FOLLOWING
// line as this key's value and deleted a key that was never a secret. A
// value on the next line is not a value; a value indented under the key
// is a block, and {@link YAML_SECRET_BLOCK_RE} owns that case.
const COLON_VALUE_RE = new RegExp(
  `(?<!")\\b(${KEY_PATTERN})([ \\t]*:[ \\t]*)("[^"]*"|'[^']*'|[^\\r\\n]+)`,
  "gi",
);

/**
 * A secret key whose value CONTINUES on more-indented lines: a block
 * scalar (`token: |`), a block list, or a nested mapping. The whole
 * continuation is replaced as one unit, because replacing the first line
 * alone orphans the rest - `token: |` became `token: ***REDACTED***`
 * followed by its still-readable indented block, and
 * `token:\n  - a\n  - b` became `token:\n  ***REDACTED***\n  - b`.
 *
 * The backreference pins the continuation to a deeper indent than the
 * key, so a following key at the same level is never swallowed. Every
 * quantifier is bounded to a single line, so the pass stays linear.
 */
const YAML_SECRET_BLOCK_RE = new RegExp(
  `^([ \\t]*)(${KEY_PATTERN})[ \\t]*:[ \\t]*(?:[|>][+-]?\\d{0,2})?[ \\t]*\\r?\\n` +
    "(?:\\1[ \\t]+[^\\r\\n]*\\r?\\n?)+",
  "gim",
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
// label is alphabetic, so this never collides with `ipv4:port`. A negative
// lookahead skips source-file extensions (`index.js:42`, `app.ts:128`) so
// diagnostics and stack frames are not mistaken for service endpoints when
// `redactInfra` runs over tool output (e.g. ArtifactStore.put).
const FQDN_PORT_SOURCE_EXTS =
  "js|ts|tsx|jsx|py|json|rs|go|java|rb|php|c|cc|cpp|cxx|h|hpp|css|scss|sass|less|" +
  "html|htm|xml|yaml|yml|toml|ini|cfg|md|markdown|sh|bash|sql|vue|svelte|gradle|" +
  "kt|swift|scala|clj|ex|exs|erl|elm|dart|lua|pl|pm|r|jl|tf|lock|map|txt|csv|log";
const FQDN_PORT_RE = new RegExp(
  "\\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+(?!(" +
    FQDN_PORT_SOURCE_EXTS +
    "):\\d)[a-zA-Z]{2,63}:\\d{1,5}\\b",
  "g",
);

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

// ----- Bare high-entropy token detector (opt-in via `redactTokens`) ---------
//
// Credential tokens passed as bare positional values carry no key=value
// shape for the assignment passes to latch onto (e.g. an argv like
// `["mytool", "sk-abc123"]`). Two complementary shapes are scrubbed:
// well-known vendor-prefixed keys, and long mixed-class runs that look
// like an API key or hash. Every quantifier is bounded, so the pass stays
// linear and cannot be driven into catastrophic backtracking.

/**
 * Vendor-prefixed credential tokens (OpenAI/Stripe `sk-`/`sk_`/`rk_`/`pk_`,
 * GitHub `ghp_`/`gho_`/…/`github_pat_`, Slack `xox?-`, AWS `AKIA…`, Google
 * `AIza…`, GitLab `glpat-`). The recognizable prefix is what lets a short
 * token like `sk-abc123` be caught without a length gate that would also
 * hit ordinary words.
 */
const VENDOR_TOKEN_RE = new RegExp(
  [
    "\\b(?:sk|rk|pk)[-_][A-Za-z0-9._-]{3,200}",
    "\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{6,255}",
    "\\bgithub_pat_[A-Za-z0-9_]{6,255}",
    "\\bxox[baprs]-[A-Za-z0-9-]{6,200}",
    "\\bAKIA[0-9A-Z]{16}\\b",
    "\\bAIza[0-9A-Za-z._-]{10,100}",
    "\\bglpat-[A-Za-z0-9_-]{6,100}",
  ].join("|"),
  "g",
);

/**
 * A long bare run that mixes letters and digits — the shape of an
 * unprefixed API key, session id, or hash. Length-gated (≥ 24) so ordinary
 * words and short ids are never touched, with bounded repetition so the
 * lookaheads stay linear.
 */
const HIGH_ENTROPY_TOKEN_RE =
  /\b(?=[A-Za-z0-9_-]{24,200}\b)(?=[A-Za-z0-9_-]{0,199}[A-Za-z])(?=[A-Za-z0-9_-]{0,199}\d)[A-Za-z0-9_-]{24,200}\b/g;

/**
 * A CONTENT ADDRESS: a hexadecimal run, optionally dash-grouped. Digests
 * (`sha256`, git object ids), canonical uuids and the hashed directory
 * names they end up in all have this shape, and all three are identifiers
 * a knowledge bundle has to carry unchanged - a wikilink target
 * `[[Brain/artifacts/<sha256>.json]]` that comes back as a placeholder is
 * a corrupted restore on the export/import round trip, not a mangled copy.
 *
 * Excluding the shape costs the high-entropy pass any credential that is
 * pure hexadecimal. That is the narrower risk: credentials in this
 * ecosystem carry a vendor prefix (caught by {@link VENDOR_TOKEN_RE}
 * regardless of alphabet) or mix alphabets beyond hexadecimal, while
 * content addresses are pervasive in every vault this exports.
 */
const CONTENT_ADDRESS_RE = /^[0-9a-fA-F]+(?:-[0-9a-fA-F]+)*$/;

function isContentAddress(run: string): boolean {
  return CONTENT_ADDRESS_RE.test(run);
}

/**
 * A base64 credential: the shape `HIGH_ENTROPY_TOKEN_RE` cannot see,
 * because its class excludes `+` and `/`. An AWS secret access key
 * (`wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY`) splits into sub-runs of
 * 13, 21 and 5 under that class - each below the 24-gate - so it passed
 * verbatim while its paired `AKIA…` id was caught, leaking the half that
 * matters.
 *
 * Narrow on purpose, because this class of run is also what long paths
 * and embedded blobs look like:
 *   - the MAXIMAL run is 32 to 64 characters (a blob runs to thousands
 *     and is left whole; a shorter run is not a credential);
 *   - it carries at least one `+`, `/` or `=`, since a pure-alphanumeric
 *     run is already {@link HIGH_ENTROPY_TOKEN_RE}'s job;
 *   - it mixes upper, lower and digit;
 *   - it neither starts nor ends with `/`, so a rooted path cannot match
 *     from its first character.
 *
 * What remains reachable is a long extension-less mixed-case path inside
 * prose - a `.`, `-` or `_` anywhere in it breaks the run - and at an
 * egress boundary that copy is recoverable where a leaked key is not.
 */
const BASE64_SECRET_RE = new RegExp(
  "(?<![A-Za-z0-9+/=])" +
    "(?=[A-Za-z0-9+/=]{32,64}(?![A-Za-z0-9+/=]))" +
    "(?=[A-Za-z0-9+/=]{0,63}[a-z])" +
    "(?=[A-Za-z0-9+/=]{0,63}[A-Z])" +
    "(?=[A-Za-z0-9+/=]{0,63}\\d)" +
    "(?=[A-Za-z0-9+/=]{0,63}[+/=])" +
    "[A-Za-z0-9+=][A-Za-z0-9+/=]{30,62}[A-Za-z0-9+=]",
  "g",
);

function redactBareTokens(text: string): string {
  return text
    .replace(VENDOR_TOKEN_RE, PLACEHOLDER)
    .replace(BASE64_SECRET_RE, PLACEHOLDER)
    .replace(HIGH_ENTROPY_TOKEN_RE, (run: string) => (isContentAddress(run) ? run : PLACEHOLDER));
}

/**
 * The credential half of the infra pass, split out so a caller can take
 * it WITHOUT the topology half. `user:pass@host` is a credential by any
 * reading; a bare public IP or an internal FQDN is topology. An export of
 * authored knowledge wants the first and not the second, because
 * redacting every `host:port` in a knowledge bundle mangles legitimate
 * references for a class of leak the operator already controls by
 * choosing the destination.
 */
function redactUrlCredentials(text: string): string {
  return text.replace(BASIC_AUTH_URL_RE, (_m, scheme: string) => `${scheme}${PLACEHOLDER}@`);
}

function redactInfraTopology(text: string): string {
  // Credentials first, so the host that follows is still available to the
  // host/port passes below - the order this pass has always run in.
  let out = redactUrlCredentials(text);
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

// ----- Keeping a redacted frontmatter block parseable -----------------------
//
// The placeholder opens with `*`, which YAML reads as an ALIAS node. A
// placeholder written unquoted into a mapping value therefore makes the
// whole block unparseable to Obsidian and to every spec-compliant reader -
// while this repository's own lenient parser accepts it, which is how the
// defect shipped. Any pass can put a placeholder there (the key-name rule,
// the bare-token pass), so the quoting is applied once at the end over the
// frontmatter block rather than at each producer.

const PLACEHOLDER_PATTERN = PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Leading `---` fenced block of a markdown document, captured in parts. */
const FRONTMATTER_BLOCK_RE = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/;

/** `key: ***REDACTED***…` at the start of a mapping value. */
const FRONTMATTER_SCALAR_RE = new RegExp(
  `^([ \\t]*[^\\s#][^:\\r\\n]*:[ \\t]*)(${PLACEHOLDER_PATTERN}[^\\r\\n]*)$`,
  "gm",
);

/** `- ***REDACTED***…` at the start of a block-list item. */
const FRONTMATTER_ITEM_RE = new RegExp(
  `^([ \\t]*-[ \\t]+)(${PLACEHOLDER_PATTERN}[^\\r\\n]*)$`,
  "gm",
);

/**
 * `[***REDACTED***]` - a placeholder as an item of a FLOW sequence or
 * mapping. `formatFrontmatter` writes lists inline, so `aliases:` comes
 * back as `[…]` and the two line-anchored rules above never see it. Same
 * alias node, same parse error, one position further in.
 */
const FRONTMATTER_FLOW_ITEM_RE = new RegExp(
  `([[{,][ \\t]*)(${PLACEHOLDER_PATTERN})(?=[ \\t]*[,\\]}])`,
  "g",
);

function quoteYamlScalar(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteRedactedFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  return text.replace(
    FRONTMATTER_BLOCK_RE,
    (_match, open: string, body: string, close: string) =>
      open +
      body
        .replace(FRONTMATTER_SCALAR_RE, (_m, prefix: string, value: string) =>
          value.startsWith('"') ? `${prefix}${value}` : `${prefix}${quoteYamlScalar(value)}`,
        )
        .replace(FRONTMATTER_ITEM_RE, (_m, prefix: string, value: string) =>
          value.startsWith('"') ? `${prefix}${value}` : `${prefix}${quoteYamlScalar(value)}`,
        )
        .replace(
          FRONTMATTER_FLOW_ITEM_RE,
          (_m, prefix: string, value: string) => `${prefix}${quoteYamlScalar(value)}`,
        ) +
      close,
  );
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
   * {@link MAX_REDACTOR_INPUT} (1 MiB) - the right cap for receipts,
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
  /**
   * When `true`, also scrub bare high-entropy credential tokens that carry
   * no key=value shape — vendor-prefixed keys (`sk-…`, `ghp_…`, `AKIA…`)
   * and long mixed letter+digit runs. Off by default (over-redacting prose
   * is worse than the narrow key/value passes). Enabled on the secret-exec
   * audit trail, whose long-lived log records a full argv that may carry a
   * foreign credential passed as a positional argument.
   */
  readonly redactTokens?: boolean;
  /**
   * When `true`, scrub credentials embedded in a URL authority
   * (`scheme://user:pass@host`) while leaving network topology alone.
   * Implied by {@link redactInfra}, which takes the whole infra pass.
   * The export boundary takes this half on its own: a URL password is a
   * credential, whereas a `host:port` in an authored note is a reference
   * a portable bundle has to keep.
   */
  readonly redactUrlCredentials?: boolean;
}

/**
 * A scan and what it could and could not see. `truncated` is a fact about
 * the SCAN - the input was longer than the window - and never a fact read
 * back off the output text. {@link wasScanTruncated} exists for a consumer
 * holding only bytes off disk; a caller that ran the scan itself must use
 * this, because a payload is free to quote the marker verbatim and a
 * substring test on the output would then let an oversized string report
 * itself as fully scanned.
 */
export interface RawScanResult {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * The scanning form of {@link redactRawOutput}, returning the redacted
 * text together with whether the scan window was exceeded. Every caller
 * that has to REFUSE on a partial scan (the egress guard, through
 * {@link redactStructured}) reads truncation from here.
 */
export function scanRawOutput(text: string, opts: RedactRawOutputOptions = {}): RawScanResult {
  if (!text) return { text, truncated: false };

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
  const truncated = out.length > maxInput;
  if (truncated) out = out.slice(0, maxInput) + SCAN_TRUNCATED_MARKER;

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

  // Indented continuations BEFORE the single-line rule: `token: |` has a
  // same-line value the colon rule would consume, leaving its block behind.
  out = out.replace(
    YAML_SECRET_BLOCK_RE,
    (_match, indent: string, key: string) => `${indent}${key}: "${PLACEHOLDER}"\n`,
  );

  out = out.replace(COLON_VALUE_RE, (match, key: string, sep: string, value: string) => {
    if (value.includes(PLACEHOLDER)) return match;
    if (value.startsWith('"') && value.endsWith('"')) {
      return `${key}${sep}"${PLACEHOLDER}"`;
    }
    if (value.startsWith("'") && value.endsWith("'")) {
      return `${key}${sep}'${PLACEHOLDER}'`;
    }
    // Quoted even when the source value was bare: the placeholder opens
    // with `*`, which YAML reads as an alias node, so an unquoted
    // replacement turns a valid mapping into a parse error.
    return `${key}${sep}"${PLACEHOLDER}"`;
  });

  // Infra-topology pass last: it runs on values the key/value passes
  // already left untouched (bare coordinates), and any value they redacted
  // is now a placeholder with no IP/host shape left to match.
  if (opts.redactTokens) out = redactBareTokens(out);

  if (opts.redactInfra) out = redactInfraTopology(out);
  else if (opts.redactUrlCredentials) out = redactUrlCredentials(out);

  // Last: a placeholder any pass above put into frontmatter value position
  // has to be quoted or the block stops parsing.
  out = quoteRedactedFrontmatter(out);

  return { text: out, truncated };
}

export function redactRawOutput(text: string, opts: RedactRawOutputOptions = {}): string {
  return scanRawOutput(text, opts).text;
}

// ----- Identifiers, which are checked rather than rewritten ----------------
//
// A payload can be replaced: the vault still holds the original and the
// copy is merely poorer. An IDENTIFIER cannot. Redacting a filename merges
// the pages it names (three notes collapsed onto `concepts/***REDACTED***`,
// two bodies destroyed); redacting a mapping key renames a field; redacting
// a path segment hands a support person a path that does not exist. So an
// identifier is scanned and REPORTED, never rewritten - and a caller at a
// trust boundary decides what a report is worth.

/**
 * Key names whose value NAMES something rather than carrying content.
 * Matched on the last underscore/dash-separated segment, because
 * identifier keys compose (`bundle_path`, `session_id`, `config_path`).
 */
const IDENTIFIER_KEY_RE =
  /(^|[_-])(id|ids|uuid|uuids|guid|path|paths|slug|slugs|filename|filenames|basename)$/i;

/** True when a mapping key declares its value to be an identity. */
export function isIdentifierKeyName(name: unknown): boolean {
  return typeof name === "string" && IDENTIFIER_KEY_RE.test(name);
}

/** Rooted path forms, where internal whitespace is still a path. */
const PATH_ANCHOR_RE = /^(?:[/\\]|~[/\\]|\.{1,2}[/\\]|[A-Za-z]:[/\\])/;

/**
 * True when a whole string leaf is a filesystem path. A URL authority is
 * deliberately excluded (`://`, `@`): `scheme://user:pass@host` is a
 * credential the url-credential pass must still reach.
 */
export function isPathLikeValue(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  if (value.includes("@") || value.includes("://")) return false;
  if (!value.includes("/") && !value.includes("\\")) return false;
  return PATH_ANCHOR_RE.test(value) || !/\s/.test(value);
}

/** Non-global copy: `.test` on a `/g` regex carries `lastIndex` between calls. */
const VENDOR_TOKEN_TEST_RE = new RegExp(VENDOR_TOKEN_RE.source);

/**
 * Does an identifier VALUE carry a credential? Vendor prefixes only. A
 * long mixed run is a guess, which is the right trade for a payload and
 * the wrong one for an identity: record ids, slugs and build ids are long
 * mixed runs BY CONSTRUCTION (`ctn_20260815120000_a1b2c3d4e5f6a7b8`), and
 * refusing every export that contains one would refuse every export.
 */
function identifierCarriesSecret(value: string): boolean {
  return VENDOR_TOKEN_TEST_RE.test(value);
}

/**
 * Does a mapping KEY carry a credential? The full detector set, because a
 * key name is authored vocabulary rather than a generated identity: a
 * 24-character mixed run in key position is anomalous where the same run
 * in an id is ordinary. The OKF manifest's `producer_meta` is built from a
 * page's `x-*` frontmatter keys, which is how a token reaches this
 * position at all.
 */
function keyNameCarriesSecret(name: string): boolean {
  if (identifierCarriesSecret(name)) return true;
  for (const match of name.matchAll(HIGH_ENTROPY_TOKEN_RE)) {
    if (!isContentAddress(match[0])) return true;
  }
  return false;
}

/** Bound on the reported list, so a refusal message stays readable. */
const MAX_REPORTED_IDENTIFIERS = 12;

// ----- Structured (mapping / tree) redaction --------------------------------

/**
 * Outcome of {@link redactStructured}: the transformed value plus the two
 * facts a caller at a trust boundary has to act on.
 */
export interface StructuredRedaction {
  /** The redacted value. Same shape as the input. */
  readonly value: unknown;
  /** True when any leaf changed - nothing was silently altered. */
  readonly redacted: boolean;
  /**
   * True when some string was larger than the scan window, so only its
   * prefix was examined. The value is NOT clean and NOT provably dirty;
   * a caller about to hand it outside must refuse rather than report
   * success. {@link wasScanTruncated} is the underlying reader.
   */
  readonly truncated: boolean;
  /**
   * Tree locations (`manifest.pages[2].bundle_path`, `producer_meta#0`)
   * where an IDENTIFIER is secret-shaped. Each one was left verbatim -
   * rewriting it would merge or rename what it identifies - so a caller
   * handing these bytes outside must act on this list rather than assume
   * the value is clean. Locations only: the identifier itself is the
   * secret, and echoing it into a message would leak what the refusal is
   * refusing to write.
   */
  readonly secretIdentifiers: ReadonlyArray<string>;
}

/** Walked as data; anything else (Date, Map, class instance) passes through. */
function isPlainContainer(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Redact a JSON-shaped value tree: every string leaf through
 * {@link redactRawOutput}, and every value whose KEY NAME declares a
 * credential ({@link isSecretKeyName}) replaced whole.
 *
 * This exists because redacting a SERIALISED document is unsafe. The
 * `key: value` pass consumes to end of line, so a note body reading
 * `my token: abc` inside a pretty-printed JSON string would lose the
 * closing quote and the document would stop parsing. Redacting the tree
 * and serialising afterwards has neither problem, and it is also the only
 * way the key-name rule can fire at all - a bare `sk-…` leaf carries no
 * assignment shape for the value passes to latch onto.
 *
 * `null` and `undefined` under a credential key are left alone on
 * purpose: absence is not a secret, and stamping a placeholder over it
 * would report a credential that is not configured as one that is.
 */
export function redactStructured(
  input: unknown,
  opts: RedactRawOutputOptions = {},
): StructuredRedaction {
  let redacted = false;
  let truncated = false;
  const secretIdentifiers = new Set<string>();

  const record = (location: string): void => {
    if (secretIdentifiers.size < MAX_REPORTED_IDENTIFIERS) secretIdentifiers.add(location);
  };

  const walk = (
    value: unknown,
    location: string,
    underSecretKey: boolean,
    underIdentifierKey: boolean,
  ): unknown => {
    if (underSecretKey) {
      if (value === null || value === undefined) return value;
      redacted = true;
      return PLACEHOLDER;
    }
    if (typeof value === "string" && (underIdentifierKey || isPathLikeValue(value))) {
      // Checked, never collapsed: see the identifier section above.
      if (identifierCarriesSecret(value)) record(location);
      // One exception, and it is not a collapse: a `user:pass@host`
      // authority is not part of what an identifier identifies. Stripping
      // it leaves the identifier pointing at the same resource, where
      // replacing the identifier would point it at nothing. Without this,
      // a URL under a key named `source_path` would be exempt from the
      // credential pass that catches the same URL one key over.
      const cleaned =
        opts.redactInfra === true || opts.redactUrlCredentials === true
          ? redactUrlCredentials(value)
          : value;
      if (cleaned !== value) redacted = true;
      return cleaned;
    }
    if (typeof value === "string") {
      // Truncation comes from the scan, never from a substring test on the
      // output: a leaf is free to quote the marker verbatim, and reading
      // the answer back out of the text let such a leaf release at any
      // size with its unscanned tail silently dropped.
      const scan = scanRawOutput(value, opts);
      if (scan.text !== value) redacted = true;
      if (scan.truncated) truncated = true;
      return scan.text;
    }
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        walk(item, `${location}[${index}]`, false, underIdentifierKey),
      );
    }
    if (typeof value === "object" && value !== null) {
      if (!isPlainContainer(value)) return value;
      const out: Record<string, unknown> = {};
      let index = 0;
      for (const [key, child] of Object.entries(value)) {
        // The key is reported by POSITION, never by name: the name is the
        // secret in this case.
        if (keyNameCarriesSecret(key)) record(`${location === "" ? "" : location}#${index}`);
        const childLocation = location === "" ? key : `${location}.${key}`;
        out[key] = walk(child, childLocation, isSecretKeyName(key), isIdentifierKeyName(key));
        index += 1;
      }
      return out;
    }
    return value;
  };

  return {
    value: walk(input, "", false, false),
    redacted,
    truncated,
    secretIdentifiers: Object.freeze([...secretIdentifiers].toSorted()),
  };
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
