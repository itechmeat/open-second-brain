import { estimateTokens } from "./text/tokenizer.ts";

export interface ContextTransformOptions {
  readonly cacheStableOrdering?: boolean;
  readonly deduplicateRepeatedContext?: boolean;
}

export interface ContextTransformAnnotations {
  readonly originalRank?: number;
  readonly stableRank?: number;
  readonly dedupedFrom?: string;
  readonly referenceHint?: string;
}

export interface ContextTransformItem {
  readonly id: string;
  readonly path: string;
  readonly body: string;
  readonly tokens: number;
}

function compareStable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The delivered text a deduplicated repeated item carries: one
 * deterministic sentence naming the first copy. Shared with the receipt
 * verify kernel, whose re-derivation must produce the same bytes the
 * writer delivered, so the two cannot drift about the replacement's
 * spelling.
 */
export function dedupReplacementText(firstId: string): string {
  return `Repeated context omitted; see ${firstId}.`;
}

export function applyContextTransforms<T extends ContextTransformItem>(
  items: ReadonlyArray<T>,
  opts: ContextTransformOptions | undefined,
): ReadonlyArray<T & ContextTransformAnnotations> {
  if (!opts?.cacheStableOrdering && !opts?.deduplicateRepeatedContext)
    return Object.freeze([...items]);

  const ranked = items.map((item, index) => ({
    item,
    originalRank: index + 1,
  }));
  if (opts.cacheStableOrdering) {
    ranked.sort(
      (a, b) => compareStable(a.item.id, b.item.id) || compareStable(a.item.path, b.item.path),
    );
  }

  const firstByBody = new Map<string, string>();
  const transformed = ranked.map(({ item, originalRank }, index) => {
    const base: T & ContextTransformAnnotations = {
      ...item,
      originalRank,
      ...(opts.cacheStableOrdering ? { stableRank: index + 1 } : {}),
    };
    if (!opts.deduplicateRepeatedContext) return base;

    const bodyKey = item.body.trim();
    if (bodyKey.length === 0) return base;
    const firstId = firstByBody.get(bodyKey);
    if (firstId === undefined) {
      firstByBody.set(bodyKey, item.id);
      return base;
    }

    const body = dedupReplacementText(firstId);
    return {
      ...base,
      body,
      tokens: estimateTokens(body),
      dedupedFrom: firstId,
      referenceHint: `see ${firstId}`,
    };
  });

  return Object.freeze(transformed);
}
