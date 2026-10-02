/**
 * Per-MOC topic-coverage audit.
 *
 * Given a hub note id, classify each member of the hub's outbound
 * cluster into:
 *   - `wellCovered`     - many inbound backlinks + body above floor
 *   - `fragile`         - one inbound backlink OR short body
 *   - `candidateMissing` - target referenced via `[[…]]` but no
 *                          on-disk artifact exists
 *   - `suggestedNext`   - the highest-leverage candidate-missing,
 *                          measured by reference count across hub +
 *                          cluster members
 *
 * MOC detection is purely structural: outbound link count + ratio
 * of link characters to non-whitespace body characters must cross
 * the thresholds in `link_graph` config. No vocabulary detection
 * of "this looks like a MOC because the title says so".
 *
 * That structural predicate lives in ONE exported place,
 * {@link isHubBody} / {@link evaluateHubBody}: the audit and the
 * inbox-drain hub selection (t_23bd347d) decide through the same
 * function, so there is exactly one definition of "hub".
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { FRONTMATTER_RE } from "../../vault.ts";
import { buildBacklinkIndex } from "../backlinks.ts";
import { ownerScopeView } from "../owner-scope-view.ts";
import { brainDirs, vaultRelative } from "../paths.ts";
import { BRAIN_LINK_GRAPH_DEFAULTS, loadBrainConfig, resolveLinkGraph } from "../policy.ts";
import { normaliseWikilinkTarget } from "../wikilink.ts";
import { extractWikilinkRichBodies, parseWikilinkRich } from "./parse-wikilink.ts";

/** Inclusive minimum backlink count for the `wellCovered` bucket. */
const WELL_COVERED_MIN_BACKLINKS = 2;
/** Inclusive minimum body-character count for the `wellCovered` bucket. */
const WELL_COVERED_MIN_BODY_CHARS = 200;
/** Maximum backlink count that still qualifies for the `fragile` bucket. */
const FRAGILE_MAX_BACKLINKS = 1;

export class MocAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MocAuditError";
  }
}

export interface MocClusterMember {
  readonly id: string;
  readonly backlinkCount: number;
  readonly bodyChars: number;
}

export interface MocAuditReport {
  readonly hubId: string;
  readonly outboundCount: number;
  readonly wellCovered: ReadonlyArray<MocClusterMember>;
  readonly fragile: ReadonlyArray<MocClusterMember>;
  readonly candidateMissing: ReadonlyArray<{
    readonly id: string;
    readonly referenceCount: number;
  }>;
  readonly suggestedNext?: {
    readonly id: string;
    readonly referenceCount: number;
  };
}

export interface AuditMocOptions {
  /** When set, skip the `link_graph` config lookup and use this. */
  readonly minOutboundLinks?: number;
  /** When set, skip the `link_graph` config lookup and use this. */
  readonly minLinkRatio?: number;
  /**
   * Owner scope the cluster is filtered against
   * (a-label-is-not-a-boundary, U3). Absent / `null` filters nothing.
   *
   * A hidden member is dropped from EVERY bucket, not moved into
   * `candidateMissing`: reporting it as missing would answer the
   * exists-vs-absent question this audit exists to answer, in the
   * direction that says "no such artifact" about one that exists. It
   * simply does not appear, which is what "identical to absent" means
   * everywhere else in this vault. `bodyChars` sizes a private body and
   * `backlinkCount` counts references from artifacts the caller may not
   * see, so both follow the member out.
   */
  readonly ownerScope?: string | null;
  /**
   * May the caller read the page at this vault-relative path? Absent
   * reads every page. A hub it refuses answers as an absent hub, and a
   * member it refuses is dropped exactly as an owner-hidden member is:
   * not bucketed, not sized, and its links not counted toward a missing
   * target's `referenceCount`.
   */
  readonly readable?: (rel: string) => boolean;
}

/** The structural hub thresholds (from `link_graph` config unless overridden). */
export interface HubBodyThresholds {
  /** Inclusive minimum of unique non-self outbound wikilink targets. */
  readonly minOutbound: number;
  /** Inclusive minimum of link characters over non-whitespace body characters. */
  readonly minRatio: number;
}

/** Options of the shared hub-body predicate. */
export interface HubBodyOptions {
  /**
   * Normalized wikilink id of the page the body belongs to; links to it are
   * not counted toward its own hubness, exactly as {@link auditMoc} never
   * counted a hub's link to itself. Absent / null excludes nothing.
   */
  readonly selfTarget?: string | null;
}

