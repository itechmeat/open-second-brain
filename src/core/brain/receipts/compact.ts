/**
 * Receipt fold engine (storage-lifecycle, Lane 3 task 3.2).
 *
 * The confirmed half of receipt compaction: rewrite explicitly named
 * receipt-ledger shards, replacing the records older than the age
 * threshold with one aggregate line per (kind, month) and keeping
 * everything else - protected classes, young records, aggregates and
 * torn lines - byte-verbatim, in file order. Blank lines are the one
 * exception: the rewrite reads and writes non-blank lines, so a blank
 * line in the shard is dropped rather than preserved.
 *
 * The gates, in order, before anything is written:
 *
 *   1. Shard refs resolve through the family's name grammar - a name
 *      that is not a shard is a caller error, never a traversal.
 *   2. A fresh per-shard recount against the disk (never the caller's
 *      scan numbers) feeds the count guard: an `expect` mismatch aborts
 *      before any write, snapshot included.
 *   3. A confirmed run that will write asserts vault identity and
 *      consults the permissions document through `refuseDocumentDeny`
 *      on the ingest mutation lane - the same ladder
 *      `deleteBySource` runs.
 *   4. The rewrites sit inside one `withDestructiveSnapshot` span: the
 *      recovery point is on disk before the first shard is touched, and
 *      a snapshot failure aborts the run.
 *
 * Per shard the engine is fail-soft: a shard that cannot be read, has
 * drifted since the recount, or would not strictly shrink is collected
 * into `failures` and the run still completes. Writes are atomic per
 * shard - `atomicWriteFileSync` with `expectBefore` compare-and-swap -
 * under the shard's own lock. The real guarantee is narrower than "the
 * append paths hold this lock": it excludes the continuity appenders
 * only. A metrics shard is guarded by the compare-and-swap alone - the
 * metrics append path writes bare `appendFileSync` - so a concurrent
 * metrics append landing inside the rewrite window is lost without
 * error, not refused as drift. Those are advisory samples, and the
 * forecast series that reads them tolerates the gap.
 *
 * Idempotency: a re-run recounts a compacted shard, finds nothing
 * foldable, and writes nothing - no rewrite, no snapshot, no audit
 * record. The audit is the additive `receipt_compaction` continuity
 * kind (one record per confirmed run that folded, never on a dry run),
 * carrying the honest per-shard outcomes including failures. An audit
 * record that cannot be appended after the shards are durable is a
 * named outcome on the result (`auditError`), never a post-write throw:
 * the run's work is done by then, and discarding it would leave the
 * caller unable to tell what landed.
 *
 * Aggregate lines are stamped `o2b.receipt-fold.v1` and carry no record
 * fields: the continuity read model drops a row without
 * `id`/`kind`/`createdAt` and the metrics reader skips a row without a
 * string `run_at`, so an aggregate is inert bytes to every reader.
 */

import { readFileSync } from "node:fs";

import { resolveAgentName } from "../../config.ts";
import { atomicWriteFileSync, isFileDrift } from "../../fs-atomic.ts";
import { appendContinuityRecord } from "../continuity/store.ts";
import { assertExpectedCount } from "../count-guard.ts";
import type { RecoverabilityVerdict } from "../gates/recoverability.ts";
import { acquireLockSync } from "../sync-lockfile.ts";
import { BRAIN_SNAPSHOT_REASON } from "../types.ts";
import { withDestructiveSnapshot } from "../snapshot-gate.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { refuseDocumentDeny, type WriteSubject } from "../write-disposition.ts";
import { REVIEW_LANE } from "../write-gate.ts";
import {
  canonicalSecond,
  classifyContinuityRecord,
  classifyMetricRecord,
  isFoldAggregateLine,
  RECEIPT_SHARD_UNREADABLE,
  resolveReceiptShardPath,
} from "./scan.ts";
import {
  RECEIPT_COMPACTION_OPERATION,
  RECEIPT_FOLD_DEFAULT_AGE_DAYS,
  RECEIPT_FOLD_SCHEMA,
  RECEIPT_LEDGER_FAMILY,
  receiptShardRefId,
  type ReceiptLedgerFamily,
  type ReceiptShardRef,
} from "./types.ts";

