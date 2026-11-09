/**
 * Overwrite-only exact-state lane (t_b0c9d0a3).
 *
 * Operational "current value" state - the deploy target, the active branch,
 * the current sprint - accumulates badly in a free-form scratchpad: an old
 * value stays in the text and can resurface through semantic recall. This
 * lane stores that state STRUCTURALLY, keyed by aspect: each write to an
 * aspect overwrites its canonical value entirely, with no history and no
 * versioned copies. One file per aspect at `Brain/state/<aspect>.md`.
 *
 * The lane is excluded from the search index by the index-admission
 * predicate ({@link ../vault-scope/index-admission.ts}) and from retrieval
 * by the staleness barrier ({@link ../search/result-filters.ts}), so a
 * superseded value can never leak back through FTS/vector/graph recall.
 *
 * Language-agnostic: the aspect is an opaque slug; nothing here inspects the
 * natural-language content of the value.
 *
 * Once this machine is store-only (design D14, task 2.10) the lane lives in
 * the brain store, as the migration imports it: one `lane-entry` record per
 * write in lane {@link EXACT_STATE_LANE}, keyed by the aspect, and a
 * `lane-entry-remove` tombstone per clear. The entry fold gives the current
 * value; nothing under `Brain/state/` is written or read.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { sanitiseTextField } from "../redactor.ts";
import { STORE_PARTITIONS } from "../store/constants.ts";
import { foldLaneEntries, laneEntryRecord, laneEntryRemoveRecord } from "../store/lane-records.ts";
import type { DualWriteRecord } from "../store/dual-write.ts";
import { protectionStore, StoreUnavailableError } from "../store/read/protection-store.ts";
import { readStreamRecords } from "../store/read/stream-read.ts";
import { rowNamesPrivatePage } from "../store/reference-privacy.ts";
import { isStoreOnly } from "../store/store-only.ts";
import type { StoreInspection } from "../store/store-open.ts";
import { routeWrite } from "../store/store-write.ts";
import { parseFrontmatterText } from "../vault.ts";
import { brainStateDir, exactStatePath, validateSlug } from "./paths.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

/** Frontmatter `kind` marking a page as an exact-state lane artifact. */
export const EXACT_STATE_KIND = "exact-state";

/** The store lane of exact-state entries, as the migration names it (`surface-map.ts`). */
export const EXACT_STATE_LANE = "exact-state";

/** Hard ceiling on a single aspect's value. Mirrors the pinned-context budget. */
export const MAX_EXACT_STATE_VALUE_LEN = 20_000;

export type ExactStateErrorCode = "budget_exceeded" | "invalid_aspect";

/** Typed failure so callers surface a structured error instead of opaque prose. */
export class ExactStateError extends Error {
  readonly code: ExactStateErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ExactStateErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ExactStateError";
    this.code = code;
    this.details = details;
  }
}

export interface ExactStateEntry {
  /** The aspect slug this entry is keyed by. */
  readonly aspect: string;
  /** The canonical value (the latest overwrite). */
  readonly value: string;
  /** Absolute path of the aspect's lane file; empty for an entry held in the store. */
  readonly path: string;
  /** ISO-8601 instant of the last write. */
  readonly updatedAt: string;
}

function normaliseValue(value: unknown): string {
  return sanitiseTextField(value, { maxLen: Number.POSITIVE_INFINITY }).trim();
}

/**
 * Validate an aspect slug, converting the generic slug-guard `Error` into a
 * typed {@link ExactStateError} so an invalid aspect surfaces as a handleable
 * operational failure instead of crashing a caller that only catches
 * `ExactStateError`.
 */
function validateAspect(aspect: string): string {
  try {
    return validateSlug(aspect);
  } catch (exc) {
    throw new ExactStateError("invalid_aspect", (exc as Error).message, { aspect });
  }
}

function renderPage(aspect: string, value: string, updatedAt: string): string {
  // Fixed, machine-safe frontmatter fields (slug aspect, ISO instant,
  // constant kind) - no user text reaches the YAML, so no quoting hazard.
  return `---\nkind: ${EXACT_STATE_KIND}\naspect: ${aspect}\nupdated_at: ${updatedAt}\n---\n\n${value}\n`;
}

/**
 * Write (overwrite) an aspect's canonical value. Returns the stored entry.
 * Over-budget input is rejected with {@link ExactStateError} BEFORE any
 * write - never silently truncated. An invalid aspect slug is rejected with
 * {@link ExactStateError} (`invalid_aspect`).
 */
