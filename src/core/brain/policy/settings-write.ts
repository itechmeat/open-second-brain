/**
 * The one writer of shared brain settings (design D4, D14 item 3): what
 * `o2b brain settings get|set|unset|list` and the `brain_settings` MCP tool
 * call.
 *
 *  - **Store-only machine** (`../../store/store-only.ts`, also with no
 *    vault): a `set` appends one `setting-set` record, an `unset` one
 *    `setting-unset` record, to the `settings` stream of `shared`, under
 *    the key the migration uses (`brain.<block>.<field>`, `brain.<key>`
 *    for a scalar). Nothing is written under the vault's `Brain/`. The
 *    authority is the caller's: `human` from the CLI, `agent` from MCP.
 *    The settings fold resolves by authority, then clock, so an agent
 *    record could never displace a human one; such a write is refused
 *    instead of being written and ignored.
 *  - **Unswitched machine**: the key is edited in place in
 *    `Brain/_brain.yaml` (`./settings-yaml-edit.ts`), as before the store.
 *
 * A store-native setting (`STORE_NATIVE_SETTINGS` in `./settings-names.ts`,
 * such as `view.language`) has no `_brain.yaml` home: it is a store record
 * under its own key on every machine, switched or not, checked by its own
 * validator.
 *
 * An operator-only key (`OPERATOR_ONLY_SETTINGS` in `./settings-keys.ts`:
 * the integrity gates, the read, index, capture and write boundaries, the
 * promotion guardrails) is refused to an agent in both modes.
 *
 * Only `shared` keys of the classification (`./settings-keys.ts`) are
 * written. A `device` key is answered with the machine-config line to add
 * instead, and `schema_version` is no setting. Every value goes through
 * the same validator `_brain.yaml` goes through, over the settings in
 * force, before anything is written.
 */

import { existsSync, readFileSync } from "node:fs";
import lockfile from "proper-lockfile";

import { canonicalJson } from "../../integrity/digest.ts";
import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { AUTHORITY_FIELD, SETTING_SET_KIND, SETTING_UNSET_KIND } from "../../store/constants.ts";
import { foldSettings, type SettingsFold } from "../../store/fold-settings.ts";
import { callerInput, opaqueFields, operationPrivacy } from "../../store/operation-privacy.ts";
import { withOperationPrivacy } from "../../store/operation-scope.ts";
import { protectionStore, StoreUnavailableError } from "../../store/read/protection-store.ts";
import { readStreamRecords } from "../../store/read/stream-read.ts";
import { storeOnlyMode } from "../../store/store-only.ts";
import type { StoreInspection } from "../../store/store-open.ts";
import { storeWrite } from "../../store/store-write.ts";
import { brainConfigPath } from "../paths.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { parseBrainYaml } from "../yaml-parse.ts";
import { BrainConfigError } from "./errors.ts";
import { readRawBrainSettingsFromStore } from "./settings-source.ts";
import {
  BrainSettingError,
  defaultOf,
  isYamlValue,
  KEY_PREFIX,
  resolveSettingName,
  STORE_NATIVE_SETTINGS,
  withDeviceValue,
  type SettingAuthority,
  type SettingTarget,
} from "./settings-names.ts";
import { BRAIN_YAML_KEYS, isOperatorOnlySetting } from "./settings-keys.ts";
import {
  editBrainYamlKey,
  REMOVE_KEY,
  UnrepresentableValueError,
  type YamlSettingValue,
} from "./settings-yaml-edit.ts";
import { validateBrainConfigDetailed } from "./validate.ts";

export {
  BrainSettingError,
  parseSettingValue,
  resolveSettingName,
  type BrainSettingErrorCode,
  type SettingAuthority,
} from "./settings-names.ts";

/** Where a settings read looks. */
export interface BrainSettingsReadContext {
  /** The vault (`null`: none configured, which reads the store). */
  readonly vault: string | null;
  readonly configPath?: string;
}

export interface BrainSettingsWriteContext extends BrainSettingsReadContext {
  readonly authority: SettingAuthority;
  /** The writing agent's name, stamped on the record. */
  readonly agent: string;
}

/** Where the settings of this machine live. */
export type BrainSettingsMode = "store" | "legacy";

