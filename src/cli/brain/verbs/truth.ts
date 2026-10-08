/**
 * `o2b brain truth <op>` (Entity Truth & Self-Improving Dream Suite):
 * operator surface over the claim ledger - `ingest` appends one claim
 * (optionally validity-windowed), `slots` and `conflicts` render the
 * fold (with conflict detection), `aggregate` sums exact-match
 * quantities, `collisions` reports cross-agent convergence, `events`
 * recalls a windowed slice of the ledger, `state` grounds one
 * agent-stated claim with an anchoring verdict, `sweep` bounds the
 * ledger.
 *
 * Exit codes: 0 on success, 1 on an operational failure, 2 on usage
 * errors.
 */

import { aggregateQuantities } from "../../../core/brain/truth/aggregate.ts";
import { detectAgentCollisions } from "../../../core/brain/truth/collision.ts";
import { computeTruthStateWithConflicts } from "../../../core/brain/truth/conflicts.ts";
import { claimEventLimit } from "../../../core/brain/truth/events-window.ts";
import {
  appendClaimEvent,
  CLAIM_EVENT_MAX_COUNT,
  ClaimWindowRefusal,
  readClaimEvents,
  sweepClaimEvents,
} from "../../../core/brain/truth/store.ts";
import {
  appendStatedClaims,
  StatedClaimsRefusal,
} from "../../../core/brain/truth/stated-claims.ts";
import { normalizeEntityName } from "../../../core/brain/entities/canonical.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { SearchError } from "../../../core/search/types.ts";
import { TRANSPORT_REACH } from "../../../core/graph/transport-reach.ts";
import { resolveAgentName } from "../../../core/config.ts";
import { claimEventsReport, statedClaimEntities } from "../../../mcp/brain/knowledge-tools.ts";
import { parseTimeBounds } from "../../../mcp/brain/time-bounds.ts";
import { brainVerbContext, fail, ok, okJson, parse, resolveBrainAgent } from "../helpers.ts";

const OPS = [
  "ingest",
  "slots",
  "conflicts",
  "aggregate",
  "collisions",
  "events",
  "state",
  "sweep",
] as const;
type TruthOp = (typeof OPS)[number];

