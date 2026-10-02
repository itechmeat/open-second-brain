/**
 * Best-effort secret redactor + text-field normaliser shared across
 * the Brain writers.
 *
 * The redactor catches six secret-bearing keys in four assignment
 * shapes:
 *
 *   key=value                     env-style assignments, including a
 *                                 prefixed name (`ANTHROPIC_API_KEY=…`)
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
 * Stable, machine-detectable sentinel embedded in {@link SCAN_TRUNCATED_MARKER}.
 * {@link wasScanTruncated} matches on this so downstream consumers can
 * demote/exclude a partially-scanned artifact without parsing prose.
 */
const SCAN_TRUNCATED_SENTINEL = "***SCAN_TRUNCATED***";

/**
 * Appended when input exceeds the scan window. The tail past the window
 * is dropped *and* flagged: because it was never scanned, the whole
 * payload must be treated as unverified rather than clean.
 */
export const SCAN_TRUNCATED_MARKER =
  `\n\n${SCAN_TRUNCATED_SENTINEL} [redactor scan window exceeded (> 1 MiB); the unscanned tail was dropped. ` +
  `This payload was only partially scanned — treat it as unverified and inspect the raw source before sharing.]\n`;

/**
 * True when `text` carries the fail-closed marker appended by
 * {@link redactRawOutput} on oversized input. Consumers use this to
 * demote or exclude an artifact that could not be fully scanned instead
 * of trusting the redactor's output as complete.
 */
