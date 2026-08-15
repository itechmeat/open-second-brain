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

import {
  classifyTranscriptScan,
  type TranscriptRuntime,
  type TranscriptScanResult,
} from "./types.ts";

/** Subdirectories of `~/.codex/` that have held session files across releases. */
const CANDIDATE_SUBDIRS: ReadonlyArray<string> = Object.freeze([
  "sessions",
  "session",
  "history",
  ".tmp",
]);

const MAX_DEPTH = 3;

export const codexTranscript: TranscriptRuntime = {
  runtime: "codex",
  agentHint: "codex-vps-agent",
  scan(dayStartMs, dayEndMs, home = homedir()): TranscriptScanResult {
    const base = join(home, ".codex");
    const files: string[] = [];
    const unreadable: string[] = [];
    let rootsPresent = false;
    for (const sub of CANDIDATE_SUBDIRS) {
      const dir = join(base, sub);
      if (!existsSync(dir)) continue;
      rootsPresent = true;
      pushJsonInRange(dir, dayStartMs, dayEndMs, files, unreadable, MAX_DEPTH);
    }
    return classifyTranscriptScan(rootsPresent, files, unreadable);
  },
};

function pushJsonInRange(
  dir: string,
  dayStartMs: number,
  dayEndMs: number,
  files: string[],
  unreadable: string[],
  depth: number,
): void {
  if (depth < 0) {
    // The walk stopped short of the bottom, so anything below is uncounted.
    unreadable.push(dir);
    return;
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    unreadable.push(dir);
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      pushJsonInRange(full, dayStartMs, dayEndMs, files, unreadable, depth - 1);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const ms = statSync(full).mtimeMs;
      if (ms >= dayStartMs && ms < dayEndMs) files.push(full);
    } catch {
      unreadable.push(full);
    }
  }
}
