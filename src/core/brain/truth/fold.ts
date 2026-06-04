/**
 * The truth fold (t_d6849b56): a deterministic, order-insensitive
 * projection of claim events into per-(entity, aspect) slots. The
 * fold sorts its input internally, so the same event set always
 * produces the same state regardless of shard arrival order - the
 * `computeActivationState` discipline applied to claims.
 *
 * Conflict detection (t_e9692750) extends this fold in
 * `conflicts.ts`; the base fold keeps `conflicts` empty and
 * `contested: false` so the ledger core has no policy baked in.
 */

import { normalizeEntityName } from "../entities/canonical.ts";
import type { ClaimEvent, ClaimSlot, ClaimVersion, TruthState } from "./types.ts";
import { TRUTH_SCHEMA_VERSION } from "./types.ts";

/** Superseded values kept per slot, newest first. */
export const SLOT_HISTORY_CAP = 20;

/** Identity used to group claims into one addressable slot. */
export function slotKey(entity: string, aspect: string): string {
  return `${normalizeEntityName(entity)}\n${normalizeEntityName(aspect)}`;
}

/** Value identity inside a slot: case- and whitespace-insensitive. */
export function normalizeClaimValue(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Stable total order over events: (ts, agent, source, value). */
function compareEvents(a: ClaimEvent, b: ClaimEvent): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.agent !== b.agent) return a.agent < b.agent ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.value !== b.value) return a.value < b.value ? -1 : 1;
  return 0;
}

interface VersionAccumulator {
  value: string;
  valueKind: ClaimVersion["valueKind"];
  quantity: ClaimVersion["quantity"];
  ts: string;
  agent: string;
  source: string;
  assertCount: number;
}

function freezeVersion(acc: VersionAccumulator): ClaimVersion {
  return Object.freeze({
    value: acc.value,
    valueKind: acc.valueKind,
    ...(acc.quantity !== undefined ? { quantity: acc.quantity } : {}),
    ts: acc.ts,
    agent: acc.agent,
    source: acc.source,
    assertCount: acc.assertCount,
  });
}

/**
 * Fold claim events into the derived truth state. Consecutive
 * re-assertions of one value collapse into a single version whose
 * `ts`/`agent`/`source` track the latest assertion and whose
 * `assertCount` counts every one; a different value opens a new
 * version and pushes the previous one into history (bounded to
 * {@link SLOT_HISTORY_CAP}, newest first).
 */
export function computeTruthState(events: ReadonlyArray<ClaimEvent>): TruthState {
  const ordered = [...events].toSorted(compareEvents);
  const byKey = new Map<string, VersionAccumulator[]>();
  let latestTs: string | null = null;

  for (const e of ordered) {
    if (latestTs === null || e.ts > latestTs) latestTs = e.ts;
    const key = slotKey(e.entity, e.aspect);
    const versions = byKey.get(key) ?? [];
    const last = versions.at(-1);
    if (last !== undefined && normalizeClaimValue(last.value) === normalizeClaimValue(e.value)) {
      last.ts = e.ts;
      last.agent = e.agent;
      last.source = e.source;
      last.assertCount++;
      if (e.quantity !== undefined) last.quantity = e.quantity;
    } else {
      versions.push({
        value: e.value,
        valueKind: e.valueKind,
        quantity: e.quantity,
        ts: e.ts,
        agent: e.agent,
        source: e.source,
        assertCount: 1,
      });
    }
    byKey.set(key, versions);
  }

  const slots: ClaimSlot[] = [];
  for (const key of [...byKey.keys()].toSorted()) {
    const versions = byKey.get(key)!;
    const [entity, aspect] = key.split("\n") as [string, string];
    const current = versions.at(-1)!;
    const history = versions
      .slice(0, -1)
      .toReversed()
      .slice(0, SLOT_HISTORY_CAP)
      .map(freezeVersion);
    slots.push(
      Object.freeze({
        entity,
        aspect,
        current: freezeVersion(current),
        history: Object.freeze(history),
        contested: false,
      }),
    );
  }

  return Object.freeze({
    version: TRUTH_SCHEMA_VERSION,
    events: events.length,
    updatedAt: latestTs,
    slots: Object.freeze(slots),
    conflicts: Object.freeze([]),
  });
}
