/**
 * `o2b brain lifecycle <action>` - cross-type tombstone + supersede
 * lifecycle CLI (Belief lifecycle suite, Track A anchor, t_7d5a3589).
 *
 * Actions:
 *   - `tombstone <path> --reason <r> [--superseded-by <id>]`
 *   - `supersede <predecessor> <successor> [--reason <r>]`
 *   - `tip <id>`            resolve a supersede chain to its live tip
 *   - `curator [--high-use-min <n>]`  read slices over observed-use verdicts
 *
 * CLI mirror of the `brain_lifecycle` MCP tool; both delegate to the
 * core lifecycle module so the on-disk shape cannot drift.
 */

import { defaultConfigPath } from "../../../core/config.ts";
import { curatorSlices } from "../../../core/brain/lifecycle/curator.ts";
import {
  resolveChainTipInVault,
  supersede,
  tombstone,
} from "../../../core/brain/lifecycle/tombstone.ts";
import { normalizeFlagString, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

const USAGE_ERROR_EXIT = 2;

function usageError(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return USAGE_ERROR_EXIT;
}

/** Project curator slice rows into the CLI's snake_cased JSON shape. */
function renderCuratorRows(
  rows: ReadonlyArray<{
    key: string;
    reuse: { used: number; ignored: number; contradicted: number };
  }>,
): unknown[] {
  return rows.map((r) => ({
    key: r.key,
    used: r.reuse.used,
    ignored: r.reuse.ignored,
    contradicted: r.reuse.contradicted,
  }));
}

export async function cmdBrainLifecycle(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    agent: { type: "string" },
    reason: { type: "string" },
    "superseded-by": { type: "string" },
    "high-use-min": { type: "string" },
    json: { type: "boolean" },
  });

  const action = positional[0];
  if (action === undefined) {
    return usageError("brain lifecycle requires an action: tombstone | supersede | tip | curator");
  }

  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const explicitAgent = normalizeFlagString(flags["agent"]);
  const wantsJson = flags["json"] === true;

  try {
    switch (action) {
      case "tombstone": {
        const path = positional[1];
        if (path === undefined) {
          return usageError("brain lifecycle tombstone requires a note path");
        }
        const reason = normalizeFlagString(flags["reason"]);
        if (!reason) {
          return usageError("brain lifecycle tombstone requires --reason <text>");
        }
        const supersededBy = normalizeFlagString(flags["superseded-by"]);
        const res = tombstone({
          vault,
          path,
          reason,
          ...(supersededBy ? { supersededBy } : {}),
          ...(explicitAgent ? { agent: explicitAgent } : {}),
          configPath: config,
        });
        if (wantsJson) {
          okJson({
            changed: res.changed,
            path: res.path,
            tombstoned: res.state.tombstoned,
            superseded_by: res.state.supersededBy,
          });
        } else {
          ok(res.changed ? `tombstoned ${res.path}` : `already tombstoned: ${res.path}`);
        }
        return 0;
      }
      case "supersede": {
        const predecessor = positional[1];
        const successor = positional[2];
        if (predecessor === undefined || successor === undefined) {
          return usageError("brain lifecycle supersede requires <predecessor> <successor>");
        }
        const reason = normalizeFlagString(flags["reason"]);
        const res = supersede({
          vault,
          predecessor,
          successor,
          ...(reason ? { reason } : {}),
          ...(explicitAgent ? { agent: explicitAgent } : {}),
          configPath: config,
        });
        if (wantsJson) {
          okJson({
            changed: res.changed,
            path: res.path,
            superseded_by: res.state.supersededBy,
          });
        } else {
          ok(
            res.changed
              ? `superseded ${res.path} -> ${res.state.supersededBy}`
              : `already tombstoned: ${res.path}`,
          );
        }
        return 0;
      }
      case "tip": {
        const id = positional[1];
        if (id === undefined) {
          return usageError("brain lifecycle tip requires an id");
        }
        const res = resolveChainTipInVault(vault, id);
        if (wantsJson) {
          okJson({
            tip: res.tip,
            steps: res.steps,
            cycle: res.cycle,
            resolved_all: res.resolvedAll,
          });
        } else {
          ok(`tip: ${res.tip} (${res.steps} hop${res.steps === 1 ? "" : "s"})`);
        }
        return 0;
      }
      case "curator": {
        const highUseMinRaw = normalizeFlagString(flags["high-use-min"]);
        const highUseMin = highUseMinRaw === null ? undefined : Number(highUseMinRaw);
        if (highUseMin !== undefined && (!Number.isFinite(highUseMin) || highUseMin < 0)) {
          return usageError("brain lifecycle curator --high-use-min must be a non-negative number");
        }
        const slices = curatorSlices(vault, highUseMin !== undefined ? { highUseMin } : {});
        if (wantsJson) {
          okJson({
            injected_never_used: renderCuratorRows(slices.injectedNeverUsed),
            contradicted: renderCuratorRows(slices.contradicted),
            high_used: renderCuratorRows(slices.highUsed),
          });
        } else {
          ok(
            `injected-never-used: ${slices.injectedNeverUsed.length}, ` +
              `contradicted: ${slices.contradicted.length}, ` +
              `high-used: ${slices.highUsed.length}`,
          );
        }
        return 0;
      }
      default:
        return usageError(`unknown lifecycle action: ${action}`);
    }
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message ?? String(exc)}\n`);
    return 1;
  }
}
