/**
 * The one error class for "this process cannot examine the vault": its
 * directory, or the `Brain/` folder whose presence decides the layout,
 * answers a permission or I/O error to a look (a stat, a realpath).
 *
 * It is a leaf module so every layer that meets the condition throws the
 * same class: the store-only predicate (`StoreOnlyUndeterminedError`
 * extends it), and the path-safety check, whose realpath of a mode-000
 * vault throws EACCES on macOS where Linux answers. Classification is by
 * this class, not by call site: the MCP error table maps it to
 * `vault_unreadable` and the command line prints it as one line with exit
 * 1, wherever it surfaces.
 */

import { accessSync, constants, statSync, type Stats } from "node:fs";

/** The vault, or the folder that decides its layout, cannot be examined. */
export class VaultUnexaminableError extends Error {
  readonly vault: string;
  /** The errno code of the failed look, when it carried one. */
  readonly code: string | undefined;
  constructor(vault: string, cause: Error, message?: string) {
    const code = (cause as NodeJS.ErrnoException).code;
    super(
      message ??
        `the vault ${vault} cannot be examined (${code ?? cause.message}); nothing is read from ` +
          "or written to the store or the vault until it can be read (make it and every parent " +
          "directory traversable, chmod u+rx)",
      { cause },
    );
    this.name = "VaultUnexaminableError";
    this.vault = vault;
    this.code = code;
  }
}

/** Errno codes of a look that says nothing about what is there. */
const UNEXAMINABLE_CODES: ReadonlySet<string> = new Set(["EACCES", "EPERM", "EIO", "ELOOP"]);

/** Errors of a look that prove nothing is at the path. */
const ABSENT_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENAMETOOLONG",
  "ERR_INVALID_ARG_VALUE",
  "ERR_INVALID_ARG_TYPE",
]);

/** What a look at a folder the vault's layout depends on found. */
export type DirectoryLook = "present" | "absent" | { readonly failed: Error };

/**
 * Look at a folder on the path from the vault root to `Brain/` (or a folder
 * below it that decides the layout), keeping the errno: absent only when
 * the look proves nothing is there (`ENOENT`, a name no file can have);
 * "cannot be examined" for every other failure (`EACCES`, `EPERM`, `EIO`,
 * `ELOOP`, `ENOTDIR` where a parent is a file), for an entry that is not
 * a directory, and for a directory this process cannot list and traverse
 * (mode 000: `stat` answers, every look inside it does not). Never
 * `existsSync`, which answers false for all of these alike.
 */
export function lookAtDirectory(path: string): DirectoryLook {
  let stat: Stats;
  try {
    stat = statSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (ABSENT_CODES.has(code)) return "absent";
    return { failed: err instanceof Error ? err : new Error(String(err)) };
  }
  if (!stat.isDirectory()) {
    return {
      failed: Object.assign(new Error(`ENOTDIR: not a directory, '${path}'`), { code: "ENOTDIR" }),
    };
  }
  try {
    accessSync(path, constants.R_OK | constants.X_OK);
  } catch (err) {
    return { failed: err instanceof Error ? err : new Error(String(err)) };
  }
  return "present";
}

/**
 * The error for `path` (the vault, or a folder inside it) that cannot be
 * examined, naming the path when it is not the vault itself.
 */
export function unexaminablePath(
  vault: string,
  path: string,
  cause: Error,
): VaultUnexaminableError {
  if (path === vault) return new VaultUnexaminableError(vault, cause);
  const code = (cause as NodeJS.ErrnoException).code;
  return new VaultUnexaminableError(
    vault,
    cause,
    `${path} in the vault ${vault} cannot be examined (${code ?? cause.message}); nothing is ` +
      "read from or written to the store or the vault until it can be read (make it and every " +
      "parent directory traversable, chmod u+rx)",
  );
}

/**
 * The refusal for a vault root that is not there, or cannot be examined.
 *
 * A write must never MATERIALISE a vault: the folder is either an
 * unmounted disk or a mistyped path, and a fresh tree written in its
 * place hides the real vault. The refusal is the class this module
 * already owns, so every layer answers `vault_unreadable` for it.
 */
export function assertVaultPresent(vault: string): void {
  const look = lookAtDirectory(vault);
  if (look === "present") return;
  if (look === "absent") {
    const gone = Object.assign(new Error(`ENOENT: no such directory, '${vault}'`), {
      code: "ENOENT",
    });
    throw new VaultUnexaminableError(
      vault,
      gone,
      `the vault ${vault} is not there (ENOENT); a write never creates the vault folder ` +
        "(mount or restore it, or point the machine config at the vault)",
    );
  }
  throw new VaultUnexaminableError(vault, look.failed);
}

/** Whether `err` is a failed look that leaves the vault unexaminable. */
export function isUnexaminableLook(err: unknown): err is NodeJS.ErrnoException & Error {
  return err instanceof Error && UNEXAMINABLE_CODES.has((err as NodeJS.ErrnoException).code ?? "");
}

/**
 * Whether `path` (in `vault`) exists, keeping the errno: false only when
 * the look proves it absent; the unexaminable class for any other failure
 * (a parent that cannot be traversed reads as absent to `existsSync`).
 * For a decision that moves, seeds or refuses on the answer.
 */
export function pathPresent(vault: string, path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (ABSENT_CODES.has(code) || code === "ENOTDIR") return false;
    throw unexaminablePath(vault, path, err instanceof Error ? err : new Error(String(err)));
  }
}