/** The answer of {@link getBrainSetting}, one row of {@link listBrainSettings}. */
export interface BrainSettingView {
  /** `<block>.<field>`, or the scalar key. */
  readonly name: string;
  /** The store setting key, `brain.<name>`. */
  readonly key: string;
  /** Whether a value is set (a record in force, or a line in `_brain.yaml`). */
  readonly set: boolean;
  /** The set value; `null` when none is set and the default applies. */
  readonly value: unknown;
  /** The shipped default, when there is one. */
  readonly default?: unknown;
  /** The authority of the record in force (store only). */
  readonly authority?: string;
  /** The id of the record in force (store only). */
  readonly record?: string;
  readonly source: "store" | "brain-yaml" | "default";
}

export interface BrainSettingWrite {
  readonly name: string;
  readonly key: string;
  /** The value now in force (`null` after an unset). */
  readonly value: unknown;
  readonly previous: unknown;
  readonly changed: boolean;
  readonly mode: BrainSettingsMode;
  /** The id of the record written (store mode, when something changed). */
  readonly record?: string;
}

function modeOf(ctx: BrainSettingsReadContext): BrainSettingsMode {
  if (ctx.vault === null) return "store";
  const mode = storeOnlyMode({
    vault: ctx.vault,
    ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
  });
  return mode.storeOnly ? "store" : "legacy";
}

// ----- Store mode -------------------------------------------------------------

/** The shared settings fold, with the shards it could not see. */
interface SharedRead {
  readonly fold: SettingsFold;
  /** `shared/<rel>` of settings shards unreadable, or gone since this machine read them. */
  readonly unseen: ReadonlyArray<string>;
}

function sharedRead(ctx: BrainSettingsReadContext): SharedRead {
  let store: StoreInspection | null;
  try {
    store = protectionStore(ctx.configPath, { needShared: true });
  } catch (err) {
    if (!(err instanceof StoreUnavailableError)) throw err;
    // A switched machine whose store cannot be opened: the operator's
    // value is unknown, as with an unseen shard.
    return { fold: foldSettings([]), unseen: [err.message] };
  }
  if (store === null || !store.partitions.has("shared")) {
    return { fold: foldSettings([]), unseen: [] };
  }
  const read = readStreamRecords(store.root, "shared", { stream: "settings" });
  return {
    fold: foldSettings(read.records),
    unseen: read.unreadable.map((rel) => `shared/${rel}`),
  };
}

function sharedFold(ctx: BrainSettingsReadContext): SettingsFold {
  return sharedRead(ctx).fold;
}

/**
 * Refuse an agent's store write while a settings shard cannot be seen: the
 * operator's value of the setting may be in it, and whether it is in
 * force decides the write (design D14, fail closed). The operator's own
 * writes go on: a human value outranks every other.
 */
function refuseUnseen(target: SettingTarget, read: SharedRead, authority: SettingAuthority) {
  if (authority === "human" || read.unseen.length === 0) return;
  throw new BrainSettingError(
    "settings_unreadable",
    `${target.name} cannot be changed by an agent while a shared settings shard cannot be read ` +
      `(${read.unseen.join(", ")}): the operator's value may be in it. Run \`o2b brain doctor\`, ` +
      "then retry once the shard reads again",
  );
}

function storeView(target: SettingTarget, fold: SettingsFold): BrainSettingView {
  const state = fold.settings.get(target.key);
  const fallback =
    target.native !== undefined ? target.native.default : defaultOf(target.block, target.field);
  const base = {
    name: target.name,
    key: target.key,
    ...(fallback !== undefined ? { default: fallback } : {}),
  };
  if (state === undefined || state.removed) {
    return { ...base, set: false, value: null, source: "default" };
  }
  return {
    ...base,
    set: true,
    value: state.value,
    authority: state.winner.authority,
    record: state.winner.record.id,
    source: "store",
  };
}

