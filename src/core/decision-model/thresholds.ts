/**
 * The local per-model thresholds store (issue #264).
 *
 * Thresholds are a property of the installation, not of the code. They
 * live in `decision-thresholds.json`, next to `config.yaml` in the user
 * config directory, keyed by `(model id, use)` - the model id the server
 * reports, never the provider preset, so a self-hosted server that swaps
 * models never inherits the previous model's thresholds.
 *
 * Semantics the whole feature relies on:
 *
 *   - An entry exists for `(model, use)` exactly when that use may run
 *     `enforce` for that model. A model without an entry for a use runs
 *     that use as `shadow`, and `check`/`report` name the tuning command.
 *   - Entries are never deleted by a switch: the file keeps every model
 *     ever tuned, so switching back restores enforce without re-tuning.
 *     Writing an entry keeps the previous value in the entry's history.
 *   - A `vaults` section overrides the global entry for one vault, keyed
 *     by the vault's absolute path.
 *   - The code's built-in threshold values ({@link BUILTIN_USE_THRESHOLDS}
 *     in `questions.ts`, the hosted baseline family's) remain the
 *     fallback; a stored value for the same name wins.
 *
 * The file is small and read through a TTL cache (the tuning-mark
 * precedent, `eval/mark.ts`), so a hot path pays one cached read per
 * minute. Every write is atomic and busts the cache. A missing, unreadable
 * or malformed file reads as an empty store: fail closed to shadow, and
 * never throw - the store only ever widens what may enforce.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { DECISION_MODEL_USES, type DecisionModelUse } from "./contract.ts";
import { BUILTIN_USE_THRESHOLDS } from "./questions.ts";

/** The file name, read next to the operator's `config.yaml`. */
export const DECISION_THRESHOLDS_FILE = "decision-thresholds.json";

/** How long a loaded store is trusted before its file is read again. */
export const THRESHOLDS_CACHE_TTL_MS = 60_000;

/** How many previous values one entry's history keeps. */
export const THRESHOLD_HISTORY_MAX = 20;

/** Where a threshold value came from: the fit command or a hand set. */
export type DecisionThresholdSource = "fit" | "set";

export interface DecisionThresholdHistoryItem {
  readonly value: number;
  readonly source: string;
  readonly updated_at: string;
}

export interface DecisionThresholdEntry {
  /** The threshold values this entry carries, by name (`low_priority_min`). */
  readonly values: Readonly<Record<string, number>>;
  readonly source: DecisionThresholdSource;
  readonly updated_at: string;
  /** The false-action target the fit derived the value against. */
  readonly target?: number;
  /** How many labelled samples the fit saw. */
  readonly samples?: number;
  /** Previous values of this entry, most recent first. Never trimmed by a switch. */
  readonly history?: ReadonlyArray<DecisionThresholdHistoryItem>;
}

/** One model's entries by use; a use without an entry is untuned for it. */
export type DecisionThresholdModelEntries = Readonly<
  Partial<Record<DecisionModelUse, DecisionThresholdEntry>>
>;

export interface DecisionThresholdsStore {
  readonly version: 1;
  readonly models: Readonly<Record<string, DecisionThresholdModelEntries>>;
  /** Per-vault overrides, keyed by the vault's absolute path. */
  readonly vaults: Readonly<
    Record<string, Readonly<Record<string, DecisionThresholdModelEntries>>>
  >;
}

/** The path of the thresholds file beside `configPath`. */
export function decisionThresholdsPath(configPath: string): string {
  return join(dirname(configPath), DECISION_THRESHOLDS_FILE);
}

export const EMPTY_THRESHOLD_STORE: DecisionThresholdsStore = Object.freeze({
  version: 1,
  models: Object.freeze({}),
  vaults: Object.freeze({}),
});

