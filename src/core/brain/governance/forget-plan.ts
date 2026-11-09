import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";

import { memoryFromStore, storeRecordPages } from "../memory-pages.ts";
import { parseFrontmatter } from "../../vault.ts";
import { storeLogDays } from "../log-days.ts";
import { brainDirs, vaultRelative } from "../paths.ts";

export interface ForgetPlanEntry {
  readonly id: string;
  readonly path: string;
  readonly kind: "inbox" | "processed" | "archived" | "preference" | "retired" | "log" | "other";
  readonly action: "would-remove-source-support";
  readonly sha256: string;
}

export interface ForgetPlan {
  readonly mode: "dry-run";
  readonly source: string;
  readonly entries: ReadonlyArray<ForgetPlanEntry>;
  readonly audit: {
    readonly contentIncluded: false;
    readonly entryCount: number;
  };
}

export function buildForgetPlan(vault: string, opts: { readonly source: string }): ForgetPlan {
  const source = opts.source.trim();
  if (!source) {
    return Object.freeze({
      mode: "dry-run",
      source,
      entries: Object.freeze([]),
      audit: Object.freeze({ contentIncluded: false, entryCount: 0 }),
    });
  }

  const entries: ForgetPlanEntry[] = [];
  for (const { path, read, id } of brainMarkdown(vault)) {
    let text: string;
    try {
      text = read();
    } catch {
      continue;
    }
    if (!text.includes(source)) continue;
    entries.push({
      id: id ?? readId(path),
      path: vaultRelative(path, vault),
      kind: classify(vault, path),
      action: "would-remove-source-support",
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));

  return Object.freeze({
    mode: "dry-run",
    source,
    entries: Object.freeze(entries),
    audit: Object.freeze({
      contentIncluded: false,
      entryCount: entries.length,
    }),
  });
}

interface BrainMarkdown {
  readonly path: string;
  readonly read: () => string;
  /** The record's id when known without reading the file. */
  readonly id?: string;
}

/**
 * Every Markdown document of the Brain layer. On a store-only machine
 * (task 2.10) the preferences and signals are the folds' records, as the
 * pages they would be, the log is one entry per day of the store's
 * `log-event` records, and their legacy folders are not walked. The
 * compiled digests are rendered on demand there, not written to the vault,
 * so they are no document to plan.
 */
function brainMarkdown(vault: string): BrainMarkdown[] {
  if (!memoryFromStore(vault)) {
    return walkBrainMarkdown(vault).map((path) => ({
      path,
      read: () => readFileSync(path, "utf8"),
    }));
  }
  const dirs = brainDirs(vault);
  // The log is the store's `log-event` records too: one entry per day.
  const memoryDirs = [dirs.inbox, dirs.preferences, dirs.retired, dirs.log];
  // `pending/` also stages notes; only its signals are memory records.
  const isMemory = (path: string): boolean =>
    memoryDirs.some((dir) => insideDir(path, dir)) ||
    (insideDir(path, dirs.pending) && basename(path).startsWith("sig-"));
  const files = walkBrainMarkdown(vault)
    .filter((path) => !isMemory(path))
    .map((path) => ({ path, read: () => readFileSync(path, "utf8") }));
  const records = storeRecordPages(vault, { signalStates: "all" }).map((page) => ({
    path: page.path,
    read: () => page.text,
    id: typeof page.meta["id"] === "string" && page.meta["id"].trim() ? page.meta["id"] : page.id,
  }));
  const logDays = (storeLogDays(vault) ?? []).map((day) => ({
    path: join(dirs.log, `${day.date}.md`),
    // The entries' own string values, unescaped, as a day file would hold
    // them: a JSON rendering escapes backslashes, quotes and newlines, so
    // a source like a Windows path would never match it.
    read: () => day.entries.flatMap((entry) => stringsOf(entry)).join("\n"),
    id: day.date,
  }));
  return [...files, ...records, ...logDays];
}

/** Every string value below `value`, depth first. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}

function walkBrainMarkdown(vault: string): string[] {
  const root = brainDirs(vault).brain;
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        visit(full);
        continue;
      }
      if (st.isFile() && name.endsWith(".md")) out.push(full);
    }
  };
  visit(root);
  out.sort();
  return out;
}

function readId(path: string): string {
  try {
    const [meta] = parseFrontmatter(path);
    if (typeof meta["id"] === "string" && meta["id"].trim()) return meta["id"];
  } catch {
    // Fall back to the basename below.
  }
  return basename(path, ".md");
}

function classify(vault: string, path: string): ForgetPlanEntry["kind"] {
  const dirs = brainDirs(vault);
  if (insideDir(path, dirs.processed)) return "processed";
  if (insideDir(path, dirs.archived)) return "archived";
  if (insideDir(path, dirs.inbox)) return "inbox";
  if (insideDir(path, dirs.preferences)) return "preference";
  if (insideDir(path, dirs.retired)) return "retired";
  if (insideDir(path, dirs.log)) return "log";
  return "other";
}

function insideDir(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}${sep}`);
}
