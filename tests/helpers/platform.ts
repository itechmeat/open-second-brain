/**
 * Platform facts that decide whether a test's fixture can be built at all.
 *
 * Several suites build an "unreadable file" or "unwritable directory" by
 * dropping POSIX permission bits (`chmod 000`, `chmod 0o500`) and then pin the
 * named refusal the product prints for it. Two hosts cannot build that
 * state, and on both the test would fail for a reason that says nothing
 * about the product:
 *
 * - root reads and writes through any mode bits, so the chmod is a no-op;
 * - Windows maps `chmod` onto the single read-only attribute: it never
 *   removes read access, and a read-only directory still accepts new
 *   entries, so the denial the test waits for never happens.
 *
 * Tests gate on these constants instead of re-deriving the check inline, so
 * the reason a skip exists is written down once.
 */

import { join } from "node:path";

/** True when the process runs as root, which ignores permission bits. */
export const RUNNING_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

/** True on native Windows, where `chmod` cannot deny read or directory writes. */
export const IS_WINDOWS = process.platform === "win32";

/**
 * True when `chmod` cannot produce a permission-denied fixture on this host:
 * root on POSIX, or any user on Windows.
 */
export const CHMOD_CANNOT_DENY = RUNNING_AS_ROOT || IS_WINDOWS;

/**
 * The environment entries that point a child process's home at `home`.
 *
 * Suites that spawn a hook or the CLI with a minimal environment
 * (`{ PATH, HOME }`) rely on HOME to keep the child off the operator's real
 * config. That holds on POSIX only. A Windows child with no `USERPROFILE`
 * or `%LOCALAPPDATA%` resolves its home through the OS profile API, so the
 * product's per-user roots (`src/core/platform-dirs.ts`) land in the
 * operator's REAL `%LOCALAPPDATA%\open-second-brain` - where a hook that
 * mints a device id then writes a config file. On win32 this also sets the
 * three Windows variables under `home`, the layout Windows itself uses.
 */
export function homeEnv(home: string): Record<string, string> {
  if (!IS_WINDOWS) return { HOME: home };
  return {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "AppData", "Local"),
    APPDATA: join(home, "AppData", "Roaming"),
  };
}
