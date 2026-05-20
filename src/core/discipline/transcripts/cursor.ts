/**
 * Cursor session-transcript paths for the discipline report.
 *
 * Cursor stores per-workspace chat history in `state.vscdb` SQLite
 * files. We probe both the Linux layout
 * (`~/.config/Cursor/User/workspaceStorage/<hash>/state.vscdb`) and
 * the macOS layout (under `~/Library/Application Support/Cursor/`).
 * collect() remains the mtime probe for backward compat; collectDetail()
 * does a deeper SQLite parse when bun:sqlite is available.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { TranscriptDetail, TranscriptRuntime } from "./types.ts";

function findDatabases(home: string): string[] {
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
      if (existsSync(db)) out.push(db);
    }
  }
  return out;
}

function queryCursorDb(dbPath: string, dayStartMs: number, dayEndMs: number): TranscriptDetail | null {
  let Database: typeof import("bun:sqlite").Database;
  try {
    Database = require("bun:sqlite").Database;
  } catch {
    return null;
  }

  let db: InstanceType<typeof Database>;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }

  try {
    const rows = db
      .query("SELECT key, value FROM ItemTable WHERE key LIKE 'sessionData.%'")
      .all() as Array<{ key: string; value: string }>;

    let sessionCount = 0;
    let messageCount = 0;

    for (const row of rows) {
      try {
        const data = JSON.parse(row.value);
        const messages = data?.messages ?? data?.turns ?? data?.data?.messages;
        if (Array.isArray(messages)) {
          let hasActivityInWindow = false;
          for (const msg of messages) {
            const ts = msg?.timestamp ?? msg?.createdAt ?? msg?.created_at;
            if (ts) {
              const tsMs = typeof ts === "number" ? ts : Date.parse(ts);
              if (Number.isFinite(tsMs) && tsMs >= dayStartMs && tsMs < dayEndMs) {
                hasActivityInWindow = true;
              }
            }
          }
          if (hasActivityInWindow) {
            sessionCount++;
            for (const msg of messages) {
              const ts = msg?.timestamp ?? msg?.createdAt ?? msg?.created_at;
              if (ts) {
                const tsMs = typeof ts === "number" ? ts : Date.parse(ts);
                if (Number.isFinite(tsMs) && tsMs >= dayStartMs && tsMs < dayEndMs) {
                  messageCount++;
                }
              }
            }
          }
        }
      } catch {
        // ignore malformed rows
      }
    }

    if (sessionCount === 0 && messageCount === 0) return null;
    return { sessionCount, messageCount };
  } finally {
    try {
      db.close();
    } catch {
      // ignore close failures
    }
  }
}

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
  collectDetail(dayStartMs, dayEndMs, home = homedir()): TranscriptDetail | null {
    const dbs = findDatabases(home);
    let totalSessions = 0;
    let totalMessages = 0;

    for (const db of dbs) {
      try {
        const result = queryCursorDb(db, dayStartMs, dayEndMs);
        if (result) {
          totalSessions += result.sessionCount;
          totalMessages += result.messageCount;
        }
      } catch {
        // ignore unreadable dbs and keep probing the rest
      }
    }

    if (totalSessions === 0) return null;
    return { sessionCount: totalSessions, messageCount: totalMessages };
  },
};