const USAGE =
  "usage: o2b brain truth <ingest|slots|conflicts|aggregate|collisions|events|state|sweep>\n" +
  "  ingest     --entity E --aspect A --value V --source S [--agent N] [--ts ISO]\n" +
  "             [--valid-from X --valid-until Y]\n" +
  "             [--quantity-value N --quantity-unit U --quantity-action W]\n" +
  "  slots      [--entity E]\n" +
  "  conflicts  [--window-days N]\n" +
  "  aggregate  --action W [--unit U] [--entity E]\n" +
  "  collisions [--window-days N]\n" +
  "  events     [--entity E] [--since X] [--until Y] [--limit N]\n" +
  "  state      --subject S --relation R --object O --text T --source S\n" +
  "             [--agent N]\n" +
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
    "valid-from": { type: "string" },
    "valid-until": { type: "string" },
    subject: { type: "string" },
    relation: { type: "string" },
    object: { type: "string" },
    text: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    limit: { type: "string" },
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
  const { config, vault } = brainVerbContext(flags);

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
        const validFrom = flags["valid-from"] as string | undefined;
        const validUntil = flags["valid-until"] as string | undefined;
        // Validity windows (contract item 1): presence-gated passthrough;
        // the store refuses an unparseable or inverted window by name,
        // mapped to the usage failure class - a mistyped window is the
        // same kind of mistake as --since garbage or --limit 0.
        let result;
        try {
          result = appendClaimEvent(vault, {
            ts: (flags["ts"] as string | undefined) ?? isoSecond(new Date()),
            agent: resolveBrainAgent(flags, config),
            entity: requireString(flags, "entity"),
            aspect: requireString(flags, "aspect"),
            value: requireString(flags, "value"),
            valueKind,
            ...(quantity !== undefined ? { quantity } : {}),
            ...(validFrom !== undefined ? { validFrom } : {}),
            ...(validUntil !== undefined ? { validUntil } : {}),
            source: requireString(flags, "source"),
          });
        } catch (exc) {
          if (exc instanceof ClaimWindowRefusal) throw new UsageError((exc as Error).message);
          throw exc;
        }
        const body = {
          ok: true,
          entity: result.event.entity,
          aspect: result.event.aspect,
          value: result.event.value,
          path: result.path,
          ...(result.event.validFrom !== undefined ? { valid_from: result.event.validFrom } : {}),
          ...(result.event.validUntil !== undefined
            ? { valid_until: result.event.validUntil }
            : {}),
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
      case "events": {
        // Bounds parse through the shared time-bounds wrapper - the same
        // parser the MCP events operation refuses with - mapped to the
        // INVALID_PARAMS-equivalent exit-2 usage error.
        let sinceMs: number | null;
        let untilMs: number | null;
        try {
          const bounds = parseTimeBounds(
            flags["since"] as string | undefined,
            flags["until"] as string | undefined,
          );
          sinceMs = bounds.sinceMs;
          untilMs = bounds.untilMs;
        } catch (exc) {
          if (exc instanceof SearchError) throw new UsageError(exc.message);
          throw exc;
        }
        const limitRaw = flags["limit"] as string | undefined;
        // A non-numeric --limit reaches the shared limit guard as NaN,
        // and that guard's refusal would stringify the NaN as "null" -
        // naming nothing the operator typed. Validate the flag is finite
        // here, before that message is composed, and name the raw value.
        if (limitRaw !== undefined && !Number.isFinite(Number(limitRaw))) {
          throw new UsageError(
            `--limit must be a positive integer, got ${JSON.stringify(limitRaw)}`,
          );
        }
        let limit: number;
        try {
          limit = claimEventLimit(limitRaw === undefined ? undefined : Number(limitRaw));
        } catch (exc) {
          throw new UsageError((exc as Error).message);
        }
        // The CLI runs at local reach (stdio child of the caller); the
        // owner-scope gate still binds the server-resolved identity. The
        // body is the shared claimEventsReport, so this surface answers
        // byte-identically to the MCP operation at the same query.
        const body = claimEventsReport(vault, resolveAgentName(config), TRANSPORT_REACH.local, {
          entity: flags["entity"] as string | undefined,
          sinceMs,
          untilMs,
          limit,
        });
        if (asJson) {
          okJson(body);
        } else {
          const rows = body.events as ReadonlyArray<{
            ts: string;
            entity: string;
            aspect: string;
            value: string;
            source: string;
          }>;
          ok(
            `events: ${body.total} matched, ${rows.length} shown` +
              `${body.truncated ? ", truncated" : ""}`,
          );
          for (const e of rows) {
            ok(`  ${e.ts}  ${e.entity} / ${e.aspect} = ${e.value}  ${e.source}`);
          }
        }
        return 0;
      }
      case "state": {
        // One agent-stated claim per invocation, through the same
        // grounded-claim core the MCP state operation calls: the payload
        // boundary refuses whole (unknown relation, missing text or
        // source) as the INVALID_PARAMS-equivalent usage error, and the
        // anchoring verdict - committed event or reported-back reasons -
        // is the answer.
        const body = (() => {
          try {
            const outcome = appendStatedClaims(
              vault,
              {
                claims: [
                  {
                    subject: requireString(flags, "subject"),
                    relation: requireString(flags, "relation"),
                    object: requireString(flags, "object"),
                  },
                ],
                text: requireString(flags, "text"),
                agent: resolveBrainAgent(flags, config),
                ts: isoSecond(new Date()),
                source: requireString(flags, "source"),
              },
              { entities: statedClaimEntities(vault), configPath: config },
            );
            return {
              ok: true,
              operation: "state" as const,
              committed: outcome.committed.map((result) => ({ ...result.event })),
              ungrounded: outcome.ungrounded.map(({ claim, reasons }) => ({
                subject: claim.subject,
                relation: claim.relation,
                object: claim.object,
                reasons,
              })),
            };
          } catch (exc) {
            // Both refusal channels are mistyped-input refusals, so both
            // answer as the usage failure class - the same mapping the
            // ingest case applies, so the state verb never answers a
            // window the SOURCE record carries as an operational failure.
            if (exc instanceof StatedClaimsRefusal || exc instanceof ClaimWindowRefusal) {
              throw new UsageError((exc as Error).message);
            }
            throw exc;
          }
        })();
        if (asJson) {
          okJson(body);
        } else {
          if (body.committed.length > 0) {
            for (const row of body.committed) {
              const r = row as { entity: string; aspect: string; value: string };
              ok(`anchored claim recorded: ${r.entity} / ${r.aspect} = ${r.value}`);
            }
          }
          for (const u of body.ungrounded) {
            ok(
              `ungrounded claim reported back: ${u.subject} / ${u.relation} / ${u.object}` +
                ` (${u.reasons.join(", ")})`,
            );
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
