/**
 * The legacy-file watermark of the automatic transition import (task 2.4,
 * design D11a), kept in the device-local migration state: the stamp
 * (size, mtime, inode) of every legacy file a record mapping reads, as
 * they were when an import last read the tree whole.
 *
 * A stamp is taken BEFORE the pass that reads the files, so the content a
 * watermark describes was imported: a file that changed after its stamp
 * no longer matches it and is read again. The migration (first and later
 * machine) and the transition that binds a vault record it at their final
 * delta pass, so the automatic import's first run on this machine starts
 * from a point whose content is in the store (`auto-transition.ts`).
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { StoreHandle } from "../store/store-open.ts";
import { legacyRootNames, migrationCatalogue, recordDestination } from "./catalogue.ts";
import type { Locator } from "./destinations.ts";
import { migrationDir } from "./journal.ts";
import { claims } from "./legacy-claims.ts";

const WATERMARK_FILE = "transition-watermark.json";

export interface Watermark {
  /** Vault-relative path to `size:mtimeMs:ino`. */
  readonly files: Record<string, string>;
  /** Device ids seen in legacy shard names at the last import. */
  readonly devices: ReadonlyArray<string>;
  /**
   * The partitions this machine held when the last import held items back
   * for a missing one; absent when nothing was held back. While they are
   * unchanged, the held-back items cannot be imported and an unchanged
   * tree idles.
   */
  readonly held_partitions?: ReadonlyArray<string>;
}

/** The partitions `store` holds, sorted. */
export function heldPartitions(store: StoreHandle): string[] {
  return [...store.partitions].toSorted();
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJson(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${JSON.stringify(value)}\n`);
}

/** This machine's watermark, or null when none was recorded. */
export function readWatermark(store: StoreHandle): Watermark | null {
  return readJson<Watermark>(join(migrationDir(store), WATERMARK_FILE));
}

export function writeWatermark(store: StoreHandle, watermark: Watermark): void {
  writeJson(migrationDir(store), WATERMARK_FILE, watermark);
}

/**
 * Record the watermark of an import that read the tree whole: `stamps`
 * taken before its final pass, the legacy devices it saw (added to those
 * the previous watermark knew), and the held partitions when it held an
 * item back. Only an import that converged may say "nothing new since";
 * otherwise the previous file stamps stay.
 */
export function recordImportWatermark(
  store: StoreHandle,
  input: {
    readonly stamps: Record<string, string>;
    readonly devices: Iterable<string>;
    readonly converged: boolean;
    readonly heldBack: number;
  },
): void {
  const previous = readWatermark(store);
  const seen = new Set(previous?.devices ?? []);
  for (const device of input.devices) seen.add(device);
  writeWatermark(store, {
    files: input.converged ? input.stamps : (previous?.files ?? {}),
    devices: [...seen].toSorted(),
    ...(input.heldBack > 0 ? { held_partitions: heldPartitions(store) } : {}),
  });
}

/** The stamp of every legacy file a record mapping reads. */
export function legacyFileStamps(vault: string): Record<string, string> {
  const catalogue = migrationCatalogue(vault);
  const locators: Locator[] = catalogue
    .filter((entry) => recordDestination(entry) !== null)
    .flatMap((entry) => entry.locators);
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(path);
      } else if (stat.isFile() && locators.some((l) => claims(l, path, name))) {
        out[relative(vault, path).split(sep).join("/")] =
          `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
      }
    }
  };
  for (const top of legacyRootNames(vault, catalogue)) walk(join(vault, top));
  return out;
}
