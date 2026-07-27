/**
 * Destinations for the two `@osb` marker kinds that materialise a Brain
 * artifact directly: `fact` and `skill` (signals-that-survive, unit 7).
 *
 * Both destinations already carry a review gate, so this module adds
 * none of its own:
 *
 *   - a `fact` marker goes through `deriveFact`, which validates every
 *     premise against the preferences on disk and commits the
 *     conclusion as an UNCONFIRMED preference. The dream pass is what
 *     later confirms or expires it. An unresolvable premise throws
 *     {@link DeriveFactError} and nothing is written - never a partial
 *     write, never a silent drop.
 *   - a `skill` marker goes through `draftDeclaredSkillProposal`, which
 *     writes into the PENDING proposal queue only. `acceptSkillProposal`
 *     remains the human step that promotes it.
 *
 * The module owns exactly the translation between the marker's fields
 * and each writer's input - the derived slug, the source reference -
 * and delegates every validation to the writer that owns the rule.
 *
 * {@link previewCaptureMarker} is the same walk with the write removed,
 * for `scan-inline --dry-run`: same input, same identity, same outcome
 * vocabulary, nothing touched.
 */

import { existsSync } from "node:fs";

import { slugify } from "../vault.ts";
import {
  DeriveFactError,
  deriveFact,
  parseDeriveFactInput,
  type DeriveFactInput,
} from "./derived-fact.ts";
import {
  isFactMarker,
  isSkillMarker,
  type FactMarker,
  type MarkerKind,
  type ParsedMarker,
  type SkillMarker,
} from "./inline.ts";
import { preferencePath } from "./paths.ts";
import {
  draftDeclaredSkillProposal,
  previewDeclaredSkillProposal,
  type DeclaredSkillProposalInput,
  type DeclaredSkillProposalResult,
} from "./skill-proposals.ts";

/**
 * The marker kinds this module has a destination for. Callers gate on
 * this set and then call {@link routeCaptureMarker}; the two stay in
 * step because a kind in the set with no route is a hard error rather
 * than a skipped marker.
 */
export const ROUTED_MARKER_KINDS: ReadonlySet<MarkerKind> = new Set<MarkerKind>(["fact", "skill"]);

/** Where the marker was found, and the clock to stamp the artifact with. */
export interface CaptureRouteContext {
  /** Wikilink to the source note, e.g. `[[Daily/2026-07-27]]`. */
  readonly sourceRef: string;
  readonly now: Date;
}

/**
 * What a routed marker did at its destination. Same vocabulary for both
 * kinds, so a caller counts and reports one set of outcomes:
 *
 *   - `created`   - the artifact was written.
 *   - `deduped`   - an equivalent artifact already existed; nothing was
 *                   written and nothing was lost.
 *   - `suppressed`- the destination declined and the marker's content is
 *                   stored nowhere. Named, never silent.
 */
export type CaptureRouteOutcome = "created" | "deduped" | "suppressed";

interface CaptureRouteResultBase {
  /** Id of the artifact the marker landed in; embedded in the consumed sentinel. */
  readonly id: string;
}

export type CaptureRouteResult = CaptureRouteResultBase &
  (
    | { readonly outcome: "created" | "deduped" }
    /** `reason` is required here so a decline can never reach a caller unexplained. */
    | { readonly outcome: "suppressed"; readonly reason: string }
  );

/**
 * Send one marker to the store its kind belongs in. Callers must have
 * checked {@link ROUTED_MARKER_KINDS} first; a kind in that set with no
 * branch here throws by name rather than returning a marker-shaped
 * nothing.
 */
export function routeCaptureMarker(
  vault: string,
  marker: ParsedMarker,
  ctx: CaptureRouteContext,
): CaptureRouteResult {
  if (isFactMarker(marker)) return routeFactMarker(vault, marker, ctx);
  if (isSkillMarker(marker)) return routeSkillMarker(vault, marker, ctx);
  throw new Error(`no capture route for marker kind: ${marker.kind}`);
}

/**
 * What {@link routeCaptureMarker} would do, without writing anything.
 *
 * This is what `scan-inline --dry-run` walks. A preview that reported
 * nothing while two vault writes were queued would be a result computed
 * and dropped, so the preview resolves the same identity, refuses the
 * same markers, and returns the same outcome vocabulary as the write.
 */
