/**
 * `o2b brain truth <op>` (Entity Truth & Self-Improving Dream Suite):
 * operator surface over the claim ledger - `ingest` appends one claim,
 * `slots` and `conflicts` render the fold (with conflict detection),
 * `aggregate` sums exact-match quantities, `collisions` reports
 * cross-agent convergence, `sweep` bounds the ledger.
 *
 * Exit codes: 0 on success, 1 on an operational failure, 2 on usage
 * errors.
 */

import { defaultConfigPath, resolveAgentName } from "../../../core/config.ts";
import { aggregateQuantities } from "../../../core/brain/truth/aggregate.ts";
import { detectAgentCollisions } from "../../../core/brain/truth/collision.ts";
import { computeTruthStateWithConflicts } from "../../../core/brain/truth/conflicts.ts";
import {
  appendClaimEvent,
  CLAIM_EVENT_MAX_COUNT,
  readClaimEvents,
  sweepClaimEvents,
} from "../../../core/brain/truth/store.ts";
import { normalizeEntityName } from "../../../core/brain/entities/canonical.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { fail, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

const OPS = ["ingest", "slots", "conflicts", "aggregate", "collisions", "sweep"] as const;
type TruthOp = (typeof OPS)[number];

const USAGE =
  "usage: o2b brain truth <ingest|slots|conflicts|aggregate|collisions|sweep>\n" +
  "  ingest     --entity E --aspect A --value V --source S [--agent N] [--ts ISO]\n" +
  "             [--quantity-value N --quantity-unit U --quantity-action W]\n" +
  "  slots      [--entity E]\n" +
  "  conflicts  [--window-days N]\n" +
  "  aggregate  --action W [--unit U] [--entity E]\n" +
  "  collisions [--window-days N]\n" +
  "  sweep      [--max-events N]\n" +
  "  common     [--vault <path>] [--json]";

function requireString(flags: Record<string, unknown>, name: string): string {
  const value = flags[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new UsageError(`--${name} is required`);
  }
  return value;
}

class UsageError extends Error {}

