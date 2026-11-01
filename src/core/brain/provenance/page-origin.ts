/**
 * The delivery provenance probe: what a page's own stamps say about who
 * authored it, read the one way a delivery may read them (delivery-trust
 * wave, lane A).
 *
 * There is no per-page verified flag on disk, and adding one would be a
 * backfill both stamp modules forbid - a stamp applied by a later pass
 * describes the pass, not the writer. "Unverified / agent-origin" at
 * delivery is therefore DERIVED, from the three stamps that already
 * exist, by the closed rule {@link storedTextTreatment} states:
 *
 *   - an `untrusted_source` marker makes the page unverified;
 *   - `content_class: prompt-derived` makes it agent-origin;
 *   - `origin_channel` of `mcp-tool` or `import` makes it agent-origin;
 *   - `origin_channel: cli` is the one operator-authored answer;
 *   - ANY absence - no probe, no channel, the `unset` literal, a page
 *     that cannot be read - resolves fenced, never plain.
 *
 * Fail-closed is the tree's own doctrine applied honestly: both stamp
 * docblocks state that absence means "written before the stamp
 * existed", which is a statement about knowledge, not trust, so the
 * delivery side must not guess operator-authorship it cannot prove. The
 * consequence is stated plainly in the design: a legacy vault's pages
 * are fenced at remote reads until the operator stamps them, and the
 * `delivery-provenance-unknown` doctor check names that population so
 * the widening is observable, never silent.
 *
 * Reading the channel is legal - the origin-channel census forbids
 * NAMING it in a tool input, not reading it off a stamped record - and
 * the derivation is a closed pure function over three frontmatter
 * values. The probe reads ONLY those three fields, one frontmatter read
 * per (vault, path) pair through the shared cache, so a delivery shapes
 * with no uncached per-row file reads.
 */

import type { FrontmatterMap } from "../../types.ts";
import {
  ORIGIN_CHANNEL,
  ORIGIN_CHANNEL_FIELD,
  isOriginChannelStamp,
  type OriginChannelStamp,
} from "../../origin-channel.ts";
import type { FrontmatterCache } from "../../search/result-filters.ts";
import { readCachedFrontmatterEntry } from "../../search/result-filters.ts";
import { hasUntrustedSourceMarker } from "../trust/untrusted-provenance.ts";
import { CONTENT_CLASS, CONTENT_CLASS_FIELD, readContentClass } from "./content-class.ts";
import { DELIVERY_TREATMENT, type DeliveryTreatment } from "../delivery-shaping.ts";

/**
 * What the probe can prove about one page's authorship, as the raw
 * fields it was derived from. Every member is nullable on purpose: a
 * legacy page carries no stamps at all, and the derivation needs to
 * distinguish "stamped operator-authored" from "nothing is known" -
 * the second is the fail-closed case, not the first.
 */
export interface PageOriginForDelivery {
  /** The stamped channel, `unset` when no entry point claimed the process, null when absent. */
  readonly originChannel: OriginChannelStamp | null;
  /** The stamped class (`prompt-derived`), null when absent or out of vocabulary. */
  readonly contentClass: string | null;
  /** Whether the page declares the untrusted-provenance marker. */
  readonly untrustedSource: boolean;
}

/**
 * Read one page's three provenance stamps through the shared
 * frontmatter cache.
 *
 * One cached read per (vault, path) pair - the same seam every
 * post-rank filter uses - so shaping a whole result set costs no
 * additional file reads beyond the first probe per distinct page. A
 * page that cannot be read at all answers all-absent: `unreadable` and
 * "no stamps" are the same fact for this probe, and both fail closed in
 * {@link storedTextTreatment}. Never throws; the cache already absorbs
 * the filesystem's bad days.
 */
export function pageOriginForDelivery(
  vault: string,
  rel: string,
  cache: FrontmatterCache,
): PageOriginForDelivery {
  const entry = readCachedFrontmatterEntry(cache, vault, rel);
  return pageOriginFromMeta(entry.meta);
}

/**
 * The derivation's pure half over an already-read map, so the cache is
 * the only I/O the probe ever touches.
 *
 * An out-of-vocabulary channel is no evidence of authorship: the
 * closed-vocabulary posture the content class states (a hand edit is
 * not a stamp) maps it to null, which fails closed like every other
 * absence. The marker read is the tolerant one the trust gate itself
 * uses, accepting both the writer's boolean and the string form a YAML
 * round-trip leaves behind.
 */
function pageOriginFromMeta(meta: FrontmatterMap): PageOriginForDelivery {
  const channelValue = meta[ORIGIN_CHANNEL_FIELD];
  return {
    originChannel: isOriginChannelStamp(channelValue) ? channelValue : null,
    contentClass: readContentClass(meta),
    untrustedSource: hasUntrustedSourceMarker(meta),
  };
}

/**
 * The fail-closed derivation, in precedence order: any untrusted-source
 * marker, any prompt-derived class, and any agent-origin channel
 * resolve `fenced`; `origin_channel: cli` with NO other marker is the
 * one `plain` answer; and every absence - a null probe, a null channel,
 * the `unset` literal - resolves `fenced`. Never throws, never guesses.
 */
export function storedTextTreatment(origin: PageOriginForDelivery | null): DeliveryTreatment {
  if (origin === null) return DELIVERY_TREATMENT.fenced;
  if (origin.untrustedSource) return DELIVERY_TREATMENT.fenced;
  if (origin.contentClass === CONTENT_CLASS.promptDerived) return DELIVERY_TREATMENT.fenced;
  if (origin.originChannel === ORIGIN_CHANNEL.mcpTool) return DELIVERY_TREATMENT.fenced;
  if (origin.originChannel === ORIGIN_CHANNEL.import) return DELIVERY_TREATMENT.fenced;
  if (origin.originChannel === ORIGIN_CHANNEL.cli) return DELIVERY_TREATMENT.plain;
  return DELIVERY_TREATMENT.fenced;
}

/**
 * The fence's `origin` attribute text for a probed page: the derived
 * provenance, named. The label is built ONLY from closed stamp
 * vocabularies and fixed phrases - never from raw frontmatter values -
 * so it is single-line and attribute-safe by construction, and the
 * shaper's own label hygiene never has anything to clean.
 */
export function deliveryOriginLabel(origin: PageOriginForDelivery): string {
  if (origin.untrustedSource) {
    return "stored text: untrusted source (untrusted_source marker)";
  }
  if (origin.contentClass === CONTENT_CLASS.promptDerived) {
    return `stored text: agent-authored (${CONTENT_CLASS_FIELD}=${CONTENT_CLASS.promptDerived})`;
  }
  if (origin.originChannel === ORIGIN_CHANNEL.mcpTool) {
    return `stored text: agent-authored (${ORIGIN_CHANNEL_FIELD}=${ORIGIN_CHANNEL.mcpTool})`;
  }
  if (origin.originChannel === ORIGIN_CHANNEL.import) {
    return `stored text: agent-authored (${ORIGIN_CHANNEL_FIELD}=${ORIGIN_CHANNEL.import})`;
  }
  if (origin.originChannel === ORIGIN_CHANNEL.cli) {
    return `stored text: operator-authored (${ORIGIN_CHANNEL_FIELD}=${ORIGIN_CHANNEL.cli})`;
  }
  return "stored text: unverified provenance (no derivable stamps)";
}