/** The outcome of the shared structural check over one page body. */
export interface HubBodyVerdict {
  /** True when the body crosses both thresholds. */
  readonly isHub: boolean;
  /** Unique non-self outbound wikilink targets, first-occurrence order. */
  readonly outboundTargets: ReadonlyArray<string>;
  /** Link characters over non-whitespace body characters. */
  readonly linkRatio: number;
}

/**
 * Evaluate the structural hub predicate over one page body: unique non-self
 * outbound wikilink targets >= `minOutbound` AND link ratio >= `minRatio`.
 *
 * This is THE definition of "hub" - `auditMoc` and the inbox-drain hub
 * selection (t_23bd347d) both decide through it, so the two can never drift
 * into two spellings of the same question.
 */
export function evaluateHubBody(
  body: string,
  thresholds: HubBodyThresholds,
  opts: HubBodyOptions = {},
): HubBodyVerdict {
  const selfTarget = opts.selfTarget ?? null;
  const outboundBodies = extractWikilinkRichBodies(body);
  const outboundTargets = uniq(
    outboundBodies
      .map((b) => parseWikilinkRich(b).target)
      .filter((t) => t.length > 0 && t !== selfTarget),
  );

  // Link-ratio: total characters inside `[[…]]` over non-whitespace
  // body characters. Whitespace is excluded from the denominator so
  // a heavily-indented link list isn't penalised against a compact
  // one. Numerator includes the four bracket characters (`[[]]`)
  // per link so a bracket-heavy body counts proportionally.
  const linkChars = outboundBodies.reduce((sum, b) => sum + b.length + 4, 0);
  const bodyChars = body.replace(/\s+/g, "").length;
  const ratio = bodyChars > 0 ? linkChars / bodyChars : 0;

  return {
    isHub: outboundTargets.length >= thresholds.minOutbound && ratio >= thresholds.minRatio,
    outboundTargets,
    linkRatio: ratio,
  };
}

/** Boolean form of {@link evaluateHubBody} for callers that need only the verdict. */
export function isHubBody(
  body: string,
  thresholds: HubBodyThresholds,
  opts: HubBodyOptions = {},
): boolean {
  return evaluateHubBody(body, thresholds, opts).isHub;
}

/**
 * The hub thresholds this vault's `link_graph` config resolves to, falling
 * back to the shipped defaults when the config cannot be read - the same
 * resolution `auditMoc` performs for its own audit.
 */
export function resolveHubThresholds(vault: string): HubBodyThresholds {
  let cfg;
  try {
    cfg = loadBrainConfig(vault);
  } catch {
    cfg = null;
  }
  const lg = cfg ? resolveLinkGraph(cfg) : null;
  return {
    minOutbound: lg ? lg.moc_min_outbound_links : BRAIN_LINK_GRAPH_DEFAULTS.moc_min_outbound_links,
    minRatio: lg ? lg.moc_min_link_ratio : BRAIN_LINK_GRAPH_DEFAULTS.moc_min_link_ratio,
  };
}

/** The {@link AuditMocOptions.readable} answer when none is given. */
const READ_EVERY_PAGE = (): boolean => true;