export function writeExactState(
  vault: string,
  aspect: string,
  value: unknown,
  now: number = Date.now(),
): ExactStateEntry {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const slug = validateAspect(aspect);
  const normalised = normaliseValue(value);
  if (normalised.length > MAX_EXACT_STATE_VALUE_LEN) {
    throw new ExactStateError(
      "budget_exceeded",
      `exact-state value of ${normalised.length} chars exceeds the ${MAX_EXACT_STATE_VALUE_LEN} budget`,
      { aspect: slug, length: normalised.length, budget: MAX_EXACT_STATE_VALUE_LEN },
    );
  }
  const updatedAt = new Date(now).toISOString();
  const replacesPrivate = replacesPrivateAspect(vault, slug);
  const routed = routeWrite({
    legacy: () => {
      const path = exactStatePath(vault, slug);
      atomicWriteFileSync(path, renderPage(slug, normalised, updatedAt));
      return path;
    },
    // One verdict over the whole caller input, the aspect and its value,
    // raised by the entry it replaces: a private aspect stays private. A
    // shared aspect the new value raises to private gets a shared
    // tombstone first (content-free, dropped when the value stays shared),
    // so a machine that holds only shared stops reading the old value.
    store: () => {
      const live = storeEntries().get(slug);
      return [
        ...(live !== undefined && !live.livePrivate ? [replacedSharedTombstone(slug)] : []),
        laneEntryRecord({
          lane: EXACT_STATE_LANE,
          entry: slug,
          fields: { kind: EXACT_STATE_KIND, aspect: slug, updated_at: updatedAt },
          text: normalised,
          authority: "agent",
          private:
            replacesPrivate || rowNamesPrivatePage(vault, { aspect: slug, value: normalised }),
        }),
      ];
    },
    context: { vault },
  });
  const path = routed.mode === "legacy" ? routed.value : "";
  return Object.freeze({ aspect: slug, value: normalised, path, updatedAt });
}

/** The shared tombstone of a shared aspect a private value replaces (`Located`). */
function replacedSharedTombstone(slug: string): DualWriteRecord {
  return {
    ...laneEntryRemoveRecord({
      lane: EXACT_STATE_LANE,
      entry: slug,
      authority: "agent",
      private: false,
    }),
    located: { partition: "shared", content: false, onlyIfApart: true },
  };
}

/**
 * Whether a write of `slug` replaces a private aspect (design D14, one
 * verdict per operation, fail closed): on a store-only machine the live
 * entry lives in `private`; on an unswitched one the value on the page
 * names a private page, as the write that stored it judged. A private
 * aspect never becomes shared by an overwrite, so while a store shard
 * cannot be seen the aspect counts as private.
 */
function replacesPrivateAspect(vault: string, slug: string): boolean {
  if (isStoreOnly({ vault })) {
    const read = readStoreAspects();
    return read.incomplete || read.entries.get(slug)?.livePrivate === true;
  }
  if (!existsSync(exactStatePath(vault, slug))) return false;
  try {
    const current = readExactState(vault, slug);
    return rowNamesPrivatePage(vault, { aspect: slug, value: current?.value ?? "" });
  } catch {
    return true;
  }
}

/** An exact-state entry the store holds, with the partitions its records sit in. */
interface StoreEntry extends ExactStateEntry {
  /** Whether a record of its history is private. */
  readonly private: boolean;
  /** Whether a record of its history is shared. */
  readonly shared: boolean;
  /** Whether its live record is in `private`. */
  readonly livePrivate: boolean;
}

/** Every exact-state entry the store holds, keyed by aspect. */
function storeEntries(): Map<string, StoreEntry> {
  return readStoreAspects().entries;
}

/**
 * The store's exact-state entries, and whether an `events` shard of a
 * held partition could not be read or is gone since this machine read it
 * (`incomplete`): an aspect's private records may be in it.
 */
