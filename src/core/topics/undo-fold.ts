/**
 * Undo resolution of the topic fold (design D8): which topic records an
 * effective `undo` voids. Split from `fold.ts`; pure, like the fold.
 */

import type { StoreRecord } from "../store/envelope.ts";
import { authorityRank, recordAuthority } from "../store/fold.ts";
import { TOPIC_UNDO_KIND } from "./constants.ts";

/**
 * Records voided by an effective undo. An undo cycle (only a forged one)
 * is cut where the walk meets it again: the record it meets counts as not
 * voided there, so the outcome depends only on the canonical record order
 * and is the same on every machine.
 */
export function voidedRecords(records: ReadonlyArray<StoreRecord>): Set<string> {
  const byId = new Map(records.map((r) => [r.id, r]));
  const undoers = new Map<string, StoreRecord[]>();
  for (const r of records) {
    if (r.kind !== TOPIC_UNDO_KIND) continue;
    const target = r.body["record"] as string;
    undoers.set(target, [...(undoers.get(target) ?? []), r]);
  }
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  const isVoided = (id: string): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return false;
    visiting.add(id);
    const target = byId.get(id);
    const rank = target === undefined ? 0 : authorityRank(recordAuthority(target)!);
    const result = (undoers.get(id) ?? []).some(
      (u) => authorityRank(recordAuthority(u)!) >= rank && !isVoided(u.id),
    );
    visiting.delete(id);
    memo.set(id, result);
    return result;
  };
  const out = new Set<string>();
  for (const r of records) if (isVoided(r.id)) out.add(r.id);
  return out;
}
