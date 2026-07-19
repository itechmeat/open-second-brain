/**
 * `o2b brain inbox-drain` (Knowledge intake suite, I2, t_b0bba8cb): the
 * classify-and-route pass over staged captures.
 *
 * Dry-run is the default and writes nothing; `--apply` executes the route
 * and archives each processed capture through the seam-1 contract. Every
 * item is reported with its action and reason; unroutable items are named
 * and left in place. A rerun after apply finds no staged captures and is a
 * no-op.
 */

import {
  drainInbox,
  type DrainItem,
  type DrainReport,
} from "../../../core/brain/capture/inbox-drain.ts";
import { brainVerbContext, ok, okJson, parse, resolveBrainAgent } from "../helpers.ts";

function itemJson(item: DrainItem): Record<string, unknown> {
  return {
    id: item.id,
    capture_path: item.capturePath,
    classification: item.classification,
    action: item.action,
    reason: item.reason,
    target: item.target,
    routed: item.routed,
  };
}

function reportJson(report: DrainReport): Record<string, unknown> {
  return {
    mode: report.mode,
    routed: report.routed,
    unroutable: report.unroutable,
    items: report.items.map(itemJson),
  };
}

export async function cmdBrainInboxDrain(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    agent: { type: "string" },
    apply: { type: "boolean" },
    json: { type: "boolean" },
  });
  const { config, vault } = brainVerbContext(flags);
  const agent = resolveBrainAgent(flags, config);
  const report = drainInbox(vault, { apply: flags["apply"] === true, agent, now: new Date() });

  if (flags["json"] === true) {
    okJson(reportJson(report));
    return 0;
  }

  ok(`inbox-drain (${report.mode}): ${report.items.length} capture(s)`);
  for (const item of report.items) {
    const targetLabel = item.target !== null ? ` -> ${item.target}` : "";
    ok(`  [${item.classification}] ${item.action}${targetLabel}: ${item.reason}`);
  }
  ok(`  routed ${report.routed}, unroutable ${report.unroutable}`);
  if (!flags["apply"] && report.items.length > 0) {
    ok("  re-run with --apply to route and archive");
  }
  return 0;
}
