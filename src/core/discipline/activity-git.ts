import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export interface ActivityWindow {
  readonly startUtc: Date;
  readonly endUtc: Date;
}

export interface GitActivity {
  readonly commits: number;
  readonly filesChanged: number;
  readonly pathsChanged?: ReadonlyArray<string>;
  readonly insertions: number;
  readonly deletions: number;
}

export function gitActivity(
  path: string,
  win: ActivityWindow,
): GitActivity | null {
  if (!existsSync(join(path, ".git"))) return null;
  const since = win.startUtc.toISOString();
  const until = win.endUtc.toISOString();
  let raw: string;
  try {
    raw = execFileSync(
      "git",
      [
        "-C",
        path,
        "log",
        `--since=${since}`,
        `--until=${until}`,
        "--no-merges",
        "--numstat",
        "--pretty=tformat:__COMMIT__",
      ],
      { encoding: "utf8" },
    );
  } catch {
    // Surface git failure as `null` so the orchestrator can fall back to
    // mtime activity for this watched path. Returning zeros would mask a
    // real "the agent shipped commits but git refused to talk" day and
    // suppress the alert §D exists to raise.
    return null;
  }

  let commits = 0;
  let insertions = 0;
  let deletions = 0;
  const seenFiles = new Set<string>();

  for (const line of raw.split("\n")) {
    if (line === "__COMMIT__") {
      commits += 1;
      continue;
    }
    // numstat format: "<added>\t<deleted>\t<filename>"
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    insertions += m[1] === "-" ? 0 : Number(m[1]);
    deletions += m[2] === "-" ? 0 : Number(m[2]);
    seenFiles.add(m[3]!);
  }

  return {
    commits,
    filesChanged: seenFiles.size,
    pathsChanged: [...seenFiles].toSorted(),
    insertions,
    deletions,
  };
}
