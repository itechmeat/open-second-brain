/**
 * The shared settings fold (design D4, spec "Shared store settings";
 * task 1.6): values every machine must agree on, stored as records in the
 * `settings` stream of the `shared` partition instead of in device-local
 * config, so a change made on one machine applies on every other once the
 * record syncs.
 *
 * Input records:
 *
 *  - `setting-set` `{ authority, key, value }`: proposes `value` for `key`.
 *  - `setting-unset` `{ authority, key }`: a tombstone; the key falls back
 *    to its default.
 *
 * Each key is one register, resolved by authority, then clock. Keys this
 * version knows are validated (see {@link SETTING_RULES}); a record with
 * an invalid value is rejected and does not take effect. Unknown keys
 * (written by a newer release) fold as plain JSON values, so an older
 * machine keeps them instead of losing them.
 */

import {
  SETTING_SET_KIND,
  SETTING_TOPIC_MIN_RECORDS,
  SETTING_TOPIC_MIN_SESSIONS,
  SETTING_UNSET_KIND,
  SETTING_VIEW_LANGUAGE,
  SETTING_VIEW_WRITER,
  type SettingKey,
} from "./constants.ts";
import { isValidDeviceId } from "../config.ts";
import type { StoreRecord } from "./envelope.ts";
import {
  prepareRecords,
  recordAuthority,
  RegisterSet,
  TOMBSTONE,
  type RegisterState,
  type RejectedRecord,
} from "./fold.ts";

/** Setting keys: dot-separated lowercase words with underscores. */
export const SETTING_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,7}$/;

/** Validation and default of a known key. */
interface SettingRule {
  readonly valid: (value: unknown) => boolean;
  readonly expected: string;
  readonly fallback: unknown;
}

const positiveInt = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/** Language tags such as `en`, `ru` or `pt-BR`. */
const LANGUAGE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

/** The keys this version knows: what a valid value is, and the default. */
export const SETTING_RULES: Readonly<Record<SettingKey, SettingRule>> = Object.freeze({
  [SETTING_VIEW_WRITER]: {
    valid: (value) => typeof value === "string" && isValidDeviceId(value),
    expected: "a device id",
    fallback: null,
  },
  [SETTING_VIEW_LANGUAGE]: {
    valid: (value) => typeof value === "string" && LANGUAGE_RE.test(value),
    expected: "a language tag such as en or pt-BR",
    fallback: null,
  },
  [SETTING_TOPIC_MIN_RECORDS]: { valid: positiveInt, expected: "a positive integer", fallback: 5 },
  [SETTING_TOPIC_MIN_SESSIONS]: { valid: positiveInt, expected: "a positive integer", fallback: 2 },
});

function ruleOf(key: string): SettingRule | undefined {
  return Object.hasOwn(SETTING_RULES, key) ? SETTING_RULES[key as SettingKey] : undefined;
}

export interface SettingsFold {
  /** Resolved keys, inserted in code unit order. */
  readonly settings: ReadonlyMap<string, RegisterState<unknown>>;
  readonly rejected: ReadonlyArray<RejectedRecord>;
}

function rejection(record: StoreRecord): string | null {
  if (recordAuthority(record) === null) return "missing or invalid authority";
  const key = record.body["key"];
  if (typeof key !== "string" || !SETTING_KEY_RE.test(key)) return "missing or invalid key";
  if (record.kind === SETTING_UNSET_KIND) return null;
  if (!("value" in record.body) || record.body["value"] === null) return "value is required";
  const rule = ruleOf(key);
  if (rule !== undefined && !rule.valid(record.body["value"])) {
    return `${key} must be ${rule.expected}`;
  }
  return null;
}

/** Fold setting records (any order, duplicates allowed). */
export function foldSettings(input: Iterable<StoreRecord>): SettingsFold {
  const { records } = prepareRecords(input);
  const registers = new RegisterSet<unknown>();
  const rejected: RejectedRecord[] = [];
  for (const record of records) {
    if (record.kind !== SETTING_SET_KIND && record.kind !== SETTING_UNSET_KIND) continue;
    const reason = rejection(record);
    if (reason !== null) {
      rejected.push({ id: record.id, kind: record.kind, reason });
      continue;
    }
    const value = record.kind === SETTING_UNSET_KIND ? TOMBSTONE : record.body["value"];
    registers.offer(record.body["key"] as string, {
      record,
      authority: recordAuthority(record)!,
      value,
    });
  }
  const settings = new Map<string, RegisterState<unknown>>();
  for (const key of registers.keys()) settings.set(key, registers.get(key)!);
  return { settings, rejected };
}

/**
 * The effective value of `key`: the folded value, or the key's default
 * when it was never set or a removal won (`null` for an unknown key).
 */
export function settingValue(fold: SettingsFold, key: string): unknown {
  const state = fold.settings.get(key);
  if (state !== undefined && !state.removed) return state.value;
  return ruleOf(key)?.fallback ?? null;
}

/** The resolved settings as plain JSON, for the state digest. */
export function settingsFingerprint(fold: SettingsFold): unknown {
  const out: Record<string, unknown> = {};
  for (const [key, state] of fold.settings) {
    out[key] = { value: state.value, removed: state.removed, winner: state.winner.record.id };
  }
  return { settings: out, rejected: fold.rejected.map((r) => r.id) };
}
