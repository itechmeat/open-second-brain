/**
 * `o2b brain receipts` - scan / compact over the receipt ledgers
 * (storage-lifecycle, Lane 3 task 3.4).
 *
 *   o2b brain receipts [scan] [--older-than-days N] [--json]
 *   o2b brain receipts compact --shard continuity:2026-08.jsonl[,family:name...]
 *        [--older-than-days N] [--apply] [--expect N] [--strict] [--json]
 *
 * Scan is the default and is a pure read. Compact previews by default -
 * the rewrite happens only behind `--apply` - and never runs without
 * explicit shard ids from a scan. Modes and the shard-reference spelling
 * come from the shared receipts vocabulary, so this verb and the
 * brain_receipts tool cannot drift apart.
 */

import {
  compactReceiptLedgers,
  type ReceiptCompactResult,
} from "../../../core/brain/receipts/compact.ts";
import { scanReceiptLedgers } from "../../../core/brain/receipts/scan.ts";
import { compactView, scanView } from "../../../core/brain/receipts/views.ts";
import {
  isReceiptMode,
  RECEIPT_FOLD_DEFAULT_AGE_DAYS,
  RECEIPT_MODE,
  RECEIPT_MODES,
  RECEIPT_COMPACTION_OPERATION,
  parseReceiptShardRef,
  type ReceiptShardRef,
} from "../../../core/brain/receipts/types.ts";
import { brainVerbContext, fail, parse, resolveBrainAgent } from "../helpers.ts";

export const RECEIPTS_USAGE =
  `usage: o2b brain receipts <${RECEIPT_MODES.join("|")}> [options]\n` +
  `       o2b brain receipts scan [--older-than-days N] [--json]\n` +
  "       o2b brain receipts compact --shard family:name [--older-than-days N] " +
  "[--apply] [--expect N] [--strict] [--json]";

/** Parse the repeatable `--shard family:name` flag into shard refs. */
function parseShards(raw: string | string[] | undefined): ReceiptShardRef[] {
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const refs: ReceiptShardRef[] = [];
  for (const value of values.flatMap((entry) => entry.split(","))) {
    const trimmed = value.trim();
    if (trimmed === "") continue;
    refs.push(parseReceiptShardRef(trimmed));
  }
  return refs;
}

function renderScanJson(vault: string, olderThanDays: number): number {
  const report = scanReceiptLedgers(vault, { olderThanDays, now: new Date() });
  // The same view the brain_receipts tool answers with, so `--json` and
  // the wire cannot disagree on field spellings.
  process.stdout.write(`${JSON.stringify(scanView(report), null, 2)}\n`);
  return report.errors.length === 0 ? 0 : 1;
}

function renderScanText(vault: string, olderThanDays: number): number {
  const report = scanReceiptLedgers(vault, { olderThanDays, now: new Date() });
  process.stdout.write(
    `${RECEIPT_COMPACTION_OPERATION} scan @ ${report.generated_at} ` +
      `(older than ${report.olderThanDays} days, cutoff ${report.cutoff})\n`,
  );
  for (const shard of report.shards) {
    process.stdout.write(
      `- ${shard.family}:${shard.name} - ${shard.records} record(s), ${shard.foldable} foldable, ` +
        `${shard.protectedRecords} protected, ${shard.unparseable} unparseable, ` +
        `${shard.aggregates} aggregate(s), ${shard.bytes} bytes\n`,
    );
  }
  process.stdout.write(
    `total: ${report.totals.foldable} foldable of ${report.totals.records} record(s) across ` +
      `${report.totals.shards} shard(s)\n`,
  );
  for (const error of report.errors) {
    process.stdout.write(`! ${error.shard}: ${error.message}\n`);
  }
  return report.errors.length === 0 ? 0 : 1;
}

