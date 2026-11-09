/**
 * Owner-only copies for the migration's device-local folders (design D11
 * step 3, D14 item 6): the backup and the moved device-local state hold
 * secrets, signing keys and a snapshot of `Brain/`, so a copy there is
 * readable by its owner alone whatever mode its source had (an older
 * install, a restored backup, a filesystem that kept no modes).
 *
 * On POSIX every folder from the copy root down to the file is `0700` and
 * the file `0600`, set explicitly rather than inherited from the source or
 * the umask. Windows ignores those modes; there the copy root gets the
 * owner-only ACL of the secrets module (`restrictToOwner`), whose
 * inheritable grant every folder and file created below it then carries.
 */

import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { restrictToOwner } from "../brain/secrets/owner-acl.ts";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Create `root` (and its parents) owner-only: `0700` on POSIX, the
 * owner-only ACL on Windows. Call it before the first copy into `root`, so
 * on Windows everything created below inherits the restriction.
 */
export function ensureOwnerOnlyRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: DIR_MODE });
  if (process.platform === "win32") restrictToOwner(root, "directory");
  else chmodSync(root, DIR_MODE);
}

/** Every folder from `root` (included) down to `dir` (included). */
function foldersFrom(root: string, dir: string): string[] {
  const rel = relative(resolve(root), resolve(dir));
  if (rel === "" || rel.startsWith("..")) return [resolve(root)];
  const out = [resolve(root)];
  for (const segment of rel.split(sep)) out.push(`${out.at(-1)!}${sep}${segment}`);
  return out;
}

/** Copy `source` to `target` (inside `root`), owner-only on every platform. */
export function copyOwnerOnly(source: string, target: string, root: string): void {
  mkdirSync(dirname(target), { recursive: true, mode: DIR_MODE });
  if (process.platform !== "win32") {
    for (const folder of foldersFrom(root, dirname(target))) chmodSync(folder, DIR_MODE);
  }
  copyFileSync(source, target);
  if (process.platform !== "win32") chmodSync(target, FILE_MODE);
}