export function auditMoc(vault: string, hubId: string, opts: AuditMocOptions = {}): MocAuditReport {
  const hubCanonical = normaliseWikilinkTarget(hubId);
  const view = ownerScopeView(vault, opts.ownerScope ?? null);
  const hubPath = locateArtifact(vault, hubCanonical);
  const readable = opts.readable ?? READ_EVERY_PAGE;
  // A hub the caller may not see reads as a hub that is not there: the
  // same sentence an absent hub produces, so the two are indistinguishable.
  if (!hubPath || !view.visible(hubCanonical) || !readable(vaultRelative(hubPath, vault))) {
    throw new MocAuditError(`hub note not found: ${hubCanonical}`);
  }

  const hubBody = stripFrontmatter(readFileSync(hubPath, "utf8"));

  const thresholds = resolveThresholds(vault, opts);
  const verdict = evaluateHubBody(hubBody, thresholds, { selfTarget: hubCanonical });
  if (!verdict.isHub) {
    // The count is named first, exactly as the two checks were ordered when
    // they lived inline: a body below both thresholds reports the count.
    if (verdict.outboundTargets.length < thresholds.minOutbound) {
      throw new MocAuditError(
        `not a MOC: outbound link count ${verdict.outboundTargets.length} < threshold ${thresholds.minOutbound}`,
      );
    }
    throw new MocAuditError(
      `not a MOC: link ratio ${verdict.linkRatio.toFixed(2)} < threshold ${thresholds.minRatio}`,
    );
  }
  const outboundTargets = verdict.outboundTargets;

  // Backlink index + cluster member metadata.
  const index = buildBacklinkIndex(vault, view.scope);
  const wellCovered: MocClusterMember[] = [];
  const fragile: MocClusterMember[] = [];
  const candidateMissing: { id: string; referenceCount: number }[] = [];
  const missingCounts = new Map<string, number>();

  for (const target of outboundTargets) {
    const memberPath = locateArtifact(vault, target);
    // A member this caller may not see leaves no trace in any bucket -
    // not even the missing one, which would decide exists-vs-absent for it.
    if (memberPath && (!view.visible(target) || !readable(vaultRelative(memberPath, vault)))) {
      continue;
    }
    if (!memberPath) {
      missingCounts.set(target, (missingCounts.get(target) ?? 0) + 1);
      continue;
    }
    const memberBody = stripFrontmatter(readFileSync(memberPath, "utf8"));
    const backlinks = index.get(target) ?? [];
    // Don't count the hub's own outbound reference toward the
    // bucket assignment; the bucket measures coverage by OTHER
    // notes, not by the hub itself.
    const inboundFromOthers = backlinks.filter((r) => r.source !== hubCanonical).length;
    const member: MocClusterMember = Object.freeze({
      id: target,
      backlinkCount: inboundFromOthers,
      bodyChars: memberBody.length,
    });
    if (
      inboundFromOthers >= WELL_COVERED_MIN_BACKLINKS &&
      memberBody.length >= WELL_COVERED_MIN_BODY_CHARS
    ) {
      wellCovered.push(member);
    } else if (inboundFromOthers <= FRAGILE_MAX_BACKLINKS) {
      fragile.push(member);
    }
    // Members between the two buckets (e.g. high backlinks but short
    // body) fall through; future releases can expose them under a
    // "developing" bucket if profile shows it pays.
  }

  // Walk cluster member bodies to find additional references to
  // missing targets (for the `referenceCount` field).
  for (const target of outboundTargets) {
    if (!missingCounts.has(target)) continue;
    for (const member of outboundTargets) {
      const path = locateArtifact(vault, member);
      if (!path || !view.visible(member) || !readable(vaultRelative(path, vault))) continue;
      const body = stripFrontmatter(readFileSync(path, "utf8"));
      for (const bracketBody of extractWikilinkRichBodies(body)) {
        const t = parseWikilinkRich(bracketBody).target;
        if (t === target) {
          missingCounts.set(target, (missingCounts.get(target) ?? 0) + 1);
        }
      }
    }
  }

  for (const [id, count] of missingCounts) {
    candidateMissing.push(Object.freeze({ id, referenceCount: count }));
  }
  candidateMissing.sort((a, b) => b.referenceCount - a.referenceCount);

  const suggestedNext = candidateMissing[0];

  return Object.freeze({
    hubId: hubCanonical,
    outboundCount: outboundTargets.length,
    wellCovered: Object.freeze(wellCovered) as ReadonlyArray<MocClusterMember>,
    fragile: Object.freeze(fragile) as ReadonlyArray<MocClusterMember>,
    candidateMissing: Object.freeze(candidateMissing) as ReadonlyArray<{
      id: string;
      referenceCount: number;
    }>,
    ...(suggestedNext ? { suggestedNext } : {}),
  });
}

function locateArtifact(vault: string, id: string): string | null {
  const dirs = brainDirs(vault);
  const candidates = [join(dirs.preferences, `${id}.md`), join(dirs.retired, `${id}.md`)];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function stripFrontmatter(text: string): string {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return text;
  return text.slice(m[0].length);
}

function uniq<T>(values: ReadonlyArray<T>): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function resolveThresholds(vault: string, opts: AuditMocOptions): HubBodyThresholds {
  if (opts.minOutboundLinks !== undefined && opts.minLinkRatio !== undefined) {
    return {
      minOutbound: opts.minOutboundLinks,
      minRatio: opts.minLinkRatio,
    };
  }
  const resolved = resolveHubThresholds(vault);
  return {
    minOutbound: opts.minOutboundLinks ?? resolved.minOutbound,
    minRatio: opts.minLinkRatio ?? resolved.minRatio,
  };
}
