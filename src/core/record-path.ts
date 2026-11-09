/**
 * Paths that store records carry (a signal's `path`, a lane entry's id, an
 * imported record's `migrated.key`), checked before any of them names a
 * file. A record may come from any machine that syncs its partition
 * (FORMAT.md, Trust), so such a path is untrusted input: it must stay a
 * plain relative path, and the file it names must stay inside the folder
 * the caller meant.
 *
 *  - {@link recordRelPathProblem} / {@link isRecordRelPath}: the platform
 *    independent shape check, which the folds and record builders use. A
 *    path is `/`-separated, relative, with no empty, `.` or `..` segment
 *    (nor one of dots and spaces only, which Windows trims to one of
 *    those), no backslash, no NUL or line break, and no drive prefix.
 *  - {@link containedRecordPath}: the one helper every place that turns a
 *    record field into a filesystem path calls. It resolves the path under
 *    a root, refuses it when it lands outside the root (lexically or
 *    through a link), and on Windows also refuses a reserved device name
 *    (`con`, `nul`, `com1` and the rest) as any segment. It answers null
 *    instead of throwing, so a caller counts and reports the record and
 *    carries on with the others.
 */

import { join, resolve } from "node:path";

import { pathIsInside, realpathInsideVault } from "./path-safety.ts";

/** Windows device names, reserved in every folder and with any extension. */
const WINDOWS_RESERVED_RE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** A drive prefix (`C:`), which Windows reads as absolute or drive-relative. */
const DRIVE_RE = /^[A-Za-z]:/;

/** Why `rel` cannot name a file as a record path, or null when it can. */
export function recordRelPathProblem(rel: unknown): string | null {
  if (typeof rel !== "string" || rel === "") return "empty path";
  if (/[\0\r\n]/.test(rel)) return "control character in path";
  if (rel.includes("\\")) return "backslash in path";
  if (DRIVE_RE.test(rel)) return "drive prefix in path";
  if (rel.startsWith("/")) return "absolute path";
  for (const segment of rel.split("/")) {
    if (segment === "") return "empty path segment";
    if (/^[. ]+$/.test(segment)) return "dot segment in path";
  }
  return null;
}

/** Whether `rel` has the shape of a record path ({@link recordRelPathProblem}). */
export function isRecordRelPath(rel: unknown): rel is string {
  return recordRelPathProblem(rel) === null;
}

/** Whether a segment is a Windows device name, its extension and trailing dots ignored. */
function isWindowsReserved(segment: string): boolean {
  const stem = segment.split(".")[0]!.trimEnd();
  return WINDOWS_RESERVED_RE.test(stem) || WINDOWS_CONSOLE_RE.test(stem);
}

/** The console device names, which the `CON` family above does not cover. */
const WINDOWS_CONSOLE_RE = /^(?:CONIN\$|CONOUT\$)$/i;

/**
 * A segment Windows reads in a special way: a `:` opens an alternate data
 * stream of the file before it (`a.md:evil`), a trailing dot or space is
 * dropped (`a.md.` and `a.md` name one file, so two records would
 * overwrite each other), and `<>"|?*` are refused by the filesystem.
 */
const WINDOWS_SPECIAL_SEGMENT_RE = /[:<>"|?*\p{Cc}]|[. ]$/u;

/**
 * The absolute path `rel` names under `root`, or null when `rel` is not a
 * record path, names `root` itself, or lands outside `root` lexically or
 * through a link. `platform` decides whether Windows device names and the
 * segments Windows reads in a special way are refused; it is the host's
 * own unless a test names one.
 */
export function containedRecordPath(
  root: string,
  rel: unknown,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!isRecordRelPath(rel)) return null;
  const segments = rel.split("/");
  if (
    platform === "win32" &&
    segments.some((s) => isWindowsReserved(s) || WINDOWS_SPECIAL_SEGMENT_RE.test(s))
  ) {
    return null;
  }
  const target = resolve(join(root, ...segments));
  if (!pathIsInside(target, root) || resolve(root) === target) return null;
  if (!realpathInsideVault(target, root)) return null;
  return target;
}
