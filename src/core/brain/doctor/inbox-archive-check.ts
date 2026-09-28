/**
 * `inbox-archivable` (issue #195): how many inbox signals can no longer
 * become candidates.
 *
 * The dream pass archives an inbox signal once it is older than
 * `dream.contradiction_window_days` and was never consumed
 * (`signal-archive.ts`). Until a pass runs, those signals sit in the inbox
 * and every capture's dedup walk pays for them. This check states the inbox
 * size and the archivable count, and names the pass that clears them.
 *
 * A WARNING, not an error: nothing is broken, and the next dream pass fixes
 * it without a decision from anyone. Silent when nothing is archivable, when
 * the archive is switched off (`dream.archive_stale_signals: false`), and
 * when `_brain.yaml` could not be loaded (the config check reports that).
 *
 * The rule is the one the pass applies, imported rather than restated, so
 * the count here is exactly what `o2b brain dream --dry-run` would archive
 * less the signals that pass consumes instead.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../../vault.ts";
import { brainDirs } from "../paths.ts";
import { archiveEnabled, isOutsideWindow } from "../signal-archive.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";

/** Inbox signals that left the contradiction window unconsumed. */
export const INBOX_ARCHIVABLE_CODE = "inbox-archivable";

export const inboxArchivableCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    const cfg = ctx.config;
    if (cfg === undefined || !archiveEnabled(cfg)) return;
    const inbox = brainDirs(ctx.vault).inbox;
    if (!existsSync(inbox)) return;
    const windowDays = cfg.dream.contradiction_window_days;
    let total = 0;
    let archivable = 0;
    for (const name of readdirSync(inbox)) {
      if (!name.startsWith("sig-") || !name.endsWith(".md")) continue;
      total++;
      const createdAt = parseFrontmatter(join(inbox, name))[0]["created_at"];
      if (typeof createdAt === "string" && isOutsideWindow(createdAt, windowDays, ctx.now)) {
        archivable++;
      }
    }
    if (archivable === 0) return;
    out.issues.push({
      severity: "warning",
      code: INBOX_ARCHIVABLE_CODE,
      path: inbox,
      message:
        `Brain/inbox/ holds ${total} signal(s); ${archivable} of them are older than ` +
        `dream.contradiction_window_days (${windowDays}) and can no longer become candidates. ` +
        "The next dream pass moves them to Brain/inbox/archived/ unless a preference consumes " +
        "them first; nothing is deleted",
    } satisfies DoctorIssue);
  },
};
