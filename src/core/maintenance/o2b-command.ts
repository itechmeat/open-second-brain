import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * argv prefix that runs this checkout's CLI (current plugin version), for
 * the detached children the self-heal and freshen paths start.
 *
 * POSIX goes through `scripts/o2b`, which also applies the macOS SQLite
 * setup. Native Windows cannot execute that bash launcher, so it runs the
 * TypeScript entry point with the Bun that is running this process.
 */
export function o2bCommand(): string[] {
  // src/core/maintenance/o2b-command.ts -> repo root
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (process.platform === "win32") {
    return [process.execPath, "run", join(repo, "src", "cli", "main.ts")];
  }
  return [join(repo, "scripts", "o2b")];
}