/** Parse one store document. Anything malformed parses as empty (fail closed). */
export function parseThresholdsStore(text: string): DecisionThresholdsStore {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return EMPTY_THRESHOLD_STORE;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return EMPTY_THRESHOLD_STORE;
  }
  const r = raw as Record<string, unknown>;
  const models = parseModelSection(r["models"]);
  const vaults: Record<string, DecisionThresholdsStore["vaults"][string]> = {};
  if (r["vaults"] !== null && typeof r["vaults"] === "object" && !Array.isArray(r["vaults"])) {
    for (const [vaultPath, section] of Object.entries(r["vaults"] as Record<string, unknown>)) {
      const parsed = parseModelSection(section);
      if (parsed !== null) vaults[vaultPath] = parsed;
    }
  }
  return { version: 1, models: models ?? {}, vaults };
}

function parseModelSection(raw: unknown): DecisionThresholdsStore["models"] | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const models: Record<string, DecisionThresholdModelEntries> = {};
  for (const [model, uses] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof model !== "string" || model === "" || uses === null || typeof uses !== "object") {
      continue;
    }
    const entries: Record<string, DecisionThresholdEntry> = {};
    for (const use of DECISION_MODEL_USES) {
      const entry = parseEntry((uses as Record<string, unknown>)[use]);
      if (entry !== null) entries[use] = entry;
    }
    if (Object.keys(entries).length > 0) models[model] = entries;
  }
  return models;
}

function parseEntry(raw: unknown): DecisionThresholdEntry | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (
    e["values"] === null ||
    typeof e["values"] !== "object" ||
    Array.isArray(e["values"]) ||
    !Object.values(e["values"]).every((v) => typeof v === "number" && Number.isFinite(v)) ||
    Object.keys(e["values"]).length === 0 ||
    (e["source"] !== "fit" && e["source"] !== "set") ||
    typeof e["updated_at"] !== "string"
  ) {
    return null;
  }
  const history: DecisionThresholdHistoryItem[] = [];
  if (
    e["history"] !== null &&
    Array.isArray(e["history"]) &&
    e["history"].every(
      (h) =>
        h !== null &&
        typeof h === "object" &&
        typeof (h as Record<string, unknown>)["value"] === "number" &&
        typeof (h as Record<string, unknown>)["updated_at"] === "string",
    )
  ) {
    for (const h of e["history"] as Record<string, unknown>[]) {
      history.push({
        value: h["value"] as number,
        source: typeof h["source"] === "string" ? h["source"] : "unknown",
        updated_at: h["updated_at"] as string,
      });
    }
  }
  return {
    values: Object.freeze({ ...(e["values"] as Record<string, number>) }),
    source: e["source"],
    updated_at: e["updated_at"],
    ...(typeof e["target"] === "number" && Number.isFinite(e["target"])
      ? { target: e["target"] }
      : {}),
    ...(typeof e["samples"] === "number" && Number.isFinite(e["samples"])
      ? { samples: e["samples"] }
      : {}),
    ...(history.length > 0 ? { history } : {}),
  };
}

const STORE_CACHE = new Map<string, { store: DecisionThresholdsStore; loadedAtMs: number }>();

/** Tests only: forget every loaded store. */
export function resetThresholdsStoreCache(): void {
  STORE_CACHE.clear();
}

/**
 * Read the store at `path` through the TTL cache. Anything unreadable or
 * malformed reads as the empty store, and that absence is cached too, so
 * a missing file costs one stat-and-read per {@link THRESHOLDS_CACHE_TTL_MS}.
 */
export function readThresholdsStore(
  path: string,
  nowMs: number = Date.now(),
): DecisionThresholdsStore {
  const hit = STORE_CACHE.get(path);
  if (hit !== undefined && nowMs - hit.loadedAtMs < THRESHOLDS_CACHE_TTL_MS) return hit.store;
  let store: DecisionThresholdsStore;
  try {
    store = parseThresholdsStore(readFileSync(path, "utf8"));
  } catch {
    store = EMPTY_THRESHOLD_STORE;
  }
  STORE_CACHE.set(path, { store, loadedAtMs: nowMs });
  return store;
}

/**
 * The stored entry for `(model, use)`: the vault's override when the
 * vault declares one, else the global entry, else null.
 */
