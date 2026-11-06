/**
 * The generic fold engine of the brain store (design D3, D4; task 1.6).
 *
 * Pure: no I/O, no clock. Every concrete fold (preferences, pinned
 * context, settings) is built from the two pieces here.
 *
 *  - {@link prepareRecords} turns any delivered set of verified records
 *    into one canonical sequence: duplicates collapse by record id (a
 *    record delivered twice is applied once), then the records sort in
 *    fold order (hlc, device, id). The same set gives the same sequence in
 *    any delivery order. Records whose body is still a pending blob
 *    reference are held out, since their content is not known yet.
 *  - {@link RegisterSet} resolves keyed registers by authority, then clock:
 *    a human record beats an agent record, which beats a decision-model
 *    record; within one authority the record later in fold order wins.
 *    Nothing is dropped: every offer stays in the register's history, so a
 *    losing value remains queryable. A removal is an ordinary offer whose
 *    value is the {@link TOMBSTONE}.
 *
 * Records whose kind a fold handles but whose body is malformed are not
 * applied; the fold reports them as rejected so doctor can name them.
 */

import { canonicalJson } from "../integrity/digest.ts";
import { compareCodeUnits } from "./compare.ts";
import { AUTHORITIES, AUTHORITY_FIELD, type Authority } from "./constants.ts";
import { compareRecords, isBlobRef, type StoreRecord } from "./envelope.ts";

/** The value of a register that a removal record decided. */
export const TOMBSTONE: unique symbol = Symbol("tombstone");
export type Tombstone = typeof TOMBSTONE;

/** A record a fold refused to apply, with the reason. */
export interface RejectedRecord {
  readonly id: string;
  readonly kind: string;
  readonly reason: string;
}

/** Two deliveries that share an id but not their content. */
export interface IdConflict {
  readonly id: string;
  /** Number of distinct versions delivered. */
  readonly versions: number;
}

export interface PreparedRecords {
  /** Unique records in fold order. */
  readonly records: ReadonlyArray<StoreRecord>;
  /** Deliveries dropped as exact duplicates of a record already seen. */
  readonly duplicates: number;
  /** Ids delivered with different content; one version was kept deterministically. */
  readonly conflicts: ReadonlyArray<IdConflict>;
  /** Records whose body is a blob that has not arrived (or not verified) yet. */
  readonly pending: ReadonlyArray<StoreRecord>;
}

/**
 * Pick the version of a conflicting id to keep: the smallest in fold
 * order, then by canonical text, so every machine keeps the same one.
 */
function preferVersion(a: StoreRecord, b: StoreRecord): StoreRecord {
  const order = compareRecords(a, b);
  if (order !== 0) return order < 0 ? a : b;
  return canonicalJson(a) <= canonicalJson(b) ? a : b;
}

/** Deduplicate by id, hold out pending bodies, and sort in fold order. */
export function prepareRecords(input: Iterable<StoreRecord>): PreparedRecords {
  const byId = new Map<string, StoreRecord>();
  // Canonical texts of every version delivered, kept only for repeated ids.
  const delivered = new Map<string, Set<string>>();
  let duplicates = 0;
  for (const record of input) {
    const seen = byId.get(record.id);
    if (seen === undefined) {
      byId.set(record.id, record);
      continue;
    }
    let texts = delivered.get(record.id);
    if (texts === undefined) {
      texts = new Set([canonicalJson(seen)]);
      delivered.set(record.id, texts);
    }
    const text = canonicalJson(record);
    if (texts.has(text)) {
      duplicates += 1; // an exact copy of a version already delivered
      continue;
    }
    texts.add(text);
    byId.set(record.id, preferVersion(seen, record));
  }
  const records: StoreRecord[] = [];
  const pending: StoreRecord[] = [];
  for (const record of byId.values()) (isBlobRef(record.body) ? pending : records).push(record);
  records.sort(compareRecords);
  pending.sort(compareRecords);
  const conflicts = [...delivered.entries()]
    .filter(([, texts]) => texts.size > 1)
    .map(([id, texts]) => ({ id, versions: texts.size }))
    .toSorted((a, b) => compareCodeUnits(a.id, b.id));
  return { records, duplicates, conflicts, pending };
}

/** Rank of an authority: higher beats lower. */
export function authorityRank(authority: Authority): number {
  return AUTHORITIES.length - AUTHORITIES.indexOf(authority);
}

/** Whether `value` names an authority. */
export function isAuthority(value: unknown): value is Authority {
  return typeof value === "string" && (AUTHORITIES as ReadonlyArray<string>).includes(value);
}

/**
 * The authority a mutable-entity record carries in its body, or `null`
 * when the field is missing or names no authority. It is never inferred
 * from the agent name.
 */
export function recordAuthority(record: StoreRecord): Authority | null {
  const value = record.body[AUTHORITY_FIELD];
  return isAuthority(value) ? value : null;
}

/** One offer to a register: who said what, and in which record. */
export interface RegisterEntry<V> {
  readonly record: StoreRecord;
  readonly authority: Authority;
  readonly value: V | Tombstone;
}

/** A resolved register. */
export interface RegisterState<V> {
  /** The winning value; `null` when a tombstone won. */
  readonly value: V | null;
  /** Whether a removal won. */
  readonly removed: boolean;
  /** The winning offer. */
  readonly winner: RegisterEntry<V>;
  /** Every offer in fold order, the winner included. */
  readonly history: ReadonlyArray<RegisterEntry<V>>;
}

/** Whether `next` beats `current`, given that `next` comes later in fold order. */
function beats(next: Authority, current: Authority): boolean {
  return authorityRank(next) >= authorityRank(current);
}

/**
 * Keyed registers resolved by authority, then fold order. Offers must
 * arrive in fold order (the order of {@link prepareRecords}); a later
 * offer of the same or a stronger authority takes the register.
 */
export class RegisterSet<V> {
  readonly #winners = new Map<string, RegisterEntry<V>>();
  readonly #history = new Map<string, RegisterEntry<V>[]>();

  offer(key: string, entry: RegisterEntry<V>): void {
    const current = this.#winners.get(key);
    if (current === undefined || beats(entry.authority, current.authority)) {
      this.#winners.set(key, entry);
    }
    const history = this.#history.get(key) ?? [];
    history.push(entry);
    this.#history.set(key, history);
  }

  get(key: string): RegisterState<V> | undefined {
    const winner = this.#winners.get(key);
    if (winner === undefined) return undefined;
    const removed = winner.value === TOMBSTONE;
    return {
      value: removed ? null : (winner.value as V),
      removed,
      winner,
      history: this.#history.get(key)!,
    };
  }

  /** Keys in code unit order. */
  keys(): string[] {
    return [...this.#winners.keys()].toSorted();
  }
}
