/**
 * Names of the dream owner role (change `agent-neutral-dream`, design D1):
 * the one place that spells its record kinds, device-local file names and
 * commands, so the fold, the gate, the CLI, MCP and doctor cannot drift
 * apart. Mirrors `src/core/view/constants.ts`.
 *
 * The dream owner is one agent installation on one device. Only that
 * device runs a live dream pass on the brain; every other device previews.
 */

/** Settings stream: a device takes the role, or the owner's device changes its agent. */
export const DREAM_OWNER_CLAIM_KIND = "dream-owner-claim";
/** Settings stream: a device that is not the owner asks for the role. */
export const DREAM_OWNER_REQUEST_KIND = "dream-owner-request";
/** Settings stream: the owner's device hands the role over, or gives it up. */
export const DREAM_OWNER_RELEASED_KIND = "dream-owner-released";

/** Every record kind of the role; FORMAT.md documents each. */
export const DREAM_OWNER_RECORD_KINDS = Object.freeze([
  DREAM_OWNER_CLAIM_KIND,
  DREAM_OWNER_REQUEST_KIND,
  DREAM_OWNER_RELEASED_KIND,
] as const);

/** Device-local subdirectory of the role's state (never synced). */
export const DREAM_OWNER_STATE_DIR = "dream-owner";
/** Device-local file: the claim this device has already caught up on once. */
export const DREAM_OWNER_CLAIM_SEEN_FILE = "claim-seen.json";
/** Device-local lock target held for a whole live pass and for a release. */
export const DREAM_PASS_LOCK = "pass";

/** The command that shows the owner. */
export const DREAM_OWNER_COMMAND = "o2b dream owner";
/** The command that takes, asks for or adopts the role on the machine it runs on. */
export const DREAM_OWNER_HERE_COMMAND = "o2b dream owner --here";

/** The error code of a live pass refused on a device that is not the owner. */
export const DREAM_NOT_OWNER_CODE = "dream_not_owner";