function readStoreAspects(): { entries: Map<string, StoreEntry>; incomplete: boolean } {
  const out = new Map<string, StoreEntry>();
  let store: StoreInspection | null;
  try {
    store = protectionStore(undefined, { needShared: true });
  } catch (err) {
    if (!(err instanceof StoreUnavailableError)) throw err;
    // A switched machine whose store cannot be opened sees no aspect.
    return { entries: out, incomplete: true };
  }
  if (store === null) return { entries: out, incomplete: false };
  const privateIds = new Set<string>();
  let incomplete = false;
  const records = STORE_PARTITIONS.filter((p) => store.partitions.has(p)).flatMap((partition) => {
    const read = readStreamRecords(store.root, partition, { stream: "events" });
    if (read.unreadable.length > 0) incomplete = true;
    if (partition === "private") for (const r of read.records) privateIds.add(r.id);
    return read.records;
  });
  for (const state of foldLaneEntries(records).entries.values()) {
    const value = state.value;
    if (value === null || value.lane !== EXACT_STATE_LANE) continue;
    const updated = value.fields["updated_at"];
    out.set(
      value.entry,
      Object.freeze({
        aspect: value.entry,
        value: value.text.trim(),
        path: "",
        updatedAt: typeof updated === "string" ? updated : "",
        private: state.history.some((h) => privateIds.has(h.record.id)),
        shared: state.history.some((h) => !privateIds.has(h.record.id)),
        livePrivate: privateIds.has(state.winner),
      }),
    );
  }
  return { entries: out, incomplete };
}

/** Read an aspect's canonical value, or null when it was never written. */
export function readExactState(vault: string, aspect: string): ExactStateEntry | null {
  const slug = validateAspect(aspect);
  if (isStoreOnly({ vault })) {
    const entry = storeEntries().get(slug);
    if (entry === undefined) return null;
    const { private: _private, livePrivate: _live, ...rest } = entry;
    return Object.freeze(rest);
  }
  const path = exactStatePath(vault, slug);
  // Read directly rather than existsSync-then-read: a concurrent delete
  // between the check and the read would otherwise surface as an unhandled
  // ENOENT. Treat "not found" as null; propagate any other read error.
  try {
    return parseEntry(slug, path, readFileSync(path, "utf8"));
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw exc;
  }
}

/** Every aspect in the lane, sorted by aspect slug ascending. */
export function listExactState(vault: string): ExactStateEntry[] {
  if (isStoreOnly({ vault })) {
    return [...storeEntries().values()]
      .map(({ private: _private, shared: _shared, ...rest }) => Object.freeze(rest))
      .toSorted((a, b) => (a.aspect < b.aspect ? -1 : a.aspect > b.aspect ? 1 : 0));
  }
  const dir = brainStateDir(vault);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ExactStateEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const aspect = name.slice(0, -3);
    try {
      const entry = readExactState(vault, aspect);
      if (entry !== null) out.push(entry);
    } catch {
      // A malformed aspect filename is not a valid lane entry; skip it.
    }
  }
  out.sort((a, b) => (a.aspect < b.aspect ? -1 : a.aspect > b.aspect ? 1 : 0));
  return out;
}

/** Remove an aspect. Returns whether it existed before the call. */
export function clearExactState(vault: string, aspect: string): boolean {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const slug = validateAspect(aspect);
  if (isStoreOnly({ vault })) {
    const held = storeEntries().get(slug);
    if (held === undefined) return false;
    routeWrite({
      legacy: () => undefined,
      store: () =>
        laneEntryRemoveRecord({
          lane: EXACT_STATE_LANE,
          entry: slug,
          authority: "agent",
          // A tombstone names only the lane and the aspect slug. It goes to
          // shared whenever a shared record of the aspect exists, so a
          // machine without private clears the value it still shows;
          // otherwise it stays in private with the entry.
          private: held.private && !held.shared,
        }),
      context: { vault },
    });
    return true;
  }
  const path = exactStatePath(vault, slug);
  if (!existsSync(path)) return false;
  // Judged from the value being cleared, as the write judged it; an
  // unreadable page counts as private.
  let isPrivate = true;
  try {
    const current = readExactState(vault, slug);
    isPrivate = rowNamesPrivatePage(vault, { aspect: slug, value: current?.value ?? "" });
  } catch {
    // fail closed
  }
  // The dual write records the tombstone, so the store's fold forgets the
  // aspect too and a later switch cannot bring the cleared value back.
  routeWrite({
    legacy: () => rmSync(path, { force: true }),
    store: () =>
      laneEntryRemoveRecord({
        lane: EXACT_STATE_LANE,
        entry: slug,
        authority: "agent",
        private: isPrivate,
      }),
    context: { vault },
  });
  return true;
}

function parseEntry(aspect: string, path: string, raw: string): ExactStateEntry {
  const [meta, body] = parseFrontmatterText(raw);
  const updatedAt = typeof meta["updated_at"] === "string" ? meta["updated_at"] : "";
  return Object.freeze({ aspect, value: body.trim(), path, updatedAt });
}
