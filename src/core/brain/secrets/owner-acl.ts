/**
 * Windows stand-in for the secrets store's `0600` / `0700` modes.
 *
 * On POSIX the keyfile is created `0600` inside a `0700` directory, so
 * no other local account can read the key. Windows ignores those mode
 * arguments: the file and the directory inherit whatever ACL their
 * parent carries, which under a vault on a shared or synced drive can
 * include every authenticated user. The equivalent there is an explicit
 * ACL - inheritance removed, one full-control entry for the current
 * user - which `icacls` sets.
 *
 * Best-effort by design, like the modes it replaces: the key is already
 * written when this runs, and failing that write because an ACL tool is
 * missing or refused would lose nothing an attacker wants and break
 * every secret operation. A failure is reported on stderr as a warning
 * that names the path, and the caller carries on.
 *
 * The threat model is unchanged (see `crypto.ts`): same-user processes
 * and administrators still read the key.
 */

import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";

/** How long `icacls` may take before the protection is reported as failed. */
const ICACLS_TIMEOUT_MS = 10_000;

/**
 * The account the ACL grants, as `icacls` names it: `DOMAIN\user` when
 * the logon domain is known (a local account's domain is the machine
 * name), the bare user name otherwise. The user name comes from the OS
 * rather than `%USERNAME%`, which any parent process can rewrite.
 */
export function windowsAclPrincipal(
  env: Readonly<Record<string, string | undefined>> = process.env,
  username: string = userInfo().username,
): string {
  const domain = env["USERDOMAIN"]?.trim();
  return domain ? `${domain}\\${username}` : username;
}

/**
 * The `icacls` argument vector that leaves `path` readable and writable
 * by `principal` alone: `/inheritance:r` drops every inherited entry,
 * `/grant:r` replaces any explicit grant for the principal with full
 * control. A directory's grant carries `(OI)(CI)` so the files created
 * in it later (the ciphertext store, its temp file) inherit the same
 * single entry instead of the creator's default ACL.
 */
export function ownerOnlyAclArgv(
  path: string,
  principal: string,
  kind: "file" | "directory",
): ReadonlyArray<string> {
  const rights = kind === "directory" ? "(OI)(CI)F" : "F";
  return [path, "/inheritance:r", "/grant:r", `${principal}:${rights}`];
}

/**
 * Restrict `path` to the current user on Windows; a no-op elsewhere,
 * where the POSIX mode set at creation already does it. Returns whether
 * the ACL was applied, and warns on stderr when it was not. `platform` is
 * a test seam.
 */
export function restrictToOwner(
  path: string,
  kind: "file" | "directory",
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return true;
  let detail: string;
  try {
    const proc = spawnSync("icacls.exe", [...ownerOnlyAclArgv(path, windowsAclPrincipal(), kind)], {
      encoding: "utf8",
      windowsHide: true,
      timeout: ICACLS_TIMEOUT_MS,
    });
    if (proc.error === undefined && proc.status === 0) return true;
    detail =
      proc.error !== undefined
        ? proc.error.message
        : `icacls exited ${proc.status ?? proc.signal}: ${(proc.stderr || proc.stdout).trim()}`;
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
  }
  process.stderr.write(
    `warning: could not restrict secrets ${kind} to the current user, ` +
      `it keeps its inherited ACL: ${path}: ${detail}\n`,
  );
  return false;
}
