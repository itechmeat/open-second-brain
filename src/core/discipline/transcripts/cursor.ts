/**
 * Cursor session-transcript paths for the discipline report.
 *
 * Cursor stores per-workspace chat history in `state.vscdb` SQLite
 * files, under one of three layouts different builds have used. Those
 * three used to be listed here; they are declared once in
 * `src/core/runtime/host-facts.ts` and read from there. What stays local
 * is this scanner's own question - which databases were TOUCHED inside
 * the report's local day - and the deeper `collectDetail` parse.
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
  type TranscriptDetail,
  type TranscriptRuntime,
  type TranscriptScanResult,
} from "./types.ts";

/** Every layout a Cursor build has used, from the one declaration. */
function workspaceStorageRoots(ctx: HostContext): ReadonlyArray<string> {
  return resolveSessionRootsFor(SESSION_RUNTIME_ID.cursor, ctx).map((root) => root.path);
}

function findDatabases(ctx: HostContext): string[] {
  const out: string[] = [];
  for (const root of workspaceStorageRoots(ctx)) {
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

function queryCursorDb(
  dbPath: string,
  dayStartMs: number,
  dayEndMs: number,
): TranscriptDetail | null {
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
  scan(dayStartMs, dayEndMs, home = homedir(), env = process.env): TranscriptScanResult {
    const files: string[] = [];
    const unreadable: string[] = [];
    let rootsPresent = false;
    for (const root of workspaceStorageRoots({ home, env })) {
      if (!existsSync(root)) continue;
      rootsPresent = true;
      let dirs: import("node:fs").Dirent[];
      try {
        dirs = readdirSync(root, { withFileTypes: true });
      } catch {
        unreadable.push(root);
        continue;
      }
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const db = join(root, d.name, "state.vscdb");
        if (!existsSync(db)) continue;
        try {
          const ms = statSync(db).mtimeMs;
          if (ms >= dayStartMs && ms < dayEndMs) files.push(db);
        } catch {
          unreadable.push(db);
        }
      }
    }
    return classifyTranscriptScan(rootsPresent, files, unreadable);
  },
  collectDetail(
    dayStartMs,
    dayEndMs,
    home = homedir(),
    env = process.env,
  ): TranscriptDetail | null {
    const dbs = findDatabases({ home, env });
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
