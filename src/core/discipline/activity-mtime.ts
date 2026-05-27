import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ActivityWindow } from "./activity-git.ts";

const EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  ".snapshots",
  "dist",
  "build",
  "out",
]);

export interface MtimeActivity {
  readonly modifiedFiles: number;
}

export function mtimeActivity(root: string, win: ActivityWindow): MtimeActivity {
  const startMs = win.startUtc.getTime();
  const endMs = win.endUtc.getTime();
  let count = 0;

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (EXCLUDE_DIRS.has(name)) continue;
      const p = join(dir, name);
      // lstatSync first — refuse to follow symlinks so we never recurse
      // through a symlink cycle (`a -> b -> a`) or escape the watched
      // tree via a symlink to `/`. Regular files reachable through a
      // symlinked parent are skipped too, which matches what a
      // cron-friendly nightly walk should do.
      let lst;
      try {
        lst = lstatSync(p);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) continue;
      if (lst.isDirectory()) {
        walk(p);
        continue;
      }
      if (!lst.isFile()) continue;
      // statSync (deref) is fine here because we already know the entry
      // is a regular file via lstat — no symlink follow happens.
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      const m = st.mtimeMs;
      if (m >= startMs && m < endMs) count += 1;
    }
  }

  walk(root);
  return { modifiedFiles: count };
}
