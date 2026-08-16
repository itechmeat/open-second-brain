/**
 * Claude Code session-transcript paths for the discipline report.
 *
 * The `~/.claude/projects/*` layout used to be spelled here, a second
 * time in `src/core/brain/claude-memory-paths.ts`, and a third time in
 * the docblock of the session adapter. It is now declared once in
 * `src/core/runtime/host-facts.ts` and read from there; what stays local
 * is this scanner's own question - which files were TOUCHED inside the
 * report's local day - and the `TRANSCRIPT_SCAN` vocabulary that answers
 * which emptiness produced an empty list.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  resolveSessionRootsFor,
  SESSION_RUNTIME_ID,
  type HostContext,
} from "../../runtime/host-facts.ts";
import {
  classifyTranscriptScan,
  type TranscriptRuntime,
  type TranscriptScanResult,
} from "./types.ts";

/** The declared roots for Claude Code against one host. */
function roots(ctx: HostContext): ReadonlyArray<string> {
  return resolveSessionRootsFor(SESSION_RUNTIME_ID.claudeCode, ctx).map((root) => root.path);
}

export const claudeCodeTranscript: TranscriptRuntime = {
  runtime: "claudecode",
  agentHint: "claude-vps-agent",
  scan(dayStartMs, dayEndMs, home = homedir(), env = process.env): TranscriptScanResult {
    const files: string[] = [];
    const unreadable: string[] = [];
    let rootsPresent = false;
    for (const base of roots({ home, env })) {
      if (!existsSync(base)) continue;
      rootsPresent = true;

      let entries: string[];
      try {
        entries = readdirSync(base);
      } catch {
        // The store is there; we simply cannot see inside it. Reporting zero
        // files here without saying so is the defect this scan exists to fix.
        unreadable.push(base);
        continue;
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
    }
    return classifyTranscriptScan(rootsPresent, files, unreadable);
  },
};
