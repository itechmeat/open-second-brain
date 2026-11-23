/**
 * Names of the dream session trigger (change `dream-session-trigger`):
 * the one place that spells its device-local file names, its timings and
 * its environment switch, so the check, the worker, the outcome, the
 * status and doctor cannot drift apart. A leaf: it imports nothing.
 */

/** Device-local subdirectory of the state root holding one record per configured store root. */
export const DREAM_TRIGGER_DIR = "dream-trigger";

/** Version of the record's shape. */
export const DREAM_TRIGGER_RECORD_VERSION = 1;

/** Suffix of the claim file beside a record (`<record>.claim`). */
export const DREAM_TRIGGER_CLAIM_SUFFIX = ".claim";

/** First retry after a failed or incomplete pass: one hour. */
export const DREAM_TRIGGER_RETRY_BASE_MS = 60 * 60 * 1000;
/** Longest retry delay: one day. */
export const DREAM_TRIGGER_RETRY_CAP_MS = 24 * 60 * 60 * 1000;

/** What a claim may outlive the pass deadline by before its worker counts as lost. */
export const DREAM_TRIGGER_CLAIM_GRACE_MS = 2 * 60 * 1000;

/** Days the owner may cover nothing before other machines say so. */
export const DREAM_TRIGGER_SILENT_OWNER_DAYS = 3;

/**
 * Machine switch: `false` (or `0`, `off`, `no`) keeps every session on
 * this machine from starting a pass, whatever the shared setting says.
 */
export const DREAM_AUTO_ENV = "OPEN_SECOND_BRAIN_DREAM_AUTO";

/** The command a person runs a whole live pass with. */
export const DREAM_RUN_COMMAND = "o2b dream run";
/** The command that shows the state of the day. */
export const DREAM_STATUS_COMMAND = "o2b dream status";
/** The argument that hands a claim to the worker. */
export const DREAM_RUN_CLAIM_FLAG = "--claim";
/** The argument that runs the worker on no vault (a check that served none). */
export const DREAM_RUN_NO_VAULT_FLAG = "--no-vault";

/** The code of the runtime notice that carries the day check's note. */
export const DREAM_DAY_NOTICE_CODE = "dream-day";

/** Who ran a pass, as the record names it. */
export type DreamRunBy = "worker" | "cli" | "mcp" | "lane";

/** Whether the machine switch turns automatic dream off here. */
export function dreamAutoOffByEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env[DREAM_AUTO_ENV]?.trim().toLowerCase();
  return raw === "false" || raw === "0" || raw === "off" || raw === "no";
}