export function wasScanTruncated(text: string): boolean {
  return typeof text === "string" && text.includes(SCAN_TRUNCATED_SENTINEL);
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
//
// The key may be the SUFFIX of a longer identifier, and the boundary here
// has to say so explicitly. `\b` was what stood in this position, and `_`
// is a word character, so the boundary never fired after one:
// `export ANTHROPIC_API_KEY=…` and `MY_DB_PASSWORD=…` - the single most
// common shape a credential takes in a shell line, a `.env` file or an
// agent transcript - both passed through this pass untouched while the
// unprefixed `API_KEY=…` was caught. What still came out redacted in the
// common cases came out that way through the vendor-prefix rule on the
// VALUE (`sk-…`, `ghp_…`), not through this key-name pass, so a
// non-vendor secret under a prefixed name left verbatim.
//
// `(?<![A-Za-z0-9])` is the replacement: the key may begin at the start of
// the identifier or immediately after a `_` / `-` separator, which is how
// a prefixed environment variable is spelled, and nowhere else. It stays
// deliberately narrow at both ends. `--max-tokens=4096` keeps its value,
// because `token` there is followed by `s` rather than by the assignment.
// `MYTOKEN=…` also keeps its value, because `TOKEN` starts mid-identifier
// with no separator in front of it - the same under-match `\b` already
// had, left in place rather than widened into every word that happens to
// end in a secret name.
const ENV_RE = new RegExp(`(?<![A-Za-z0-9])(${KEY_PATTERN})(\\s*=\\s*)([^\\s\\r\\n]+)`, "gi");

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

// A bare JSON Web Token: three base64url segments joined by dots. The
// shape carries no key=value assignment for the passes above and no
// vendor prefix for the token pass, and the canonical 20-character
// header slips HIGH_ENTROPY_TOKEN_RE's 24-character gate - so under the
// token pass the payload and signature were eaten while the header
// stayed, announcing a credential and naming its algorithm. Default-on:
// a JWT is a bearer credential wherever it appears, not only where a
// key names it.
//
// The header prefix anchors the match, while matching any three
// dot-separated base64url runs would also claim ordinary dotted
// identifiers. A compact header `{"` encodes to `eyJ`; a header written
// with whitespace after the brace encodes to `eyA` (`{ `), `ewo` (`{\n`),
// `ew0` (`{\r`) or `ewk` (`{\t`), so all five open the match. The header
// segment must be at least 12 characters in total (a real header is far
// longer), which keeps short dotted words such as `ewok.a.b` prose.
// Segments are bounded (64 KiB each, room for a large claims payload),
// so the pass stays linear on large inputs.
const JWT_RE =
  /\b(?:eyJ|eyA|ewo|ew0|ewk)[A-Za-z0-9_-]{9,65533}(?:\.[A-Za-z0-9_-]{4,65536}){2}(?![A-Za-z0-9_-])/g;

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
//
// The password class is `[^\s@]+`, not `[^\s/@]+`: a generated database
// password routinely carries `/`, and with the old class the regex failed
// the match ENTIRELY - both the user and the password left verbatim, a
// wider leak than if the pass had never run. The username may be EMPTY -
// a password-only authority is a spelling connection strings really use
// (`scheme://:pass@host`) - while the colon between the halves stays
// mandatory and adjacent, so a URL whose path carries an `@` but no
// userinfo colon is untouched. Every class still cannot cross whitespace,
// the `://` scheme anchor and the `@` anchor are kept. The anchors alone do
// not keep the pass linear: a run that never meets its terminator is
// rescanned from every word boundary, which is quadratic on a long line of
// `a://b:` or `a.` repeats. Each run therefore has a length bound (scheme
// 32, user 256, password 4096 characters), so a start position costs at
// most a fixed number of steps; a password longer than the bound is not
// recognised by this pass.
//
// Because the password class crosses `/`, a `host:port/path@x` URL would
// read the port colon as the userinfo colon and swallow the host, the port
// and half the path (`http://localhost:5173/@vite/client`). The lookahead
// rejects a colon followed by 1-5 digits and then `/`: that is a port and a
// path, not a password. Two accepted trade-offs, both as on main: a slash
// password that begins with 1-5 digits (`bob:8080/x@host`) is missed, and a
// query or fragment directly after a port with an `@` in it
// (`example.com:443?x@y`) is still read as userinfo - far rarer than a
// password such as `123?secret`, which this keeps redacted.
const BASIC_AUTH_URL_RE =
  /\b([a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/)([^\s/:@]{0,256}):(?!\d{1,5}\/)([^\s@]{1,4096})@/g;

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
 * A SIGNAL ID: `sig-<YYYY-MM-DD>-<slug>`, the filename and frontmatter
 * `id` every taste signal in a Brain vault carries, and the target every
 * preference's `_evidenced_by` wikilink points at. The same carve-out
 * argument as {@link CONTENT_ADDRESS_RE}, arriving through a second
 * shape: 26 characters of `[A-Za-z0-9_-]` mixing letters and digits, not
 * pure hexadecimal, so `HIGH_ENTROPY_TOKEN_RE` claimed it. A slug of nine
 * characters is enough to cross the gate, which is routine, so an export
 * shipped `_evidenced_by: ["[[***REDACTED***]]"]` and the import wrote
 * that back verbatim - reporting a full success while every preference
 * that lost a signal id landed on ONE dangling wikilink. A placeholder is
 * a constant, so replacing an identifier merges the things it identified.
 *
 * The carve-out is the SHAPE, not the prefix: an ISO date, then lowercase
 * alphanumeric runs joined by dashes, which is exactly what `slugify`
 * emits plus the `-<n>` collision suffix `allocateAndCreate` appends. A
 * credential wearing a `sig-` prefix is still redacted whenever it fails
 * either half - no ISO date, or the mixed case, underscore or other
 * punctuation a slug cannot carry - which covers every credential format
 * this redactor was written against.
 *
 * It is not an absolute, and the earlier wording here said it was. A
 * secret that is entirely lowercase alphanumeric AND is written behind
 * `sig-` AND behind an ISO date passes: `sig-2026-08-16-<secret>` is
 * indistinguishable from a signal id whose slug happens to be that
 * string, because at that point it IS one by shape. Nothing narrower
 * would do without keying on the prefix, which is what the paragraph
 * above rejects - and a key wearing three disguises to reach a Brain
 * signal filename is a different threat from the one this pass is for.
 */
const SIGNAL_ID_RE = /^sig-\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isSignalId(run: string): boolean {
  return SIGNAL_ID_RE.test(run);
}

/**
 * True when a high-entropy run is an IDENTIFIER this boundary must hand
 * through unchanged rather than a payload it may replace. One predicate
 * so the two passes that ask the question - the bare-token replacer and
 * the identifier scan - cannot drift into disagreeing about what an
 * identifier is.
 */
function isPreservedIdentifier(run: string): boolean {
  return isContentAddress(run) || isSignalId(run);
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
    .replace(HIGH_ENTROPY_TOKEN_RE, (run: string) =>
      isPreservedIdentifier(run) ? run : PLACEHOLDER,
    );
}

/**
 * The credential half of the infra pass, split out so a caller can take
 * it WITHOUT the topology half. `user:pass@host` is a credential by any
 * reading; a bare public IP or an internal FQDN is topology. An export of
 * authored knowledge wants the first and not the second, because
 * redacting every `host:port` in a knowledge bundle mangles legitimate
 * references for a class of leak the operator already controls by
 * choosing the destination.
 *
 * Also the first step of {@link redactSpecifierCredentials}.
 */
function redactUrlCredentials(text: string): string {
  return text.replace(BASIC_AUTH_URL_RE, (_m, scheme: string) => `${scheme}${PLACEHOLDER}@`);
}

/**
 * Query parameter keys whose value is a credential in a module source or
 * import specifier: the Terraform git getter's `sshkey`, S3 and GCS
 * signing and access-key parameters, and the generic token, password and
 * signature names. Matched without regard to case.
 */
export const CREDENTIAL_QUERY_KEYS: ReadonlyArray<string> = Object.freeze([
  "sshkey",
  "token",
  "access_token",
  "password",
  "secret",
  "signature",
  "sig",
  "key",
  "aws_access_key_id",
  "aws_access_key_secret",
  "aws_secret_access_key",
  "aws_access_token",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "x-goog-signature",
  "x-goog-credential",
]);

const CREDENTIAL_QUERY_KEY_SET: ReadonlySet<string> = new Set(CREDENTIAL_QUERY_KEYS);

/** A Terraform go-getter forcing prefix (`git::`, `s3::`, `gcs::`), kept as written. */
const GETTER_PREFIX_RE = /^[a-z0-9]+::/i;

/** Schemes whose userinfo has no conventional login: a bare user there is a token. */
const TOKEN_USERINFO_SCHEMES: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "git+http:",
  "git+https:",
]);

