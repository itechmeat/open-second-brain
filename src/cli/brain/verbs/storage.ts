/**
 * `o2b brain storage` - the vault's storage report.
 *
 * The report answers three questions in one pass, from one builder shared
 * with the `brain_storage` MCP tool (`../../../mcp/brain/storage-tools.ts`,
 * which owns the rationale): what the vault's storage holds, per surface,
 * measured or refused by name; where it is heading against the configured
 * cap, as a tier with the numbers it rests on; and which usage sample this
 * invocation recorded. Each invocation takes one census and appends one
 * `storage_usage` sample - the forecast series accumulates precisely
 * because the report was asked for.
 *
 * An uncapped vault reports tier `unbounded` and says so plainly: bytes
 * are reported, no days-to-exhaustion is invented, nothing pauses and
 * nothing refuses. The verb is a report: it never fails on a finding -
 * a critical tier still exits 0, because the report succeeded and
 * enforcement lives at the gates that consume the tier.
 *
 * The CLI runs at local reach (a stdio child of its caller), so it always
 * gets the measured form; the refusal form of the report is rendered
 * anyway, named, rather than assumed impossible.
 */

import {
  STORAGE_FORECAST_TIER,
  type StorageForecast,
} from "../../../core/brain/storage/forecast.ts";
import { TRANSPORT_REACH } from "../../../core/graph/transport-reach.ts";
import {
  buildStorageReport,
  type StorageReport,
  type StorageReportRefusal,
} from "../../../mcp/brain/storage-tools.ts";
import { brainVerbContext, failWith, parse, writeJson } from "../helpers.ts";

/** Column widths of the per-surface listing; padded for scanability. */
const SURFACE_COLUMN = 16;
const TIER_COLUMN = 15;

export async function cmdBrainStorage(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);

  let report: StorageReport | StorageReportRefusal;
  try {
    report = buildStorageReport({ vault, reach: TRANSPORT_REACH.local });
  } catch (exc) {
    return failWith("build the storage report", exc);
  }

  if (flags["json"]) writeJson(report);
  else renderText(report);
  return 0;
}

/** The human-readable report; the `--json` payload is the builder's object as-is. */
function renderText(report: StorageReport | StorageReportRefusal): void {
  if (!report.measured) {
    renderRefusal(report);
    return;
  }
  const usage = report.usage;
  process.stdout.write(
    `usage: ${usage.totalBytes} bytes across ${usage.surfaces.length} surfaces` +
      ` (measured ${usage.measuredAt})\n`,
  );
  for (const surface of usage.surfaces) {
    process.stdout.write(
      `  ${surface.surface.padEnd(SURFACE_COLUMN)}${surface.tier.padEnd(TIER_COLUMN)}${surface.bytes}\n`,
    );
  }
  process.stdout.write(`forecast: ${renderForecast(report.forecast)}\n`);
  if (usage.unmeasured.length > 0) {
    const refused = usage.unmeasured.map((u) => `${u.surface} (${u.reason})`).join(", ");
    process.stdout.write(`unmeasured: ${refused}\n`);
  }
  if (report.sample.appended) {
    process.stdout.write(`sample: appended as ${report.sample.runId}\n`);
  } else {
    process.stdout.write(`sample: not appended - ${report.sample.appendError ?? "unknown"}\n`);
  }
}

/** The reach refusal, named the way the MCP caller sees it. */
function renderRefusal(report: StorageReportRefusal): void {
  process.stdout.write(`not measured: ${report.reason} - ${report.detail}\n`);
}

/** The forecast line: the tier first, then the numbers it rests on. */
function renderForecast(forecast: StorageForecast): string {
  if (forecast.tier === STORAGE_FORECAST_TIER.unbounded) {
    return "unbounded - no cap configured; nothing pauses and nothing refuses";
  }
  if (forecast.tier === STORAGE_FORECAST_TIER.unmeasurable) {
    const refused = forecast.unmeasured.map((u) => u.surface).join(", ");
    return `unmeasurable - the census was refused for ${refused}`;
  }
  if (forecast.tier === STORAGE_FORECAST_TIER.noForecast) {
    return "no_forecast - fewer than two usage samples are recorded, so no trend exists";
  }
  const parts: string[] = [];
  if (forecast.percentUsed !== null) {
    parts.push(`${forecast.percentUsed.toFixed(1)} percent of the ${forecast.capBytes}-byte cap`);
  }
  if (forecast.daysToCap !== null) {
    parts.push(`${forecast.daysToCap.toFixed(1)} days to the cap at the measured trend`);
  }
  if (parts.length === 0) return forecast.tier;
  return `${forecast.tier} - ${parts.join(", ")}`;
}