function renderCompact(result: ReceiptCompactResult, json: boolean): number {
  // A lost audit record is a failure on every surface (L10): the shards
  // above are folded but the ledger carries no receipt_compaction record
  // for the run, and a silent exit 0 would read as a completed run.
  const failed = result.failures.length > 0 || result.auditError !== undefined;
  if (json) {
    process.stdout.write(`${JSON.stringify(compactView(result), null, 2)}\n`);
    return failed ? 1 : 0;
  }
  process.stdout.write(
    `${RECEIPT_COMPACTION_OPERATION}${result.dryRun ? " preview" : ""} - cutoff ` +
      `${result.cutoff} (older than ${result.olderThanDays} days)\n`,
  );
  for (const shard of result.shards) {
    process.stdout.write(
      `- ${shard.shard}: folded ${shard.folded}, kept ${shard.kept}, ` +
        `${shard.aggregates} aggregate(s), ${shard.bytesBefore} -> ${shard.bytesAfter} bytes\n`,
    );
  }
  for (const failure of result.failures) {
    process.stdout.write(`! ${failure.shard}: ${failure.message}\n`);
  }
  if (result.auditError !== undefined) {
    process.stdout.write(`! ${result.auditError}\n`);
  }
  if (result.snapshotRunId !== undefined) {
    process.stdout.write(`recovery point: ${result.snapshotRunId}\n`);
  }
  if (result.snapshotBytes !== undefined && result.netDeltaBytes !== undefined) {
    process.stdout.write(
      `net: ${result.netDeltaBytes} bytes (ledger shrank ` +
        `${result.totals.bytesBefore - result.totals.bytesAfter}, ` +
        `recovery point added ${result.snapshotBytes})\n`,
    );
  }
  if (result.dryRun) {
    process.stdout.write("preview only - pass --apply to fold these shards\n");
  }
  return failed ? 1 : 0;
}

export async function cmdBrainReceipts(argv: string[]): Promise<number> {
  // A bare invocation - or one that starts with a flag - scans: the
  // read-only mode is the default, and a mode nobody named is scanned
  // for rather than guessed as a mutation. A WORD that names no mode is
  // a usage error, never a silent scan of an intent nobody expressed.
  const first = argv[0];
  const named = isReceiptMode(first) ? first : undefined;
  if (first !== undefined && named === undefined && !first.startsWith("-")) {
    return fail(RECEIPTS_USAGE);
  }
  const mode = named ?? RECEIPT_MODE.scan;
  const { flags } = parse(named === undefined ? argv : argv.slice(1), {
    vault: { type: "string" },
    agent: { type: "string" },
    shard: { type: "string-array" },
    "older-than-days": { type: "string" },
    apply: { type: "boolean" },
    expect: { type: "string" },
    strict: { type: "boolean" },
    json: { type: "boolean" },
  });
  const { config, vault } = brainVerbContext(flags);

  let olderThanDays = RECEIPT_FOLD_DEFAULT_AGE_DAYS;
  const daysRaw = flags["older-than-days"];
  if (daysRaw !== undefined) {
    const days = Number(daysRaw);
    if (!Number.isInteger(days) || days <= 0) {
      return fail("--older-than-days must be a positive integer");
    }
    olderThanDays = days;
  }

  if (mode === RECEIPT_MODE.scan) {
    return flags["json"] === true
      ? renderScanJson(vault, olderThanDays)
      : renderScanText(vault, olderThanDays);
  }

  let shards: ReceiptShardRef[];
  try {
    shards = parseShards(flags["shard"] as string | string[] | undefined);
  } catch (exc) {
    return fail((exc as Error).message);
  }
  if (shards.length === 0) {
    return fail("compact requires --shard family:name ids from a scan");
  }
  const expectRaw = flags["expect"] as string | undefined;
  let expect: number | null = null;
  if (expectRaw !== undefined) {
    const n = Number(expectRaw);
    if (!Number.isInteger(n) || n < 0) return fail("--expect must be a non-negative integer");
    expect = n;
  }

  let result: ReceiptCompactResult;
  try {
    result = compactReceiptLedgers(vault, {
      shards,
      olderThanDays,
      now: new Date(),
      dryRun: flags["apply"] !== true,
      expect,
      strict: flags["strict"] === true,
      subject: { agent: resolveBrainAgent(flags, config), via: "config" },
      configPath: config,
    });
  } catch (exc) {
    return fail(`receipt compaction failed: ${(exc as Error).message ?? exc}`);
  }
  return renderCompact(result, flags["json"] === true);
}
