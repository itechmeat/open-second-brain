/**
 * Vault token footprint - per-category sum of `estimateTokens` over
 * every Brain/* page, surfaced through `o2b brain token-footprint`
 * and a digest section. Lets operators catch runaway ingestion
 * before it overflows model context windows.
 *
 * Categories: `preferences`, `retired`, `inbox`, `processed`, `log`,
 * `other`. The "other" bucket captures anything that lives under
 * Brain/ but does not match a known subdirectory.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { storeLogDays } from "./log-days.ts";
import { withoutPrivateEntries } from "./log-events-at-reach.ts";
import { memoryFromStore, storePagesIn } from "./memory-pages.ts";
import { BRAIN_ROOT_REL, brainDirs } from "./paths.ts";
import { estimateTokens } from "./text/tokenizer.ts";

export const TOKEN_WARN_THRESHOLD_DEFAULT = 200_000;

export interface TokenFootprintCategory {
  readonly name: string;
  readonly tokens: number;
  readonly files: number;
}

export interface TokenFootprintReport {
  readonly total: number;
  readonly files: number;
  readonly byCategory: ReadonlyArray<TokenFootprintCategory>;
  readonly warnThreshold: number;
  readonly exceeded: boolean;
}

function sumDir(dir: string): { tokens: number; files: number } {
  // Non-recursive: each Brain bucket is structurally flat, and
  // counting recursively would double-count nested subdirs (e.g.
  // `inbox/processed/` is its own bucket and must not roll into
  // the parent `inbox` total).
  if (!existsSync(dir)) return { tokens: 0, files: 0 };
  let tokens = 0;
  let files = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { tokens: 0, files: 0 };
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const full = join(dir, name);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) continue;
    let raw: string;
    try {
      raw = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    tokens += estimateTokens(raw);
    files += 1;
  }
  return { tokens, files };
}

/** {@link sumDir} over the store's records whose page sat in `dir`. */
function sumStorePages(vault: string, dir: string): { tokens: number; files: number } {
  const pages = storePagesIn(vault, dir);
  return {
    tokens: pages.reduce((sum, page) => sum + estimateTokens(page.text), 0),
    files: pages.length,
  };
}

/**
 * The store's log on a store-only machine, measured as its days: one
 * "file" per day with an event, the events of the day as JSON lines (the
 * shape a day file holds). With `withholdsPrivate`, an event of the
 * store's `private` partition is not measured, and a day left with no
 * event is not a file.
 */
function sumStoreLog(vault: string, withholdsPrivate: boolean): { tokens: number; files: number } {
  const days = storeLogDays(vault) ?? [];
  let tokens = 0;
  let files = 0;
  for (const day of days) {
    const entries = withoutPrivateEntries(day.entries, withholdsPrivate);
    if (entries.length === 0) continue;
    tokens += estimateTokens(entries.map((entry) => JSON.stringify(entry)).join("\n"));
    files += 1;
  }
  return { tokens, files };
}

/**
 * Resolve the warn threshold from an env-var override, falling back
 * to the documented default. The env-var path lets cron jobs
 * customise the warning level without code changes.
 */
function resolveWarnThreshold(envValue: string | undefined): number {
  if (envValue) {
    const n = Number.parseInt(envValue, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return TOKEN_WARN_THRESHOLD_DEFAULT;
}

export interface ComputeTokenFootprintOptions {
  readonly warnThreshold?: number;
  readonly envWarnThreshold?: string;
  /**
   * The caller is below local reach: the log bucket leaves out the events
   * of the store's `private` partition. The page buckets are page
   * aggregates and count every page. Default false.
   */
  readonly withholdsPrivate?: boolean;
}

export function computeTokenFootprint(
  vault: string,
  opts: ComputeTokenFootprintOptions = {},
): TokenFootprintReport {
  const dirs = brainDirs(vault);
  const tracked: Array<[name: string, path: string]> = [
    ["preferences", dirs.preferences],
    ["retired", dirs.retired],
    ["inbox", dirs.inbox],
    ["processed", dirs.processed],
    ["archived", dirs.archived],
    ["log", dirs.log],
  ];

  const byCategory: TokenFootprintCategory[] = [];
  let total = 0;
  let totalFiles = 0;
  // Store-only (task 2.10): the memory records are the fold's, measured
  // as the pages they would be; the log folder is not a memory record.
  const fromStore = memoryFromStore(vault);
  for (const [name, path] of tracked) {
    let measured: { tokens: number; files: number };
    if (!fromStore) measured = sumDir(path);
    else if (name === "log") measured = sumStoreLog(vault, opts.withholdsPrivate === true);
    else measured = sumStorePages(vault, path);
    const { tokens, files } = measured;
    byCategory.push({ name, tokens, files });
    total += tokens;
    totalFiles += files;
  }

  // "other" bucket: any *.md directly under Brain/ that we have not
  // already accounted for. We do not recurse into unknown subdirs
  // so a runaway plugin dropping junk under Brain/exotic-thing/ is
  // not silently included; the digest action list flags it instead.
  // A store-only machine writes nothing under `Brain/`: files left there
  // are pre-switch copies nothing reads, so they are not counted.
  const brainRoot = join(vault, BRAIN_ROOT_REL);
  if (!fromStore && existsSync(brainRoot)) {
    let otherTokens = 0;
    let otherFiles = 0;
    for (const name of readdirSync(brainRoot)) {
      const full = join(brainRoot, name);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) continue;
      if (!name.endsWith(".md")) continue;
      let raw: string;
      try {
        raw = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      otherTokens += estimateTokens(raw);
      otherFiles += 1;
    }
    byCategory.push({ name: "other", tokens: otherTokens, files: otherFiles });
    total += otherTokens;
    totalFiles += otherFiles;
  }

  const warnThreshold = opts.warnThreshold ?? resolveWarnThreshold(opts.envWarnThreshold);
  return Object.freeze({
    total,
    files: totalFiles,
    byCategory: Object.freeze(byCategory),
    warnThreshold,
    exceeded: total > warnThreshold,
  });
}
