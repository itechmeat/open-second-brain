/**
 * Where a relocated store went (`store-relocation.ts`): the marker a moved
 * root carries, and whether the root it names still holds the store. Read
 * by every store open, so it loads nothing but the file system: no lock,
 * no ledger (a hook that opens the store stays light).
 *
 * One reading of the marker serves every decision ({@link readRelocationMarker}):
 * the root resolver (`store-paths.ts`), the open (`store-open.ts`), the
 * appender's redirect and the late-write carry. A marker is absent, valid,
 * or present and unreadable; an unreadable one is never taken for an
 * absent one, because a relocation that committed and whose marker was
 * damaged since would then split the store: new processes on one root,
 * stale handles on the other. Neither root is used while it is unreadable.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  STORE_IDENTITY_FILE,
  STORE_PARTITIONS,
  STORE_RELOCATED_FILE,
  type StorePartition,
} from "./constants.ts";
import { isUlid } from "./ulid.ts";

/** What `relocated.json` in the old root says. */
export interface RelocatedMarker {
  readonly store_id: string;
  /** The root the store moved to. */
  readonly to: string;
  /** The device that moved it. */
  readonly device: string;
  readonly at: string;
  /**
   * Bytes of each of this device's files already in the new root when the
   * move committed, by path relative to the old root (`/` separators):
   * what {@link carryLateWrites} carries from. A shard's offset ends on a
   * whole line.
   */
  readonly files: Readonly<Record<string, number>>;
}

/** The marker of a root as read once: absent, valid, or there and not usable. */
export type RelocationMarkerRead =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly marker: RelocatedMarker }
  | { readonly kind: "unreadable"; readonly path: string; readonly why: string };

function isOffsetMap(value: unknown): value is Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
  );
}

function isMarker(value: unknown): value is RelocatedMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    isUlid(v["store_id"]) &&
    typeof v["to"] === "string" &&
    v["to"] !== "" &&
    typeof v["device"] === "string" &&
    v["device"] !== "" &&
    typeof v["at"] === "string" &&
    isOffsetMap(v["files"])
  );
}

