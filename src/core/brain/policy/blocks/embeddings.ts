/**
 * The `embeddings:` block — an operator's own record of a decommission
 * announcement they have read.
 *
 * One reason to change: what this vault knows about its embedding model's
 * lifecycle that this build's shipped survey does not.
 *
 * ## Why the block exists at all
 *
 * The sunset survey is a static table compiled into the binary. Its
 * unfixable weakness is that it goes stale between releases: a vendor
 * announces a shutdown, or moves one, and the table cannot learn until
 * somebody ships. This block is the layer that does not depend on the
 * build being current — an operator who has just read the announcement
 * records it here, and the check reports it immediately.
 *
 * It is deliberately an ADDITIONAL layer rather than the only source. A
 * declaration on its own cannot distinguish "the operator declared
 * nothing" from "no shutdown exists", and collapsing those two is the
 * exact defect the sunset check was built to remove. The survey keeps
 * answering `unsurveyed` / `none_announced` / `undetermined` on its own
 * terms; this block only ever adds a positive.
 *
 * ## Why two scalars rather than a model-to-date map
 *
 * `_brain.yaml` is read by a hand-rolled two-level indent parser, and the
 * validator's key index is built BY CONSTRUCTION from the keys each block
 * checks for — so a block with arbitrary model-shaped sub-keys would
 * report every one of them as an unknown key on every load. Two declared
 * scalars fit the grammar and the index exactly, and an operator has one
 * configured model at a time.
 *
 * ## Why the model is named rather than implied
 *
 * `sunset_model` could have been left out, with the date taken to mean
 * "whatever `embedding_model` currently is". That would silently
 * re-target the declaration the next time the operator switched models,
 * asserting one vendor's shutdown date about a different vendor's model.
 * The pair is therefore both-or-neither: half a declaration is an
 * operator who meant something that did not take effect, which is a
 * refusal rather than a default.
 */

import type { BrainConfig, BrainEmbeddingsConfig } from "../../types.ts";
import { isValidIsoInstant } from "../../health/iso-time.ts";
import { BrainConfigError } from "../errors.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";
import type { EmbeddingSunsetDeclaration } from "../../../search/embeddings/sunset.ts";

const BLOCK = "embeddings";

const MODEL_KEY = "sunset_model";
const DATE_KEY = "sunset_at";

/**
 * The declaration this vault carries, or `null` when it carries none.
 *
 * `null` here means "the operator declared nothing", which the sunset
 * classifier treats as "consult the survey" — never as "no shutdown
 * exists". That distinction is the whole reason this is a layer over the
 * survey rather than a replacement for it.
 */
export function resolveEmbeddingSunsetDeclaration(
  cfg: BrainConfig | undefined,
): EmbeddingSunsetDeclaration | null {
  const block = cfg?.embeddings;
  if (block === undefined) return null;
  const model = block.sunset_model;
  const sunsetAt = block.sunset_at;
  // Both-or-neither is enforced at parse time; this is the read-side
  // consequence of that rule rather than a second, laxer one.
  if (model === undefined || sunsetAt === undefined) return null;
  return { model, sunsetAt };
}

/**
 * Shape:
 *   embeddings:
 *     sunset_model: "text-embedding-3-small"   # exact model string
 *     sunset_at: "2027-03-01"                  # ISO date/timestamp
 */
export function parseEmbeddingsBlock(ctx: BlockParseContext): BrainEmbeddingsConfig | undefined {
  const obj = openBlock(ctx, BLOCK);
  if (obj === undefined) return undefined;

  const partial: Record<string, unknown> = {};
  if (MODEL_KEY in obj) {
    const v = obj[MODEL_KEY];
    if (typeof v !== "string" || v.trim() === "") {
      throw new BrainConfigError(
        "must be a non-empty model string, matched exactly against the configured embedding_model",
        `${BLOCK}.${MODEL_KEY}`,
        ctx.source,
      );
    }
    partial[MODEL_KEY] = v;
  }
  if (DATE_KEY in obj) {
    const v = obj[DATE_KEY];
    if (typeof v !== "string" || !isValidIsoInstant(v)) {
      throw new BrainConfigError(
        "must be an ISO-8601 date (YYYY-MM-DD) or timestamp",
        `${BLOCK}.${DATE_KEY}`,
        ctx.source,
      );
    }
    partial[DATE_KEY] = v;
  }
  // Half a declaration is refused rather than ignored. A date with no
  // model would have to mean "whatever is configured", which re-targets
  // itself on the next model change; a model with no date declares
  // nothing at all. Either way the operator wrote something that would
  // not take effect, and silently dropping it is how a setting an
  // operator believes is in force turns out not to be.
  const declaredModel = MODEL_KEY in partial;
  const declaredDate = DATE_KEY in partial;
  if (declaredModel !== declaredDate) {
    throw new BrainConfigError(
      `${MODEL_KEY} and ${DATE_KEY} are declared together or not at all; found only ` +
        `${declaredModel ? MODEL_KEY : DATE_KEY}`,
      BLOCK,
      ctx.source,
    );
  }
  warnUnknownKeys(ctx, obj, [MODEL_KEY, DATE_KEY], BLOCK);
  return partial as BrainEmbeddingsConfig;
}
