/**
 * Codex session-transcript paths for the discipline report.
 *
 * Codex stores per-session JSON files under `$CODEX_HOME` (default
 * `~/.codex`), and the exact subdirectory has moved between CLI releases
 * (`sessions/`, `session/`, `history/`, `.tmp/`). That list used to be
 * spelled here AND in `src/core/runtime/host-facts.ts`; it is now
 * declared once there and read from here. What stays local is this
 * scanner's own question - which `.json` files were TOUCHED inside the
 * report's local day, three levels deep - and the `TRANSCRIPT_SCAN`
 * vocabulary that answers which emptiness produced an empty list.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveSessionRootsFor, SESSION_RUNTIME_ID } from "../../runtime/host-facts.ts";
import {
  classifyTranscriptScan,
  type TranscriptRuntime,
  type TranscriptScanResult,
} from "./types.ts";

const MAX_DEPTH = 3;

export const codexTranscript: TranscriptRuntime = {
  runtime: "codex",
  agentHint: "codex-vps-agent",
  scan(dayStartMs, dayEndMs, home = homedir(), env = process.env): TranscriptScanResult {
    const files: string[] = [];
    const unreadable: string[] = [];
    let rootsPresent = false;
    for (const root of resolveSessionRootsFor(SESSION_RUNTIME_ID.codex, { home, env })) {
      if (!existsSync(root.path)) continue;
      rootsPresent = true;
      pushJsonInRange(root.path, dayStartMs, dayEndMs, files, unreadable, MAX_DEPTH);
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
