/**
 * Receipt surface: scan / compact over the receipt ledgers
 * (storage-lifecycle, Lane 3 task 3.4).
 *
 * One tool, two modes, derived from the shared receipts vocabulary the
 * `o2b brain receipts` verb uses, so the two surfaces cannot disagree on
 * the mode names or the `family:name` shard spelling; the responses are
 * the same views the verb's `--json` renders
 * (`src/core/brain/receipts/views.ts`), so neither can drift on field
 * spellings either:
 *
 *   - `scan` (default): read-only inventory of both receipt ledgers -
 *     per-shard record, foldable, protected and unparseable counts with
 *     byte sizes. Writes nothing.
 *   - `compact`: fold expired records into per-(kind, month) aggregates
 *     in EXPLICITLY named shards. Preview-bound: without `apply` it is a
 *     dry run; with `apply` the core runs the count guard, consults the
 *     permissions document, takes the recovery point and rewrites each
 *     shard atomically. The operation names itself receipt compaction -
 *     deliberately disjoint from the Hermes context-compaction
 *     vocabulary on every surface.
 */

import { resolveAgentName } from "../../core/config.ts";
import { compactReceiptLedgers } from "../../core/brain/receipts/compact.ts";
import { receiptShardNameError, scanReceiptLedgers } from "../../core/brain/receipts/scan.ts";
import { compactView, scanView } from "../../core/brain/receipts/views.ts";
import {
  isReceiptMode,
  parseReceiptShardRef,
  RECEIPT_COMPACTION_OPERATION,
  RECEIPT_FOLD_DEFAULT_AGE_DAYS,
  RECEIPT_MODE,
  RECEIPT_MODES,
  type ReceiptShardRef,
} from "../../core/brain/receipts/types.ts";
import { CountGuardError } from "../../core/brain/count-guard.ts";
import { WriteRefusedError } from "../../core/brain/write-disposition.ts";
import { TRANSPORT_REACH } from "../../core/graph/transport-reach.ts";
import { coerceBool } from "../coerce.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { COUNT_GUARD_WIRE_CODE } from "../tool-error-codes.ts";
import { contextReach, type ServerContext, type ToolDefinition } from "../tool-contract.ts";
import { readCountGuardArgs } from "./shared.ts";

/** Read and bound the age-threshold argument. */
function readOlderThanDays(args: Record<string, unknown>): number {
  const raw = args["older_than_days"];
  if (raw === undefined || raw === null) return RECEIPT_FOLD_DEFAULT_AGE_DAYS;
  const days = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(days) || days <= 0) {
    throw new MCPError(INVALID_PARAMS, "'older_than_days' must be a positive integer");
  }
  return days;
}

/**
 * The reason a compact below local reach names, beside the reasons the
 * core itself refuses: the fold was not planned at all because of who
 * was asking, not because a shard refused.
 */
export const RECEIPT_COMPACT_REACH_REASON = "reach" as const;

/** Every reason a compact can name for answering without a plan. */
export type ReceiptCompactRefusalReason = typeof RECEIPT_COMPACT_REACH_REASON;

/** The response a caller below local reach receives: no plan, a named refusal. */
export interface ReceiptCompactRefusal {
  readonly operation: typeof RECEIPT_COMPACTION_OPERATION;
  readonly measured: false;
  readonly reason: ReceiptCompactRefusalReason;
  /** Why the compact is local-reach-only, stated for the caller. */
  readonly detail: string;
}

/** Parse the explicit `family:name` shard list compact requires. */
function readShards(args: Record<string, unknown>): ReceiptShardRef[] {
  const raw = args["shards"];
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((v) => typeof v === "string")) {
    throw new MCPError(
      INVALID_PARAMS,
      "compact requires explicit 'shards' (array of family:name strings) from a scan",
    );
  }
  return (raw as string[]).map((value) => {
    try {
      const ref = parseReceiptShardRef(value);
      // Up front, beside the family check: a name the family's grammar
      // does not recognise is the caller's invalid argument - a plain
      // error escaping the core's per-shard handling would surface as an
      // internal error instead (L9).
      const nameError = receiptShardNameError(ref);
      if (nameError !== null) throw new Error(nameError);
      return ref;
    } catch (exc) {
      throw new MCPError(INVALID_PARAMS, (exc as Error).message);
    }
  });
}

