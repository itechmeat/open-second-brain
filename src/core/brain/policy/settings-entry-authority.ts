/**
 * Who decides one entry of a list setting (task 3.12, design D19 item 1),
 * for the shared settings writer (`./settings-write.ts`): an entry folds
 * as its own register (`../../store/fold-setting-lists.ts`), so an agent's
 * change of an entry a stronger authority decided would be ignored by the
 * fold, and is refused instead of written. A whole-list write or unset of
 * a key folded per entry is judged the same way, for every entry it would
 * change.
 */

import { SETTING_SET_KIND, SETTING_UNSET_KIND, type Authority } from "../../store/constants.ts";
import { authorityRank, type RegisterState } from "../../store/fold.ts";
import { settingEntrySlot } from "../../store/fold-setting-lists.ts";
import type { SettingsFold } from "../../store/fold-settings.ts";
import { BrainSettingError, type SettingAuthority, type SettingTarget } from "./settings-names.ts";

/** The authority that decides the entry slot `slot` of a list setting now, if any record does. */
function slotAuthority(fold: SettingsFold, key: string, slot: string): Authority | undefined {
  const named = fold.lists.get(key)?.get(slot);
  if (named !== undefined) return named.winner.authority;
  const state = fold.settings.get(key);
  if (state === undefined) return undefined;
  // A slot no record named yet is decided by the whole-list records alone
  // (a `setting-set` or `setting-unset` offers it as absent once it is
  // named), so the strongest of those decides it; entry records of other
  // slots do not.
  let strongest: Authority | undefined;
  for (const offer of state.history) {
    if (offer.record.kind !== SETTING_SET_KIND && offer.record.kind !== SETTING_UNSET_KIND)
      continue;
    if (strongest === undefined || authorityRank(offer.authority) > authorityRank(strongest)) {
      strongest = offer.authority;
    }
  }
  return strongest;
}

/**
 * The id of the record that decides the slot of `entry` in the list
 * setting `key` now: the slot's own winning offer once an entry record
 * named it, else the key's winning whole-list record; `null` when no record
 * decides the key.
 */
export function slotDecider(fold: SettingsFold, key: string, entry: string): string | null {
  const named = fold.lists.get(key)?.get(settingEntrySlot(key, entry));
  if (named !== undefined) return named.winner.record.id;
  return fold.settings.get(key)?.winner.record.id ?? null;
}

function refuseSlot(
  target: SettingTarget,
  fold: SettingsFold,
  slot: string,
  shown: string,
  authority: SettingAuthority,
): void {
  const decided = slotAuthority(fold, target.key, slot);
  if (decided === undefined || authorityRank(decided) <= authorityRank(authority)) return;
  throw new BrainSettingError(
    "human_value_in_force",
    `${target.name}: the entry "${shown}" was decided by the operator (human authority); an ` +
      "agent cannot change it. Ask the operator to make the change with " +
      "`o2b brain schema apply`",
  );
}

/** Refuse an agent's change of one entry a stronger authority decides. */
export function refuseOverStrongerEntry(
  target: SettingTarget,
  fold: SettingsFold,
  entry: string,
  authority: SettingAuthority,
): void {
  refuseSlot(target, fold, settingEntrySlot(target.key, entry), entry, authority);
}

/**
 * Refuse an agent's whole-list write (`value`, or `null` for an unset) of
 * a key folded per entry when any entry slot it would change, added,
 * removed or respelled, is decided by a stronger authority (finding 1 of
 * the task 3.12 review). A slot is the normalised form the pack parser
 * reads, so a variant spelling is the same slot, not a second one.
 */
export function refuseWholeListOverStrongerEntries(
  target: SettingTarget,
  fold: SettingsFold,
  value: unknown,
  authority: SettingAuthority,
): void {
  const slots: ReadonlyMap<string, RegisterState<string>> = fold.lists.get(target.key) ?? new Map();
  const requested = new Map<string, string>();
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = String(item);
      requested.set(settingEntrySlot(target.key, text), text);
    }
  }
  for (const slot of new Set([...slots.keys(), ...requested.keys()])) {
    const state = slots.get(slot);
    const before = state === undefined || state.removed ? undefined : state.value;
    const after = requested.get(slot);
    if (before === after) continue;
    refuseSlot(target, fold, slot, after ?? before ?? slot, authority);
  }
}
