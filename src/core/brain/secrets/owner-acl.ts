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
import { resolve, win32 } from "node:path";

/** How long `icacls` or `whoami` may take before the protection is reported as failed. */
const TOOL_TIMEOUT_MS = 10_000;

/**
 * Absolute path of a System32 tool. A bare `icacls.exe` is looked up in the
 * current directory before PATH, so a copy planted in whatever directory
 * the process runs in would be the one handed the secrets path.
 */
export function system32Tool(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const root = env["SystemRoot"] || env["windir"] || "C:\\Windows";
  return win32.join(root, "System32", name);
}

/** The current user as `whoami` reports it: the account name and its SID. */
export interface WindowsIdentity {
  readonly name: string;
  readonly sid: string;
}

/**
 * Parse `whoami /user /fo csv /nh`, one line: `"host\\user","S-1-5-21-..."`.
 * Returns null for anything else.
 */
export function parseWhoamiUser(stdout: string): WindowsIdentity | null {
  const m = /^\s*"([^"]+)","(S-1-\d+(?:-\d+)+)"\s*$/m.exec(stdout);
  return m ? { name: m[1]!, sid: m[2]! } : null;
}

let cachedIdentity: WindowsIdentity | null | undefined;

/**
 * The current user's account name and SID, from the process token via
 * `whoami`, or null when it cannot be read. Cached for the process.
 *
 * The ACL grants by SID, never by name. A name has to come from somewhere
 * a parent process can rewrite (`%USERNAME%`, `%USERDOMAIN%`) or has to be
 * mapped back to an account by `icacls` (`AzureAD\\...` on an Entra-joined
 * machine may not map), and `/inheritance:r` then leaves the key readable
 * by whoever that name resolved to and nobody else.
 */
export function currentWindowsIdentity(): WindowsIdentity | null {
  if (cachedIdentity !== undefined) return cachedIdentity;
  try {
    const proc = spawnSync(system32Tool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: TOOL_TIMEOUT_MS,
    });
    cachedIdentity =
      proc.error === undefined && proc.status === 0 ? parseWhoamiUser(proc.stdout) : null;
  } catch {
    cachedIdentity = null;
  }
  return cachedIdentity;
}

/**
 * The `icacls` argument vector that leaves `path` readable and writable
 * by the account with SID `sid` alone: `/inheritance:r` drops every
 * inherited entry, `/grant:r` replaces any explicit grant for that account
 * with full control (`*S-1-...` is how `icacls` takes a SID). A directory's
 * grant carries `(OI)(CI)` so the files created in it later (the ciphertext
 * store, its temp file) inherit the same single entry instead of the
 * creator's default ACL.
 */
export function ownerOnlyAclArgv(
  path: string,
  sid: string,
  kind: "file" | "directory",
): ReadonlyArray<string> {
  const rights = kind === "directory" ? "(OI)(CI)F" : "F";
  return [path, "/inheritance:r", "/grant:r", `*${sid}:${rights}`];
}

/** Paths this process already restricted; see {@link restrictToOwner}. */
const restricted = new Set<string>();

/**
 * Restrict `path` to the current user on Windows; a no-op elsewhere,
 * where the POSIX mode set at creation already does it. Returns whether
 * the ACL is in place, and warns on stderr when it is not. `platform` is
 * a test seam.
 *
 * Idempotent, and meant to be called on every load rather than only when
 * the file is created: a secrets directory that arrived with a copied or
 * restored vault carries whatever ACL it inherited at its new place. Each
 * path is set once per process; a failure is retried on the next call.
 */
export function restrictToOwner(
  path: string,
  kind: "file" | "directory",
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return true;
  const key = `${kind}:${resolve(path).toLowerCase()}`;
  if (restricted.has(key)) return true;
  let detail: string;
  try {
    const identity = currentWindowsIdentity();
    if (identity === null) {
      detail = "the current user's SID could not be read (whoami /user)";
    } else {
      const proc = spawnSync(
        system32Tool("icacls.exe"),
        [...ownerOnlyAclArgv(path, identity.sid, kind)],
        { encoding: "utf8", windowsHide: true, timeout: TOOL_TIMEOUT_MS },
      );
      if (proc.error === undefined && proc.status === 0) {
        restricted.add(key);
        return true;
      }
      detail =
        proc.error !== undefined
          ? proc.error.message
          : `icacls exited ${proc.status ?? proc.signal}: ${(proc.stderr || proc.stdout).trim()}`;
    }
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
  }
  process.stderr.write(
    `warning: could not restrict secrets ${kind} to the current user, ` +
      `it keeps its inherited ACL: ${path}: ${detail}\n`,
  );
  return false;
}
