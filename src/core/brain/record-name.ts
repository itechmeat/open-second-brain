/**
 * Name allocation for a record written with no vault (design D14, task
 * 2.10).
 *
 * With a vault, a signal or preference name is allocated against the
 * files under `Brain/` (`allocateAndCreate` in `./paths.ts`), and a
 * store-only vault also checks the fold. With no vault there is no file
 * to probe: the name is free when the fold does not hold it. The
 * candidates are the same (`<prefix>-<slug>`, then `-2`, `-3`, ...), so a
 * record keeps the name it would have had in a vault. The caller holds
 * the device-local lock that serialises allocation on this machine.
 */

import { createHash } from "node:crypto";

import { readDeviceId } from "../config.ts";
import { collisionCandidateName, SLUG_ALLOCATION_MAX_ATTEMPTS, validateSlug } from "./paths.ts";

/** One allocated name: `<prefix>-<slug>` with the collision suffix applied. */
export interface RecordName {
  /** The full name (`sig-2026-11-07-naming-2`). */
  readonly name: string;
  /** The slug part, suffix included (`naming-2`). */
  readonly slug: string;
}

/**
 * The first candidate name `taken` does not claim. Throws once
 * `maxAttempts` candidates are taken, as the file allocator does.
 */
export function allocateRecordName(
  prefix: string,
  slug: string,
  taken: (name: string) => boolean,
  maxAttempts: number = SLUG_ALLOCATION_MAX_ATTEMPTS,
): RecordName {
  const base = validateSlug(slug);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = collisionCandidateName(base, attempt);
    const name = `${prefix}-${candidate}`;
    if (!taken(name)) return { name, slug: candidate };
  }
  throw new Error(
    `allocateRecordName: could not find a free name after ${maxAttempts} attempts ` +
      `(prefix ${JSON.stringify(prefix)}, slug ${JSON.stringify(base)})`,
  );
}

/** Hex characters of the device tag a store-only machine adds to a minted id. */
const DEVICE_TAG_CHARS = 6;

/**
 * The short device-derived component of an id minted on a store-only
 * machine (`sig-<date>-<slug>-<tag>`, `ws-<date>-<time>-<tag>`): the first
 * hex characters of the device id's SHA-256. A store-only machine checks
 * a new id only against its own view of the fold, under a device-local
 * lock, so two synced devices minting the same name before their shards
 * meet would otherwise write one id twice, and the fold would keep one
 * capture. The tag keeps their ids apart; the per-device collision suffix
 * still separates two mints on one device. `null` when the machine has no
 * device id (it cannot write store records then). Ids minted before the
 * tag, and every legacy id, stay valid: readers take the id as written.
 */
export function deviceMintTag(configPath?: string): string | null {
  const device = readDeviceId(configPath ?? null);
  if (device === null) return null;
  return createHash("sha256").update(device).digest("hex").slice(0, DEVICE_TAG_CHARS);
}

/** `slug` with this device's mint tag, when it has one. */
export function deviceTaggedSlug(slug: string, configPath?: string): string {
  const tag = deviceMintTag(configPath);
  return tag === null ? slug : `${slug}-${tag}`;
}
