/**
 * Source-distillation tool (Ingestion & Import Robustness suite, t_2e2e959f).
 *
 * The calling agent reads a source and distills it into atomic claims, each
 * with an optional block id pointing back to the source block it came from,
 * and submits them here. Open Second Brain runs no model - it validates the
 * claims, checks every quoted span in them against the cited block or the
 * source, and writes one idempotent distillation page per source, listing
 * each claim with its block-level citation and a provenance section. The
 * response names the capture scope and, when spans were checked, the quotes
 * report; `strict_quotes` turns an unverified span into a refusal carrying
 * the `quote_unverified` wire code.
 */

import {
  DISTILL_CLAIMS_MAX,
  distillSource,
  DistillValidationError,
  parseDistillClaims,
  type DistillSourceInput,
  type DistillSourceOptions,
  type DistillSourceResult,
} from "../../core/brain/distill/distill-source.ts";
import { QuoteCheckError } from "../../core/brain/distill/quote-verdict.ts";
import {
  CAPTURE_EXCERPT_MAX_BYTES,
  CaptureExcerptError,
} from "../../core/brain/provenance/capture-scope.ts";
import { ResponseShapeError } from "../../core/brain/response-shape.ts";
import { resolveAgentName } from "../../core/config.ts";
import { coerceBoolOptional, coerceStr } from "../coerce.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { readableAtContextReach } from "./reach-readable.ts";
import { wrapToolErrors } from "./shared.ts";

const TOOL = "brain_distill_source";
const EXCERPT_ARG = "excerpt";

async function toolBrainDistillSource(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sourcePath = coerceStr(args, "source_path", true)!;
  const agentArg = coerceStr(args, "agent", false);
  const agent =
    agentArg && agentArg.trim().length > 0
      ? agentArg
      : resolveAgentName(ctx.configPath ?? undefined);

  const excerpt = readExcerptArg(args);
  const strictQuotes = coerceBoolOptional(args, "strict_quotes") ?? false;

  return wrapToolErrors(
    TOOL,
    [DistillValidationError, ResponseShapeError, CaptureExcerptError],
    async () => {
      // Shape first: the payload is validated before a single claim is
      // normalized, so a malformed item aborts the whole batch unwritten.
      const claims = parseDistillClaims(args["claims"]);
      const res = distillWithQuoteCode(
        ctx.vault,
        { sourcePath, claims, ...(excerpt !== undefined ? { excerpt } : {}) },
        // The quote check reads the source's bytes on the caller's behalf, so
        // it answers only for a page the caller may read at its reach.
        { agent, now: new Date(), strictQuotes, readable: readableAtContextReach(ctx) },
      );
      return {
        distillation_path: res.distillationPath,
        created: res.created,
        claim_count: res.claimCount,
        // Omitted rather than reported as a sentinel when the source had no
        // bytes to hash: an absent key reads as "not recorded", where the
        // `missing` string this used to return read as a digest until you knew
        // better.
        ...(res.sourceHash !== undefined ? { source_hash: res.sourceHash } : {}),
        // The lane the page ACTUALLY landed in. Classifying the source a second
        // time here would be a second answer to one question, free to disagree
        // with the write that already happened.
        trust: res.trust,
        // How much of the source the page holds. Always present, like `trust`.
        capture_scope: res.captureScope,
        // Only when a claim held a quoted span: absence means nothing was
        // quoted, never "checked and clean" (that is `unquoted: 0`).
        ...(res.quotes !== undefined ? { quotes: res.quotes } : {}),
      };
    },
  );
}

/**
 * The `excerpt` argument, verbatim. `coerceStr` folds a blank string into
 * "absent", which would turn an empty excerpt into a silent no-op; the core
 * refuses an empty one by name, so the bytes are passed through untouched
 * and only a non-string is rejected here.
 */
function readExcerptArg(args: Record<string, unknown>): string | undefined {
  const raw = args[EXCERPT_ARG];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new MCPError(INVALID_PARAMS, `${TOOL}: argument '${EXCERPT_ARG}' must be a string`);
  }
  return raw;
}

/**
 * Run the distillation, answering a strict quote refusal with its registered
 * wire code. `wrapToolErrors` folds a validation class into a bare
 * `INVALID_PARAMS` and drops any data, so this one class is mapped here,
 * where the code is still in hand; every other error keeps the shared path.
 */
function distillWithQuoteCode(
  vault: string,
  input: DistillSourceInput,
  opts: DistillSourceOptions,
): DistillSourceResult {
  try {
    return distillSource(vault, input, opts);
  } catch (err) {
    if (err instanceof QuoteCheckError) {
      throw new MCPError(INVALID_PARAMS, `${TOOL}: ${err.message}`, { code: err.code });
    }
    throw err;
  }
}

export const DISTILL_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    // The guarantee is stated here, in the idiom `brain_intake_entities` uses:
    // a caller choosing a tool reads this, and a write that quarantines what it
    // just wrote must say so where the choice is made.
    //
    // It is stated CONDITIONALLY, and the condition is named. This sentence
    // used to assert that the page was "excluded from ordinary reads", which
    // was false on a default install: the exclusion is `trustGateAdjuster`,
    // which `search/pipeline/post-rank.ts` mounts only when
    // `recall.retrievalTrustGateEnabled` is set, and that flag falls back to
    // `false`. The marker is written correctly and `classifyRetrievalTrust`
    // reads it correctly - nothing mounts the gate.
    //
    // Making it true by default was the other option and is not taken here.
    // Flipping the flag turns on three signals at once, changes the search
    // result shape (the trust receipts stop being null), the cache slot key and
    // the explain envelope - a release-wide decision that does not belong to a
    // tool description. Mounting a partial gate for this one signal would
    // exclude pages with no receipt to say so, which is the silent drop this
    // project forbids. So the limit is admitted instead, with the setting
    // named, and `tests/cli/distill-trust-lane.test.ts` proves both halves:
    // the default returns the page, the setting stops returning it.
    //
    // Note the asymmetry with `brain_intake_entities`, whose quarantine holds
    // by DEFAULT: it works through `status: quarantine` plus the entity page
    // status scope, which nothing gates. The same words mean less here.
    description:
      "Distill one source into atomic claims; runs no model, checks quotes. Writes one idempotent page citing each claim as `[[source#^block]]`. A source outside this vault is marked `untrusted_source`, which ordinary reads still return unless `search_trust_gate_enabled` is on. `trust` names the lane.",
    inputSchema: {
      type: "object",
      properties: {
        source_path: {
          type: "string",
          description: "Source identity: a vault-relative path or a URL.",
        },
        claims: {
          type: "array",
          description: `Atomic claims distilled from the source, each one line (1 to ${DISTILL_CLAIMS_MAX}).`,
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "The atomic claim text." },
              block: {
                type: "string",
                description: "Optional source block id the claim was drawn from (the `^abc` id).",
              },
            },
            required: ["text"],
            additionalProperties: false,
          },
        },
        strict_quotes: {
          type: "boolean",
          description:
            "Refuse the write (code quote_unverified) when a quoted span fails the check; by default the span is unquoted and reported.",
        },
        excerpt: {
          type: "string",
          // Characters, a necessary bound on the byte cap the core enforces.
          maxLength: CAPTURE_EXCERPT_MAX_BYTES,
          description: `Verbatim text read from a url-only source; stored on the page as bounded-local and used to check quotes. At most ${CAPTURE_EXCERPT_MAX_BYTES} bytes.`,
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
      },
      required: ["source_path", "claims"],
      additionalProperties: false,
    },
    handler: toolBrainDistillSource,
  },
]);