export function storedThresholdEntry(
  store: DecisionThresholdsStore,
  model: string | null,
  use: DecisionModelUse,
  vault?: string | null,
): DecisionThresholdEntry | null {
  if (model === null || model === "") return null;
  const entry = store.models[model]?.[use];
  const override = vault != null ? store.vaults[vault]?.[model]?.[use] : undefined;
  return override ?? entry ?? null;
}

/**
 * The threshold values a use applies for `model`: the built-in defaults
 * with every stored value of the same name winning. Without a stored
 * entry this is exactly the built-in baseline family's set.
 */
export function effectiveThresholds(
  store: DecisionThresholdsStore,
  model: string | null,
  use: DecisionModelUse,
  vault?: string | null,
): Readonly<Record<string, number>> {
  const entry = storedThresholdEntry(store, model, use, vault);
  if (entry === null) return Object.freeze({ ...BUILTIN_USE_THRESHOLDS[use] });
  return Object.freeze({ ...BUILTIN_USE_THRESHOLDS[use], ...entry.values });
}

/**
 * Merge `entry` into the store at `path` atomically. A previous entry for
 * the same `(model, use)` keeps its current value in the entry's history
 * (most recent first, capped); nothing is ever deleted, so switching
 * models and switching back never loses a tune. The cache entry is
 * dropped so the next read sees the write.
 */
export function writeThresholdEntry(
  path: string,
  model: string,
  use: DecisionModelUse,
  entry: {
    readonly values: Readonly<Record<string, number>>;
    readonly source: DecisionThresholdSource;
    readonly target?: number;
    readonly samples?: number;
  },
  vaultPath?: string | null,
  now: Date = new Date(),
): DecisionThresholdEntry {
  let store: DecisionThresholdsStore;
  try {
    store = parseThresholdsStore(readFileSync(path, "utf8"));
  } catch {
    store = EMPTY_THRESHOLD_STORE;
  }
  // History first: the entry being replaced keeps its old value, latest
  // first, capped - nothing is ever deleted, so switching models and
  // switching back never loses a tune.
  const previous =
    vaultPath == null
      ? store.models[model]?.[use]
      : (store.vaults[vaultPath]?.[model]?.[use] ?? store.models[model]?.[use]);
  const history =
    previous === undefined || previous === null
      ? undefined
      : Object.freeze(
          [
            {
              value: primaryValueOf(previous),
              source: previous.source,
              updated_at: previous.updated_at,
            },
            ...(previous.history ?? []),
          ].slice(0, THRESHOLD_HISTORY_MAX),
        );
  const updated: DecisionThresholdEntry = {
    values: Object.freeze({ ...entry.values }),
    source: entry.source,
    updated_at: now.toISOString(),
    ...(entry.target !== undefined ? { target: entry.target } : {}),
    ...(entry.samples !== undefined ? { samples: entry.samples } : {}),
    ...(history !== undefined ? { history } : {}),
  };
  const section: Record<string, DecisionThresholdEntry> = {
    ...(vaultPath == null
      ? store.models[model]
      : (store.vaults[vaultPath]?.[model] ?? store.models[model])),
  };
  section[use] = updated;
  const sectionEntries: DecisionThresholdModelEntries = section;
  const vaults: DecisionThresholdsStore["vaults"] =
    vaultPath == null
      ? store.vaults
      : {
          ...store.vaults,
          [vaultPath]: { ...store.vaults[vaultPath], [model]: sectionEntries },
        };
  const globalModels: DecisionThresholdsStore["models"] =
    vaultPath == null ? { ...store.models, [model]: sectionEntries } : store.models;
  const next: DecisionThresholdsStore = { version: 1, models: globalModels, vaults };
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  STORE_CACHE.delete(path);
  return updated;
}

/** The entry's primary stored value, for the history line. */
function primaryValueOf(entry: DecisionThresholdEntry): number {
  const first = Object.values(entry.values)[0];
  return typeof first === "number" ? first : Number.NaN;
}
