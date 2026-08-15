/**
 * Claude Code session-transcript paths for the discipline report.
 *
 * Reuses the same `~/.claude/projects/*` layout that
 * `o2b brain import-claude-memory` walks. We treat any `.jsonl`
 * session file as evidence of agent activity on the day matching
 * its mtime.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  classifyTranscriptScan,
  type TranscriptRuntime,
  type TranscriptScanResult,
} from "./types.ts";

export const claudeCodeTranscript: TranscriptRuntime = {
  runtime: "claudecode",
  agentHint: "claude-vps-agent",
  scan(dayStartMs, dayEndMs, home = homedir()): TranscriptScanResult {
    const base = join(home, ".claude", "projects");
    const files: string[] = [];
    const unreadable: string[] = [];
    if (!existsSync(base)) return classifyTranscriptScan(false, files, unreadable);

    let entries: string[];
    try {
      entries = readdirSync(base);
    } catch {
      // The store is there; we simply cannot see inside it. Reporting zero
      // files here without saying so is the defect this scan exists to fix.
      unreadable.push(base);
      return classifyTranscriptScan(true, files, unreadable);
    }
    for (const entry of entries) {
      const projectDir = join(base, entry);
      let projectFiles: string[];
      try {
        projectFiles = readdirSync(projectDir);
      } catch {
        unreadable.push(projectDir);
        continue;
      }
      for (const name of projectFiles) {
        if (!name.endsWith(".jsonl")) continue;
        const full = join(projectDir, name);
        try {
          const ms = statSync(full).mtimeMs;
          if (ms >= dayStartMs && ms < dayEndMs) files.push(full);
        } catch {
          // A file whose mtime cannot be read cannot be placed in or out of
          // the window, so it is uncounted rather than assumed absent.
          unreadable.push(full);
        }
      }
    }
    return classifyTranscriptScan(true, files, unreadable);
  },
};
