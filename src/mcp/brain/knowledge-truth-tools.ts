/**
 * The truth tools of the knowledge family (task 3.19):
 * `brain_truth`, `brain_dead_ends` and `brain_codegraph_report`, the
 * operator and agent surfaces over the claim ledger's verdicts. Split
 * from `knowledge-tools.ts`; registration happens through that module's
 * registry, which preserves the public KNOWLEDGE_TOOLS surface.
 */

import { resolveAgentName } from "../../core/config.ts";
import { isoSecond } from "../../core/brain/time.ts";
import { normalizeAgentArgument } from "../../core/agent-identity.ts";
import { normalizeEntityName } from "../../core/brain/entities/canonical.ts";
import {
  appendStatedClaims,
  StatedClaimsRefusal,
  type StatedClaim,
} from "../../core/brain/truth/stated-claims.ts";
import { listDeadEnds, recordDeadEnd } from "../../core/brain/dead-ends.ts";
import { lanePath, laneVault } from "./lane-vault.ts";
import { buildCodegraphReport, type CodegraphReport } from "../../core/partner/codegraph-report.ts";
import { toolPath } from "./device-path.ts";
import { aggregateQuantities } from "../../core/brain/truth/aggregate.ts";
import { detectAgentCollisions } from "../../core/brain/truth/collision.ts";
import { computeTruthStateWithConflicts } from "../../core/brain/truth/conflicts.ts";
import {
  appendClaimEvent,
  ClaimWindowRefusal,
  readClaimEvents,
} from "../../core/brain/truth/store.ts";
import { claimEventLimit } from "../../core/brain/truth/events-window.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { contextReach, contextVault } from "../tool-contract.ts";
import type { ServerContext } from "../tool-contract.ts";
import { unknownOperationError } from "../coerce.ts";
import { vaultRelativeSafe } from "./shared.ts";
import { resolveTimeBounds } from "./time-bounds.ts";
import { readableAtContextReachOrUndefined } from "./reach-readable.ts";
import { claimEventsReport, statedClaimEntities } from "./knowledge-claim-tools.ts";

// ----- brain_context_pack (v0.10.15) ---------------------------------------

/**
 * Operator/agent surface over the entity claim ledger: ingest one
 * claim, render slots/conflicts from the fold, aggregate exact-match
 * quantities, report cross-agent collisions, recall a windowed slice of
 * the ledger via the events operation, and commit grounded agent-stated
 * claims via the state operation with per-claim anchoring verdicts. The
 * read ops are pure folds over the append-only ledger.
 */