const MS_PER_DAY = 86_400_000;

/**
 * The closed sentence a confirmed fold carries when its audit record
 * could not be appended: the shards are folded and durable, the ledger
 * holds no `receipt_compaction` record for the run, and the result says
 * so instead of a throw that would discard everything the run did.
 */
export const RECEIPT_AUDIT_APPEND_FAILED =
  "the receipt_compaction audit record could not be appended; the shards above are folded as reported";

/** One confirmed shard rewrite, or what stopped it. */
export interface ReceiptFoldShardOutcome {
  /** The `family:name` spelling of the shard. */
  readonly shard: string;
  readonly folded: number;
  /** Records, aggregates and torn lines kept verbatim. */
  readonly kept: number;
  /** Aggregate lines the shard now carries. */
  readonly aggregates: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

/** One fold group: what the aggregate line preserves as metadata. */
export interface ReceiptFoldGroup {
  readonly shard: string;
  /** Continuity kind, or the metrics surface. */
  readonly kind: string;
  /** UTC month the folded records belong to. */
  readonly month: string;
  readonly count: number;
  readonly first: string;
  readonly last: string;
  /**
   * Byte length of the folded record lines, newline separators excluded,
   * preserved inside the aggregate line.
   */
  readonly bytes: number;
}

/** One fold group together with where its aggregate line is written. */
interface GroupEntry {
  /** Index into the shard's lines of the group's first folded record. */
  readonly firstIndex: number;
  /** The fold group, replaced in place as later records join it. */
  group: ReceiptFoldGroup;
}

/** One shard the confirmed run could not rewrite, with the reason. */
export interface ReceiptFoldFailure {
  readonly shard: string;
  readonly message: string;
}

export interface ReceiptCompactTotals {
  readonly shards: number;
  readonly folded: number;
  readonly kept: number;
  readonly aggregates: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

export interface ReceiptCompactResult {
  readonly operation: typeof RECEIPT_COMPACTION_OPERATION;
  readonly dryRun: boolean;
  readonly olderThanDays: number;
  readonly cutoff: string;
  readonly shards: ReadonlyArray<ReceiptFoldShardOutcome>;
  readonly groups: ReadonlyArray<ReceiptFoldGroup>;
  readonly failures: ReadonlyArray<ReceiptFoldFailure>;
  readonly totals: ReceiptCompactTotals;
  /** Present on a confirmed run that took its recovery point. */
  readonly snapshotRunId?: string;
  readonly recoverability?: RecoverabilityVerdict;
  /** Present on a confirmed run that appended its audit record. */
  readonly auditRecordId?: string;
  /**
   * Present on a confirmed run whose audit record could not be appended:
   * the shards above are folded and the recovery point exists, but the
   * ledger carries no `receipt_compaction` record for this run. A closed
   * sentence - the raw condition names absolute host paths no payload
   * carries; its detail goes to the operator's stderr only.
   */
  readonly auditError?: string;
}

export interface ReceiptCompactInput {
  /** Explicit shard selection, as a scan reported it. Required non-empty. */
  readonly shards: ReadonlyArray<ReceiptShardRef>;
  readonly olderThanDays?: number;
  readonly now?: Date;
  /** Preview with zero writes. Default true: preview-bound like a scan. */
  readonly dryRun?: boolean;
  /** Count guard: assert exactly this many records will fold. */
  readonly expect?: number | null;
  /** Count guard: refuse a guardless confirmed run. */
  readonly strict?: boolean;
  /** Credential subject for the permissions-document consult. */
  readonly subject?: WriteSubject;
  /** Config path the default subject's agent name resolves from. */
  readonly configPath?: string;
}

/** One shard's recount: the lines, their classification, and the fold groups. */
interface ShardPlan {
  readonly ref: ReceiptShardRef;
  readonly display: string;
  readonly path: string;
  /** Ledger base: the month for continuity, the surface for metrics. */
  readonly base: string;
  readonly lines: ReadonlyArray<string>;
  readonly cutoffMs: number;
  readonly foldable: number;
  readonly kept: number;
  /** Fold groups in first-occurrence order, each with its aggregate slot. */
  readonly groupEntries: ReadonlyArray<GroupEntry>;
  /** Exact text the recount read; the compare-and-swap anchor. */
  readonly text: string;
  readonly bytesBefore: number;
}

/** The line classification one pass over a shard's lines produces. */
interface LineVerdict {
  readonly foldable: boolean;
  /** Continuity kind, or the metrics surface; defined only when foldable. */
  readonly kind?: string;
  /** UTC month the record belongs to; defined only when foldable. */
  readonly month?: string;
  /** The record's own timestamp; defined only when foldable. */
  readonly timestamp?: string;
}

function verdictFor(
  family: ReceiptLedgerFamily,
  parsed: unknown,
  base: string,
  cutoffMs: number,
): LineVerdict {
  if (isFoldAggregateLine(parsed)) return { foldable: false };
  if (family === RECEIPT_LEDGER_FAMILY.continuity) {
    const record = parsed as {
      readonly kind?: unknown;
      readonly createdAt?: unknown;
      readonly payload?: unknown;
    };
    if (classifyContinuityRecord(record, cutoffMs) !== "foldable") return { foldable: false };
    // The month a continuity aggregate carries is the shard's own base.
    return {
      foldable: true,
      kind: record.kind as string,
      month: base,
      timestamp: record.createdAt as string,
    };
  }
  const record = parsed as {
    readonly surface?: unknown;
    readonly run_at?: unknown;
  };
  if (classifyMetricRecord(record, cutoffMs) !== "foldable") return { foldable: false };
  const timestamp = record.run_at as string;
  return {
    foldable: true,
    kind: record.surface as string,
    month: timestamp.slice(0, 7),
    timestamp,
  };
}

/**
 * The instant a foldable record's stamp stands for. Both classifiers
 * stamp a foldable verdict only under a grammar-validated UTC timestamp
 * (`isCanonicalUtcTimestamp`, `ISO_UTC_RE`), so the parse is finite by
 * construction; the instant, not the text, is what the aggregate's
 * first/last bounds order by.
 */
function instantOf(timestamp: string): number {
  return Date.parse(timestamp);
}

/**
 * Recount one named shard against the disk. A shard that cannot be read
 * yields a failure instead of a plan - named unreadable, with its
 * `family:name` identity and no filesystem detail, since the raw error
 * text would carry an absolute host path and a missing-versus-denied
 * oracle onto every surface the failure payload reaches. Every other
 * condition classifies into the plan.
 */
function planShard(
  vault: string,
  ref: ReceiptShardRef,
  cutoffMs: number,
): { readonly plan: ShardPlan } | { readonly failure: ReceiptFoldFailure } {
  const display = receiptShardRefId(ref);
  const resolved = resolveReceiptShardPath(vault, ref);
  let text: string;
  try {
    text = readFileSync(resolved.path, "utf8");
  } catch {
    return { failure: { shard: display, message: RECEIPT_SHARD_UNREADABLE } };
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const byKey = new Map<string, GroupEntry>();
  const groupEntries: GroupEntry[] = [];
  let foldable = 0;
  let kept = 0;
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      kept += 1; // a torn line is nobody's to fold
      continue;
    }
    const verdict = verdictFor(ref.family, parsed, resolved.base, cutoffMs);
    if (!verdict.foldable) {
      kept += 1;
      continue;
    }
    foldable += 1;
    const key = `${verdict.kind}\u0000${verdict.month}`;
    const bytes = Buffer.byteLength(line, "utf8");
    const existing = byKey.get(key);
    if (existing === undefined) {
      const entry: GroupEntry = {
        firstIndex: index,
        group: {
          shard: display,
          kind: verdict.kind!,
          month: verdict.month!,
          count: 1,
          first: verdict.timestamp!,
          last: verdict.timestamp!,
          bytes,
        },
      };
      byKey.set(key, entry);
      groupEntries.push(entry);
      continue;
    }
    const prior = existing.group;
    const timestamp = verdict.timestamp!;
    existing.group = {
      ...prior,
      count: prior.count + 1,
      // The bounds compare by instant, never by stamp text: the canonical
      // grammars admit optional fractional seconds, and "." sorts before
      // "Z", so the LATER half-second stamp is the textually smaller one.
      // A folded record's own stamp is kept verbatim on whichever bound
      // its instant wins.
      first: instantOf(timestamp) < instantOf(prior.first) ? timestamp : prior.first,
      last: instantOf(timestamp) > instantOf(prior.last) ? timestamp : prior.last,
      bytes: prior.bytes + bytes,
    };
  }
  return {
    plan: {
      ref,
      display,
      path: resolved.path,
      base: resolved.base,
      lines,
      cutoffMs,
      foldable,
      kept,
      groupEntries: Object.freeze(groupEntries),
      text,
      bytesBefore: Buffer.byteLength(text, "utf8"),
    },
  };
}

/** The aggregate line one fold group folds into, with the fixed field order. */
function aggregateLine(family: ReceiptLedgerFamily, group: ReceiptFoldGroup): string {
  const fold: Record<string, unknown> =
    family === RECEIPT_LEDGER_FAMILY.continuity
      ? {
          family,
          kind: group.kind,
          month: group.month,
          count: group.count,
          first_created_at: group.first,
          last_created_at: group.last,
          bytes: group.bytes,
        }
      : {
          family,
          surface: group.kind,
          month: group.month,
          count: group.count,
          first_run_at: group.first,
          last_run_at: group.last,
          bytes: group.bytes,
        };
  return JSON.stringify({ schema: RECEIPT_FOLD_SCHEMA, fold });
}

/**
 * Rebuild one shard's content: kept lines verbatim in order, each fold
 * group's aggregate line at the position of the group's first folded
 * record. Deterministic for a given shard and cutoff.
 */
function rebuildContent(plan: ShardPlan): string {
  const byIndex = new Map<number, GroupEntry>(plan.groupEntries.map((e) => [e.firstIndex, e]));
  const emitted = new Set<string>();
  const out: string[] = [];
  for (const [index, line] of plan.lines.entries()) {
    const entry = byIndex.get(index);
    if (entry !== undefined) {
      const key = `${entry.group.kind}\u0000${entry.group.month}`;
      if (!emitted.has(key)) {
        emitted.add(key);
        out.push(aggregateLine(plan.ref.family, entry.group));
      }
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.push(line); // torn lines stay
      continue;
    }
    const verdict = verdictFor(plan.ref.family, parsed, plan.base, plan.cutoffMs);
    if (verdict.foldable) continue; // represented by the aggregate above
    out.push(line);
  }
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

/**
 * Fold the old records of the named receipt-ledger shards. See the
 * module header for the gate order and the failure contract.
 */
export function compactReceiptLedgers(
  vault: string,
  input: ReceiptCompactInput,
): ReceiptCompactResult {
  if (!Array.isArray(input.shards) || input.shards.length === 0) {
    throw new Error(
      "compactReceiptLedgers requires explicit shard ids from a scan; " +
        "a bare compaction never folds every shard blindly",
    );
  }
  const olderThanDays = input.olderThanDays ?? RECEIPT_FOLD_DEFAULT_AGE_DAYS;
  const nowMs = (input.now ?? new Date()).getTime();
  const cutoffMs = nowMs - olderThanDays * MS_PER_DAY;
  const cutoff = canonicalSecond(cutoffMs);
  const dryRun = input.dryRun !== false;

  // Gates 1+2: resolve every ref, recount against the disk, collect
  // per-shard plans and failures. Nothing has been written yet.
  const plans: ShardPlan[] = [];
  const failures: ReceiptFoldFailure[] = [];
  for (const ref of input.shards) {
    const result = planShard(vault, ref, cutoffMs);
    if ("failure" in result) failures.push(result.failure);
    else plans.push(result.plan);
  }
  const matched = plans.reduce((total, plan) => total + plan.foldable, 0);

  // Gate 3: the count guard, before any write including the snapshot.
  assertExpectedCount({
    matched,
    expect: input.expect ?? null,
    strict: input.strict === true,
    willMutate: !dryRun,
    matchList: plans.map((plan) => plan.display),
  });

  const base: Pick<ReceiptCompactResult, "operation" | "olderThanDays" | "cutoff"> = {
    operation: RECEIPT_COMPACTION_OPERATION,
    olderThanDays,
    cutoff,
  };

  // A dry run - and a confirmed run with nothing left foldable - writes
  // nothing: no rewrite, no snapshot, no audit record.
  if (dryRun || matched === 0) {
    const outcomes = plans.map(outcomeFromPlan);
    return Object.freeze({
      ...base,
      dryRun,
      shards: Object.freeze(outcomes),
      groups: Object.freeze(plans.flatMap((plan) => plan.groupEntries.map((e) => e.group))),
      failures: Object.freeze(failures),
      totals: totalsOf(outcomes, failures),
    });
  }

  // Gate 4: a confirmed run that will write. Identity, then the
  // permissions document, then the recovery point.
  assertVaultIdentityForWrite(vault);
  refuseDocumentDeny(
    vault,
    REVIEW_LANE.ingest,
    input.subject ?? { agent: resolveAgentName(input.configPath), via: "config" },
  );

  const gated = withDestructiveSnapshot(
    vault,
    BRAIN_SNAPSHOT_REASON.receiptCompaction,
    (snapshot) => ({ runId: snapshot.runId, ...rewriteShards(plans, failures) }),
    { now: input.now },
  );
  const outcomes = gated.result.outcomes;
  const foldedShards = new Set(outcomes.map((outcome) => outcome.shard));

  // One audit record per confirmed run that folded something, with the
  // honest outcomes - failures included - so the ledger says what the
  // run did even when a shard refused. A record that cannot be appended
  // is a NAMED outcome on the result, never a post-write throw: the
  // shards above are already folded and durable, and a throw here would
  // discard every outcome, failure and the recovery point with them.
  // The wire carries the closed sentence (the raw condition names
  // absolute host paths no payload repeats); the detail goes to the
  // operator's stderr only.
  let auditRecordId: string | undefined;
  let auditError: string | undefined;
  try {
    auditRecordId = appendContinuityRecord(vault, {
      kind: "receipt_compaction",
      createdAt: canonicalSecond(nowMs),
      payload: {
        operation: RECEIPT_COMPACTION_OPERATION,
        snapshot_run_id: gated.result.runId,
        older_than_days: olderThanDays,
        cutoff,
        shards: plans.map((plan) => plan.display),
        folded: sumOutcomes(outcomes, (o) => o.folded),
        kept: sumOutcomes(outcomes, (o) => o.kept),
        aggregates: sumOutcomes(outcomes, (o) => o.aggregates),
        bytes_before: sumOutcomes(outcomes, (o) => o.bytesBefore),
        bytes_after: sumOutcomes(outcomes, (o) => o.bytesAfter),
        failures: failures.map((failure) => ({ ...failure })),
      },
    }).id;
  } catch (err) {
    auditError = RECEIPT_AUDIT_APPEND_FAILED;
    process.stderr.write(
      `receipt compaction: ${RECEIPT_AUDIT_APPEND_FAILED} ` +
        `(${err instanceof Error ? err.message : String(err)})\n`,
    );
  }

  return Object.freeze({
    ...base,
    dryRun: false,
    shards: Object.freeze(outcomes),
    groups: Object.freeze(
      plans
        .filter((plan) => foldedShards.has(plan.display))
        .flatMap((plan) => plan.groupEntries.map((e) => e.group)),
    ),
    failures: Object.freeze(failures),
    totals: totalsOf(outcomes, failures),
    snapshotRunId: gated.result.runId,
    recoverability: gated.recoverability,
    ...(auditRecordId !== undefined ? { auditRecordId } : {}),
    ...(auditError !== undefined ? { auditError } : {}),
  });
}

/** Rewrite every planned shard, fail-soft per shard, under one snapshot. */
function rewriteShards(
  plans: ReadonlyArray<ShardPlan>,
  failures: ReceiptFoldFailure[],
): { readonly outcomes: ReadonlyArray<ReceiptFoldShardOutcome> } {
  const outcomes: ReceiptFoldShardOutcome[] = [];
  for (const plan of plans) {
    try {
      outcomes.push(rewriteShard(plan));
    } catch (err) {
      failures.push({
        shard: plan.display,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { outcomes: Object.freeze(outcomes) };
}

/**
 * Rewrite one shard: rebuild under the shard's lock, verify the fold
 * strictly shrinks the file, and swap atomically on the recount's bytes.
 * A drifted shard, a non-shrinking fold and an unwritable target are
 * throws the caller collects - never partial writes. Every throw names
 * the shard and the condition: the lock and compare-and-swap failures
 * are re-stated rather than forwarded, because the raw filesystem text
 * under them carries absolute host paths no surface should repeat.
 *
 * A shard the recount found nothing foldable in is answered without
 * touching the file: its rebuild is byte-identical at best - and one
 * byte longer when the file lacks a trailing newline - so the
 * strict-shrink guard would fail exactly the no-op the re-run contract
 * promises a mixed selection's already-compacted shards. Nothing-to-do
 * is an outcome, not a failure.
 */
function rewriteShard(plan: ShardPlan): ReceiptFoldShardOutcome {
  if (plan.foldable === 0) return outcomeFromPlan(plan);
  let handle: ReturnType<typeof acquireLockSync>;
  try {
    handle = acquireLockSync(plan.path);
  } catch {
    throw new Error(`${plan.display} could not be locked for the rewrite`);
  }
  try {
    const rebuilt = rebuildContent(plan);
    const bytesAfter = Buffer.byteLength(rebuilt, "utf8");
    if (bytesAfter >= plan.bytesBefore) {
      throw new Error(
        `folding ${plan.display} would not shrink it ` +
          `(${plan.bytesBefore} -> ${bytesAfter} bytes); refusing to rewrite without a size win`,
      );
    }
    try {
      atomicWriteFileSync(plan.path, rebuilt, { expectBefore: plan.text });
    } catch (err) {
      if (isFileDrift(err)) {
        throw new Error(`${plan.display} changed since it was recounted; re-scan and retry`);
      }
      throw new Error(`${plan.display} could not be rewritten`);
    }
    return Object.freeze({
      shard: plan.display,
      folded: plan.foldable,
      kept: plan.kept,
      aggregates: plan.groupEntries.length,
      bytesBefore: plan.bytesBefore,
      bytesAfter,
    });
  } finally {
    handle.release();
  }
}

function outcomeFromPlan(plan: ShardPlan): ReceiptFoldShardOutcome {
  return Object.freeze({
    shard: plan.display,
    folded: plan.foldable,
    kept: plan.kept,
    aggregates: plan.groupEntries.length,
    bytesBefore: plan.bytesBefore,
    bytesAfter: plan.bytesBefore, // nothing was written
  });
}

function totalsOf(
  outcomes: ReadonlyArray<ReceiptFoldShardOutcome>,
  failures: ReadonlyArray<ReceiptFoldFailure>,
): ReceiptCompactTotals {
  return Object.freeze({
    shards: outcomes.length + failures.length,
    folded: sumOutcomes(outcomes, (o) => o.folded),
    kept: sumOutcomes(outcomes, (o) => o.kept),
    aggregates: sumOutcomes(outcomes, (o) => o.aggregates),
    bytesBefore: sumOutcomes(outcomes, (o) => o.bytesBefore),
    bytesAfter: sumOutcomes(outcomes, (o) => o.bytesAfter),
  });
}

function sumOutcomes(
  outcomes: ReadonlyArray<ReceiptFoldShardOutcome>,
  pick: (outcome: ReceiptFoldShardOutcome) => number,
): number {
  return outcomes.reduce((total, outcome) => total + pick(outcome), 0);
}
