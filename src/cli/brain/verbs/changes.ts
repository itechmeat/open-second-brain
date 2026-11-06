/**
 * `o2b brain changes [--since <watermark>]` - the brain store change probe.
 *
 * One builder serves this verb and the `brain_changes` MCP tool
 * (`../../../mcp/brain/changes-tools.ts`); the watermark contract lives in
 * `../../../core/search/brain-store/changes.ts`. The verb prints the new
 * record ids grouped by partition, stream, scope and topic, then the
 * watermark to pass next time. `--json` prints the builder's object as-is.
 *
 * The CLI runs at local reach, so it always gets the measured form.
 */

import {
  CHANGES_DEFAULT_LIMIT,
  CHANGES_MAX_LIMIT,
} from "../../../core/search/brain-store/changes.ts";
import { TRANSPORT_REACH } from "../../../core/graph/transport-reach.ts";
import { buildBrainChanges, type BrainChangesView } from "../../../mcp/brain/changes-tools.ts";
import { CliError } from "../../argparse.ts";
import { brainVerbContext, failWith, parse, writeJson } from "../helpers.ts";

export async function cmdBrainChanges(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    since: { type: "string" },
    limit: { type: "string" },
    json: { type: "boolean" },
  });
  const { vault, config } = brainVerbContext(flags);
  const rawLimit = flags["limit"] as string | undefined;
  const limit = parseLimit(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > CHANGES_MAX_LIMIT) {
    throw new CliError(`--limit must be an integer in 1..${CHANGES_MAX_LIMIT}`);
  }
  const since = flags["since"] as string | undefined;

  let view: BrainChangesView;
  try {
    view = await buildBrainChanges({
      vault,
      reach: TRANSPORT_REACH.local,
      configPath: config,
      ...(since !== undefined ? { since } : {}),
      limit,
    });
  } catch (exc) {
    return failWith("read the brain store changes", exc);
  }

  if (flags["json"]) writeJson(view);
  else renderText(view);
  return 0;
}

/** `--limit` as a number; NaN unless it is plain decimal digits (`Number` takes "1e3", "0x10", " 5 "). */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return CHANGES_DEFAULT_LIMIT;
  return /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
}

function label(value: string | null): string {
  return value ?? "-";
}

function renderText(view: BrainChangesView): void {
  if (!view.measured) {
    process.stdout.write(`not measured: ${view.reason} - ${view.detail}\n`);
    return;
  }
  if (!view.storeInUse) {
    process.stdout.write("no brain store is in use on this machine\n");
    return;
  }
  for (const warning of view.warnings) process.stdout.write(`warning: ${warning}\n`);
  if (view.reset) {
    process.stdout.write("the watermark came from a replaced index; listing from the start\n");
  }
  process.stdout.write(`${view.count} new record(s)\n`);
  for (const g of view.groups) {
    const stream = g.ledger === null ? g.stream : `${g.stream}/${g.ledger}`;
    process.stdout.write(
      `  ${g.partition} ${stream} scope=${label(g.scope)} topic=${label(g.topic)}: ${g.ids.join(", ")}\n`,
    );
  }
  if (view.truncated) process.stdout.write("more records are waiting after the watermark\n");
  process.stdout.write(`watermark: ${view.watermark ?? "-"}\n`);
}
