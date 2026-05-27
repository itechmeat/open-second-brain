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
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildBacklinkIndex } from "../backlinks.ts";
import { brainDirs } from "../paths.ts";
import { loadBrainConfig, resolveLinkGraph } from "../policy.ts";
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
}

export function auditMoc(vault: string, hubId: string, opts: AuditMocOptions = {}): MocAuditReport {
  const hubCanonical = normaliseWikilinkTarget(hubId);
  const hubPath = locateArtifact(vault, hubCanonical);
  if (!hubPath) {
    throw new MocAuditError(`hub note not found: ${hubCanonical}`);
  }

  const hubBody = stripFrontmatter(readFileSync(hubPath, "utf8"));
  const outboundBodies = extractWikilinkRichBodies(hubBody);
  const outboundTargets = uniq(
    outboundBodies
      .map((b) => parseWikilinkRich(b).target)
      .filter((t) => t.length > 0 && t !== hubCanonical),
  );

  const { minOutbound, minRatio } = resolveThresholds(vault, opts);
  if (outboundTargets.length < minOutbound) {
    throw new MocAuditError(
      `not a MOC: outbound link count ${outboundTargets.length} < threshold ${minOutbound}`,
    );
  }

  // Link-ratio: total characters inside `[[…]]` over non-whitespace
  // body characters. Whitespace is excluded from the denominator so
  // a heavily-indented link list isn't penalised against a compact
  // one. Numerator includes the four bracket characters (`[[]]`)
  // per link so a bracket-heavy body counts proportionally.
  const linkChars = outboundBodies.reduce((sum, b) => sum + b.length + 4, 0);
  const bodyChars = hubBody.replace(/\s+/g, "").length;
  const ratio = bodyChars > 0 ? linkChars / bodyChars : 0;
  if (ratio < minRatio) {
    throw new MocAuditError(`not a MOC: link ratio ${ratio.toFixed(2)} < threshold ${minRatio}`);
  }

  // Backlink index + cluster member metadata.
  const index = buildBacklinkIndex(vault);
  const wellCovered: MocClusterMember[] = [];
  const fragile: MocClusterMember[] = [];
  const candidateMissing: { id: string; referenceCount: number }[] = [];
  const missingCounts = new Map<string, number>();

  for (const target of outboundTargets) {
    const memberPath = locateArtifact(vault, target);
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
      if (!path) continue;
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
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text);
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

function resolveThresholds(
  vault: string,
  opts: AuditMocOptions,
): { minOutbound: number; minRatio: number } {
  if (opts.minOutboundLinks !== undefined && opts.minLinkRatio !== undefined) {
    return {
      minOutbound: opts.minOutboundLinks,
      minRatio: opts.minLinkRatio,
    };
  }
  let cfg;
  try {
    cfg = loadBrainConfig(vault);
  } catch {
    cfg = null;
  }
  const lg = cfg ? resolveLinkGraph(cfg) : null;
  return {
    minOutbound: opts.minOutboundLinks ?? (lg ? lg.moc_min_outbound_links : 5),
    minRatio: opts.minLinkRatio ?? (lg ? lg.moc_min_link_ratio : 0.3),
  };
}