export async function cmdBrainTruth(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    entity: { type: "string" },
    aspect: { type: "string" },
    value: { type: "string" },
    source: { type: "string" },
    agent: { type: "string" },
    ts: { type: "string" },
    "quantity-value": { type: "string" },
    "quantity-unit": { type: "string" },
    "quantity-action": { type: "string" },
    action: { type: "string" },
    unit: { type: "string" },
    "window-days": { type: "string" },
    "max-events": { type: "string" },
    json: { type: "boolean" },
  });
  const op = positional[0] as TruthOp | undefined;
  if (op === undefined || !OPS.includes(op)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const asJson = flags["json"] === true;
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  try {
    switch (op) {
      case "ingest": {
        const quantityValueRaw = flags["quantity-value"] as string | undefined;
        if (
          quantityValueRaw === undefined &&
          (flags["quantity-unit"] !== undefined || flags["quantity-action"] !== undefined)
        ) {
          throw new UsageError(
            "--quantity-value is required when --quantity-unit or --quantity-action is provided",
          );
        }
        let valueKind: "text" | "quantity" = "text";
        let quantity: { value: number; unit: string | null; action: string | null } | undefined;
        if (quantityValueRaw !== undefined) {
          const qv = Number(quantityValueRaw);
          if (!Number.isFinite(qv))
            throw new UsageError("--quantity-value must be a finite number");
          valueKind = "quantity";
          quantity = {
            value: qv,
            unit: (flags["quantity-unit"] as string | undefined) ?? null,
            action: (flags["quantity-action"] as string | undefined) ?? null,
          };
        }
        const result = appendClaimEvent(vault, {
          ts: (flags["ts"] as string | undefined) ?? isoSecond(new Date()),
          agent: (flags["agent"] as string | undefined) ?? resolveAgentName(config),
          entity: requireString(flags, "entity"),
          aspect: requireString(flags, "aspect"),
          value: requireString(flags, "value"),
          valueKind,
          ...(quantity !== undefined ? { quantity } : {}),
          source: requireString(flags, "source"),
        });
        const body = {
          ok: true,
          entity: result.event.entity,
          aspect: result.event.aspect,
          value: result.event.value,
          path: result.path,
        };
        if (asJson) okJson(body);
        else ok(`claim recorded: ${body.entity} / ${body.aspect} = ${body.value}`);
        return 0;
      }
      case "slots": {
        const state = computeTruthStateWithConflicts(readClaimEvents(vault).events);
        const entityFilter = flags["entity"] as string | undefined;
        const slots = state.slots.filter(
          (s) => entityFilter === undefined || s.entity === normalizeEntityName(entityFilter),
        );
        if (asJson) {
          okJson({ events: state.events, slots });
        } else {
          ok(`truth: ${state.events} event(s), ${slots.length} slot(s)`);
          for (const s of slots) {
            const flag = s.contested ? " [CONTESTED]" : "";
            ok(`  ${s.entity} / ${s.aspect} = ${s.current.value}${flag}`);
            for (const h of s.history) ok(`    superseded: ${h.value} (${h.ts}, ${h.source})`);
          }
        }
        return 0;
      }
      case "conflicts": {
        const windowRaw = flags["window-days"] as string | undefined;
        const windowDays = windowRaw !== undefined ? Number(windowRaw) : undefined;
        if (windowDays !== undefined && (!Number.isInteger(windowDays) || windowDays <= 0)) {
          throw new UsageError("--window-days must be a positive integer");
        }
        const state = computeTruthStateWithConflicts(
          readClaimEvents(vault).events,
          windowDays !== undefined ? { windowDays } : {},
        );
        if (asJson) {
          okJson({ conflicts: state.conflicts });
        } else {
          ok(`conflicts: ${state.conflicts.length}`);
          for (const c of state.conflicts) {
            ok(
              `  ${c.entity} / ${c.aspect}: ${c.values.map((v) => v.value).join(" vs ")} ` +
                `(priority ${c.priority}, ${c.resolution})`,
            );
          }
        }
        return 0;
      }
      case "aggregate": {
        const state = computeTruthStateWithConflicts(readClaimEvents(vault).events);
        const result = aggregateQuantities(state.slots, {
          ...(typeof flags["action"] === "string" ? { action: flags["action"] } : {}),
          unit: (flags["unit"] as string | undefined) ?? null,
          ...(typeof flags["entity"] === "string" ? { entity: flags["entity"] } : {}),
        });
        if (asJson) {
          okJson({ ...result });
        } else {
          ok(
            `${result.action ?? "all actions"}${result.unit !== null ? ` (${result.unit})` : ""}: ` +
              `total ${result.total} across ${result.count} value(s)`,
          );
          for (const c of result.contributions) {
            ok(`  ${c.value}  ${c.entity} / ${c.aspect}  ${c.source}`);
          }
        }
        return 0;
      }
      case "collisions": {
        const windowRaw = flags["window-days"] as string | undefined;
        const windowDays = windowRaw !== undefined ? Number(windowRaw) : undefined;
        if (windowDays !== undefined && (!Number.isInteger(windowDays) || windowDays <= 0)) {
          throw new UsageError("--window-days must be a positive integer");
        }
        const collisions = detectAgentCollisions(readClaimEvents(vault).events, {
          now: new Date(),
          ...(windowDays !== undefined ? { windowDays } : {}),
        });
        if (asJson) {
          okJson({ collisions });
        } else {
          ok(`collisions: ${collisions.length}`);
          for (const c of collisions) {
            ok(`  ${c.entity}: ${c.agents.join(" + ")} (${c.claims} claim(s))`);
          }
        }
        return 0;
      }
      case "sweep": {
        const maxRaw = flags["max-events"] as string | undefined;
        const maxEvents = maxRaw !== undefined ? Number(maxRaw) : CLAIM_EVENT_MAX_COUNT;
        if (!Number.isInteger(maxEvents) || maxEvents < 0) {
          throw new UsageError("--max-events must be a non-negative integer");
        }
        const outcome = sweepClaimEvents(vault, { maxEvents });
        if (asJson) okJson({ removed: outcome.removed, kept: outcome.kept });
        else ok(`truth sweep: removed ${outcome.removed}, kept ${outcome.kept}`);
        return 0;
      }
    }
  } catch (exc) {
    if (exc instanceof UsageError) {
      process.stderr.write(`brain truth ${op}: ${exc.message}\n${USAGE}\n`);
      return 2;
    }
    const message = `truth ${op} failed: ${(exc as Error).message ?? exc}`;
    if (asJson) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}
