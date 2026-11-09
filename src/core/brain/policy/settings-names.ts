/**
 * Names, classification and values of the shared brain settings: the
 * part of `./settings-write.ts` that touches no storage. A name is
 * `<block>.<field>` (or a scalar key such as `primary_agent`, with an
 * optional `brain.` prefix); it is classified by `./settings-keys.ts`, so
 * only a `shared` key resolves, a `device` key is refused with the
 * machine-config key that holds it, and `schema_version` is no setting.
 * A value is what the `_brain.yaml` parser reads: a scalar, or a list of
 * scalars.
 *
 * A few settings are native to the store and have no `_brain.yaml` home
 * ({@link STORE_NATIVE_SETTINGS}): they keep their own key (no `brain.`
 * prefix), are written as store records on every machine, and carry their
 * own validator.
 */

import { SETTING_RULES } from "../../store/fold-settings.ts";
import { SETTING_VIEW_LANGUAGE } from "../../store/constants.ts";
import {
  parsePermissionsDocumentText,
  PERMISSIONS_DOCUMENT_SETTING,
} from "../permissions/document.ts";
import { DEFAULT_VIEW_LANGUAGE, isViewLanguage, VIEW_LANGUAGES } from "../../view/i18n.ts";
import { DEFAULT_BRAIN_CONFIG } from "./defaults.ts";
import { brainConfigKey, brainKeyHome, brainSettingKey } from "./settings-keys.ts";
import type { YamlSettingValue } from "./settings-yaml-edit.ts";

/** Who writes a setting: the operator at the CLI, or an agent over MCP. */
export type SettingAuthority = "human" | "agent";

/** Why a settings operation was refused. */
export type BrainSettingErrorCode =
  | "unknown_setting"
  | "device_setting"
  | "not_a_setting"
  | "field_required"
  | "invalid_setting_value"
  | "human_value_in_force"
  | "operator_only_setting"
  | "private_setting_value"
  | "no_settings_file"
  | "settings_unreadable";

export class BrainSettingError extends Error {
  readonly code: BrainSettingErrorCode;
  /** For `device_setting`: the machine-config key that holds this value. */
  readonly configKey?: string;

  constructor(code: BrainSettingErrorCode, message: string, configKey?: string) {
    super(message);
    this.name = "BrainSettingError";
    this.code = code;
    if (configKey !== undefined) this.configKey = configKey;
  }
}

export interface SettingTarget {
  readonly block: string;
  readonly field: string | undefined;
  readonly name: string;
  readonly key: string;
  /** Set for a store-native setting: its validator and default. */
  readonly native?: StoreNativeSetting;
}

/** A setting that lives in the store only, under its own key. */
export interface StoreNativeSetting {
  /** `null` when `value` is valid, else why it is not. */
  readonly invalid: (value: unknown) => string | null;
  /** What applies when the setting is not set. */
  readonly default: unknown;
  /** Only the operator (human authority) sets it: it holds a safety boundary. */
  readonly operatorOnly?: true;
}

