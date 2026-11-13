/**
 * `brain_context_pack` (task 3.19): the composed context the agent
 * session opens with, assembled at the caller's reach from the rules,
 * digests, pinned context and session evidence the caller may read.
 * Split from `pack-tools.ts`; registration happens through that
 * module's registry, which preserves the public PACK_TOOLS surface.
 */

import {
  resolveDensityRankingContextPack,
  resolveEntityFactsContextPack,
  resolveRecallAdequacyThresholds,
  resolveRecallGateTelemetry,
  resolveSearchFocusContextPack,
  resolveTailTrimContextPack,
} from "../../core/config.ts";
import { resolveSearchConfig } from "../../core/search/index.ts";
import {
  loadBeliefSemanticRelevance,
  spentQueryDisclosure,
} from "../../core/brain/belief-semantic.ts";
import { readActiveSessionFocus } from "../../core/search/session-focus.ts";
import {
  CONTEXT_PACK_QUERY_MODES,
  ContextPackPackingLaneEmptyError,
  isContextPackQueryMode,
  packContext,
} from "../../core/brain/context-pack.ts";
import {
  isPackingPolicy,
  PACKING_POLICIES,
  type PackingPolicy,
} from "../../core/brain/recall-budget.ts";
import { assessRecallAdequacy } from "../../core/brain/recall-adequacy.ts";
import { recordRecallAdequacyDemand } from "../../core/brain/query-demand.ts";
import { emitGatedTelemetry } from "../../core/brain/continuity/emit.ts";
import {
  presetForResolvedWindow,
  unrecognisedModelBudgetRefusal,
} from "../../core/brain/context-presets.ts";
import { type ModelWindowSource, type ResolvedModelWindow } from "../../core/brain/model-window.ts";
import { ownerScopeView } from "../../core/brain/owner-scope-view.ts";
import { resolveOwnerScopeDelivery } from "../../core/brain/preferences-collect.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext } from "../tool-contract.ts";
import { contextReach } from "../tool-contract.ts";
import { reachView } from "../../core/brain/reach-view.ts";
import { TRANSPORT_REACH } from "../../core/graph/transport-reach.ts";
import { vaultPathField } from "../vault-path-field.ts";
import { exceedsMcpQueryCap, MCP_QUERY_CAP_MESSAGE } from "../search-tools.ts";
import {
  coerceAgentScope,
  coerceDecisionAnswerable,
  coerceRecallAdequacyInput,
  DECISION_ANSWERABLE_ARG_NAME,
  coerceStr,
  coerceStrList,
  coerceBool,
} from "../coerce.ts";
import { decisionAnswerableFor } from "../decision-answerable.ts";
import { coercePositiveInteger, telemetryOptionsFromArgs } from "./shared.ts";
import {
  RECALL_SCORES_ARG_NAME,
  configuredDegradation,
  discloseSpentPackQuery,
  optionalModelArg,
  receiptOptionsFromArgs,
  resolveSurfaceModelWindow,
  semanticReportField,
  vaultRelative,
  withSearchErrorsOnWire,
} from "./pack-shared.ts";