/** The relocation marker of `root`, read once (module docblock). */
export function readRelocationMarker(root: string): RelocationMarkerRead {
  const path = join(root, STORE_RELOCATED_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "unreadable", path, why: `cannot be read (${code ?? String(err)})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unreadable", path, why: "is not valid JSON" };
  }
  if (!isMarker(parsed)) {
    return { kind: "unreadable", path, why: "is not a relocation marker this release can read" };
  }
  return { kind: "valid", marker: parsed };
}

/** The valid relocation marker of `root`, or null when it has none or it cannot be read. */
export function readRelocatedMarker(root: string): RelocatedMarker | null {
  const read = readRelocationMarker(root);
  return read.kind === "valid" ? read.marker : null;
}

/**
 * The root the store `storeId` at `root` moved to, as its marker says, or
 * null when its marker names no move of this store. Whether that root
 * still holds the store is {@link relocationOf}'s question.
 */
export function relocatedRootOf(root: string, storeId: string): string | null {
  const marker = readRelocatedMarker(root);
  return marker !== null && marker.store_id === storeId ? marker.to : null;
}

/** Where the store at a root is after a relocation (see {@link relocationOf}). */
export type RelocationOf =
  | { readonly kind: "none" }
  /** Moved to a root whose partitions `held` carry this store's identity file. */
  | {
      readonly kind: "moved";
      readonly to: string;
      readonly held: ReadonlySet<StorePartition>;
    }
  /** It moved, and its destination holds no store or another one now. */
  | { readonly kind: "unavailable"; readonly to: string; readonly found: string }
  /** Its marker is there and cannot be read: whether it moved cannot be told. */
  | { readonly kind: "unreadable"; readonly marker: string; readonly why: string };

/** A relocation state in which the store is opened at neither root. */
export type RelocationRefused = Extract<RelocationOf, { kind: "unavailable" | "unreadable" }>;

/**
 * Where the store `storeId` at `root` is now: not moved, moved to a root
 * that holds the same store, moved to a root that does not hold it now
 * (removed, replaced by another store, or not synced back yet), or behind
 * a marker that cannot be read. In the last two cases neither root is the
 * store: the old one is a frozen recovery copy, and a write or read must
 * be refused rather than go to either.
 */
export function relocationOf(root: string, storeId: string): RelocationOf {
  const read = readRelocationMarker(root);
  if (read.kind === "absent") return { kind: "none" };
  if (read.kind === "unreadable") return { kind: "unreadable", marker: read.path, why: read.why };
  if (read.marker.store_id !== storeId) return { kind: "none" };
  const to = read.marker.to;
  const ids = new Set<string>();
  const held = new Set<StorePartition>();
  for (const partition of STORE_PARTITIONS) {
    const id = identityAt(join(to, partition, STORE_IDENTITY_FILE));
    if (id === null) continue;
    ids.add(id);
    if (id === storeId) held.add(partition);
  }
  if (ids.size === 1 && ids.has(storeId)) return { kind: "moved", to, held };
  const found = ids.size === 0 ? "no brain store" : `another brain store (${[...ids].join(", ")})`;
  return { kind: "unavailable", to, found };
}

/** Where writes and opens of the store at a root go: {@link followRelocation}. */
export type FollowedRelocation =
  | { readonly kind: "none" }
  | {
      readonly kind: "moved";
      readonly to: string;
      readonly held: ReadonlySet<StorePartition>;
    }
  /** Neither root is the store: `root` is the one to name in the refusal. */
  | { readonly kind: "refused"; readonly root: string; readonly state: RelocationRefused };

/**
 * {@link relocationOf}, followed one move and never a second: the one rule
 * an open (`store-open.ts`) and a write through a handle opened before the
 * move (`appender.ts`) both go by, so a write never lands where an open
 * refuses. The root the store moved to must not itself name a move of the
 * store elsewhere (two restored copies whose markers point at each other,
 * or a chain), nor carry a marker that cannot be read or names a move to a
 * root that does not hold the store. A marker that names its own root is
 * no move.
 */
export function followRelocation(root: string, storeId: string): FollowedRelocation {
  const first = relocationOf(root, storeId);
  if (first.kind === "none") return first;
  if (first.kind !== "moved") return { kind: "refused", root, state: first };
  // A marker that names its own root (a recovery copy copied back into the
  // folder it moved to) names no move: the store is here.
  if (first.to === root) return { kind: "none" };
  const onward = relocationOf(first.to, storeId);
  if (onward.kind === "unavailable" || onward.kind === "unreadable") {
    return { kind: "refused", root: first.to, state: onward };
  }
  if (onward.kind === "moved" && onward.to !== first.to) {
    return {
      kind: "refused",
      root,
      state: {
        kind: "unavailable",
        to: first.to,
        found: `a copy of the store whose own relocation marker points on to ${onward.to}`,
      },
    };
  }
  return first;
}

/**
 * The store ids the partitions under `root` carry (each identity file read
 * once; one that cannot be read counts as "unreadable"). Empty when no
 * partition carries one.
 */
export function storeIdsAt(root: string): Set<string> {
  const ids = new Set<string>();
  for (const partition of STORE_PARTITIONS) {
    const id = identityAt(join(root, partition, STORE_IDENTITY_FILE));
    if (id !== null) ids.add(id);
  }
  return ids;
}

/** The store id an identity file names, "unreadable" when it cannot be read, null when absent. */
function identityAt(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
  try {
    const id = (JSON.parse(text) as { store_id?: unknown }).store_id;
    return isUlid(id) ? id : "unreadable";
  } catch {
    return "unreadable";
  }
}

/** Why a store whose relocation cannot be followed is neither read nor written. */
export function relocationUnavailableReason(root: string, state: RelocationRefused): string {
  if (state.kind === "unreadable") {
    return (
      `the brain store at ${root} carries a relocation marker that ${state.why} ` +
      `(${state.marker}), so whether the store moved into the vault cannot be told; nothing is ` +
      `read or written at ${root} or in the vault until that is settled. If the vault's ` +
      `store folder holds this store, it moved there: move ${root} aside (it is the recovery ` +
      `copy). If it does not, remove ${state.marker}`
    );
  }
  return (
    `the brain store at ${root} moved to ${state.to}, which holds ${state.found} now; ` +
    `${root} is a recovery copy and is not used, so nothing is read or written until ` +
    `${state.to} holds the store again (let the sync finish, or restore that folder)`
  );
}
