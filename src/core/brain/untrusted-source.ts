/**
 * Untrusted-source delimiting and structural neutralization (Unit 1 of
 * the Vault Integrity & Trust suite).
 *
 * Open Second Brain ingests external material and feeds untrusted note /
 * source text into model-facing operations (dream, deep-synthesis,
 * pre-compact extraction). Un-delimited, a malicious or accidental
 * injection string inside a note can reach the model as if it were an
 * instruction. This module wraps an untrusted span in a provenance-
 * carrying delimiter and neutralizes the structural vectors that let
 * content escape that wrapper or smuggle invisible control sequences.
 *
 * Language-agnostic by construction. Neutralization keys off STRUCTURE
 * only - invisible / control characters and this module's own delimiter
 * token - never off natural-language vocabulary. There is no blocklist
 * of injection phrases ("ignore previous instructions") or role words
 * ("system:", "assistant:") in any language: a word blocklist cannot be
 * complete across all languages and would corrupt legitimate prose.
 * Containment, not vocabulary, is what makes the span inert - inside the
 * wrapper, a line that reads like an instruction is just data, and the
 * delimiter cannot be closed early because the closing token is escaped
 * wherever it appears in the content.
 *
 * Read-time only: this never rewrites a note on disk. The provenance
 * sha256 hashes the ORIGINAL source bytes (so a verifier can match it
 * against the file), while the embedded body is the neutralized form.
 */

import { createHash } from "node:crypto";

import { canonicalNotePath } from "../path-safety.ts";

/** The delimiter tag name. Exported so callers and tests share one source. */
export const UNTRUSTED_SOURCE_TAG = "untrusted_source";

/**
 * Characters that have no place in plain note prose but enable injection
 * or display spoofing, matched as a single class. Built from explicit
 * code-point escapes (not literal invisible characters in source) so the
 * set is auditable and the file stays readable:
 *   - C0 controls except TAB (U+0009) and LF (U+000A): U+0000-0008 and
 *     U+000B-001F (this also strips CR U+000D; the body uses LF newlines).
 *   - DEL + C1 controls: U+007F-009F.
 *   - Zero-width, joiners, bidi marks, word joiner, BOM: U+200B-200F,
 *     U+2060, U+FEFF.
 *   - Bidirectional embeddings / overrides / isolates (text-direction
 *     spoofing): U+202A-202E, U+2066-2069.
 * The set is structural, not lexical - it is identical for every human
 * language.
 */
const INJECTION_CONTROL_CHARS = new RegExp(
  "[" +
    "\\u0000-\\u0008\\u000B-\\u001F" + // C0 except TAB, LF
    "\\u007F-\\u009F" + // DEL + C1
    "\\u200B-\\u200F\\u2060\\u202A-\\u202E\\u2066-\\u2069\\uFEFF" + // zero-width / bidi / BOM
    "]",
  "gu",
);

/** Case-insensitive match of this module's own opening/closing delimiter. */
const DELIMITER_OPENING = new RegExp(`<(${UNTRUSTED_SOURCE_TAG})`, "gi");
const DELIMITER_CLOSING = new RegExp(`</(${UNTRUSTED_SOURCE_TAG})`, "gi");

/**
 * Neutralize an untrusted text span without altering its visible prose.
 *
 * Three structural transforms, in this exact order:
 *   1. Strip invisible / control characters (see INJECTION_CONTROL_CHARS).
 *      This MUST run first: an attacker can split the delimiter tag name
 *      with a stripped character (e.g. `</unt<U+200B>rusted_source>`) so
 *      that the delimiter regex does not match, then rely on a later
 *      strip to reconstitute a live `</untrusted_source>`. Stripping
 *      before escaping closes that reassembly bypass.
 *   2. Defuse any closing delimiter `</untrusted_source` by escaping its
 *      leading `<` to `&lt;`, so embedded content cannot close the real
 *      wrapper early (delimiter-injection breakout).
 *   3. Defuse any forged opening delimiter `<untrusted_source` the same
 *      way, so content cannot inject a second, attacker-controlled
 *      provenance frame.
 *
 * Visible characters - in any language - pass through unchanged, so the
 * function is a no-op on clean prose and idempotent on its own output
 * (the escaped `&lt;` no longer matches the delimiter patterns, and a
 * second strip finds no control characters to remove).
 */
export function neutralizeUntrustedText(text: string): string {
  return text
    .replace(INJECTION_CONTROL_CHARS, "")
    .replace(DELIMITER_CLOSING, "&lt;/$1")
    .replace(DELIMITER_OPENING, "&lt;$1");
}

/** Escape a value for safe inclusion in a double-quoted XML attribute. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Provenance stamped onto a wrapped untrusted span. */
export interface UntrustedProvenance {
  /** Vault-relative source path; canonicalized (POSIX + NFC) on wrap. */
  readonly path: string;
}

/**
 * Wrap an untrusted text span in a provenance-carrying delimiter:
 *
 *   <untrusted_source path="<canonical path>" sha256="<hash of original>">
 *   <neutralized body>
 *   </untrusted_source>
 *
 * The `sha256` is computed over the ORIGINAL bytes (provenance the
 * verifier can reproduce from the file); the body is the neutralized
 * form. The `path` is run through {@link canonicalNotePath} so the same
 * note carries one provenance identity across devices.
 */
export function wrapUntrustedSource(text: string, provenance: UntrustedProvenance): string {
  const path = canonicalNotePath(provenance.path);
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const body = neutralizeUntrustedText(text);
  const open = `<${UNTRUSTED_SOURCE_TAG} path="${escapeAttribute(path)}" sha256="${sha256}">`;
  return `${open}\n${body}\n</${UNTRUSTED_SOURCE_TAG}>`;
}