export function previewCaptureMarker(
  vault: string,
  marker: ParsedMarker,
  ctx: CaptureRouteContext,
): CaptureRouteResult {
  if (isFactMarker(marker)) return previewFactMarker(vault, marker);
  if (isSkillMarker(marker)) {
    return skillRouteResult(previewDeclaredSkillProposal(vault, skillInput(marker, ctx)));
  }
  throw new Error(`no capture route for marker kind: ${marker.kind}`);
}

/**
 * Commit a fact marker as an unconfirmed preference. The slug is derived
 * from the topic, the same derivation `scanInline` already applies when
 * it slugs a feedback signal, so a fact keeps one stable identity across
 * rescans instead of needing an author-supplied id.
 *
 * The outcome is `created` because that is `deriveFact`'s whole contract:
 * it validates, writes, and returns an id, with no branch that resolves
 * to an artifact it did not write. The census test
 * `DeriveFactResult carries only the id` fails the moment that result
 * grows a field describing what it did - at which point this mapping must
 * read that field instead of standing on the contract.
 */
function routeFactMarker(
  vault: string,
  marker: FactMarker,
  ctx: CaptureRouteContext,
): CaptureRouteResult {
  const result = deriveFact(vault, factInput(marker), { now: ctx.now });
  return { id: result.id, outcome: "created" };
}

/** Draft a skill marker as a pending proposal. Never reaches accepted. */
function routeSkillMarker(
  vault: string,
  marker: SkillMarker,
  ctx: CaptureRouteContext,
): CaptureRouteResult {
  return skillRouteResult(draftDeclaredSkillProposal(vault, skillInput(marker, ctx)));
}

/** The declaration input, identical for the write and the preview. */
function skillInput(marker: SkillMarker, ctx: CaptureRouteContext): DeclaredSkillProposalInput {
  return {
    name: marker.name,
    body: marker.body,
    sourceRefs: [ctx.sourceRef],
    now: ctx.now,
  };
}

/** Carry the queue's own outcome up unchanged; the vocabularies are one. */
function skillRouteResult(result: DeclaredSkillProposalResult): CaptureRouteResult {
  return result.outcome === "suppressed"
    ? { id: result.id, outcome: "suppressed", reason: result.reason }
    : { id: result.id, outcome: result.outcome };
}

/**
 * The derive-fact input, identical for the write and the preview.
 *
 * Routed through `parseDeriveFactInput` so the marker's verbatim `level`
 * meets the destination's own vocabulary check on both paths, instead of
 * being cast into the type and validated only where a write follows.
 */
function factInput(marker: FactMarker): DeriveFactInput {
  return parseDeriveFactInput({
    slug: slugify(marker.topic),
    topic: marker.topic,
    principle: marker.principle,
    premises: [...marker.premise],
    level: marker.level,
  });
}

/**
 * What a fact marker WOULD do. `parseDeriveFactInput` covers everything
 * `deriveFact` checks without touching the vault; the two conditions
 * below are the ones it checks against the vault, restated here because
 * a preview cannot run the writer.
 *
 * They are pinned to the writer by the test "a dry run refuses exactly
 * the markers a real run refuses", which runs both paths over the same
 * fixtures: a precondition that drifts out of `derived-fact.ts` fails
 * there rather than turning a preview into a comfortable lie.
 */
function previewFactMarker(vault: string, marker: FactMarker): CaptureRouteResult {
  const input = factInput(marker);
  for (const premise of input.premises) {
    const slug = premiseSlug(premise);
    if (!slug) throw new DeriveFactError("premise id must not be empty");
    if (!existsSync(preferencePath(vault, slug))) {
      throw new DeriveFactError(`premise preference not found: ${JSON.stringify(premise)}`);
    }
  }
  if (existsSync(preferencePath(vault, input.slug))) {
    throw new DeriveFactError(`a preference already exists for slug: ${input.slug}`);
  }
  return { id: `pref-${input.slug}`, outcome: "created" };
}

/** Strip a leading `pref-` so a premise can be given as an id or a bare slug. */
function premiseSlug(premise: string): string {
  const trimmed = premise.trim();
  return trimmed.startsWith("pref-") ? trimmed.slice("pref-".length) : trimmed;
}
