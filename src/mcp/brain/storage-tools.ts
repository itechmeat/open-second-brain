/**
 * The storage report: one measured-or-refused answer about what this
 * vault's storage holds and where it is heading.
 *
 * One builder serves both front doors - `o2b brain storage` and this
 * `brain_storage` tool - so the two surfaces cannot disagree about the
 * census, the forecast or the tier: the report object IS the shared
 * source, and each surface only decides how to render it.
 *
 * ## What one invocation does
 *
 * The invocation takes ONE census and puts it to all three uses the
 * report has: the per-surface reading the caller sees, the fresh
 * `latestUsage` reading the forecast tiers on (the two-truths rule in
 * `../core/brain/storage/forecast.ts` - a stored aggregate is advisory,
 * a fresh census is the fact), and the one `storage_usage` sample the
 * invocation records. Each report therefore appends exactly one sample;
 * the series keeps accumulating precisely because the report was asked
 * for.
 *
 * ## Reach honesty
 *
 * The census is a whole-vault byte figure: it counts every page,
 * withheld pages included, so its totals move when a page the caller may
 * not read appears or goes, and no filtered form of it exists. Below
 * local reach the number is therefore not taken at all - the
 * `link_integrity` model (`./hygiene-tools.ts`) - and the report answers
 * `measured: false` with the named reason. No sample is recorded on a
 * refused call: the sample would require taking the very census the
 * refusal withholds.
 *
 * ## No cap means unbounded
 *
 * An absent `storage.cap_bytes` is the default and is reported as the
 * tier it is: `unbounded`. Bytes are reported, no days-to-exhaustion is
 * invented, nothing pauses and nothing refuses - a forecast against an
 * invented default cap would be exactly the misleading number the
 * storage lifecycle removes.
 */

import { loadBrainConfigDetailed, resolveStorage } from "../../core/brain/policy.ts";
import {
  forecastStorageUsage,
  sampleStorageUsage,
  type StorageForecast,
} from "../../core/brain/storage/forecast.ts";
import type { StorageUsage } from "../../core/brain/storage/usage.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../core/graph/transport-reach.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { contextReach } from "../tool-contract.ts";
import { coerceFormat } from "../coerce.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";

/**
 * The reason a report below local reach names, beside the reasons the
 * measurement itself returns (`surface_unreadable`): the census was not
 * taken at all because of who was asking, not because it failed.
 */
export const STORAGE_REACH_REASON = "reach" as const;

/** Every reason a report can name for answering without a measurement. */
export type StorageReportRefusalReason = typeof STORAGE_REACH_REASON;

/** The report a caller below local reach receives: no bytes, a named reason. */
export interface StorageReportRefusal {
  readonly measured: false;
  readonly reason: StorageReportRefusalReason;
  /** Why the census is local-reach-only, stated for the caller. */
  readonly detail: string;
}

/** The report a local-reach caller receives: census, forecast, sample. */
export interface StorageReport {
  readonly measured: true;
  /** The census the invocation took; refused surfaces are in `unmeasured`. */
  readonly usage: StorageUsage;
  /** The forecast over the configured cap, tiered on the fresh census. */
  readonly forecast: StorageForecast;
  /** The sample this invocation recorded, named when the append failed. */
  readonly sample: {
    readonly runId: string;
    readonly appended: boolean;
    readonly appendError?: string;
  };
}

/** Either a measured report or the named refusal to take one. */
export type StorageReportView = StorageReport | StorageReportRefusal;

export interface BuildStorageReportOptions {
  readonly vault: string;
  /** How far the caller had to reach; the census answers at local reach only. */
  readonly reach: TransportReach;
  /** The explicit machine-config file the census resolves the store from. */
  readonly configPath?: string;
}

/**
 * Build one storage report, or the named reach refusal.
 *
 * A vault whose brain config cannot be read throws the named
 * `BrainConfigError`: a report about an uninitialized vault has no cap to
 * forecast against, and answering as an unbounded empty vault would be
 * the misleading default this subsystem refuses to invent.
 */
export function buildStorageReport(opts: BuildStorageReportOptions): StorageReportView {
  if (opts.reach !== TRANSPORT_REACH.local) {
    return {
      measured: false,
      reason: STORAGE_REACH_REASON satisfies StorageReportRefusalReason,
      detail: "storage usage is measured over the whole vault and is reported at local reach only",
    };
  }
  const storage = resolveStorage(loadBrainConfigDetailed(opts.vault).config);
  // One census, three uses: the reading, the forecast's fresh truth,
  // and the sample. Fail-soft by the sampler's contract - an append
  // failure is carried on the report, not swallowed.
  const sample = sampleStorageUsage(
    opts.vault,
    opts.configPath !== undefined ? { configPath: opts.configPath } : {},
  );
  const forecast = forecastStorageUsage(opts.vault, {
    capBytes: storage.cap_bytes,
    latestUsage: sample.usage,
    warnPercent: storage.warn_percent,
    criticalPercent: storage.critical_percent,
    warnDays: storage.warn_days,
    criticalDays: storage.critical_days,
  });
  return {
    measured: true,
    usage: sample.usage,
    forecast,
    sample: {
      runId: sample.runId,
      appended: sample.appended,
      ...(sample.appendError !== undefined ? { appendError: sample.appendError } : {}),
    },
  };
}

async function toolBrainStorage(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const format = coerceFormat(args);
  const report = buildStorageReport({
    vault: ctx.vault,
    reach: contextReach(ctx),
    ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
  });
  return { format, ...report };
}

export const STORAGE_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_storage",
    description:
      "Storage report: per-surface byte census (measured or refused by name), the growth forecast against the cap with its tier, and the usage sample this invocation records. Below local reach the census is not taken: measured: false, reason named. Read-only over vault content; appends one usage sample.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description:
            "Output format hint. Structured result is identical; caller decides rendering.",
        },
      },
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainStorage,
  },
]);
