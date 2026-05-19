import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ActivityWindow } from "./activity-git.ts";

export interface VaultDelta {
  readonly newSignals: number;
  readonly newPreferences: number;
  readonly newRetired: number;
  readonly total: number;
}

function countInWindow(dir: string, win: ActivityWindow): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (!st.isFile()) continue;
    if (st.mtimeMs >= win.startUtc.getTime() && st.mtimeMs < win.endUtc.getTime()) n += 1;
  }
  return n;
}

export function vaultDelta(vault: string, win: ActivityWindow): VaultDelta {
  const newSignals = countInWindow(join(vault, "Brain", "inbox"), win);
  const newPreferences = countInWindow(join(vault, "Brain", "preferences"), win);
  const newRetired = countInWindow(join(vault, "Brain", "retired"), win);
  return {
    newSignals, newPreferences, newRetired,
    total: newSignals + newPreferences + newRetired,
  };
}