/** The store-native settings, by name (which is also the store key). */
export const STORE_NATIVE_SETTINGS: Readonly<Record<string, StoreNativeSetting>> = Object.freeze({
  [SETTING_VIEW_LANGUAGE]: {
    invalid: (value: unknown) =>
      SETTING_RULES[SETTING_VIEW_LANGUAGE].valid(value) && isViewLanguage(value as string)
        ? null
        : `${SETTING_VIEW_LANGUAGE} must be a language the human view has strings for: ` +
          `${VIEW_LANGUAGES.join(", ")} (a regional tag such as ru-RU is accepted)`,
    default: DEFAULT_VIEW_LANGUAGE,
  },
  // The permissions document of a store-only machine (`_permissions.yaml`
  // once switched): its whole text, validated by the document's own
  // parser. Operator-only: it is the write gate an agent passes through.
  [PERMISSIONS_DOCUMENT_SETTING]: {
    invalid: (value: unknown) => {
      if (typeof value !== "string")
        return `${PERMISSIONS_DOCUMENT_SETTING} must be the YAML text of a permissions document`;
      try {
        parsePermissionsDocumentText(value, PERMISSIONS_DOCUMENT_SETTING);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    default: null,
    operatorOnly: true,
  },
});

function nativeTarget(name: string): SettingTarget | undefined {
  if (!Object.hasOwn(STORE_NATIVE_SETTINGS, name)) return undefined;
  const dot = name.indexOf(".");
  return {
    block: name.slice(0, dot),
    field: name.slice(dot + 1),
    name,
    key: name,
    native: STORE_NATIVE_SETTINGS[name]!,
  };
}

export const KEY_PREFIX = "brain.";
const NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/;

/** The shipped default of `block` or `block.field`, `undefined` when none. */
export function defaultOf(block: string, field: string | undefined): unknown {
  const top = (DEFAULT_BRAIN_CONFIG as unknown as Record<string, unknown>)[block];
  if (field === undefined) return top;
  return top !== null && typeof top === "object"
    ? (top as Record<string, unknown>)[field]
    : undefined;
}

/**
 * Whether `block` holds fields: an object default, or no default at all
 * (every top-level key without a shipped default is a block; a scalar key
 * such as `primary_agent` ships a `null` default).
 */
function isBlockWithFields(block: string): boolean {
  const top = defaultOf(block, undefined);
  if (top !== null && typeof top === "object" && !Array.isArray(top)) return true;
  return top === undefined;
}

/** Resolve and classify a setting name; throws {@link BrainSettingError}. */
export function resolveSettingName(raw: string): SettingTarget {
  const trimmed = raw.trim();
  const name = trimmed.startsWith(KEY_PREFIX) ? trimmed.slice(KEY_PREFIX.length) : trimmed;
  // The `brain.` prefix is accepted for a native setting too, as for every other one.
  const native = nativeTarget(trimmed) ?? nativeTarget(name);
  if (native !== undefined) return native;
  if (!NAME_RE.test(name)) {
    throw new BrainSettingError(
      "unknown_setting",
      `"${raw}" is not a brain setting name; use <block>.<field>, for example dream.candidate_threshold`,
    );
  }
  const dot = name.indexOf(".");
  const block = dot === -1 ? name : name.slice(0, dot);
  const field = dot === -1 ? undefined : name.slice(dot + 1);
  const home = brainKeyHome(block, field);
  if (home === undefined) {
    throw new BrainSettingError("unknown_setting", `"${name}" is not a brain setting`);
  }
  if (home === "drop") {
    throw new BrainSettingError("not_a_setting", `"${name}" is the format version, not a setting`);
  }
  if (home === "device") {
    const configKey = brainConfigKey(block, field);
    throw new BrainSettingError(
      "device_setting",
      `"${name}" is a setting of this machine, not a shared one: add ` +
        `\`${configKey}: <JSON value>\` to the machine config instead`,
      configKey,
    );
  }
  if (field === undefined && isBlockWithFields(block)) {
    throw new BrainSettingError(
      "field_required",
      `"${name}" is a block; name one of its fields, for example ${block}.<field>`,
    );
  }
  if (field !== undefined && !isBlockWithFields(block)) {
    throw new BrainSettingError("unknown_setting", `"${block}" takes a single value, not fields`);
  }
  return { block, field, name, key: brainSettingKey(block, field) };
}

/** The device-key refusal, with the value filled in when one is known. */
export function withDeviceValue(err: unknown, value: unknown): unknown {
  if (!(err instanceof BrainSettingError) || err.code !== "device_setting") return err;
  return new BrainSettingError(
    "device_setting",
    err.message.replace("<JSON value>", JSON.stringify(value)),
    err.configKey,
  );
}

/** A CLI value: JSON when it parses, else the bare string. */
export function parseSettingValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function isYamlScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

export function isYamlValue(value: unknown): value is YamlSettingValue {
  return isYamlScalar(value) || (Array.isArray(value) && value.every(isYamlScalar));
}
