/**
 * The record of which `_brain.yaml` keys the validator understands, and
 * the block-entry protocol that keeps that record honest.
 *
 * One reason to change: how the validator declares and reports its key
 * vocabulary. The index is built BY CONSTRUCTION — a key becomes "known"
 * only because some branch registered it while checking for it — so it
 * can never drift from what the validator actually reads. That drift is
 * the bug class fixed in phase 0, where four blocks were parsed but
 * missing from a hand-maintained list and valid config produced a false
 * "unknown field" warning.
 */

import type { BrainConfigLoadWarning } from "./errors.ts";
import { requireMapBlock } from "./field-checks.ts";

/**
 * The set of configuration keys the validator understands, as observed
 * during one validation run.
 */
export interface BrainConfigKeyIndex {
  readonly topLevel: ReadonlySet<string>;
  /** Block key → sub-keys that block declares. Scalar keys are absent. */
  readonly subKeys: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Mutable accumulator behind {@link BrainConfigKeyIndex}. Every helper
 * that branches on a key registers it here, so the index is a
 * by-construction record of what the validator understands rather than a
 * second list that can drift from the first.
 */
export class KeyIndexCollector implements BrainConfigKeyIndex {
  readonly topLevel = new Set<string>();
  readonly subKeys = new Map<string, ReadonlySet<string>>();

  addTop(key: string): void {
    this.topLevel.add(key);
  }

  addSub(block: string, keys: Iterable<string>): void {
    const merged = new Set(this.subKeys.get(block) ?? []);
    for (const key of keys) merged.add(key);
    this.subKeys.set(block, merged);
  }
}

/**
 * Everything a single block parser needs: the raw root map, the label
 * rendered into error messages, the warning sink, and the key index it
 * must register itself with. Passed as one value so adding a fifth
 * concern later does not re-thread twenty signatures.
 */
export interface BlockParseContext {
  readonly obj: Record<string, unknown>;
  readonly source: string | null;
  readonly warnings: BrainConfigLoadWarning[];
  readonly keys: KeyIndexCollector;
}

/**
 * Record that this call site checked for `key` at the top level, then
 * report whether it's present. Every top-level block/field presence
 * check (`"vault" in obj`, etc.) MUST go through this - or `mergeBlock`,
 * for the four blocks that merge onto numeric defaults instead of being
 * fully optional - so the key index can never drift from the set of keys
 * the validator actually understands. A key that is never checked can
 * never be "known", by construction - there is no separate list to
 * forget to update.
 */
export function hasBlock(
  obj: Record<string, unknown>,
  key: string,
  knownBlockKeys: KeyIndexCollector,
): boolean {
  knownBlockKeys.addTop(key);
  return key in obj;
}

/**
 * Register an optional block and, when present, narrow it to a map.
 * Returns `undefined` for an absent block so the caller's whole body is
 * an early return rather than a nesting level.
 */
export function openBlock(
  ctx: BlockParseContext,
  blockKey: string,
): Record<string, unknown> | undefined {
  if (!hasBlock(ctx.obj, blockKey, ctx.keys)) return undefined;
  return requireMapBlock(ctx.obj[blockKey], blockKey, ctx.source);
}

/**
 * Push one forward-compat warning per key in `map` that isn't in `known`.
 * Replaces the per-block loop that used to mix `Set`, chained `!==`, and
 * (elsewhere) `.includes` for the same "unknown sub-key" check, each with
 * its own copy of the `${blockName}.${key}: unknown field ignored
 * (forward-compat)` message.
 */
export function warnUnknownKeys(
  ctx: BlockParseContext,
  map: Readonly<Record<string, unknown>>,
  known: ReadonlyArray<string>,
  blockName: string,
): void {
  const knownSet = new Set(known);
  ctx.keys.addSub(blockName, knownSet);
  for (const key of Object.keys(map)) {
    if (!knownSet.has(key)) {
      ctx.warnings.push({
        path: ctx.source ?? "<config>",
        message: `${blockName}.${key}: unknown field ignored (forward-compat)`,
      });
    }
  }
}

/**
 * Merge a parsed block (or `undefined`) with its default, returning a
 * plain object whose value types are validated downstream. A non-object
 * block (string, number, array) is a hard error — the user probably
 * miswrote the YAML.
 */
export function mergeBlock(
  blockKey: string,
  raw: unknown,
  fallback: Readonly<Record<string, number>>,
  source: string | null,
  knownBlockKeys: KeyIndexCollector,
  optionalKeys: ReadonlyArray<string> = [],
): Record<string, unknown> {
  knownBlockKeys.addTop(blockKey);
  knownBlockKeys.addSub(blockKey, [...Object.keys(fallback), ...optionalKeys]);
  if (raw === undefined) {
    return { ...fallback };
  }
  const rawMap = requireMapBlock(raw, blockKey, source);
  const merged: Record<string, unknown> = { ...fallback };
  for (const [k, v] of Object.entries(rawMap)) {
    merged[k] = v;
  }
  return merged;
}