/** Validate `raw` with `value` placed at the target; throws `invalid_setting_value`. */
function validateCandidate(
  raw: Record<string, unknown>,
  target: SettingTarget,
  value: unknown,
  source: string,
): void {
  const candidate: Record<string, unknown> = { ...raw };
  if (target.field === undefined) {
    if (value === REMOVE_KEY) delete candidate[target.block];
    else candidate[target.block] = value;
  } else {
    const current = candidate[target.block];
    const block: Record<string, unknown> =
      current !== null && typeof current === "object" && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {};
    if (value === REMOVE_KEY) delete block[target.field];
    else block[target.field] = value;
    candidate[target.block] = block;
  }
  let config;
  try {
    ({ config } = validateBrainConfigDetailed(candidate, source));
  } catch (err) {
    if (err instanceof BrainConfigError)
      throw new BrainSettingError("invalid_setting_value", err.message);
    throw err;
  }
  // Block parsers drop a field they do not read without a warning, so a
  // field is known when it has a shipped default or survives validation.
  if (value === REMOVE_KEY || target.field === undefined) return;
  if (defaultOf(target.block, target.field) !== undefined) return;
  const block = (config as unknown as Record<string, unknown>)[target.block];
  const known =
    block !== null &&
    typeof block === "object" &&
    Object.hasOwn(block as Record<string, unknown>, target.field);
  if (!known)
    throw new BrainSettingError("unknown_setting", `"${target.name}" is not a brain setting`);
}

/**
 * Refuse an agent's write to an operator-only setting (`settings-keys.ts`
 * `OPERATOR_ONLY_SETTINGS`), in both modes and whether or not the
 * operator ever set it: such a key holds a safety or privacy boundary.
 */
function refuseOperatorOnly(target: SettingTarget, authority: SettingAuthority): void {
  if (authority === "human") return;
  if (
    target.native !== undefined
      ? target.native.operatorOnly !== true
      : !isOperatorOnlySetting(target.block, target.field)
  )
    return;
  throw new BrainSettingError(
    "operator_only_setting",
    `${target.name} holds a safety or privacy boundary; only the operator sets it. ` +
      `Ask the operator to run \`o2b brain settings set ${target.name} <value>\` or ` +
      `\`o2b brain settings unset ${target.name}\``,
  );
}

function refuseOverHuman(target: SettingTarget, fold: SettingsFold, authority: SettingAuthority) {
  const state = fold.settings.get(target.key);
  if (authority === "human" || state === undefined || state.winner.authority !== "human") return;
  throw new BrainSettingError(
    "human_value_in_force",
    `${target.name} was ${state.removed ? "reset to its default" : "set"} by the operator ` +
      "(human authority); an agent cannot change it. " +
      `Ask the operator to run \`o2b brain settings set ${target.name} <value>\` or ` +
      `\`o2b brain settings unset ${target.name}\``,
  );
}

/**
 * The legacy twin of {@link refuseOverHuman}: `_brain.yaml` records no
 * authority, so a value that differs from the shipped default is taken
 * as the operator's, and an agent may neither change nor unset it. A key
 * still at its default (or absent) stays the agent's to change.
 */
function refuseOverOperatorYaml(
  target: SettingTarget,
  before: BrainSettingView,
  fallback: unknown,
  authority: SettingAuthority,
): void {
  if (authority === "human" || !before.set) return;
  if (fallback !== undefined && canonicalJson(before.value) === canonicalJson(fallback)) return;
  throw new BrainSettingError(
    "human_value_in_force",
    `${target.name} counts as the operator's: this settings file records no author, and the ` +
      "value differs from the shipped default (an agent's own earlier write included); an " +
      `agent cannot change it. Ask the operator to run \`o2b brain settings set ${target.name} ` +
      `<value>\` or \`o2b brain settings unset ${target.name}\``,
  );
}

/** One change of a multi-key store write: a value, or {@link REMOVE_KEY}. */
interface StoreChange {
  readonly target: SettingTarget;
  readonly value: unknown;
}

/**
 * Append the records of `changes` as ONE operation: one privacy verdict
 * over the whole caller input, every record in `shared`. Returns the ids
 * written, in order.
 */
