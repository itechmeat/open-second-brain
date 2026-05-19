/**
 * Helpers used by the interactive `o2b brain rollback` flow:
 *
 *   - {@link diffSummary} counts Markdown artifacts under
 *     `Brain/preferences/`, `Brain/retired/`, `Brain/inbox/` so the
 *     dispatcher can print a one-line "(X prefs, Y retired, Z signals)"
 *     summary before prompting.
 *   - {@link readSingleLine} reads one trimmed line from stdin without
 *     pulling in `readline`. Used for the y/N prompt when `--yes` is
 *     absent and stdin is a TTY.
 *
 * No I/O on Brain content — only `fs.statSync` and stdin reads.
 */

import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { resolve } from "node:path";

export interface DiffSummary {
  readonly preferences: number;
  readonly retired: number;
  readonly signals: number;
}

export function diffSummary(vault: string): DiffSummary {
  const root = resolve(vault, "Brain");
  const safeCount = (p: string): number => {
    if (!existsSync(p)) return 0;
    try {
      const st = statSync(p);
      if (!st.isDirectory()) return 0;
    } catch {
      return 0;
    }
    try {
      const entries: Dirent[] = readdirSync(p, { withFileTypes: true });
      return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).length;
    } catch {
      return 0;
    }
  };
  return {
    preferences: safeCount(resolve(root, "preferences")),
    retired: safeCount(resolve(root, "retired")),
    signals: safeCount(resolve(root, "inbox")),
  };
}

export function readSingleLine(): Promise<string> {
  return new Promise((res) => {
    let buf = "";
    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        process.stdin.removeListener("data", onData);
        process.stdin.removeListener("end", onEnd);
        process.stdin.pause();
        res(buf.slice(0, nl).trim());
      }
    };
    const onEnd = (): void => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      res(buf.trim());
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}