export function toolBrainTruth(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const op = args["operation"];
  if (
    op !== "ingest" &&
    op !== "slots" &&
    op !== "conflicts" &&
    op !== "aggregate" &&
    op !== "collisions" &&
    op !== "events" &&
    op !== "state"
  ) {
    throw unknownOperationError(
      "brain_truth: operation must be ingest|slots|conflicts|aggregate|collisions|events|state",
    );
  }
  const requireStr = (name: string): string => {
    const value = args[name];
    if (typeof value !== "string" || value.trim() === "") {
      throw new MCPError(INVALID_PARAMS, `brain_truth ${op}: ${name} must be a non-empty string`);
    }
    return value;
  };
  // An optional string parameter is either a string or absent; any other
  // type is refused rather than silently ignored - a mistyped bound that
  // read as "no filter" would widen what the caller sees.
  const optionalStr = (name: string): string | undefined => {
    const value = args[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      throw new MCPError(INVALID_PARAMS, `brain_truth ${op}: ${name} must be a string`);
    }
    return value;
  };

  if (op === "ingest") {
    const quantityValue = args["quantity_value"];
    if (
      (quantityValue === undefined || quantityValue === null) &&
      (typeof args["quantity_unit"] === "string" || typeof args["quantity_action"] === "string")
    ) {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_truth ingest: quantity_value is required when quantity_unit or quantity_action is provided",
      );
    }
    let quantity: { value: number; unit: string | null; action: string | null } | undefined;
    if (quantityValue !== undefined && quantityValue !== null) {
      if (typeof quantityValue !== "number" || !Number.isFinite(quantityValue)) {
        throw new MCPError(INVALID_PARAMS, "brain_truth ingest: quantity_value must be a number");
      }
      quantity = {
        value: quantityValue,
        unit: typeof args["quantity_unit"] === "string" ? (args["quantity_unit"] as string) : null,
        action:
          typeof args["quantity_action"] === "string" ? (args["quantity_action"] as string) : null,
      };
    }
    const agentArg = args["agent"];
    const agent =
      normalizeAgentArgument(typeof agentArg === "string" ? agentArg : null) ??
      resolveAgentName(ctx.configPath ?? undefined);
    // Declared optional validity fields (design decision 3): explicit
    // input wins outright, bound by bound, over what ingest resolves
    // from the source record's frontmatter; absent fields leave every
    // line byte-identical to the pre-window ledger.
    const validFrom = optionalStr("valid_from");
    const validUntil = optionalStr("valid_until");
    // The source's window resolves at the CALLER's reach: a source page
    // the caller cannot read is treated exactly like an absent one -
    // windowless claim, no validity keys in the response, no signal
    // distinguishing withheld from absent. Without this gate the ingest
    // response would read a withheld page's validity frontmatter back
    // and triple as an existence oracle. (The CLI verb runs at operator
    // reach and passes no gate.)
    const readable = readableAtContextReachOrUndefined(ctx);
    // The store's window refusal is strict by design; here it is a
    // mistyped parameter, so it answers as the same failure class as the
    // sibling mistyped inputs (entity, since/until, limit) - typed
    // INVALID_PARAMS, never an internal error.
    let result;
    try {
      result = appendClaimEvent(
        ctx.vault,
        {
          ts: isoSecond(new Date()),
          agent,
          entity: requireStr("entity"),
          aspect: requireStr("aspect"),
          value: requireStr("value"),
          ...(quantity !== undefined ? { valueKind: "quantity" as const, quantity } : {}),
          ...(validFrom !== undefined ? { validFrom } : {}),
          ...(validUntil !== undefined ? { validUntil } : {}),
          source: requireStr("source"),
        },
        readable !== undefined ? { readableSource: readable } : {},
      );
    } catch (exc) {
      if (exc instanceof ClaimWindowRefusal) {
        throw new MCPError(INVALID_PARAMS, `brain_truth ingest: ${(exc as Error).message}`);
      }
      throw exc;
    }
    return {
      ok: true,
      entity: result.event.entity,
      aspect: result.event.aspect,
      path: result.path,
      ...(result.event.validFrom !== undefined ? { valid_from: result.event.validFrom } : {}),
      ...(result.event.validUntil !== undefined ? { valid_until: result.event.validUntil } : {}),
    };
  }

  // Windowed recall over the ledger (truth-correctable-time-aware,
  // Task 8): the response body is the shared claimEventsReport, so the
  // CLI subcommand answers byte-identically at the same query.
  if (op === "events") {
    const bounds = resolveTimeBounds(optionalStr("since"), optionalStr("until"));
    let limit: number;
    try {
      limit = claimEventLimit(args["limit"]);
    } catch (exc) {
      throw new MCPError(INVALID_PARAMS, `brain_truth events: ${(exc as Error).message}`);
    }
    return claimEventsReport(ctx.vault, ctx.agentName, contextReach(ctx), {
      entity: optionalStr("entity"),
      sinceMs: bounds.sinceMs,
      untilMs: bounds.untilMs,
      limit,
    });
  }

  // Grounded agent-stated claims (truth-correctable-time-aware, Task 8),
  // through lane 1's grounded-claim core: the payload boundary refuses
  // WHOLE calls (unknown relation, missing text, missing source, empty
  // agent, malformed ts) before ANY write, and anchoring verdicts are
  // per claim - the one
  // partial-commit lane in this subsystem, safe because each event is an
  // independent append in an append-only ledger and the response reports
  // exactly what landed.
  if (op === "state") {
    const claims = args["claims"];
    if (!Array.isArray(claims) || claims.length === 0) {
      throw new MCPError(INVALID_PARAMS, "brain_truth state: claims must be a non-empty array");
    }
    const stated = claims.map((raw, index): StatedClaim => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new MCPError(INVALID_PARAMS, `brain_truth state: claims[${index}] must be an object`);
      }
      const claim = raw as Record<string, unknown>;
      // Type-shaped fields only; an empty subject or object is not a
      // refusal here but a per-claim ungrounded verdict downstream.
      const readField = (name: string): string => {
        const value = claim[name];
        if (typeof value !== "string") {
          throw new MCPError(
            INVALID_PARAMS,
            `brain_truth state: claims[${index}].${name} must be a string`,
          );
        }
        return value;
      };
      return {
        subject: readField("subject"),
        relation: readField("relation"),
        object: readField("object"),
      };
    });
    const agentArg = args["agent"];
    if (agentArg !== undefined && typeof agentArg !== "string") {
      throw new MCPError(INVALID_PARAMS, "brain_truth state: agent must be a string");
    }
    const agent =
      normalizeAgentArgument(typeof agentArg === "string" ? agentArg : null) ??
      resolveAgentName(ctx.configPath ?? undefined);
    // Sample id (answer-trust, task B4): an optional call-level id naming
    // the recall/context-pack quality-sample these claims were stated
    // against. A non-string type is refused here as a mistyped parameter;
    // a blank string flows to the payload boundary's named refusal below
    // (mapped to the same failure class), so an empty id is never coerced
    // to an absent one. Committed events echo the id verbatim.
    const sampleId = optionalStr("sample_id");
    // The source's frontmatter window resolves at the CALLER's reach,
    // exactly as ingest gates it: a withheld source freezes a windowless
    // event and the committed rows carry no validity keys, so the state
    // response reads a withheld page's frontmatter no more than an
    // absent one's.
    const readable = readableAtContextReachOrUndefined(ctx);
    try {
      const outcome = appendStatedClaims(
        ctx.vault,
        {
          claims: stated,
          text: requireStr("text"),
          agent,
          ts: isoSecond(new Date()),
          source: requireStr("source"),
          ...(sampleId !== undefined ? { sampleId } : {}),
        },
        {
          entities: statedClaimEntities(ctx.vault),
          ...(ctx.configPath !== null ? { configPath: ctx.configPath } : {}),
          ...(readable !== undefined ? { readableSource: readable } : {}),
        },
      );
      return {
        ok: true,
        operation: "state",
        committed: outcome.committed.map((result) => ({ ...result.event })),
        ungrounded: outcome.ungrounded.map(({ claim, reasons }) => ({
          subject: claim.subject,
          relation: claim.relation,
          object: claim.object,
          reasons,
        })),
      };
    } catch (exc) {
      // Both refusal channels are mistyped-input refusals - the payload
      // boundary's, and the store's when the stated claim's window
      // resolves from the source record's frontmatter and inverts there
      // - so both answer as the same failure class the ingest operation
      // maps, never an internal error.
      if (exc instanceof StatedClaimsRefusal || exc instanceof ClaimWindowRefusal) {
        throw new MCPError(INVALID_PARAMS, `brain_truth state: ${exc.message}`);
      }
      throw exc;
    }
  }

  const events = readClaimEvents(ctx.vault).events;
  if (op === "slots" || op === "conflicts") {
    const state = computeTruthStateWithConflicts(events);
    if (op === "conflicts") return { events: state.events, conflicts: state.conflicts };
    const entityFilter = args["entity"];
    const slots =
      typeof entityFilter === "string" && entityFilter.trim() !== ""
        ? state.slots.filter((s) => s.entity === normalizeEntityName(entityFilter))
        : state.slots;
    return { events: state.events, slots };
  }
  if (op === "aggregate") {
    const state = computeTruthStateWithConflicts(events);
    return {
      ...aggregateQuantities(state.slots, {
        ...(typeof args["action"] === "string" ? { action: args["action"] as string } : {}),
        unit: typeof args["unit"] === "string" ? (args["unit"] as string) : null,
        ...(typeof args["entity"] === "string" ? { entity: args["entity"] as string } : {}),
      }),
    };
  }
  return {
    collisions: detectAgentCollisions(events, { now: new Date() }),
  };
}

