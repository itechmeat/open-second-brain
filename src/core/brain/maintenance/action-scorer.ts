/**
 * Pure scoring function over vault-maintenance signals. Replaces the
 * vague "Recommendation:" text that earlier digests carried with a
 * deterministic ranked list of operator-actionable next steps.
 *
 * The scorer takes already-collected inputs (page dedup candidates,
 * stale-lifecycle pages, broken merged-link rewrites, token-footprint
 * excess) and emits a sorted list of {@link ActionItem} ordered by
 * impact descending. The function is pure: every input is a typed
 * shape, no I/O. Use with `findDuplicateCandidates`, `lintConsolidate`,
 * and `computeTokenFootprint` outputs upstream.
 */

export type ActionCategory = "dedup" | "lifecycle" | "merged-link" | "token-footprint";

export interface ActionItem {
  readonly id: string;
  readonly category: ActionCategory;
  readonly title: string;
  readonly impact: number;
  /** Optional target reference (page id, file path, etc). */
  readonly target?: string;
}

export interface ActionInputs {
  readonly dedupCandidates?: ReadonlyArray<{
    readonly canonicalId: string;
    readonly secondaryCount: number;
  }>;
  readonly staleByLifecycle?: ReadonlyArray<{
    readonly id: string;
    readonly ageDays: number;
  }>;
  readonly brokenLinks?: ReadonlyArray<{
    readonly path: string;
    readonly from: string;
  }>;
  readonly tokenFootprint?: {
    readonly total: number;
    readonly warnThreshold: number;
  };
}

const WEIGHT = Object.freeze({
  dedupPerSecondary: 8,
  staleLifecyclePerYear: 4,
  brokenLink: 5,
  tokenFootprintExcessPer10k: 3,
});

function scoreDedup(inputs: NonNullable<ActionInputs["dedupCandidates"]>): ActionItem[] {
  const out: ActionItem[] = [];
  for (const c of inputs) {
    if (c.secondaryCount <= 0) continue;
    out.push({
      id: `dedup:${c.canonicalId}`,
      category: "dedup",
      title: `Merge ${c.secondaryCount} duplicate(s) into ${c.canonicalId}`,
      impact: c.secondaryCount * WEIGHT.dedupPerSecondary,
      target: c.canonicalId,
    });
  }
  return out;
}

function scoreStale(inputs: NonNullable<ActionInputs["staleByLifecycle"]>): ActionItem[] {
  const out: ActionItem[] = [];
  for (const s of inputs) {
    if (s.ageDays <= 0) continue;
    const years = Math.max(0.5, s.ageDays / 365);
    out.push({
      id: `lifecycle:${s.id}`,
      category: "lifecycle",
      title: `Re-verify or demote stale stable: ${s.id}`,
      impact: Math.round(years * WEIGHT.staleLifecyclePerYear),
      target: s.id,
    });
  }
  return out;
}

function scoreBrokenLinks(inputs: NonNullable<ActionInputs["brokenLinks"]>): ActionItem[] {
  // Bucket by source path so the report does not duplicate noisy
  // file-level recommendations when one page has many broken links.
  const byPath = new Map<string, number>();
  for (const l of inputs) {
    byPath.set(l.path, (byPath.get(l.path) ?? 0) + 1);
  }
  const out: ActionItem[] = [];
  for (const [path, count] of byPath) {
    out.push({
      id: `merged-link:${path}`,
      category: "merged-link",
      title: `Rewrite ${count} merged-link reference(s) in ${path}`,
      impact: count * WEIGHT.brokenLink,
      target: path,
    });
  }
  return out;
}

function scoreTokenFootprint(input: NonNullable<ActionInputs["tokenFootprint"]>): ActionItem[] {
  const excess = input.total - input.warnThreshold;
  if (excess <= 0) return [];
  const buckets = Math.ceil(excess / 10_000);
  return [
    {
      id: "token-footprint:vault",
      category: "token-footprint",
      title: `Vault exceeds warn threshold by ${excess} tokens; archive or split`,
      impact: buckets * WEIGHT.tokenFootprintExcessPer10k,
      target: "vault",
    },
  ];
}

export interface ScoreOptions {
  /** Cap on returned items. Default 10. */
  readonly topN?: number;
}

export function scoreActions(
  inputs: ActionInputs,
  opts: ScoreOptions = {},
): ReadonlyArray<ActionItem> {
  const all: ActionItem[] = [];
  if (inputs.dedupCandidates) all.push(...scoreDedup(inputs.dedupCandidates));
  if (inputs.staleByLifecycle) all.push(...scoreStale(inputs.staleByLifecycle));
  if (inputs.brokenLinks) all.push(...scoreBrokenLinks(inputs.brokenLinks));
  if (inputs.tokenFootprint) all.push(...scoreTokenFootprint(inputs.tokenFootprint));

  all.sort((a, b) => {
    if (b.impact !== a.impact) return b.impact - a.impact;
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Clamp + floor opts.topN so negative or fractional input cannot
  // produce slice(0, -n) (which silently truncates from the tail
  // in JS semantics) or off-by-one truncation.
  const capRaw = opts.topN ?? 10;
  const cap = Number.isFinite(capRaw) ? Math.max(0, Math.floor(capRaw)) : 10;
  return Object.freeze(all.slice(0, cap));
}
