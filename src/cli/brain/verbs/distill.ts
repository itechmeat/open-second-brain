/**
 * `o2b brain distill <source> --claims <json>` (t_2e2e959f): condense a source
 * into atomic claims with block-level provenance.
 *
 * Provider-agnostic: the agent supplies the atomic claims (and optional source
 * block ids) as JSON - a `[{ "text": "...", "block": "^abc" }]` array via
 * `--claims` or `--claims-file`. Open Second Brain validates them, checks every
 * quoted span against the cited block or the source, and writes one idempotent
 * distillation page per source. No model, no extraction here.
 *
 * `--strict-quotes` turns an unverified span into a refusal (exit 1, nothing
 * written); `--excerpt-file` stores the verbatim text read from a source the
 * vault does not hold, making the page `bounded-local`.
 *
 * Exit codes: 0 on success, 1 on an operational failure, 2 on usage errors.
 */

import { readFileSync } from "node:fs";

import {
  distillSource,
  DistillValidationError,
  parseDistillClaims,
  type DistillClaim,
  type DistillSourceResult,
} from "../../../core/brain/distill/distill-source.ts";
import {
  QuoteCheckError,
  type QuoteCheckReport,
} from "../../../core/brain/distill/quote-verdict.ts";
import {
  CAPTURE_SCOPE,
  CaptureExcerptError,
  type CaptureScope,
} from "../../../core/brain/provenance/capture-scope.ts";
import { ResponseShapeError } from "../../../core/brain/response-shape.ts";
import {
  INTAKE_TRUST,
  UNTRUSTED_SOURCE_FRONTMATTER_KEY,
  type IntakeTrust,
} from "../../../core/brain/trust/untrusted-provenance.ts";
import { brainVerbContext, fail, ok, okJson, parse, resolveBrainAgent } from "../helpers.ts";

const USAGE =
  "usage: o2b brain distill <source> (--claims <json> | --claims-file <path>) [--strict-quotes] [--excerpt-file <path>] [--agent <name>] [--vault <path>] [--json]";

/** Refusal for an excerpt file whose bytes are not UTF-8 text. */
const EXCERPT_NOT_UTF8_MESSAGE = "distill: excerpt file is not valid UTF-8";

/**
 * Strict UTF-8 decoder for the excerpt file: an invalid sequence throws
 * instead of becoming U+FFFD, and a leading byte-order mark is kept, so the
 * decoded text is exactly the file's bytes.
 */
const EXCERPT_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The excerpt file's text, or `null` when its bytes are not valid UTF-8. */
function readExcerptFile(path: string): string | null {
  const bytes = readFileSync(path);
  try {
    return EXCERPT_DECODER.decode(bytes);
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
}

/** Errors that are the operator's input, reported as `distill: <message>`. */
const OPERATOR_ERROR_CLASSES: ReadonlyArray<new (...args: never[]) => Error> = [
  DistillValidationError,
  ResponseShapeError,
  QuoteCheckError,
  CaptureExcerptError,
];

/** What `--claims` accepts, named in the operator's own terms. */
const CLAIMS_SHAPE_HINT = "claims must be a JSON array of { text, block? } objects";

/**
 * Unwrap the operator's JSON (a bare array, or an object with a `claims`
 * array) and hand it to the shared shape-checked ingress, so the CLI and the
 * MCP tool accept exactly the same payload under exactly the same rules.
 *
 * The unwrap failure is reported HERE rather than by the ingress: at this
 * point the operator's mistake is the wrapper they typed, and a path inside a
 * payload the CLI never found does not tell them what to type instead. Once a
 * list is in hand, the ingress owns every complaint about its items.
 */
function parseClaims(raw: string): DistillClaim[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("claims must be valid JSON");
  }
  const payload =
    !Array.isArray(parsed) && parsed !== null && typeof parsed === "object"
      ? (parsed as { claims?: unknown }).claims
      : parsed;
  if (!Array.isArray(payload)) throw new Error(CLAIMS_SHAPE_HINT);
  return parseDistillClaims(payload);
}

