import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { memoryFromStore, storePagesIn } from "../brain/memory-pages.ts";
import { BRAIN_INBOX_REL, BRAIN_PREFERENCES_REL, BRAIN_RETIRED_REL } from "../brain/paths.ts";
import type { ActivityWindow } from "./activity-git.ts";

export interface VaultDelta {
  readonly newSignals: number;
  readonly newPreferences: number;
  readonly newRetired: number;
  readonly total: number;
}

function countInWindow(dir: string, win: ActivityWindow): number {
  if (!existsSync(dir)) return 0;
  // Mirror the defensive shape from activity-mtime: readdirSync /
  // statSync can race with concurrent writers (dream pass, signal
  // import) and would otherwise crash the nightly cron with an
  // unhandled ENOENT/EPERM.
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtimeMs >= win.startUtc.getTime() && st.mtimeMs < win.endUtc.getTime()) n += 1;
  }
  return n;
}

/**
 * {@link countInWindow} on a store-only machine (task 2.10): the fold's
 * records whose page sat in `rel` and were last written inside the window.
 */
function countStoreInWindow(vault: string, rel: string, win: ActivityWindow): number {
  const start = win.startUtc.getTime();
  const end = win.endUtc.getTime();
  return storePagesIn(vault, rel).filter((p) => p.updatedMs >= start && p.updatedMs < end).length;
}

export function vaultDelta(vault: string, win: ActivityWindow): VaultDelta {
  const fromStore = memoryFromStore(vault);
  const count = (rel: string): number =>
    fromStore ? countStoreInWindow(vault, rel, win) : countInWindow(join(vault, rel), win);
  const newSignals = count(BRAIN_INBOX_REL);
  const newPreferences = count(BRAIN_PREFERENCES_REL);
  const newRetired = count(BRAIN_RETIRED_REL);
  return {
    newSignals,
    newPreferences,
    newRetired,
    total: newSignals + newPreferences + newRetired,
  };
}
