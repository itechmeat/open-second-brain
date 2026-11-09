/**
 * Names of the human view (design D7, spec `human-view`): the one place
 * that spells the view's pages, record kinds, config key, device-local
 * file names and time windows, so the writer, the renderer, the CLI, the
 * doctor and the format document cannot drift apart.
 *
 * The human view is a few generated Markdown pages written into a folder
 * the user chooses (inside the vault, anywhere else, or nowhere). One
 * device, the view writer, renders it; every other module reads the names
 * here.
 */

import { DAY_MS } from "../store/constants.ts";

/** Machine-config key that names the human view folder. No key: no view. */
export const VIEW_TARGET_CONFIG_KEY = "view_target";

/** Environment variable that names the human view folder, ahead of the config key. */
export const VIEW_TARGET_ENV = "OPEN_SECOND_BRAIN_VIEW_TARGET";

/** The profile page: what the brain knows about the user. */
export const VIEW_ABOUT_ME_PAGE = "about-me.md";

/** The decisions page. */
export const VIEW_DECISIONS_PAGE = "decisions.md";

/** Folder of the weekly history pages, `history/<YYYY>-W<ww>.md`. */
export const VIEW_HISTORY_DIR = "history";

/** Extension of every view page. */
export const VIEW_PAGE_EXT = ".md";

/**
 * Prefix of the view writer's own short-lived files in the view folder: the
 * new page before its rename and the replaced page right after it. A sync
 * setup should ignore names that start with it.
 */
export const VIEW_TEMP_PREFIX = ".o2b-view-";

/** Settings stream: the first machine records itself as the view writer. */
export const VIEW_WRITER_CLAIM_KIND = "view-writer-claim";
/** Settings stream: the user asks to move the role to the device that writes it. */
export const VIEW_WRITER_REQUEST_KIND = "view-writer-request";
/** Settings stream: the current writer hands the role over after a request. */
export const VIEW_WRITER_RELEASED_KIND = "view-writer-released";
/** Log stream: one page written, with its checksum and its merge base. */
export const VIEW_RENDER_KIND = "view-render";
/** Log stream: an idle render pass (every page already as rendered), at most once a day (the writer is alive). */
export const VIEW_PASS_KIND = "view-pass";
/** Log stream: bytes of a page the writer replaced or ingested, kept as a blob. */
export const VIEW_REPLACED_KIND = "view-replaced";
/** Events stream: a human correction of one generated line of a page. */
export const VIEW_CORRECTION_KIND = "view-correction";
/** Events stream: a line the user added to a page. */
export const VIEW_ADDITION_KIND = "view-addition";

/** Every record kind the human view defines; FORMAT.md documents each. */
export const VIEW_RECORD_KINDS = Object.freeze([
  VIEW_WRITER_CLAIM_KIND,
  VIEW_WRITER_REQUEST_KIND,
  VIEW_WRITER_RELEASED_KIND,
  VIEW_RENDER_KIND,
  VIEW_PASS_KIND,
  VIEW_REPLACED_KIND,
  VIEW_CORRECTION_KIND,
  VIEW_ADDITION_KIND,
] as const);

/** Doctor reports a view writer that has published nothing for this many days. */
export const VIEW_WRITER_SILENCE_DAYS = 3;
export const VIEW_WRITER_SILENCE_MS = VIEW_WRITER_SILENCE_DAYS * DAY_MS;

/** An idle writer publishes a `view-pass` at most this often. */
export const VIEW_PASS_INTERVAL_MS = DAY_MS;

/** `o2b view recover` lists replaced versions this many days back. */
export const VIEW_RECOVER_DAYS = 30;

/** Render attempts per page before a page that keeps changing under the writer is skipped. */
export const VIEW_RENDER_ATTEMPTS = 5;

/** Device-local subdirectory of the view writer's state (never synced). */
export const VIEW_STATE_DIR = "view";
/** Device-local file: the claim this device has already caught up on once. */
export const VIEW_CLAIM_SEEN_FILE = "claim-seen.json";
/** Device-local subdirectory of render intents (a page renamed, its record not yet written). */
export const VIEW_INTENT_DIR = "intents";
/** Device-local file: the stats of the pages as the writer last left them. */
export const VIEW_PAGE_STATS_FILE = "page-stats.json";
/** Device-local file: when the last automatic pass (a hook) started. */
export const VIEW_AUTO_PASS_FILE = "last-auto-pass.json";
/** The session-start hook runs a pass at most this often. */
export const VIEW_AUTO_PASS_INTERVAL_MS = 60 * 60 * 1000;
/**
 * The time budget of the render at the end of a dream pass. The pass
 * stops between pages once it runs out, and the rest wait for the next
 * pass, so a large first render cannot stretch a dream pass without
 * bound (the session-start hook has its own, smaller budget).
 */
export const VIEW_DREAM_BUDGET_MS = 30_000;
/** Device-local lock target held for a whole render pass and for a release. */
export const VIEW_RENDER_LOCK = "render";

/**
 * Device-local hook audit directory under a store's device state (design
 * D14 item 1): where fail-open paths record a failure once the store is
 * the machine's home. Never synced, never inside the vault.
 */
export const DEVICE_HOOK_AUDIT_DIR = "hook-audit";

/** The command that moves the view writer role to the machine it runs on. */
export const VIEW_WRITER_HERE_COMMAND = "o2b view writer --here";