function storeCommit(
  ctx: BrainSettingsWriteContext,
  changes: ReadonlyArray<StoreChange>,
): string[] {
  const bodies = changes.map(({ target, value }) => {
    const body: Record<string, unknown> = { [AUTHORITY_FIELD]: ctx.authority, key: target.key };
    if (value !== REMOVE_KEY) body["value"] = value;
    return { target, value, body };
  });
  // A shared setting is read from `shared` only, so a value that would
  // route the record to `private` is refused rather than written where no
  // reader looks (one verdict over the whole caller input, fail closed).
  const verdict = operationPrivacy(ctx.vault, {
    content: [
      callerInput(
        bodies.map(({ body }) => ({ key: body["key"], value: body["value"] })),
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
        bodies.map(({ value, body }) => ({
          stream: "settings" as const,
          kind: value === REMOVE_KEY ? SETTING_UNSET_KIND : SETTING_SET_KIND,
          agent: ctx.agent,
          body,
        })),
      {
        vault: ctx.vault,
        ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
      },
    ),
  );
  return written.map((w) => w.record.id);
}

/** A change of {@link writeSharedSettingRecords}: a value, or `null` to unset. */
export interface SharedSettingRecordChange {
  readonly name: string;
  /** The new value; `null` writes a `setting-unset`. */
  readonly value: unknown;
}

/**
 * Write several shared settings as one store operation, for a writer
 * that validated the values itself against a richer validator than the
 * settings one (the schema pack). Store mode only: the names are
 * classified, and an agent change to a key the operator set is refused
 * for the whole batch before anything is written. Unchanged keys are
 * skipped. Returns the ids of the records written.
 */
export function writeSharedSettingRecords(
  ctx: BrainSettingsWriteContext,
  changes: ReadonlyArray<SharedSettingRecordChange>,
): string[] {
  // An unswitched reader ignores settings records: written there, they
  // would change nothing anyone reads.
  if (modeOf(ctx) !== "store") {
    throw new Error("writeSharedSettingRecords: store mode only (this machine reads _brain.yaml)");
  }
  const read = sharedRead(ctx);
  const fold = read.fold;
  const pending: StoreChange[] = [];
  for (const change of changes) {
    const target = resolveSettingName(change.name);
    refuseOperatorOnly(target, ctx.authority);
    refuseUnseen(target, read, ctx.authority);
    const before = storeView(target, fold);
    const value = change.value === null ? REMOVE_KEY : change.value;
    const same =
      value === REMOVE_KEY
        ? !before.set
        : before.set && canonicalJson(before.value) === canonicalJson(value);
    if (same) continue;
    refuseOverHuman(target, fold, ctx.authority);
    pending.push({ target, value });
  }
  return pending.length === 0 ? [] : storeCommit(ctx, pending);
}

// ----- Legacy mode ------------------------------------------------------------

function readYaml(vault: string): { path: string; text: string } {
  const path = brainConfigPath(vault);
  if (!existsSync(path)) {
    throw new BrainSettingError(
      "no_settings_file",
      "this vault has no brain settings file yet; run `o2b brain init` first",
    );
  }
  return { path, text: readFileSync(path, "utf8") };
}

function yamlView(target: SettingTarget, parsed: Record<string, unknown>): BrainSettingView {
  const top = parsed[target.block];
  const value =
    target.field === undefined
      ? top
      : top !== null && typeof top === "object" && !Array.isArray(top)
        ? (top as Record<string, unknown>)[target.field]
        : undefined;
  const fallback = defaultOf(target.block, target.field);
  const set = value !== undefined;
  return {
    name: target.name,
    key: target.key,
    set,
    value: set ? value : null,
    ...(fallback !== undefined ? { default: fallback } : {}),
    source: set ? "brain-yaml" : "default",
  };
}

/**
 * Run `fn` holding the lock `schema-mutate.ts` takes on `_brain.yaml`
 * (proper-lockfile's `<file>.lock`), so a settings write and a schema
 * mutation, or two settings writes, never both read the old text and
 * lose one edit. The sync API has no retries, so it spins briefly (about
 * one second). The spin blocks this process's event loop: a holder of the
 * lock in the same process (an async `withFileLock` of a schema mutation
 * in a long-lived MCP server) cannot release it meanwhile, so the write
 * fails with the lock-holder error and is retried by its caller.
 */
function withSettingsFileLock<T>(path: string, fn: () => T): T {
  let release: (() => void) | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < 40 && release === null; attempt++) {
    try {
      release = lockfile.lockSync(path, { stale: 30_000, realpath: false });
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code !== "ELOCKED") throw exc;
      lastError = exc;
      Bun.sleepSync(25);
    }
  }
  if (release === null) {
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`another writer holds the brain settings file lock: ${msg}`);
  }
  try {
    return fn();
  } finally {
    release();
  }
}