/**
 * A user name that reads as a login (`git`, `deploy`) rather than a token;
 * kept on the schemes where a bare login is conventional (`ssh://git@`).
 */
const PLAUSIBLE_LOGIN_RE = /^[a-z_][a-z0-9._-]{0,31}$/;

function decodedKey(raw: string): string {
  try {
    return decodeURIComponent(raw.replaceAll("+", " ")).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/** `search` with the value of every credential key replaced, or null when none matched. */
function redactCredentialQuery(search: string): string | null {
  if (search.length <= 1) return null;
  let changed = false;
  const pairs = search
    .slice(1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0 || !CREDENTIAL_QUERY_KEY_SET.has(decodedKey(pair.slice(0, eq)))) return pair;
      changed = true;
      return `${pair.slice(0, eq + 1)}${PLACEHOLDER}`;
    });
  return changed ? `?${pairs.join("&")}` : null;
}

/**
 * The credential query pass for a specifier the URL parser refuses (the
 * scp-like `git@host:org/repo?sshkey=...` form, a host without a scheme):
 * the text between the first `?` and the first `#` after it is read as the
 * query.
 */
function redactUnparsedQuery(specifier: string): string {
  const start = specifier.indexOf("?");
  if (start < 0) return specifier;
  const hash = specifier.indexOf("#", start);
  const end = hash < 0 ? specifier.length : hash;
  const search = redactCredentialQuery(specifier.slice(start, end));
  return search === null
    ? specifier
    : `${specifier.slice(0, start)}${search}${specifier.slice(end)}`;
}

/**
 * The credential pass for a module source or import specifier. Covered:
 * the `user:password@` pair of any scheme ({@link redactUrlCredentials}),
 * a password containing `@`, a bare userinfo of an http(s) or git+http(s) URL (a token,
 * with or without a go-getter prefix such as `git::`), a userinfo of any
 * other scheme that does not read as a login (`ssh://git@` is kept), and
 * the value of every {@link CREDENTIAL_QUERY_KEYS} parameter. A specifier
 * that does not parse as a URL gets the `user:password@` pass and the
 * query pass ({@link redactUnparsedQuery}), not the bare-userinfo one; a
 * credential in a path segment, a fragment or an unnamed query key is not
 * recognised. A specifier with nothing to redact is returned
 * byte-identical; a redacted one is re-serialised by the URL parser.
 */
