/**
 * Codex session-transcript paths for the discipline report.
 *
 * Codex stores per-session JSON files under `~/.codex/`. The exact
 * subdirectory has moved between CLI releases (`sessions/`, `.tmp/`,
 * etc.); we walk every immediate subdirectory of `~/.codex/` and look
 * for `.json` files whose mtime falls in the day window.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { TranscriptRuntime } from "./types.ts";

export const codexTranscript: TranscriptRuntime = {
  runtime: "codex",
  agentHint: "codex-vps-agent",
  collect(dayStartMs, dayEndMs, home = homedir()): string[] {
    const base = join(home, ".codex");
    if (!existsSync(base)) return [];
    const candidates = ["sessions", "session", "history", ".tmp"];
    const out: string[] = [];
    for (const sub of candidates) {
      const dir = join(base, sub);
      if (!existsSync(dir)) continue;
      pushJsonInRange(dir, dayStartMs, dayEndMs, out, 3);
    }
    return out;
  },
};

function pushJsonInRange(
  dir: string,
  dayStartMs: number,
  dayEndMs: number,
  out: string[],
  depth: number,
): void {
  if (depth < 0) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      pushJsonInRange(full, dayStartMs, dayEndMs, out, depth - 1);
      continue;
    }
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    try {
      const st = statSync(full);
      if (st.mtimeMs >= dayStartMs && st.mtimeMs < dayEndMs) out.push(full);
    } catch {
      // unreadable — ignore
    }
  }
}
