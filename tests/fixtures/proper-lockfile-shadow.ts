/**
 * A check-only fixture for the `proper-lockfile` census in
 * `tests/core/fs-lock.test.ts`: a module that imports the lock under a name
 * it also uses for a parameter of its own.
 *
 * The call inside {@link run} reaches the parameter, not the import, so the
 * census must not read this file as taking a lock. It is a fixture and not a
 * source file: nothing ships it, and no lock is taken by it.
 */

import pl from "proper-lockfile";

/** A call that is not a lock call: `checkSync` only looks at a name. */
export function isLocked(path: string): boolean {
  return pl.checkSync(path);
}

/** A parameter that shadows the imported binding: this call is not the lock. */
export function run(pl: () => void): void {
  pl();
}
