/**
 * Deterministic durability gate (A2 / t_375e98fd).
 *
 * `classifyDurability(text)` decides whether an extracted fact is DURABLE
 * (worth persisting) or TRANSIENT operational noise that should be skipped
 * before it reaches the inbox. The decision is made from STRUCTURAL signals
 * ONLY - there is deliberately zero built-in natural-language word list, in
 * any language, so the gate behaves identically across scripts (a plain
 * sentence in Russian, Japanese, Arabic, or English is durable unless it
 * carries a structural transient shape).
 *
 * The allowed structural signal classes are:
 *   - `temp-path`            filesystem temp paths (`/tmp/`, `*.tmp`, OS temp
 *                            dir shapes, `%TEMP%`, `$TMPDIR`);
 *   - `progress-counter`     `N/M` ratios and `NN%` percentages;
 *   - `run-id`               run-id / timestamp-suffixed identifier shapes and
 *                            ISO-8601 datetimes / long epoch numbers;
 *   - `measurement-dominant` measurement tokens (numbers with unit suffixes
 *                            like `ms`, `s`, `MB`) as the dominant token class;
 *   - `exit-status`          process exit-status shapes (POSIX `SIG*` signal
 *                            identifiers, the shell `$?` status variable).
 *
 * The only vocabulary source is the OPERATOR-supplied `durability.denylist`
 * config (a comma-separated list of regexes), threaded in through `opts`.
 *
 * `classifyDurability` and every detector are PURE and deterministic: same
 * input, same verdict, no I/O. The config resolver `resolveDurabilityDenylist`
 * is the one I/O-aware helper and is kept separate from the classifier.
 */

import { discoverConfig } from "../../config.ts";

/** Named structural signal (or the operator denylist) that fired. */
export type DurabilitySignal =
  | "temp-path"
  | "progress-counter"
  | "run-id"
  | "measurement-dominant"
  | "exit-status"
  | "denylisted";

export interface DurabilityVerdict {
  /** `true` when the text carries no transient signal - safe to persist. */
  readonly durable: boolean;
  /** The structural signal that rejected the text, or `null` when durable. */
  readonly reason: DurabilitySignal | null;
}

export interface ClassifyDurabilityOptions {
  /**
   * Operator denylist regexes (already compiled through
   * {@link compileDurabilityDenylist}). Non-global by construction so
   * `.test` stays stateless and the classifier stays deterministic.
   */
  readonly denylist?: ReadonlyArray<RegExp>;
}

// ----- Detectors (each pure, individually tested) ---------------------------

/**
 * Filesystem temp-path shapes. Unix temp dirs (`/tmp`, `/var/tmp`,
 * `/var/folders/...`), a `.tmp` file extension, a Windows `...\Temp\`
 * segment, and the `%TEMP%` / `%TMP%` / `$TMPDIR` environment tokens. These
 * are path SHAPES, not words: "temperature" or "attempts" never match.
 */
