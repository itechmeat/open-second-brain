/**
 * Receipt-ledger growth doctor check (storage-lifecycle, Lane 3 task 3.3).
 *
 * The receipt ledgers are append-only by design, so their growth is
 * normal and their UNBOUNDED growth is the condition an operator can
 * act on: the fold engine (`o2b brain receipts`) exists to fold expired
 * records into aggregates, and a ledger that crossed the growth
 * threshold is one that nothing has folded lately. The check reports
 * one warning per family whose foldable record count crosses the
 * threshold, naming the receipts scan as the next command, and stays
 * silent below it - a compacted or young ledger is healthy, not
 * "not looked at".
 *
 * What the scan could not read is reported, never flattened to zero:
 * an unreadable ledger directory and shards the sweep could not open
 * both reach the uncertain stream under
 * {@link RECEIPT_LEDGER_UNMEASURED_CODE}, because "growth unknown" and
 * "growth fine" are different answers and only one of them is honest.
 *
 * The scan is the same `scanReceiptLedgers` the receipts surfaces run -
 * the doctor never re-implements a census - so the warning counts
 * exactly what a confirmed compaction would fold, threshold included.
 */

import { continuityLogDir } from "../continuity/store.ts";
import { scanReceiptLedgers, receiptLedgerDir } from "../receipts/scan.ts";
import { RECEIPT_LEDGER_FAMILIES } from "../receipts/types.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";
import { pushUncertain } from "./uncertain-stream.ts";

/** A receipt ledger's foldable population crossed the growth threshold. */
export const RECEIPT_LEDGER_GROWTH_CODE = "receipt-ledger-growth";

/** The receipt ledgers are there and the scan could not read them. */
export const RECEIPT_LEDGER_UNMEASURED_CODE = "receipt-ledger-unmeasured";

/**
 * Foldable records a family must accumulate before the check speaks.
 * High enough that an actively-used vault is not nagged over normal
 * append traffic, low enough that an unfolded ledger is reported while
 * the fold that would shrink it is still a single operation.
 */
export const RECEIPT_LEDGER_GROWTH_MIN_FOLDABLE = 1_000;

/**
 * The command the growth warning names and the diagnostics registry
 * resolves the code through: the scan is the preview, the confirmed
 * compact behind the same verb is the rewrite.
 */
export const RECEIPTS_NEXT_COMMAND = "o2b brain receipts scan";

export const receiptLedgerCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    let report;
    try {
      report = scanReceiptLedgers(ctx.vault, { now: ctx.now });
    } catch {
      // The scan's own refusal, named: what the enumeration stumbled on
      // carries absolute host paths no doctor surface should repeat, and
      // the repair is the operator's to choose whatever the cause was.
      pushUncertain(out.uncertain, {
        code: RECEIPT_LEDGER_UNMEASURED_CODE,
        path: continuityLogDir(ctx.vault),
        message:
          "the receipt ledgers could not be scanned, so whether they are " +
          "growing unbounded is unknown",
      });
      return;
    }
    for (const error of report.errors) {
      pushUncertain(out.uncertain, {
        code: RECEIPT_LEDGER_UNMEASURED_CODE,
        // The shard's own vault-relative path: the stream merges on
        // (code, path), so two dark shards without it collapse into one
        // anonymous entry and every shard after the first goes unreported.
        path: error.path,
        message:
          `the receipt shard ${error.shard} is ${error.message}, so its ` +
          "foldable count is unknown",
      });
    }
    for (const family of RECEIPT_LEDGER_FAMILIES) {
      const shards = report.shards.filter((shard) => shard.family === family);
      const foldable = shards.reduce((total, shard) => total + shard.foldable, 0);
      if (foldable < RECEIPT_LEDGER_GROWTH_MIN_FOLDABLE) continue;
      const bytes = shards.reduce((total, shard) => total + shard.bytes, 0);
      out.issues.push({
        severity: "warning",
        code: RECEIPT_LEDGER_GROWTH_CODE,
        path: receiptLedgerDir(ctx.vault, family),
        message:
          `the ${family} receipt ledgers hold ${foldable} foldable records across ` +
          `${shards.length} shard(s) (${bytes} bytes on disk); folding expired records into ` +
          `aggregates would shrink them - see ${RECEIPTS_NEXT_COMMAND}`,
      } satisfies DoctorIssue);
    }
  },
};
