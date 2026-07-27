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
 */

import { slugify } from "../vault.ts";
import { deriveFact } from "./derived-fact.ts";
import {
  isFactMarker,
  isSkillMarker,
  type FactMarker,
  type MarkerKind,
  type ParsedMarker,
  type SkillMarker,
} from "./inline.ts";
import type { ProvenanceLevel } from "./provenance/provenance.ts";
import { draftDeclaredSkillProposal } from "./skill-proposals.ts";

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

export interface CaptureRouteResult {
  /** Id of the artifact the marker landed in; embedded in the consumed sentinel. */
  readonly id: string;
  /** False when an equivalent artifact already existed and nothing new was written. */
  readonly created: boolean;
}

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
 * Commit a fact marker as an unconfirmed preference. The slug is derived
 * from the topic, the same derivation `scanInline` already applies when
 * it slugs a feedback signal, so a fact keeps one stable identity across
 * rescans instead of needing an author-supplied id.
 */
function routeFactMarker(
  vault: string,
  marker: FactMarker,
  ctx: CaptureRouteContext,
): CaptureRouteResult {
  const result = deriveFact(
    vault,
    {
      slug: slugify(marker.topic),
      topic: marker.topic,
      principle: marker.principle,
      premises: [...marker.premise],
      // The grammar carries `level` verbatim; `deriveFact` is the single
      // validator of that vocabulary and refuses an unknown value by name.
      level: marker.level as ProvenanceLevel,
    },
    { now: ctx.now },
  );
  return { id: result.id, created: true };
}

/** Draft a skill marker as a pending proposal. Never reaches accepted. */
function routeSkillMarker(
  vault: string,
  marker: SkillMarker,
  ctx: CaptureRouteContext,
): CaptureRouteResult {
  const result = draftDeclaredSkillProposal(vault, {
    name: marker.name,
    body: marker.body,
    sourceRefs: [ctx.sourceRef],
    now: ctx.now,
  });
  return { id: result.id, created: result.created };
}
