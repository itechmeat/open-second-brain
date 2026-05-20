/**
 * Cursor session-transcript paths for the discipline report.
 *
 * Cursor stores per-workspace chat history in `state.vscdb` SQLite
 * files. We probe both the Linux layout
 * (`~/.config/Cursor/User/workspaceStorage/<hash>/state.vscdb`) and
 * the macOS layout (under `~/Library/Application Support/Cursor/`).
 * v0.10.11 only checks file mtime; deeper SQLite parsing is deferred.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { TranscriptRuntime } from "./types.ts";

export const cursorTranscript: TranscriptRuntime = {
  runtime: "cursor",
  agentHint: "cursor-vps-agent",
  collect(dayStartMs, dayEndMs, home = homedir()): string[] {
    const roots = [
      join(home, ".config", "Cursor", "User", "workspaceStorage"),
      join(home, "Library", "Application Support", "Cursor", "User", "workspaceStorage"),
      // macOS XDG-style fallback used by some Cursor builds
      join(home, ".cursor", "workspaceStorage"),
    ];
    const out: string[] = [];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      let dirs: import("node:fs").Dirent[];
      try {
        dirs = readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const db = join(root, d.name, "state.vscdb");
        if (!existsSync(db)) continue;
        try {
          const st = statSync(db);
          if (st.mtimeMs >= dayStartMs && st.mtimeMs < dayEndMs) out.push(db);
        } catch {
          // unreadable — ignore
        }
      }
    }
    return out;
  },
};