async function toolBrainReceipts(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const mode = args["mode"] ?? RECEIPT_MODE.scan;
  if (!isReceiptMode(mode)) {
    throw new MCPError(INVALID_PARAMS, `'mode' must be one of: ${RECEIPT_MODES.join(", ")}`);
  }
  const olderThanDays = readOlderThanDays(args);

  if (mode === RECEIPT_MODE.scan) {
    return scanView(scanReceiptLedgers(ctx.vault, { olderThanDays, now: new Date() }));
  }

  // The destructive half: compact rewrites named ledger shards in place,
  // and every guarantee the rewrite runs under - vault identity, the
  // permissions-document consult, the recovery point, the per-file locks -
  // is host-local. A caller below local reach gets the named refusal
  // instead of a plan: no shard list, no figures, no write lane entered.
  // The rationale names the write lane, not the byte figures (L11): the
  // scan above reports the same per-shard figures at any reach by design,
  // so figures were never the thing that stops at local reach - and the
  // growth check that reads the same scan runs on the host, where the
  // distinction has no meaning. The scan stays readable at any reach: it
  // writes nothing.
  if (contextReach(ctx) !== TRANSPORT_REACH.local) {
    // Returned as the literal, `satisfies`-checked against the refusal
    // interface: the handler's wire type is Record<string, unknown>, and
    // a value held in the interface's name would not carry the index
    // signature that type asks for.
    return {
      operation: RECEIPT_COMPACTION_OPERATION,
      measured: false,
      reason: RECEIPT_COMPACT_REACH_REASON satisfies ReceiptCompactRefusalReason,
      detail:
        "receipt compaction rewrites named ledger shards in place; its write lane and " +
        "guards (vault identity, permissions document, recovery point) are host-local, " +
        "so it answers at local reach only",
    } satisfies ReceiptCompactRefusal;
  }

  const shards = readShards(args);
  const apply = coerceBool(args, "apply") === true;
  const { expect, strict } = readCountGuardArgs(args);
  try {
    const result = compactReceiptLedgers(ctx.vault, {
      shards,
      olderThanDays,
      now: new Date(),
      dryRun: !apply,
      expect,
      strict,
      subject: ctx.requestIdentity ?? {
        agent: resolveAgentName(ctx.configPath ?? undefined),
        via: "config",
      },
      configPath: ctx.configPath ?? undefined,
    });
    return compactView(result);
  } catch (err) {
    // The caller's fault, by name: a permissions-document rule denied the
    // compact, or the count guard measured a different population than
    // the `expect` asserted - the mismatch numbers are the whole remedy,
    // so they travel beside the code.
    if (err instanceof WriteRefusedError) {
      throw new MCPError(INVALID_PARAMS, `brain_receipts: ${err.message}`, {
        code: err.code,
        rule: err.rule,
        agent: err.agent,
        next_command: err.nextCommand,
      });
    }
    if (err instanceof CountGuardError) {
      throw new MCPError(INVALID_PARAMS, `brain_receipts: ${err.message}`, {
        code: COUNT_GUARD_WIRE_CODE,
        matched: err.matched,
        expected: err.expected,
      });
    }
    throw err;
  }
}

export const RECEIPT_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_receipts",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Receipt compaction. `scan` (default) inventories both ledgers read-only; `compact` folds " +
      "expired records into per-kind, per-month aggregates in named shards, preview-bound without " +
      "`apply`, local reach only. Never touches decision-change receipts, the source archive, or " +
      "context compaction.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: [...RECEIPT_MODES],
          description:
            "Surface mode: scan inventories both ledgers (continuity, metrics); compact folds. Default `scan`.",
        },
        older_than_days: {
          type: "integer",
          minimum: 1,
          description: `Age threshold for foldable records. Default ${RECEIPT_FOLD_DEFAULT_AGE_DAYS}.`,
        },
        shards: {
          type: "array",
          items: { type: "string" },
          description:
            "Shards to compact, as `family:name` ids from a scan (compact mode; required there).",
        },
        apply: {
          type: "boolean",
          description:
            "Perform the fold (compact mode). Without it compact is a dry run; a confirmed run " +
            "takes a recovery point first and rewrites each shard atomically.",
        },
        expect: {
          type: "integer",
          minimum: 0,
          description:
            "Count guard (compact mode): assert exactly N records will fold. On mismatch the run aborts without writing.",
        },
        strict: {
          type: "boolean",
          description: "Refuse a guardless confirmed compact (no `expect`). Default false.",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainReceipts,
  },
]);