// ----- brain_concept_synthesis (v0.10.17) ----------------------------------

/**
 * Negative-knowledge registry: record one tried-and-failed approach
 * or list the bounded active set, newest first.
 */
export function toolBrainDeadEnds(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const op = args["operation"];
  if (op !== "record" && op !== "list") {
    throw unknownOperationError("brain_dead_ends: operation must be record|list");
  }
  // A dead-end page the caller cannot read at its reach is treated as
  // absent: `list` leaves it out of the entries and the warnings.
  const readable = readableAtContextReachOrUndefined(ctx);
  const vault = laneVault(ctx);
  if (op === "list") {
    const listed = listDeadEnds(vault);
    // With no vault a dead-end page is a store record: named `Brain/...`.
    const named = <T extends { path: string }>(row: T): T =>
      contextVault(ctx) === null ? { ...row, path: lanePath(ctx, row.path) } : row;
    // The reach filter judges the absolute paths, before any is renamed:
    // a renamed `Brain/...` path would resolve against the working
    // directory, not the vault.
    const shown = (row: { path: string }): boolean =>
      readable === undefined || readable(vaultRelativeSafe(vault, row.path));
    return {
      entries: listed.entries.filter(shown).map(named),
      warnings: listed.warnings.filter(shown).map(named),
    };
  }
  const approach = args["approach"];
  const reason = args["reason"];
  if (typeof approach !== "string" || approach.trim() === "") {
    throw new MCPError(INVALID_PARAMS, "brain_dead_ends record: approach must be non-empty");
  }
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new MCPError(INVALID_PARAMS, "brain_dead_ends record: reason must be non-empty");
  }
  const agentArg = args["agent"];
  const agent =
    normalizeAgentArgument(typeof agentArg === "string" ? agentArg : null) ??
    resolveAgentName(ctx.configPath ?? undefined);
  const result = recordDeadEnd(vault, {
    approach,
    reason,
    ...(typeof args["context"] === "string" ? { context: args["context"] as string } : {}),
    agent,
    now: new Date(),
    ...(readable !== undefined ? { readable } : {}),
  });
  // The overflow trim walks every active dead end, so below local reach the
  // ids it archived are left out: they would name or count withheld pages.
  // It archives only pages the caller can read; a withheld one stays put.
  return {
    ok: true,
    id: result.entry.id,
    path: contextVault(ctx) === null ? lanePath(ctx, result.entry.path) : result.entry.path,
    ...(readable === undefined ? { archived: result.archived } : {}),
  };
}

// ----- brain_codegraph_report (t_a1e76788) -----------------------------------

/**
 * Read-only codegraph partner report: index status plus structural Cargo
 * workspace membership. Never installs, initializes, extracts, or mutates a
 * partner index or the vault - a missing CLI, missing index, or non-Rust
 * project are honest report states, not errors.
 */
export function toolBrainCodegraphReport(
  ctx: ServerContext,
  _args: Record<string, unknown>,
): Record<string, unknown> {
  const report = buildCodegraphReport({ cwd: process.cwd(), vault: ctx.vault });
  // The CLI binary, the project and the Cargo manifest are host paths
  // that may sit outside every root the server's egress pass knows (a
  // package manager's bin folder, a checkout under /srv): each is named
  // at the caller's reach here, as `toolPath` names any host path.
  const at = (path: string): string => toolPath(ctx, path);
  const named: CodegraphReport = {
    ...report,
    project: report.project === null ? null : at(report.project),
    cli: { ...report.cli, path: report.cli.path === null ? null : at(report.cli.path) },
    cargo_workspace:
      report.cargo_workspace === null
        ? null
        : { ...report.cargo_workspace, manifestPath: at(report.cargo_workspace.manifestPath) },
  };
  return named as unknown as Record<string, unknown>;
}