/**
 * What the success line adds when the page was marked untrusted. The token is
 * the frontmatter key itself rather than a sentence, so the operator can grep
 * for the same string on disk - and a trusted run's line stays exactly as it
 * was. Silence here would report one success sentence for two different
 * outcomes.
 *
 * The marker is a MARKER, not a guarantee that the page is out of reach. The
 * exclusion it feeds is the retrieval trust gate, which
 * `search/pipeline/post-rank.ts` mounts only when `search_trust_gate_enabled`
 * is set - a flag that falls back to `false`. This comment used to claim "no
 * ordinary read will ever return" it, which is false on a default install; see
 * the argument in `src/mcp/brain/distill-tools.ts` for why the answer is to
 * state the condition rather than to flip the flag from here.
 */
function untrustedNote(trust: IntakeTrust): string {
  return trust === INTAKE_TRUST.untrusted ? ` [${UNTRUSTED_SOURCE_FRONTMATTER_KEY}]` : "";
}

/**
 * What the success line adds when an excerpt was stored. Only `bounded-local`
 * earns a token: `url-only` is already named by the untrusted marker, and a
 * `full-local` run keeps its line exactly as it was.
 */
function captureNote(scope: CaptureScope): string {
  return scope === CAPTURE_SCOPE.boundedLocal ? ` [${CAPTURE_SCOPE.boundedLocal}]` : "";
}

/**
 * What the success line adds when quoted spans were checked: the spans that
 * verified (in a block or in the whole source) and the spans unquoted.
 */
function quotesNote(quotes: QuoteCheckReport | undefined): string {
  if (quotes === undefined) return "";
  const verified = quotes.verified_in_block + quotes.verified_in_source;
  return ` [quotes verified:${verified} unquoted:${quotes.unquoted}]`;
}

/** The success line, suffixes in their pinned order. */
function successLine(res: DistillSourceResult): string {
  return (
    `distilled ${res.claimCount} claim(s) -> ${res.distillationPath}${res.created ? "" : " (updated)"}` +
    `${untrustedNote(res.trust)}${captureNote(res.captureScope)}${quotesNote(res.quotes)}`
  );
}

export async function cmdBrainDistill(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    agent: { type: "string" },
    claims: { type: "string" },
    "claims-file": { type: "string" },
    "strict-quotes": { type: "boolean" },
    "excerpt-file": { type: "string" },
    json: { type: "boolean" },
  });
  const source = positional[0];
  // Usage errors exit 2 (the command's documented contract), distinct from the
  // operational exit 1 the catch below returns.
  if (!source) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (typeof flags["claims"] !== "string" && typeof flags["claims-file"] !== "string") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  try {
    const { config, vault } = brainVerbContext(flags);
    // Read the claims source inside the try so a missing --claims-file is a
    // clean error, not an uncaught throw.
    const claimsRaw =
      typeof flags["claims"] === "string"
        ? (flags["claims"] as string)
        : readFileSync(flags["claims-file"] as string, "utf8");
    const claims = parseClaims(claimsRaw);
    // Read verbatim: the excerpt is stored byte for byte and its digest is
    // taken over exactly these bytes.
    const excerpt =
      typeof flags["excerpt-file"] === "string"
        ? readExcerptFile(flags["excerpt-file"] as string)
        : undefined;
    if (excerpt === null) {
      process.stderr.write(`${EXCERPT_NOT_UTF8_MESSAGE}\n`);
      return 2;
    }
    const res = distillSource(
      vault,
      { sourcePath: source, claims, ...(excerpt !== undefined ? { excerpt } : {}) },
      {
        agent: resolveBrainAgent(flags, config),
        now: new Date(),
        strictQuotes: flags["strict-quotes"] === true,
      },
    );
    if (flags["json"]) {
      okJson({
        distillation_path: res.distillationPath,
        created: res.created,
        claim_count: res.claimCount,
        // Absent when the source had no bytes to hash, so the operator reads
        // "not recorded" rather than a sentinel that looks like a digest.
        ...(res.sourceHash !== undefined ? { source_hash: res.sourceHash } : {}),
        trust: res.trust,
        capture_scope: res.captureScope,
        ...(res.quotes !== undefined ? { quotes: res.quotes } : {}),
      });
      return 0;
    }
    ok(successLine(res));
    return 0;
  } catch (err) {
    if (OPERATOR_ERROR_CLASSES.some((cls) => err instanceof cls)) {
      return fail(`distill: ${(err as Error).message}`);
    }
    return fail(`distill failed: ${(err as Error).message ?? err}`);
  }
}
