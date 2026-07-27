/**
 * The `discipline_report:` section (§D of the agent-discipline-tail
 * design).
 *
 * One reason to change: what the daily discipline report needs to be
 * configured with. This is the only block that WARNS AND DROPS instead of
 * throwing: the report is an optional side surface, and a malformed
 * section must not take the rest of the CLI down with it. Every field is
 * mandatory once the section is present, so a partial section is dropped
 * whole rather than half-applied.
 */

import type { DisciplineReportConfig } from "../../types.ts";
import { describe } from "../field-checks.ts";
import { hasBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const BLOCK = "discipline_report";

const KNOWN_KEYS = ["enabled", "timezone", "watched_paths", "known_agents"] as const;

const IGNORED = "section ignored";

export function parseDisciplineReportBlock(
  ctx: BlockParseContext,
): DisciplineReportConfig | undefined {
  if (!hasBlock(ctx.obj, BLOCK, ctx.keys)) return undefined;
  const dr = ctx.obj[BLOCK];
  if (typeof dr !== "object" || dr === null || Array.isArray(dr)) {
    warn(ctx, `${BLOCK}: must be a map of keys; got ${describe(dr)} — ${IGNORED}`);
    return undefined;
  }

  const drObj = dr as Record<string, unknown>;
  warnUnknownKeys(ctx, drObj, KNOWN_KEYS, BLOCK);
  let ok = true;

  if (typeof drObj["enabled"] !== "boolean") {
    warn(
      ctx,
      `${BLOCK}.enabled: must be a boolean; got ${describe(drObj["enabled"])} — ${IGNORED}`,
    );
    ok = false;
  }
  if (typeof drObj["timezone"] !== "string") {
    warn(
      ctx,
      `${BLOCK}.timezone: must be a string; got ${describe(drObj["timezone"])} — ${IGNORED}`,
    );
    ok = false;
  }
  if (!checkStringArray(ctx, drObj, "watched_paths")) ok = false;
  if (!checkStringArray(ctx, drObj, "known_agents")) ok = false;

  if (!ok) return undefined;
  return {
    enabled: drObj["enabled"] as boolean,
    timezone: drObj["timezone"] as string,
    watched_paths: drObj["watched_paths"] as ReadonlyArray<string>,
    known_agents: drObj["known_agents"] as ReadonlyArray<string>,
  };
}

/** Warn on a non-array or on the first non-string entry; never throws. */
function checkStringArray(
  ctx: BlockParseContext,
  drObj: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  const value = drObj[key];
  if (!Array.isArray(value)) {
    warn(ctx, `${BLOCK}.${key}: must be an array; got ${describe(value)} — ${IGNORED}`);
    return false;
  }
  const badIdx = (value as unknown[]).findIndex((v) => typeof v !== "string");
  if (badIdx >= 0) {
    warn(
      ctx,
      `${BLOCK}.${key}[${badIdx}]: must be a string; got ${describe((value as unknown[])[badIdx])} — ${IGNORED}`,
    );
    return false;
  }
  return true;
}

function warn(ctx: BlockParseContext, message: string): void {
  ctx.warnings.push({ path: ctx.source ?? "<config>", message });
}