export async function toolBrainContextPack(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const model = optionalModelArg("brain_context_pack", args);
  const maxTokensArg = coercePositiveInteger(
    "brain_context_pack",
    "max_tokens",
    args["max_tokens"],
  );
  // The adequacy pairing is an input-SHAPE contract, declared in the
  // schema's `dependentRequired`, so it refuses an incomplete pair by
  // name before any semantic refusal can preempt it: `max_tokens` is now
  // optional behind the derivation below (t_a567cc12), and a payload
  // carrying one half of the pair must learn about the pairing, not about
  // a budget it never sent.
  const recallAttempt = coerceRecallAdequacyInput(
    "brain_context_pack",
    args,
    RECALL_SCORES_ARG_NAME,
  );
  const answerableArg = coerceDecisionAnswerable(
    "brain_context_pack",
    args,
    RECALL_SCORES_ARG_NAME,
    recallAttempt !== undefined,
  );
  // Derived budget (t_a567cc12): an explicit `max_tokens` is first-class
  // and untouched. When it is omitted, the budget derives from the model
  // context window the resolver resolves, through the matching preset's
  // `context_pack.max_tokens` - the curated mapping. A `default`-sourced
  // window defers to the model's hint preset, the same mapping
  // `brain_context_presets` suggest answers, so one model gets one budget
  // and one suggestion on every surface - and an id NOTHING places (no
  // table row, no suffix, no hint) refuses: the conservative posture this
  // tool held before derivation existed, never the default window's
  // long-context budget an 8k local model cannot hold. With nothing
  // resolvable the call refuses exactly as before: the pinned decision is
  // never a silent default budget.
  let maxTokens: number;
  let maxTokensSource: ModelWindowSource | undefined;
  if (maxTokensArg !== undefined) {
    maxTokens = maxTokensArg;
  } else {
    let resolved: ResolvedModelWindow | null;
    try {
      resolved = resolveSurfaceModelWindow(ctx.vault, model ?? undefined);
    } catch (e) {
      throw new MCPError(INVALID_PARAMS, `brain_context_pack: ${(e as Error).message}`);
    }
    if (resolved === null) {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_context_pack: max_tokens must be a positive integer",
      );
    }
    const refusal = unrecognisedModelBudgetRefusal(model, resolved);
    if (refusal !== null) {
      throw new MCPError(INVALID_PARAMS, `brain_context_pack: ${refusal}`);
    }
    // The hint fallback rides along exactly when the resolver's answer is
    // the default-sourced assumption, so a hint-only model budgets the
    // preset `brain_context_presets` suggest names for it; the source
    // disclosed on the wire stays the window's.
    maxTokens = presetForResolvedWindow(model, resolved).context_pack.max_tokens;
    maxTokensSource = resolved.source;
  }
  const query = typeof args["query"] === "string" ? (args["query"] as string) : undefined;
  // Ranked query mode (v1.53.0). Enforced beside the `dependentRequired`
  // that declares it: a mode with no query would otherwise be accepted and
  // do nothing, which is the silent no-op this project refuses.
  const queryMode = coerceStr(args, "query_mode", false);
  if (queryMode !== null) {
    if (!isContextPackQueryMode(queryMode)) {
      throw new MCPError(
        INVALID_PARAMS,
        `brain_context_pack: query_mode must be one of ${CONTEXT_PACK_QUERY_MODES.join(", ")}`,
      );
    }
    if (query === undefined) {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_context_pack: query_mode requires query; a mode with nothing to read is inert",
      );
    }
    // The semantic query is embedded once, ungated: a blank one buys nothing.
    if (queryMode === "semantic" && query.trim() === "") {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_context_pack: query_mode requires a non-empty query",
      );
    }
  }
  // Opt-in packing policy (recall-lane-latency wave). Refused beside the
  // `dependentRequired` that declares it, exactly as query_mode is: a
  // policy with no query has no turn to pack for and would be the silent
  // no-op this project refuses. A blank or whitespace-only query is the
  // same refusal, not a pass: the empty string is dropped before the core
  // and the null query filter-passes every candidate, so the policy would
  // silently reorder an unordered pack - the exact evasion the raw read
  // above would otherwise allow.
  const packingPolicy = coerceStr(args, "packing_policy", false);
  if (packingPolicy !== null) {
    if (!isPackingPolicy(packingPolicy)) {
      throw new MCPError(
        INVALID_PARAMS,
        `brain_context_pack: packing_policy must be one of ${PACKING_POLICIES.join(", ")}`,
      );
    }
    if (query === undefined || query.trim() === "") {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_context_pack: packing_policy requires query; a policy with nothing to order is inert",
      );
    }
  }
  if (query !== undefined && exceedsMcpQueryCap(query)) {
    throw new MCPError(INVALID_PARAMS, `brain_context_pack: ${MCP_QUERY_CAP_MESSAGE}`);
  }
  const includeLanes = coerceBool(args, "lanes");
  const cacheStable = coerceBool(args, "cache_stable");
  const dedupRepeated = coerceBool(args, "dedup_repeated");
  const attentionFlowIds = coerceStrList(args, "attention_flow_ids");
  const maxCharsPerMemory = coercePositiveInteger(
    "brain_context_pack",
    "max_chars_per_memory",
    args["max_chars_per_memory"],
  );
  const maxTotalChars = coercePositiveInteger(
    "brain_context_pack",
    "max_total_chars",
    args["max_total_chars"],
  );
  const receipt = receiptOptionsFromArgs("brain_context_pack", args, "context_pack", "mcp");
  const telemetry = telemetryOptionsFromArgs("brain_context_pack", args, "mcp");
  // The pairing coercions themselves ran above the budget derivation, so
  // an incomplete pair is refused by name; only the ASSESSMENT waits for
  // this point, beside the receipt and telemetry options it rides with.
  const adequacy =
    recallAttempt !== undefined
      ? assessRecallAdequacy(
          recallAttempt,
          resolveRecallAdequacyThresholds(ctx.configPath ?? undefined),
        )
      : undefined;
  // Advisory decision-model signal (issue #213, Part 8): annotates the
  // verdict and its receipt, never the level, the action or the pack.
  const answerable =
    adequacy !== undefined && answerableArg !== undefined
      ? decisionAnswerableFor(ctx, adequacy.level, answerableArg)
      : undefined;
  const answerableVerdict = answerable?.kind === "annotated" ? answerable.verdict : undefined;
  // signals-that-survive, unit 6: an unmet verdict is stamped onto the
  // cross-query demand log under the bucket key normalizeQueryTerms already
  // computes, so the knowledge-gap loop can aggregate recurrence without a
  // second identity concept.
  //
  // ONE opt-in for that log, on every surface that writes it: the
  // `recall_gate_telemetry` config key, exactly as `brain_recall_gate`
  // uses. It is a vault-level durable log feeding a vault-level loop, so
  // whether it is written is an operator decision, not a per-call one -
  // gating it here on this tool's `telemetry` ARGUMENT instead made one
  // feature answer to two different opt-ins and left the log's contents
  // depending on which surface a caller happened to use. That argument
  // keeps its own meaning: it selects whether THIS call emits its own
  // continuity records. Fail-open as ever - a log write never breaks the
  // pack.
  if (adequacy !== undefined && query !== undefined) {
    emitGatedTelemetry(resolveRecallGateTelemetry(ctx.configPath ?? undefined), () =>
      recordRecallAdequacyDemand(ctx.vault, { query, verdict: adequacy }),
    );
  }
  // Focus wiring (Agent Surface Suite, t_5b478e47): gated on the
  // search_focus_context_pack config key (default off) so the default
  // pack stays byte-identical. Fail-soft - a broken search config
  // never breaks the pack.
  let sessionFocus: ReturnType<typeof readActiveSessionFocus> = null;
  if (resolveSearchFocusContextPack(ctx.configPath ?? undefined)) {
    // Argument validation stays OUTSIDE the fail-soft block: an invalid
    // focus_session is a caller error (INVALID_PARAMS), not a config
    // read to swallow.
    const focusSession = coerceStr(args, "focus_session", false) ?? undefined;
    try {
      const searchConfig = resolveSearchConfig({
        vault: ctx.vault,
        configPath: ctx.configPath ?? undefined,
      });
      sessionFocus = readActiveSessionFocus(searchConfig, focusSession);
    } catch {
      sessionFocus = null;
    }
  }
  // Density-ranking wiring (impact-per-token allocation, t_affa3bd9):
  // gated on the density_ranking_context_pack config key (default off)
  // so the default pack stays byte-identical to the tier → recency order.
  const densityRanking = resolveDensityRankingContextPack(ctx.configPath ?? undefined);
  // Entity-facts wiring (dated commitments, t_43b0a379): gated on the
  // entity_facts_context_pack config key (default off) so the default
  // tool output carries no entity_facts key.
  const entityFacts = resolveEntityFactsContextPack(ctx.configPath ?? undefined);
  // Tail-trim wiring (t_cb6a5558): gated on the tail_trim_context_pack
  // config key (default off) so the default tool output carries no
  // tail_trim key and no trim ever runs.
  const tailTrim = resolveTailTrimContextPack(ctx.configPath ?? undefined);
  const agentScope = coerceAgentScope(ctx, args, true);
  // Root closure (t_sec_pack_reach): the pack reads page bodies by path,
  // outside the three read roots, so the reserved-token rule is asked per
  // candidate - the same shape `brain_clusters`/`brain_bridges` apply. It
  // is asked INSIDE the core, before ranking and budgeting, because every
  // other member of the report (`lanes`, `skipped`, tension `warnings`,
  // `deduped_from`, the receipt) is derived from the candidate set: a
  // filter over `items` alone left a reserved page's path and body in
  // `lanes` and its id in `skipped`. At local reach the view is the shared
  // no-op, so an operator's own transports see a byte-identical pack. The
  // core holds absolute paths; the view answers over vault-relative ones.
  const view = reachView(ctx.vault, contextReach(ctx));
  const remote = view.reach !== TRANSPORT_REACH.local;
  // Semantic mode (Honest Embedding Spend): the one async step - the query
  // embed and the stored-vector read - happens here, so `packContext`
  // stays synchronous for every other caller. Every refusal is a named
  // SearchError: a blocked tier and a missing sqlite-vec from the loader,
  // before any embed, and `BELIEF_VECTORS_MISSING` from the pack, after
  // the reach filter and before a receipt is written. The loader reads
  // only the beliefs this caller's pack can keep - the same reach and
  // owner views the pack applies - so its own pre-embed refusal never
  // answers for a withheld belief differently than for an absent one.
  const semantic =
    queryMode === "semantic" && query !== undefined
      ? await withSearchErrorsOnWire(() => {
          const owners = ownerScopeView(
            ctx.vault,
            resolveOwnerScopeDelivery(ctx.vault, agentScope).enforcedScope,
          );
          return loadBeliefSemanticRelevance(
            resolveSearchConfig({ vault: ctx.vault, configPath: ctx.configPath ?? undefined }),
            query,
            { reach: view.reach, inView: (rel) => view.visible(rel) && owners.visible(rel) },
          );
        })
      : null;
  let report: Awaited<ReturnType<typeof packContext>>;
  try {
    report = await withSearchErrorsOnWire(
      async () =>
        packContext(ctx.vault, {
          ...(remote
            ? { visible: (abs: string) => view.visible(vaultRelative(ctx.vault, abs)) }
            : {}),
          maxTokens,
          ...(agentScope !== undefined ? { agentScope } : {}),
          ...(densityRanking ? { densityRanking: true } : {}),
          ...(entityFacts ? { entityFacts: true } : {}),
          ...(tailTrim ? { tailTrim: true } : {}),
          ...(sessionFocus !== null ? { sessionFocus } : {}),
          ...(query ? { query } : {}),
          ...(queryMode !== null ? { queryMode } : {}),
          ...(packingPolicy !== null ? { packingPolicy: packingPolicy as PackingPolicy } : {}),
          ...(includeLanes ? { includeLanes: true } : {}),
          ...(receipt !== undefined ? { receipt } : {}),
          ...(adequacy !== undefined ? { recallAdequacy: adequacy } : {}),
          ...(answerableVerdict !== undefined ? { decisionAnswerable: answerableVerdict } : {}),
          ...(cacheStable || dedupRepeated
            ? {
                transforms: {
                  ...(cacheStable ? { cacheStableOrdering: true } : {}),
                  ...(dedupRepeated ? { deduplicateRepeatedContext: true } : {}),
                },
              }
            : {}),
          ...(maxCharsPerMemory !== undefined ? { maxCharsPerMemory } : {}),
          ...(maxTotalChars !== undefined ? { maxTotalChars } : {}),
          ...(configuredDegradation(ctx.vault) !== undefined
            ? { degradation: configuredDegradation(ctx.vault)! }
            : {}),
          ...(telemetry !== undefined ? { telemetry } : {}),
          // The synthesized attention-flow block has no page of its own to ask
          // the reach view about, so a remote caller does not get it (fail
          // closed, as the per-item filter this replaced did).
          ...(attentionFlowIds.length > 0 && !remote ? { attentionFlowIds } : {}),
          ...(semantic !== null ? { semanticRelevance: semantic.relevanceByPath } : {}),
        }),
      discloseSpentPackQuery(semantic),
    );
  } catch (e) {
    // A policy against a one-lane vault is a caller error the core
    // refuses by name; on the wire it is INVALID_PARAMS carrying that
    // same named message, never an internal error and never a no-op.
    if (e instanceof ContextPackPackingLaneEmptyError) {
      // The spend disclosure rides the refusal too: in semantic mode the
      // query embed was paid before the lanes were judged, and a refusal
      // that hides that spend under-discloses exactly when the caller
      // gets nothing back for it.
      throw new MCPError(
        INVALID_PARAMS,
        semantic !== null ? `${e.message} ${spentQueryDisclosure(semantic.report)}` : e.message,
      );
    }
    throw e;
  }
  const warnings = [
    ...(report.warnings ?? []),
    ...(semantic?.warnings ?? []),
    ...(answerable?.kind === "ignored" ? [answerable.warning] : []),
  ];
  return {
    vault_path: vaultPathField(ctx),
    max_tokens: report.maxTokens,
    // Present only when the budget was derived (t_a567cc12): the channel
    // that decided, so a caller can see a resolution was assumed rather
    // than paid for. An explicit `max_tokens` answers without it.
    ...(maxTokensSource !== undefined ? { max_tokens_source: maxTokensSource } : {}),
    tokens_used: report.tokensUsed,
    items: report.items.map((i) => ({
      id: i.id,
      path: i.path,
      tier: i.tier,
      tokens: i.tokens,
      body: i.body,
      trimmed: i.trimmed,
      epistemic: i.epistemic,
      ...(i.evidenceRefs.length > 0 ? { evidence_refs: i.evidenceRefs } : {}),
      ...(i.density !== undefined ? { density: i.density } : {}),
      ...(i.originalRank !== undefined ? { original_rank: i.originalRank } : {}),
      ...(i.stableRank !== undefined ? { stable_rank: i.stableRank } : {}),
      ...(i.dedupedFrom !== undefined ? { deduped_from: i.dedupedFrom } : {}),
      ...(i.referenceHint !== undefined ? { reference_hint: i.referenceHint } : {}),
      ...(i.safety ? { safety: i.safety } : {}),
    })),
    skipped: report.skipped.map((s) => ({
      id: s.id,
      tokens: s.tokens,
      reason: s.reason,
    })),
    ...(report.receiptId ? { receipt_id: report.receiptId } : {}),
    ...(report.telemetryId ? { telemetry_id: report.telemetryId } : {}),
    ...(report.lanes ? { lanes: report.lanes } : {}),
    // The core computes injection-time tension warnings and the
    // owner-scope observation and this projection dropped both, so the one
    // surface that puts vault text in front of a model every turn was the
    // one surface that could not say a memory it injected is contested.
    // `brain_pre_compress_pack` has forwarded them all along; absent when
    // empty, so a warning-free pack stays byte-identical.
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(semantic !== null && report.semantic !== undefined
      ? { semantic: semanticReportField(semantic, report.semantic) }
      : {}),
    // The packing accounting appears only when the caller named a
    // policy - the same conditional shape as `semantic` above.
    ...(report.packing ? { packing: report.packing } : {}),
    // The entity-facts rollup appears only when the config key resolved
    // on - the same conditional shape as `packing` above. Fields project
    // to the tool's wire casing.
    ...(report.entityFacts
      ? {
          entity_facts: {
            entities: report.entityFacts.entities.map((e) => ({
              entity_id: e.entityId,
              name: e.name,
              item_ids: e.itemIds,
            })),
          },
        }
      : {}),
    // The trim block appears only when the config key resolved on AND
    // the pack actually trimmed - the same conditional shape as
    // `entity_facts` above. Fields project to the tool's wire casing.
    ...(report.tailTrim
      ? {
          tail_trim: {
            dropped: report.tailTrim.dropped,
            kept_by_query_terms: report.tailTrim.keptByQueryTerms,
            rescued: report.tailTrim.rescued,
            tokens_saved: report.tailTrim.tokensSaved,
          },
        }
      : {}),
    ...(adequacy !== undefined
      ? {
          adequacy: {
            level: adequacy.level,
            action: adequacy.action,
            escalate: adequacy.escalate,
            result_count: adequacy.resultCount,
            top_score: adequacy.topScore,
            mean_score: adequacy.meanScore,
            reason: adequacy.reason,
            ...(answerableVerdict !== undefined
              ? {
                  [DECISION_ANSWERABLE_ARG_NAME]: {
                    probability: answerableVerdict.probability,
                    disagrees: answerableVerdict.disagrees,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}