/**
 * Run `fn` over the settings file's text under its lock, after the write
 * guard; a missing file refuses before the lock is taken.
 */
function legacyLocked<T>(vault: string, fn: (text: string) => T): T {
  assertVaultIdentityForWrite(vault);
  const { path } = readYaml(vault);
  return withSettingsFileLock(path, () => fn(readYaml(vault).text));
}

function legacyCommitLocked(vault: string, target: SettingTarget, requested: unknown): void {
  // A block in the file must carry its required fields, so an unset of a
  // block field writes the shipped default; a top-level key is removed.
  const fallback = defaultOf(target.block, target.field);
  const value =
    requested === REMOVE_KEY &&
    target.field !== undefined &&
    fallback !== undefined &&
    isYamlValue(fallback)
      ? fallback
      : requested;
  const { path, text } = readYaml(vault);
  let next: string;
  try {
    next = editBrainYamlKey(
      text,
      target.block,
      target.field,
      value === REMOVE_KEY ? REMOVE_KEY : (value as YamlSettingValue),
    );
  } catch (err) {
    if (err instanceof UnrepresentableValueError) {
      throw new BrainSettingError("invalid_setting_value", `${target.name}: ${err.message}`);
    }
    throw err;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseBrainYaml(next) as Record<string, unknown>;
  } catch (err) {
    throw new BrainSettingError(
      "invalid_setting_value",
      `${target.name}: ${(err as Error).message}`,
    );
  }
  const back = readBack(parsed, target);
  validateCandidate(parsed, target, back === undefined ? REMOVE_KEY : back, path);
  const wanted = value === REMOVE_KEY ? undefined : value;
  if (
    (back === undefined) !== (wanted === undefined) ||
    canonicalJson(back ?? null) !== canonicalJson(wanted ?? null)
  ) {
    throw new BrainSettingError(
      "invalid_setting_value",
      `${target.name}: the value cannot be written to the settings file as given`,
    );
  }
  atomicWriteFileSync(path, next);
}

function readBack(parsed: Record<string, unknown>, target: SettingTarget): unknown {
  const top = parsed[target.block];
  if (target.field === undefined) return top;
  return top !== null && typeof top === "object" && !Array.isArray(top)
    ? (top as Record<string, unknown>)[target.field]
    : undefined;
}

// ----- Public operations ------------------------------------------------------

/** The value of one shared setting on this machine. */
export function getBrainSetting(ctx: BrainSettingsReadContext, name: string): BrainSettingView {
  const target = resolveSettingName(name);
  if (target.native !== undefined || modeOf(ctx) === "store") {
    return storeView(target, sharedFold(ctx));
  }
  const { text } = readYaml(ctx.vault!);
  return yamlView(target, parseBrainYaml(text) as Record<string, unknown>);
}

/** The store-native settings that are set, read from the store in either mode. */
function nativeViews(ctx: BrainSettingsReadContext): BrainSettingView[] {
  const fold = sharedFold(ctx);
  return Object.keys(STORE_NATIVE_SETTINGS)
    .map((name) => storeView(resolveSettingName(name), fold))
    .filter((view) => view.set);
}

