/**
 * Tension-object lifecycle MCP tool (Belief lifecycle suite, S2,
 * t_0e3f2bee).
 *
 * One tool, `brain_tension`, dispatching on `action`:
 *   - `detect`    scan the note corpus and persist detected contradictions
 *   - `list`      list persisted tensions (optionally unresolved only)
 *   - `show`      read one tension
 *   - `confirm`   open -> confirmed
 *   - `dismiss`   open|confirmed -> dismissed
 *   - `resolve`   open|confirmed -> resolved
 *   - `verify`    read-only: an advisory decision-model verdict per
 *                 tension (one slug, or every unresolved tension); needs
 *                 the optional `tension` decision-model use
 *
 * MCP mirror of the `o2b brain tension` CLI verb; both delegate to the
 * core tensions module so the on-disk shape cannot drift.
 */

import {
  confirmTension,
  detectTensionsInVault,
  dismissTension,
  listTensions,
  listUnresolvedTensions,
  resolveTension,
  showTension,
  TensionError,
  type TensionRecord,
} from "../../core/brain/tensions.ts";
import { verifyTensions } from "../../core/brain/tension-verdicts.ts";
import { verdictFields } from "../../core/decision-model/pair-verdict.ts";
import { vaultRelative } from "../../core/path-safety.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { coerceBool, coerceStr, unknownOperationError } from "../coerce.ts";
import { readableAtContextReachOrUndefined, type ReadablePredicate } from "./reach-readable.ts";
import { wrapToolErrors } from "./shared.ts";

const TOOL = "brain_tension";

/** Project a tension record into the tool's snake_cased response shape. */
function renderRow(t: TensionRecord): Record<string, unknown> {
  return {
    id: t.id,
    slug: t.slug,
    status: t.status,
    subject_a: t.subjectA,
    subject_b: t.subjectB,
    stance_a: t.stanceA,
    stance_b: t.stanceB,
    detected_count: t.detectedCount,
    resolution_reason: t.resolutionReason,
  };
}

/**
 * May the caller read this tension page? The page carries the stricter
 * `visibility:` of its two source notes, so the page's own rule is the
 * notes' rule. `readable` undefined withholds nothing.
 */
function tensionReadable(
  vault: string,
  readable: ReadablePredicate | undefined,
  t: TensionRecord,
): boolean {
  return readable === undefined || readable(vaultRelative(t.path, vault));
}

/**
 * One tension by slug, or a typed `no tension` error when it is absent
 * or withheld from the caller: the two answer alike, so the error does
 * not confirm the page exists.
 */
function readableTension(
  vault: string,
  readable: ReadablePredicate | undefined,
  slug: string,
): TensionRecord {
  const t = showTension(vault, slug);
  if (t === null || !tensionReadable(vault, readable, t)) {
    throw new TensionError(`no tension: ${slug}`);
  }
  return t;
}

async function toolBrainTension(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return wrapToolErrors(TOOL, [TensionError], async () => {
    const action = coerceStr(args, "action", true)!;
    const agent = coerceStr(args, "agent", false) ?? undefined;
    const reason = coerceStr(args, "reason", false) ?? undefined;
    // Every action answers at the caller's reach: detect reads only the
    // notes it may read, and a tension page it may not read is left out
    // of list and verify and answered as absent by show and the
    // transitions, before anything is written.
    const readable = readableAtContextReachOrUndefined(ctx);
    const visible = (rows: ReadonlyArray<TensionRecord>): TensionRecord[] =>
      rows.filter((t) => tensionReadable(ctx.vault, readable, t));

    switch (action) {
      case "detect":
      case "scan": {
        const rawJaccard = args["jaccard"];
        let jaccard: number | undefined;
        if (rawJaccard !== undefined && rawJaccard !== null) {
          if (typeof rawJaccard !== "number" || !Number.isFinite(rawJaccard)) {
            throw new MCPError(INVALID_PARAMS, `${TOOL}: 'jaccard' must be a number`);
          }
          if (rawJaccard <= 0 || rawJaccard > 1) {
            throw new MCPError(INVALID_PARAMS, `${TOOL}: 'jaccard' must be in (0, 1]`);
          }
          jaccard = rawJaccard;
        }
        const res = detectTensionsInVault(ctx.vault, {
          ...(jaccard !== undefined ? { jaccard } : {}),
          ...(agent ? { agent } : {}),
          ...(readable !== undefined ? { readable } : {}),
        });
        return {
          action,
          created: res.created,
          updated: res.updated,
          scanned_files: res.scannedFiles,
          tensions: res.records.map(renderRow),
        };
      }
      case "list": {
        const unresolved = coerceBool(args, "unresolved");
        const rows = unresolved ? listUnresolvedTensions(ctx.vault) : listTensions(ctx.vault);
        return { action, tensions: visible(rows).map(renderRow) };
      }
      case "show": {
        const slug = coerceStr(args, "slug", true)!;
        const t = readableTension(ctx.vault, readable, slug);
        return {
          action,
          ...renderRow(t),
          subject: t.subject,
          jaccard: t.jaccard,
          quote_a: t.quoteA,
          quote_b: t.quoteB,
          created_at: t.createdAt,
          detected_at: t.detectedAt,
          status_changed_at: t.statusChangedAt,
        };
      }
      case "confirm":
      case "dismiss":
      case "resolve": {
        const slug = coerceStr(args, "slug", true)!;
        const opts = {
          ...(reason ? { reason } : {}),
          ...(agent ? { agent } : {}),
        };
        const fn =
          action === "confirm"
            ? confirmTension
            : action === "dismiss"
              ? dismissTension
              : resolveTension;
        readableTension(ctx.vault, readable, slug);
        const t = fn(ctx.vault, slug, opts);
        return { action, ...renderRow(t) };
      }
      case "verify": {
        const slug = coerceStr(args, "slug", false);
        let records: TensionRecord[];
        if (slug) {
          records = [readableTension(ctx.vault, readable, slug)];
        } else {
          records = visible(listUnresolvedTensions(ctx.vault));
        }
        const verified = await verifyTensions(ctx.vault, records, { configPath: ctx.configPath });
        return {
          action,
          available: verified.available,
          ...(verified.available ? { mode: verified.mode } : { reason: verified.reason }),
          tensions: verified.rows.map((row) => ({ ...renderRow(row.item), ...verdictFields(row) })),
        };
      }
      default:
        throw unknownOperationError(
          `${TOOL}: 'action' must be one of detect, list, show, confirm, dismiss, resolve, verify`,
        );
    }
  });
}

export const TENSION_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    description:
      "Persisted-contradiction (tension) lifecycle. detect persists contradictions from notes.read_paths as open tensions (idempotent); list/show read; confirm, dismiss, resolve transition. verify: read-only advisory verdict from the optional tension decision-model use; never changes a tension.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["detect", "list", "show", "confirm", "dismiss", "resolve", "verify"],
          description: "Which tension operation to run.",
        },
        slug: {
          type: "string",
          description:
            "show/confirm/dismiss/resolve: the tension slug. verify: optional; without it every unresolved tension is verified.",
        },
        jaccard: {
          type: "number",
          description:
            "detect: minimum prose token overlap (0, 1] for two notes to count as the same subject. Defaults to the shared health threshold.",
        },
        unresolved: {
          type: "boolean",
          description: "list: return only open/confirmed (unresolved) tensions.",
        },
        reason: {
          type: "string",
          description: "dismiss/resolve: operator reason recorded on the transition.",
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainTension,
  },
]);
