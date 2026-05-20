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

import type { TranscriptRuntime } from "./types.ts";

export const claudeCodeTranscript: TranscriptRuntime = {
  runtime: "claudecode",
  agentHint: "claude-vps-agent",
  collect(dayStartMs, dayEndMs, home = homedir()): string[] {
    const base = join(home, ".claude", "projects");
    if (!existsSync(base)) return [];
    const out: string[] = [];
    let entries: string[];
    try {
      entries = readdirSync(base);
    } catch {
      return [];
    }
    for (const e of entries) {
      const projectDir = join(base, e);
      let files: string[];
      try {
        files = readdirSync(projectDir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const full = join(projectDir, f);
        try {
          const st = statSync(full);
          const ms = st.mtimeMs;
          if (ms >= dayStartMs && ms < dayEndMs) out.push(full);
        } catch {
          // unreadable file — ignore
        }
      }
    }
    return out;
  },
};