/** Every shared setting that is set on this machine, sorted by name. */
export function listBrainSettings(ctx: BrainSettingsReadContext): {
  readonly mode: BrainSettingsMode;
  readonly settings: ReadonlyArray<BrainSettingView>;
} {
  const mode = modeOf(ctx);
  const names: string[] = [];
  const native = nativeViews(ctx);
  if (mode === "store") {
    const fold = sharedFold(ctx);
    for (const [key, state] of fold.settings) {
      if (!key.startsWith(KEY_PREFIX) || state.removed) continue;
      names.push(key.slice(KEY_PREFIX.length));
    }
    const settings = names
      .flatMap((n) => {
        try {
          return [storeView(resolveSettingName(n), fold)];
        } catch {
          return []; // a key this release does not classify, or a device key
        }
      })
      .concat(native)
      .toSorted((a, b) => (a.name < b.name ? -1 : 1));
    return { mode, settings };
  }
  // A vault with no settings file yet has no legacy keys; the store-native
  // ones are still listed, as `get` answers them.
  const parsed = existsSync(brainConfigPath(ctx.vault!))
    ? (parseBrainYaml(readYaml(ctx.vault!).text) as Record<string, unknown>)
    : {};
  for (const [block, value] of Object.entries(parsed)) {
    if (!Object.hasOwn(BRAIN_YAML_KEYS, block)) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const field of Object.keys(value)) names.push(`${block}.${field}`);
    } else {
      names.push(block);
    }
  }
  const settings = names
    .flatMap((n) => {
      try {
        return [yamlView(resolveSettingName(n), parsed)];
      } catch {
        return [];
      }
    })
    .concat(native)
    .toSorted((a, b) => (a.name < b.name ? -1 : 1));
  return { mode, settings };
}

/** Set one shared setting; see the module docblock. */
export function setBrainSetting(
  ctx: BrainSettingsWriteContext,
  name: string,
  value: unknown,
): BrainSettingWrite {
  let target: SettingTarget;
  try {
    target = resolveSettingName(name);
  } catch (err) {
    throw withDeviceValue(err, value);
  }
  const nativeProblem = target.native?.invalid(value) ?? null;
  if (nativeProblem !== null) throw new BrainSettingError("invalid_setting_value", nativeProblem);
  if (!isYamlValue(value)) {
    throw new BrainSettingError(
      "invalid_setting_value",
      `${target.name}: a setting value is a string, number, boolean, null or a list of those`,
    );
  }
  return write(ctx, target, value);
}

/** Remove one shared setting so its default applies again. */
export function unsetBrainSetting(ctx: BrainSettingsWriteContext, name: string): BrainSettingWrite {
  return write(ctx, resolveSettingName(name), REMOVE_KEY);
}

function write(
  ctx: BrainSettingsWriteContext,
  target: SettingTarget,
  value: unknown,
): BrainSettingWrite {
  refuseOperatorOnly(target, ctx.authority);
  const removing = value === REMOVE_KEY;
  const native = target.native !== undefined;
  if (native || modeOf(ctx) === "store") {
    const read = sharedRead(ctx);
    refuseUnseen(target, read, ctx.authority);
    const fold = read.fold;
    const before = storeView(target, fold);
    const same = removing
      ? !before.set
      : before.set && canonicalJson(before.value) === canonicalJson(value);
    const result = {
      name: target.name,
      key: target.key,
      value: removing ? null : value,
      previous: before.value,
      mode: "store" as const,
    };
    if (same) return { ...result, value: before.value, changed: false };
    refuseOverHuman(target, fold, ctx.authority);
    if (!native) {
      validateCandidate(
        readRawBrainSettingsFromStore(
          ctx.configPath !== undefined ? { configPath: ctx.configPath } : {},
        ),
        target,
        value,
        "brain settings",
      );
    }
    const [record] = storeCommit(ctx, [{ target, value }]);
    return { ...result, changed: true, ...(record !== undefined ? { record } : {}) };
  }
  const vault = ctx.vault!;
  // The read the comparison and the refusal judge, and the edit, are one
  // section under the file lock: an operator edit landing in between is
  // judged, never overwritten from a stale read.
  return legacyLocked(vault, (text) => {
    const before = yamlView(target, parseBrainYaml(text) as Record<string, unknown>);
    const fallback = defaultOf(target.block, target.field);
    const same = removing
      ? !before.set ||
        (fallback !== undefined && canonicalJson(before.value) === canonicalJson(fallback))
      : before.set && canonicalJson(before.value) === canonicalJson(value);
    const result = {
      name: target.name,
      key: target.key,
      value: removing ? null : value,
      previous: before.value,
      mode: "legacy" as const,
    };
    if (same) return { ...result, value: before.value, changed: false };
    refuseOverOperatorYaml(target, before, fallback, ctx.authority);
    legacyCommitLocked(vault, target, value);
    return { ...result, changed: true };
  });
}
