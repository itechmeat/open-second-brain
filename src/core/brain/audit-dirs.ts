/**
 * One spelling of every audit subdirectory a writer appends week shards
 * to (t_774dea61).
 *
 * Each name used to be a bare literal at its write site, and the doctor's
 * sync-conflict sweep needs the same directories: a rename performed at
 * the writer alone would leave the sweep looking at a directory nobody
 * writes, and report it clean. Writers and the sweep both read the names
 * from here. The schema-mutation audit keeps its own constant beside its
 * reader (`schema-integrity.ts`), the hook-audit root lives in
 * `path-constants.ts`, and the watchdog fallback's absolute path is built
 * in `watchdog.ts`, the module the state inventory attributes it to.
 */

/** `Brain/log/session-lifecycle/`: runtime session-lifecycle captures. */
export const SESSION_LIFECYCLE_AUDIT_DIR = "session-lifecycle";

/** `Brain/log/hygiene/`: hygiene applies and targeted recompiles. */
export const HYGIENE_AUDIT_DIR = "hygiene";

/** `Brain/log/secret-custody/`: secret reads, writes and exec decisions. */
export const SECRET_CUSTODY_AUDIT_DIR = "secret-custody";

/** `Brain/log/watchdog/`: watchdog probe records. */
export const WATCHDOG_AUDIT_DIR = "watchdog";

/**
 * `.open-second-brain/watchdog-audit/`: where a watchdog record lands
 * when its `Brain/log/` directory refuses the write.
 */
export const WATCHDOG_FALLBACK_AUDIT_DIR = "watchdog-audit";

/** Every audit subdirectory of `Brain/log/` named in this module. */
export const BRAIN_LOG_AUDIT_DIRS: ReadonlyArray<string> = Object.freeze([
  SESSION_LIFECYCLE_AUDIT_DIR,
  HYGIENE_AUDIT_DIR,
  SECRET_CUSTODY_AUDIT_DIR,
  WATCHDOG_AUDIT_DIR,
]);