export function redactSpecifierCredentials(specifier: string): string {
  const basic = redactUrlCredentials(specifier);
  const prefix = GETTER_PREFIX_RE.exec(basic)?.[0] ?? "";
  let url: URL;
  try {
    url = new URL(basic.slice(prefix.length));
  } catch {
    return redactUnparsedQuery(basic);
  }
  let changed = false;
  if (url.password !== "") {
    url.username = PLACEHOLDER;
    url.password = "";
    changed = true;
  } else if (
    url.username !== "" &&
    url.username !== PLACEHOLDER &&
    (TOKEN_USERINFO_SCHEMES.has(url.protocol) || !PLAUSIBLE_LOGIN_RE.test(url.username))
  ) {
    url.username = PLACEHOLDER;
    changed = true;
  }
  const search = redactCredentialQuery(url.search);
  if (search !== null) {
    url.search = search;
    changed = true;
  }
  return changed ? `${prefix}${url.href}` : basic;
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

/**
 * The text of every outermost `<private>` region in `text`, tags included,
 * using the same nesting rule as {@link stripPrivateRegions}. An unclosed
 * region runs to the end of the text. A caller holding only a slice of a
 * page (a search chunk) uses this over the whole page to tell whether the
 * slice carries private text whose tags fell outside the slice.
 */
export function privateRegionTexts(text: string): string[] {
  const regions: string[] = [];
  if (!text) return regions;
  const open = new RegExp(PRIVATE_OPEN_TAG_RE.source, "gi");
  const close = new RegExp(PRIVATE_CLOSE_TAG_RE.source, "gi");
  let cursor = 0;
  while (cursor < text.length) {
    open.lastIndex = cursor;
    const openMatch = open.exec(text);
    if (!openMatch) break;
    const start = openMatch.index;
    let depth = 1;
    let scan = open.lastIndex;
    while (depth > 0) {
      open.lastIndex = scan;
      close.lastIndex = scan;
      const nextOpen = open.exec(text);
      const nextClose = close.exec(text);
      if (!nextClose) {
        regions.push(text.slice(start));
        return regions;
      }
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth += 1;
        scan = open.lastIndex;
      } else {
        depth -= 1;
        scan = close.lastIndex;
      }
    }
    regions.push(text.slice(start, scan));
    cursor = scan;
  }
  return regions;
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

  // Bare JWTs BEFORE the opt-in passes: the token pass would eat only the
  // payload and signature segments (the header slips the entropy gate) and
  // leave a half-standing credential, and the URL pass must see a
  // JWT-in-a-password already collapsed.
  out = out.replace(JWT_RE, PLACEHOLDER);

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
 * The FULL detector set applied to one string: a vendor prefix anywhere in
 * it, or a high-entropy run that is not one of the identifier shapes this
 * boundary hands through unchanged.
 *
 * One predicate rather than two copies, because the two positions that ask
 * for it - a mapping key name, and an identifier a foreign runtime named -
 * are asking the same question and must not drift into answering it
 * differently.
 */
function carriesBareCredential(value: string): boolean {
  if (identifierCarriesSecret(value)) return true;
  for (const match of value.matchAll(HIGH_ENTROPY_TOKEN_RE)) {
    if (!isPreservedIdentifier(match[0])) return true;
  }
  return false;
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
  return carriesBareCredential(name);
}

/**
 * Does an identifier VALUE that a FOREIGN runtime named carry a
 * credential? The full detector set again, and the reason is that
 * {@link identifierCarriesSecret}'s narrowing does not reach here.
 *
 * That narrowing - vendor prefixes only, because "record ids, slugs and
 * build ids are long mixed runs BY CONSTRUCTION" - is an argument about
 * identities THIS vault generates, whose construction this code knows.
 * `session_id` and `turn_id` on a transcript record are neither: they are
 * a foreign harness's filename and a foreign harness's turn uuid, and
 * nothing in this build constrains their shape. A bare high-entropy run
 * in one of them is therefore not "an id by construction", it is an
 * unexplained secret-shaped string, and treating it as the former let a
 * transcript named `Xk7Qp2Rm9Wz4Tn6Yb8Vc3Ld5.jsonl` export verbatim under
 * exit 0 while its vendor-prefixed sibling refused the whole run.
 *
 * Opt-in ({@link RedactStructuredOptions.foreignIdentifiers}) rather than
 * the default, because the narrowing is still correct everywhere the
 * identifiers ARE vault-authored: turning this on for the preference and
 * OKF exports would refuse them over their own content addresses and
 * container ids.
 */
function foreignIdentifierCarriesSecret(value: string): boolean {
  return carriesBareCredential(value);
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

/**
 * {@link redactStructured}'s options: the raw-scan policy every string leaf
 * is scanned under, plus the one decision that only exists for a tree.
 */
export interface RedactStructuredOptions extends RedactRawOutputOptions {
  /**
   * When `true`, an IDENTIFIER value is judged by the full bare-token
   * detector ({@link foreignIdentifierCarriesSecret}) instead of by vendor
   * prefixes alone. Off by default, and set only by a boundary whose
   * identifiers were named OUTSIDE this vault - the transcript corpus,
   * whose `session_id` is a foreign harness's filename and whose `turn_id`
   * is its turn uuid. See {@link foreignIdentifierCarriesSecret} for why
   * the default narrowing is right everywhere else.
   */
  readonly foreignIdentifiers?: boolean;
}

/** Walked as data; anything else (Date, Map, class instance) passes through. */
function isPlainContainer(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * True for the sibling-pair shape configuration formats use for
 * environment entries: `{ name: "DB_PASSWORD", value: … }`. The credential
 * NAME sits in a SIBLING member, so the key-name rule - which reads only
 * the CURRENT key, and here sees `value`, which says nothing - never
 * fires, and a literal secret rode past the walk untouched.
 *
 * The matcher is the same {@link isSecretKeyName} the object branch
 * applies to a key; no new secret-name vocabulary. An entry without a
 * literal `value` member - the ECS `valueFrom` reference shape - is not a
 * literal secret and stays with the normal walk.
 */
function siblingPairDeclaresSecret(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  if (!isPlainContainer(item)) return false;
  const record = item as Record<string, unknown>;
  return "value" in record && isSecretKeyName(record["name"]);
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
  opts: RedactStructuredOptions = {},
): StructuredRedaction {
  let redacted = false;
  let truncated = false;
  const secretIdentifiers = new Set<string>();

  const record = (location: string): void => {
    if (secretIdentifiers.size < MAX_REPORTED_IDENTIFIERS) secretIdentifiers.add(location);
  };

  /**
   * Walk a plain object's entries under `location`, marking each value
   * secret when `secretKey` says its key declares one. One loop for both
   * positions that walk an object - the object branch, and the array
   * branch's sibling `{name, value}` pair - so the key reporting and the
   * location spelling cannot drift between them.
   */
  const walkEntries = (
    source: Record<string, unknown>,
    location: string,
    secretKey: (key: string) => boolean,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    let index = 0;
    for (const [key, child] of Object.entries(source)) {
      // The key is reported by POSITION, never by name: the name is the
      // secret in this case.
      if (keyNameCarriesSecret(key)) record(`${location === "" ? "" : location}#${index}`);
      const childLocation = location === "" ? key : `${location}.${key}`;
      out[key] = walk(child, childLocation, secretKey(key), isIdentifierKeyName(key));
      index += 1;
    }
    return out;
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
      //
      // The wider detector is applied only under an identifier KEY, never
      // to a leaf that merely looks path-shaped: `foreignIdentifiers` is a
      // statement about where a NAME came from, and a path-shaped run of
      // prose carries no such provenance.
      const secretShaped =
        opts.foreignIdentifiers === true && underIdentifierKey
          ? foreignIdentifierCarriesSecret(value)
          : identifierCarriesSecret(value);
      if (secretShaped) record(location);
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
      return value.map((item, index) => {
        const itemLocation = `${location}[${index}]`;
        if (!siblingPairDeclaresSecret(item)) {
          return walk(item, itemLocation, false, underIdentifierKey);
        }
        // A `{name, value}` pair whose NAME declares a credential: the
        // literal rides in the sibling `value` member, so that member is
        // walked under a secret key. Every other member keeps the normal
        // per-key decision.
        return walkEntries(item as Record<string, unknown>, itemLocation, (key) =>
          key === "value" ? true : isSecretKeyName(key),
        );
      });
    }
    if (typeof value === "object" && value !== null) {
      if (!isPlainContainer(value)) return value;
      return walkEntries(value as Record<string, unknown>, location, isSecretKeyName);
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
