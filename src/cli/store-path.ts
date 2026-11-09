/**
 * `o2b store path` (design D12, task 2.11): print where the brain store,
 * each partition, the device-local state directory and the human view's
 * target folder are, which setting
 * put each there (env, config, default) and whether each exists. It only
 * reads (`core/store/store-location.ts`); this file parses flags and
 * renders.
 *
 * Exit codes follow the status verbs: a store that does not exist yet is
 * an answer (0, with `o2b store init` as the next step, the way
 * `o2b search status` treats a missing index); a store root that cannot be
 * used as configured is a refusal (1); a broken argv is 2.
 */

import { STORE_MISSING_CODE } from "../core/brain/doctor/store-check.ts";
import { nextCommandField } from "../core/brain/next-step.ts";
import { ConfigReadError } from "../core/config.ts";
import {
  describeConfiguredStoreLocation,
  type StoreLocationReport,
} from "../core/store/store-location.ts";
import { emitNextStep } from "./advisory-rail.ts";
import { CliError, parseFlags } from "./argparse.ts";
import { sortedReplacer } from "./helpers.ts";

export const STORE_PATH_USAGE = "usage: o2b store path [--config <file>] [--json]";

const EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2 } as const);

function existence(exists: boolean): string {
  return exists ? "exists" : "missing";
}

function renderText(report: StoreLocationReport): string {
  const lines = [
    `store root:   ${report.root.path} (${report.root.origin}, ${existence(report.root.exists)})`,
    `store id:     ${report.storeId ?? "none"}`,
  ];
  for (const partition of report.partitions) {
    const state = partition.held ? "held" : `not held, ${existence(partition.exists)}`;
    lines.push(`${`${partition.name}:`.padEnd(14)}${partition.path} (${state})`);
  }
  const state = report.deviceStateDir;
  const label = state.scope === "store" ? "device state: " : "device states:";
  lines.push(`${label} ${state.path} (${state.origin}, ${existence(state.exists)})`);
  const view = report.viewTarget;
  lines.push(
    view.path === null
      ? "view target:  none (set view_target in the machine config to render the human view)"
      : `view target:  ${view.path} (${view.origin}, ${existence(view.exists)})` +
          (view.error !== null ? `\n  refused: ${view.error}` : ""),
  );
  if (report.error !== null) lines.push(`error: ${report.error}`);
  else if (!report.initialized) lines.push("The brain store does not exist yet.");
  return `${lines.join("\n")}\n`;
}

function toJson(report: StoreLocationReport): Record<string, unknown> {
  return {
    ok: report.error === null,
    root: report.root,
    initialized: report.initialized,
    store_id: report.storeId,
    partitions: report.partitions,
    device_state_dir: report.deviceStateDir,
    view_target: report.viewTarget,
    error: report.error,
    ...(report.error === null && !report.initialized ? nextCommandField(STORE_MISSING_CODE) : {}),
  };
}

export function cmdStorePath(argv: ReadonlyArray<string>): number {
  let configPath: string | undefined;
  let json: boolean;
  try {
    const { flags, positional } = parseFlags(argv, {
      config: { type: "string" },
      json: { type: "boolean" },
    });
    if (positional.length > 0) throw new CliError(`unexpected argument: ${positional[0]}`);
    configPath = flags["config"] as string | undefined;
    json = flags["json"] === true;
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    process.stderr.write(`error: ${err.message}\n${STORE_PATH_USAGE}\n`);
    return EXIT.usage;
  }

  let report: StoreLocationReport;
  try {
    report = describeConfiguredStoreLocation(configPath);
  } catch (err) {
    if (!(err instanceof ConfigReadError)) throw err;
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: err.message }, sortedReplacer, 2)}\n`,
      );
    }
    process.stderr.write(`error: ${err.message}\n`);
    return EXIT.refused;
  }

  process.stdout.write(
    json ? `${JSON.stringify(toJson(report), sortedReplacer, 2)}\n` : renderText(report),
  );
  if (report.error !== null) return EXIT.refused;
  if (!report.initialized) {
    emitNextStep(STORE_MISSING_CODE, {
      command: "store",
      argv: ["path", ...argv],
      jsonRequested: json,
    });
  }
  return EXIT.ok;
}

/**
 * The one line `o2b status` prints for the store block of
 * `core/store/store-status.ts`: the root and whether a store is there.
 */
export function storeStatusLine(block: Readonly<Record<string, unknown>>): string {
  const root = block["root"] as { path: string } | undefined;
  if (root === undefined) return `store_root: unknown (${String(block["error"])})`;
  const error = block["error"];
  let state: string;
  if (typeof error === "string") state = `unusable: ${error}`;
  else if (block["initialized"] === true) state = `store ${String(block["store_id"])}`;
  else state = "not created";
  return `store_root: ${root.path} (${state})`;
}