const TEMP_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|[\s"'(=:,])\/(?:tmp|var\/tmp|var\/folders)(?:\/|\b)/,
  /\.tmp(?=$|[\s"')\]},.:;])/i,
  /(?:^|[\\/])Temp[\\/]/,
  /%(?:TEMP|TMP)%/i,
  /\$TMPDIR\b/,
];

export function hasTempPath(text: string): boolean {
  return TEMP_PATH_PATTERNS.some((re) => re.test(text));
}

/**
 * Progress-counter tokens: an `N/M` integer ratio (e.g. `3/10`) or an
 * `NN%` percentage (e.g. `87%`, `50%`). Both are language-neutral notation.
 * Matched as WHOLE tokens (after stripping wrapper punctuation) so a
 * counter is only detected when it stands on its own, not when the same
 * notation is embedded in a factual sentence.
 */
const RATIO_TOKEN_RE = /^\d+\/\d+$/;
const PERCENT_TOKEN_RE = /^\d+(?:\.\d+)?%$/;

/** Minimum share of counter tokens for the "counter-dominant" verdict. */
export const PROGRESS_COUNTER_DOMINANCE_MIN_SHARE = 0.25;

/**
 * True when progress-counter tokens are counter-DOMINANT: their share of
 * whitespace-split tokens (after stripping wrapper punctuation, but never
 * the meaningful `%`/`/`) meets {@link PROGRESS_COUNTER_DOMINANCE_MIN_SHARE}.
 * A standalone `50%` or `3/10 done` status line is counter-dominant; a
 * percentage embedded in prose (`Acme owns 50% of the venture`) is not, so
 * a durable fact carrying incidental notation is not discarded as transient.
 */
export function hasProgressCounter(text: string): boolean {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  let counters = 0;
  for (const token of tokens) {
    const stripped = token.replace(/^["'([{]+/, "").replace(/["')\]}.,:;!?]+$/, "");
    if (RATIO_TOKEN_RE.test(stripped) || PERCENT_TOKEN_RE.test(stripped)) counters++;
  }
  return counters > 0 && counters / tokens.length >= PROGRESS_COUNTER_DOMINANCE_MIN_SHARE;
}

/**
 * Run-id / timestamp shapes: an ISO-8601 datetime, an identifier suffixed
 * with a long digit run (`run-20260718`, `job_1721304000`, `build-987654`),
 * or a bare long (>= 10-digit) number - the shape of a unix epoch. A short
 * number in prose ("version 3") never matches.
 */
const ISO_DATETIME_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?/;
const IDENTIFIER_LONGNUM_RE = /[A-Za-z][A-Za-z0-9]*[-_]\d{6,}/;
const LONG_EPOCH_RE = /\b\d{10,}\b/;

export function hasRunIdShape(text: string): boolean {
  return ISO_DATETIME_RE.test(text) || IDENTIFIER_LONGNUM_RE.test(text) || LONG_EPOCH_RE.test(text);
}

/**
 * Measurement tokens: a number immediately followed by a technical unit
 * suffix (durations, byte sizes, rates, screen units). The suffix must be
 * attached to the number (`500ms`, not `500 ms`) so an ambiguous bare word
 * ("s", "m") cannot match on its own. These are technical notation, not
 * natural-language words.
 */
const MEASUREMENT_TOKEN_RE =
  /^\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h|d|B|KB|MB|GB|TB|PB|KiB|MiB|GiB|TiB|bps|kbps|Mbps|Gbps|Hz|kHz|MHz|GHz|fps|rpm|px|em|rem)$/i;

/** Minimum share of measurement tokens for the "dominant class" verdict. */
export const MEASUREMENT_DOMINANCE_MIN_SHARE = 0.5;

/**
 * True when measurement tokens are the DOMINANT token class: their share of
 * whitespace-split tokens (after stripping surrounding punctuation) meets
 * {@link MEASUREMENT_DOMINANCE_MIN_SHARE}. A single bare measurement
 * (`500ms`) is dominant; a measurement buried in a prose sentence is not.
 */
export function hasMeasurementDominance(text: string): boolean {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  let measurement = 0;
  for (const token of tokens) {
    const stripped = token.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
    if (MEASUREMENT_TOKEN_RE.test(stripped)) measurement++;
  }
  return measurement > 0 && measurement / tokens.length >= MEASUREMENT_DOMINANCE_MIN_SHARE;
}

/**
 * Process exit-status shapes. POSIX signal identifiers (`SIGKILL`,
 * `SIGTERM`, ...) are a standardized identifier namespace - a wire-protocol
 * token family, not a natural-language word list, in the same spirit that
 * ISO-4217 currency codes are treated as language-neutral notation
 * elsewhere in this codebase. The shell `$?` status variable is likewise
 * pure notation.
 */
const POSIX_SIGNAL_RE = /\bSIG[A-Z]{2,}\b/;
const SHELL_STATUS_RE = /\$\?/;

export function hasExitStatusShape(text: string): boolean {
  return POSIX_SIGNAL_RE.test(text) || SHELL_STATUS_RE.test(text);
}

/**
 * Ordered detector table. `classifyDurability` returns the reason of the
 * FIRST detector that fires, so the order fixes which reason a text carrying
 * several shapes is labelled with. Each entry is a named, individually-tested
 * detector, so a new structural signal is added by appending one row - no
 * monolith to edit.
 */
export const DURABILITY_DETECTORS: ReadonlyArray<
  readonly [Exclude<DurabilitySignal, "denylisted">, (text: string) => boolean]
> = [
  ["temp-path", hasTempPath],
  ["progress-counter", hasProgressCounter],
  ["run-id", hasRunIdShape],
  ["measurement-dominant", hasMeasurementDominance],
  ["exit-status", hasExitStatusShape],
];

/**
 * Classify a fact's text as durable or transient. Built-in structural
 * detectors run first (in table order), then the operator denylist. Pure and
 * deterministic - the property the property-test pins.
 */
export function classifyDurability(
  text: string,
  opts: ClassifyDurabilityOptions = {},
): DurabilityVerdict {
  if (text.trim().length === 0) return { durable: true, reason: null };
  for (const [reason, detector] of DURABILITY_DETECTORS) {
    if (detector(text)) return { durable: false, reason };
  }
  for (const re of opts.denylist ?? []) {
    // Defensive reset: even though compileDurabilityDenylist strips the
    // global/sticky flags, resetting lastIndex keeps a caller-supplied regex
    // stateless so the verdict stays deterministic.
    re.lastIndex = 0;
    if (re.test(text)) return { durable: false, reason: "denylisted" };
  }
  return { durable: true, reason: null };
}

// ----- Operator denylist config (durability.denylist) -----------------------

/** Config key / env twin for the operator-supplied durability denylist. */
export const DURABILITY_DENYLIST_CONFIG_KEY = "durability.denylist";
export const DURABILITY_DENYLIST_ENV_KEY = "OPEN_SECOND_BRAIN_DURABILITY_DENYLIST";

/**
 * True when the quantifier starting at index `i` of `source` is unbounded:
 * `*`, `+`, or `{n,}` / `{,}` (no upper bound). `{n}` and `{n,m}` are bounded.
 */
function isUnboundedQuantifierAt(source: string, i: number): boolean {
  const ch = source[i];
  if (ch === "*" || ch === "+") return true;
  if (ch === "{") {
    const close = source.indexOf("}", i);
    return close !== -1 && /^\d*,$/.test(source.slice(i + 1, close));
  }
  return false;
}

/** True when a group body carries an unbounded quantifier (ignores classes). */
function bodyHasUnboundedQuantifier(body: string): boolean {
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (isUnboundedQuantifierAt(body, i)) return true;
  }
  return false;
}

/**
 * Reject a regex source that carries the classic catastrophic-backtracking
 * shape: an unbounded quantifier (`*`, `+`, `{n,}`) applied to a group whose
 * body ALSO contains an unbounded quantifier (`(a+)+`, `(.*)*`, `([0-9]+)*`).
 * These patterns can stall {@link classifyDurability} - which runs the
 * operator denylist synchronously on every fact - for exponential time on a
 * crafted input. Bounded (`{n}`, `{n,m}`) quantifiers and single-level
 * quantifiers (`(abc)+`) are safe and pass. This is a targeted guard for the
 * dominant ReDoS class, not a complete safe-regex analyzer (alternation
 * overlap such as `(a|a)+` is out of scope); it exists so an operator typo
 * cannot turn the capture hot path into a denial of service.
 */
export function hasNestedUnboundedQuantifier(source: string): boolean {
  const stack: number[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      stack.push(i);
      continue;
    }
    if (ch === ")") {
      const start = stack.pop();
      if (start === undefined) continue;
      if (
        isUnboundedQuantifierAt(source, i + 1) &&
        bodyHasUnboundedQuantifier(source.slice(start + 1, i))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Compile a comma-separated list of operator regexes into non-global
 * `RegExp` objects. Pure. An unparseable OR catastrophic-backtracking entry
 * is SKIPPED rather than thrown (the same tolerance `resolveTimezone` applies
 * to an invalid IANA zone): an operator typo must never crash or stall the
 * capture hot path, and the built-in structural detectors remain the primary
 * gate. Empty / absent yields `[]`.
 *
 * Multiple patterns are comma-delimited; a regex that needs a literal comma
 * can spell it `[,]` or `\x2c`, matching the exact-label denylist convention.
 */
export function compileDurabilityDenylist(raw: string | undefined): RegExp[] {
  if (!raw) return [];
  const out: RegExp[] = [];
  for (const part of raw.split(",")) {
    const pattern = part.trim();
    if (pattern.length === 0) continue;
    // Reject unsafe patterns before compiling: the denylist runs on every
    // fact, so a catastrophic-backtracking regex is a denial-of-service.
    if (hasNestedUnboundedQuantifier(pattern)) continue;
    try {
      out.push(new RegExp(pattern));
    } catch {
      // Skip the malformed pattern; capture must never break on bad config.
    }
  }
  return out;
}

/**
 * Resolve the operator denylist (env wins over config file), mirroring the
 * A1 label-denylist resolver. I/O-aware; the pure classifier never calls it.
 */
export function resolveDurabilityDenylist(configPath?: string): RegExp[] {
  const env = process.env[DURABILITY_DENYLIST_ENV_KEY];
  const raw =
    env !== undefined && env !== ""
      ? env
      : discoverConfig(configPath).data[DURABILITY_DENYLIST_CONFIG_KEY];
  return compileDurabilityDenylist(raw);
}
