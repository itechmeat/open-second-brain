/**
 * The store-mode commit of the shared settings writer
 * (`./settings-write.ts`): the records of one settings write appended as
 * one operation, `setting-set`, `setting-unset` or, for one entry of a
 * list setting, `setting-entry` (task 3.12). Split from the writer by
 * cohesion: this is the only part that builds and appends records.
 */

import { forgetDreamOwnerCheck } from "../dream-trigger/forget.ts";
import {
  AUTHORITY_FIELD,
  SETTING_ENTRY_KIND,
  SETTING_DREAM_AUTO,
  SETTING_SET_KIND,
  SETTING_UNSET_KIND,
} from "../../store/constants.ts";
import { assertStoreContentWrite } from "../../store/content-write-gates.ts";
import { IF_DECIDED_BY_FIELD } from "../../store/fold-setting-lists.ts";
import { callerInput, opaqueFields, operationPrivacy } from "../../store/operation-privacy.ts";
import { withOperationPrivacy } from "../../store/operation-scope.ts";
import { storeWrite } from "../../store/store-write.ts";
import { BrainSettingError, type SettingTarget } from "./settings-names.ts";
import { REMOVE_KEY } from "./settings-yaml-edit.ts";
import type { SettingAuthority } from "./settings-names.ts";

/** What a commit needs of a settings write: `BrainSettingsWriteContext` of the writer. */
export interface SettingsCommitContext {
  readonly vault: string | null;
  readonly configPath?: string;
  readonly authority: SettingAuthority;
  readonly agent: string;
}

/** One change of a multi-key store write: a value, {@link REMOVE_KEY}, or one list entry. */
export interface StoreChange {
  readonly target: SettingTarget;
  readonly value: unknown;
  /**
   * One list entry. `ifDecidedBy` makes a removal conditional
   * (`if_decided_by`): it applies only while that record decides the
   * entry's slot, so a replacement it never saw is kept.
   */
  readonly entry?: {
    readonly text: string;
    readonly present: boolean;
    readonly ifDecidedBy?: string;
  };
}

/**
 * Append the records of `changes` as ONE operation: one privacy verdict
 * over the whole caller input, every record in `shared`. Returns the ids
 * written, in order. Refused while this machine is frozen, as the legacy
 * settings write is by the vault guard.
 */
export function storeCommit(
  ctx: SettingsCommitContext,
  changes: ReadonlyArray<StoreChange>,
): string[] {
  assertStoreContentWrite(ctx.vault);
  const bodies = changes.map(({ target, value, entry }) => {
    const body: Record<string, unknown> = { [AUTHORITY_FIELD]: ctx.authority, key: target.key };
    if (entry !== undefined) {
      body["entry"] = entry.text;
      body["present"] = entry.present;
      if (entry.ifDecidedBy !== undefined) body[IF_DECIDED_BY_FIELD] = entry.ifDecidedBy;
    } else if (value !== REMOVE_KEY) body["value"] = value;
    const kind =
      entry !== undefined
        ? SETTING_ENTRY_KIND
        : value === REMOVE_KEY
          ? SETTING_UNSET_KIND
          : SETTING_SET_KIND;
    return { target, kind, body };
  });
  // A shared setting is read from `shared` only, so a value that would
  // route the record to `private` is refused rather than written where no
  // reader looks (one verdict over the whole caller input, fail closed).
  const verdict = operationPrivacy(ctx.vault, {
    content: [
      callerInput(
        bodies.map(({ body }) => ({ key: body["key"], value: body["value"] ?? body["entry"] })),
        opaqueFields("key"),
      ),
    ],
  });
  if (verdict()) {
    throw new BrainSettingError(
      "private_setting_value",
      `${changes.map((c) => c.target.name).join(", ")}: the value names a private page or ` +
        `carries a <private> region; shared settings are read by every machine`,
    );
  }
  const written = withOperationPrivacy(verdict, () =>
    storeWrite(
      () =>
        bodies.map(({ kind, body }) => ({
          stream: "settings" as const,
          kind,
          agent: ctx.agent,
          body,
        })),
      {
        vault: ctx.vault,
        ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
      },
    ),
  );
  // `dream.auto` turned on or off here: the day check of this machine
  // looks at it again today instead of trusting its first look.
  if (changes.some((c) => c.target.key === SETTING_DREAM_AUTO)) {
    forgetDreamOwnerCheck(ctx.configPath);
  }
  return written.map((w) => w.record.id);
}
