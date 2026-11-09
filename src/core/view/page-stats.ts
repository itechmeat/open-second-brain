/**
 * Device-local stats of the view pages as the writer last left them
 * (never synced): size, modification and change time and file id, with
 * the checksum of the text the writer put there. A pass whose page still
 * has the same stats skips reading it, so the no-change pass of a hook
 * touches no page file beyond one `stat`.
 *
 * The change time cannot be set by a sync tool or an editor, so a file
 * replaced or rewritten since the writer left it never matches, even when
 * its size and modification time were kept.
 */

import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { StoreHandle } from "../store/store-open.ts";
import { VIEW_PAGE_STATS_FILE, VIEW_STATE_DIR } from "./constants.ts";

export interface PageStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ino: number;
}

export type PageStats = Map<string, PageStat & { readonly sum: string }>;

/** The page's stat, or `null` when it is not a readable file. */
export function statPage(path: string): PageStat | null {
  try {
    const s = statSync(path);
    if (!s.isFile()) return null;
    return { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, ino: s.ino };
  } catch {
    return null;
  }
}

export function sameStat(a: PageStat, b: PageStat | null): boolean {
  return (
    b !== null &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.ino === b.ino
  );
}

function statsPath(store: StoreHandle): string {
  return join(store.deviceStateDir, VIEW_STATE_DIR, VIEW_PAGE_STATS_FILE);
}

/** The stats the last pass left; empty when none or unreadable. */
export function readPageStats(store: StoreHandle): PageStats {
  try {
    const parsed = JSON.parse(readFileSync(statsPath(store), "utf8")) as Record<string, unknown>;
    const out: PageStats = new Map();
    for (const [page, value] of Object.entries(parsed)) {
      // One broken entry costs only its own page a re-read.
      if (typeof value !== "object" || value === null) continue;
      const v = value as Record<string, unknown>;
      if (
        typeof v["size"] === "number" &&
        typeof v["mtimeMs"] === "number" &&
        typeof v["ctimeMs"] === "number" &&
        typeof v["ino"] === "number" &&
        typeof v["sum"] === "string"
      ) {
        out.set(page, {
          size: v["size"],
          mtimeMs: v["mtimeMs"],
          ctimeMs: v["ctimeMs"],
          ino: v["ino"],
          sum: v["sum"],
        });
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Keep the stats for the next pass (best effort: a lost file only costs page reads). */
export function writePageStats(store: StoreHandle, stats: PageStats): void {
  try {
    mkdirSync(join(store.deviceStateDir, VIEW_STATE_DIR), { recursive: true });
    writeFileSync(statsPath(store), `${JSON.stringify(Object.fromEntries(stats))}\n`);
  } catch {
    // the next pass reads the pages instead
  }
}
