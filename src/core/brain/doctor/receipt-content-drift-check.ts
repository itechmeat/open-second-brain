/**
 * Receipt content drift doctor check (t_4300e5fd, lane B task B4).
 *
 * A context receipt records what a session was DELIVERED; this check
 * answers, for a bounded recent window of receipts, whether the vault
 * content behind them is still those bytes. It re-verifies each receipt
 * through the same kernel the `verify` faces serve
 * ({@link verifyContextReceipt}) and reports ONE warning when anything
 * reports changed, with per-verdict counts and the next command naming
 * the newest drifted receipt. Report-only: the doctor never mutates and
 * the check never infers a verdict the kernel did not make.
 *
 * Silences, each deliberate:
 *
 *   - Legacy receipts without recorded hashes: nothing verifiable, so
 *     nothing to report - the preference `content-hash-drift` precedent,
 *     where drift detection is opt-in via the hash write.
 *   - `session_inject` receipts: no delivered text by construction, so
 *     every item is unavailable(no_hash) and a warning would nag over a
 *     receipt that could never have been verified.
 *   - `private` and `redacted` receipts: withheld symmetrically with the
 *     session fold, which never unfolds them.
 *   - A clean window: healthy, not "not looked at".
 *
 * The window is bounded twice: the READ is bounded by `since`
 * (whole-month shards outside it are skipped by the store) and the FOLD
 * by {@link RECEIPT_CONTENT_DRIFT_WINDOW} receipts, newest first, so a
 * large ledger costs a bounded walk and a bounded re-hash. What the
 * window cannot answer is named, never flattened to a clean bill: a
 * listing that cannot be read reaches the uncertain stream under
 * {@link RECEIPT_CONTENT_DRIFT_UNMEASURED_CODE}.
 */

import { isAbsolute, join, relative } from "node:path";

import { continuityLogDir, listContinuityRecords } from "../continuity/store.ts";
import type { ContinuityRecord } from "../continuity/types.ts";
import {
  RECEIPT_VERIFY_VERDICT,
  verifyContextReceipt,
  type ReceiptItemVerification,
} from "../context-receipts-verify.ts";
import { ensureInsideVault } from "../../path-safety.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";
import { pushUncertain } from "./uncertain-stream.ts";

/** A recent receipt re-verifies with changed content. */
export const RECEIPT_CONTENT_DRIFT_CODE = "receipt-content-drift";

/** The recent window could not be read, so drift is unknown. */
export const RECEIPT_CONTENT_DRIFT_UNMEASURED_CODE = "receipt-content-drift-unmeasured";

/**
 * How many of the most recent context receipts one pass re-verifies.
 * High enough that day-to-day drift is caught within a pass or two,
 * low enough that the re-hash stays a bounded O(window items) walk.
 */
export const RECEIPT_CONTENT_DRIFT_WINDOW = 20;

/**
 * How far back the recent window reaches, bounding the READ (the store
 * skips whole month shards older than this).
 */
export const RECEIPT_CONTENT_DRIFT_SINCE_DAYS = 30;

/** The command the warning names, with the newest drifted receipt's id. */
export const RECEIPT_VERIFY_NEXT_COMMAND = "o2b brain context-receipts verify";

export const receiptContentDriftCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    let receipts: ReadonlyArray<ContinuityRecord>;
    try {
      const since = new Date(
        ctx.now.getTime() - RECEIPT_CONTENT_DRIFT_SINCE_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      // Newest first, bounded to the window - AFTER the receipts that
      // can never verify are set aside, so the window counts receipts
      // that can actually be verified: a burst of session_inject or
      // withheld receipts must not push every verifiable one out of the
      // fold and read as a clean bill. The listing is append order
      // (oldest first), so the reversal puts the freshest inside the
      // bound.
      receipts = listContinuityRecords(ctx.vault, { kind: "context_receipt", since })
        .filter(
          (record) =>
            !record.private && !record.redacted && record.payload["trigger"] !== "session_inject",
        )
        .toReversed()
        .slice(0, RECEIPT_CONTENT_DRIFT_WINDOW);
    } catch {
      pushUncertain(out.uncertain, {
        code: RECEIPT_CONTENT_DRIFT_UNMEASURED_CODE,
        path: continuityLogDir(ctx.vault),
        message:
          "the recent context receipts could not be read, so whether their " +
          "delivered content still matches the vault is unknown",
      });
      return;
    }

    // The counting contract every counting check follows: a page the
    // caller may not read neither moves the counts nor is named. Item
    // paths are absolute or vault-relative, so each resolves to a
    // vault-relative page rel before the view is asked; a path that
    // resolves outside the vault is not readable by anyone.
    const countableItems = (
      items: ReadonlyArray<ReceiptItemVerification>,
    ): ReadonlyArray<ReceiptItemVerification> => {
      if (ctx.readable === undefined) return items;
      return items.filter((item) => {
        if (item.path === null) return true;
        try {
          const absolute = ensureInsideVault(
            isAbsolute(item.path) ? item.path : join(ctx.vault, item.path),
            ctx.vault,
          );
          return ctx.readable!(relative(ctx.vault, absolute).split(/\\/).join("/"));
        } catch {
          return false;
        }
      });
    };

    let receiptsChecked = 0;
    let matched = 0;
    let changed = 0;
    let unavailable = 0;
    let withDrift = 0;
    let newestDriftedId: string | null = null;
    for (const receipt of receipts) {
      let verification;
      try {
        verification = verifyContextReceipt(ctx.vault, receipt);
      } catch {
        // The kernel is built never to throw; a throw here means the
        // receipt itself could not be walked, which is uncertainty about
        // the window, not drift in it.
        pushUncertain(out.uncertain, {
          code: RECEIPT_CONTENT_DRIFT_UNMEASURED_CODE,
          path: continuityLogDir(ctx.vault),
          message: `the receipt ${receipt.id} could not be re-verified, so its drift is unknown`,
        });
        continue;
      }
      const items = countableItems(verification.items);
      // Legacy hashless receipts, and receipts whose every item sits on
      // a page this caller may not read: nothing this caller may count,
      // nothing to report.
      const matches = items.filter((item) => item.verdict === RECEIPT_VERIFY_VERDICT.match).length;
      const changedItems = items.filter((item) => item.verdict === RECEIPT_VERIFY_VERDICT.changed);
      if (matches + changedItems.length === 0) continue;
      receiptsChecked += 1;
      matched += matches;
      changed += changedItems.length;
      unavailable += items.filter(
        (item) => item.verdict === RECEIPT_VERIFY_VERDICT.unavailable,
      ).length;
      if (changedItems.length > 0) {
        withDrift += 1;
        if (newestDriftedId === null) newestDriftedId = receipt.id;
      }
    }

    if (withDrift === 0 || newestDriftedId === null) return;
    out.issues.push({
      severity: "warning",
      code: RECEIPT_CONTENT_DRIFT_CODE,
      path: continuityLogDir(ctx.vault),
      message:
        `${receiptsChecked} recent context receipt(s) re-verified against the vault: ` +
        `${changed} item(s) changed, ${matched} matched, ${unavailable} unavailable, across ` +
        `${withDrift} receipt(s) with drift - inspect with ` +
        `${RECEIPT_VERIFY_NEXT_COMMAND} ${newestDriftedId}`,
    } satisfies DoctorIssue);
  },
};
