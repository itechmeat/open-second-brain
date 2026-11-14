/**
 * The preset and anticipatory tools of the pack family (task 3.19):
 * `brain_context_presets`, `brain_pre_compress_pack`,
 * `brain_pre_compact_extract` and `brain_anticipatory_context`. Split
 * from `pack-tools.ts`; registration happens through that module's
 * registry, which preserves the public PACK_TOOLS surface.
 */

import {
  buildReaderAnticipatoryContext,
  readAnticipatoryContext,
  refreshAnticipatoryCache,
  type ReadAnticipatoryContextResult,
} from "../../core/brain/anticipatory-cache.ts";
import { loadBrainConfig } from "../../core/brain/policy.ts";
import { buildPreCompressPack } from "../../core/brain/pre-compress-pack.ts";
import {
  diffContextPreset,
  getContextPreset,
  listContextPresets,
  presetForResolvedWindow,
  suggestContextPreset,
  type ContextPresetCurrentConfig,
} from "../../core/brain/context-presets.ts";
import {
  MODEL_CONTEXT_WINDOW_ENV_KEY,
  type ResolvedModelWindow,
} from "../../core/brain/model-window.ts";
import { extractPreCompactRecords } from "../../core/brain/pre-compact-extract.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext } from "../tool-contract.ts";
import { contextReach } from "../tool-contract.ts";
import { readableAtContextReachOrUndefined } from "./reach-readable.ts";
import { reachView } from "../../core/brain/reach-view.ts";
import { TRANSPORT_REACH } from "../../core/graph/transport-reach.ts";
import { vaultPathField } from "../vault-path-field.ts";
import { coerceAgentScope, coerceStr, coerceBool, unknownOperationError } from "../coerce.ts";
import {
  coercePositiveInteger,
  optionalStringArg,
  requiredStringArg,
  telemetryOptionsFromArgs,
} from "./shared.ts";
import {
  configuredDegradation,
  optionalModelArg,
  receiptOptionsFromArgs,
  resolveSurfaceModelWindow,
  vaultRelative,
} from "./pack-shared.ts";

export async function toolBrainContextPresets(
  _ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = optionalStringArg("brain_context_presets", args, "operation");
  if (operation === "show") {
    const presetId = optionalStringArg("brain_context_presets", args, "preset_id");
    const result =
      presetId === undefined ? { presets: listContextPresets() } : getContextPreset(presetId);
    if (result === null) {
      throw new MCPError(INVALID_PARAMS, `brain_context_presets: unknown preset ${presetId}`);
    }
    return Array.isArray(result) ? { presets: result } : { ...result };
  }
  if (operation === "suggest") {
    const model = optionalStringArg("brain_context_presets", args, "model");
    const window = coercePositiveInteger(
      "brain_context_presets",
      "context_window_tokens",
      args["context_window_tokens"],
    );
    return {
      ...suggestContextPreset({
        ...(model !== undefined ? { model } : {}),
        ...(window !== undefined ? { contextWindowTokens: window } : {}),
      }),
    };
  }
  if (operation === "diff") {
    const presetId = optionalStringArg("brain_context_presets", args, "preset_id");
    if (presetId === undefined) {
      throw new MCPError(INVALID_PARAMS, "brain_context_presets: preset_id is required for diff");
    }
    return {
      ...diffContextPreset(presetId, contextPresetCurrentConfig(args["current"])),
    };
  }
  throw unknownOperationError("brain_context_presets: operation must be show, suggest, or diff");
}

export function contextPresetCurrentConfig(raw: unknown): ContextPresetCurrentConfig {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new MCPError(INVALID_PARAMS, "brain_context_presets: current must be an object");
  }
  return raw as ContextPresetCurrentConfig;
}

// ----- brain_pre_compact_extract ------------------------------------------

/**
 * Read-only bundle of the highest-confidence confirmed preferences plus
 * the head of active.md, rendered as a system-prompt addendum for a host
 * runtime to inject just before a context-compression event.
 */
export async function toolBrainPreCompressPack(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const model = optionalModelArg("brain_pre_compress_pack", args);
  const topK = coercePositiveInteger("brain_pre_compress_pack", "top_k", args["top_k"]) ?? 10;
  const maxCharsPerMemory = coercePositiveInteger(
    "brain_pre_compress_pack",
    "max_chars_per_memory",
    args["max_chars_per_memory"],
  );
  const maxTotalChars = coercePositiveInteger(
    "brain_pre_compress_pack",
    "max_total_chars",
    args["max_total_chars"],
  );
  // Derived caps (t_a567cc12): an absent cap used to mean unbounded - the
  // one injection surface with no ceiling at all. When a cap is absent
  // and a window resolves, the matching preset's `pre_compress` block
  // fills it; explicit caps stay first-class; with nothing resolvable the
  // historical unbounded addendum stands, byte-identical. `top_k` keeps
  // its own 10 default - the presets' top-k values are suggestion
  // diagnostics, not this tool's default.
  let resolvedCaps: ResolvedModelWindow | null = null;
  // A malformed OPEN_SECOND_BRAIN_MODEL_CONTEXT_WINDOW used to rethrow
  // here as INVALID_PARAMS - blaming the caller's parameters and losing
  // the addendum over an operator typo the caller cannot see and this
  // result never disclosed. On THIS path an unparseable env value means
  // nothing resolvable: the historical unbounded caps stand and a named
  // warning says which channel misread, never echoing the value itself.
  let windowWarning: string | undefined;
  if (maxCharsPerMemory === undefined || maxTotalChars === undefined) {
    try {
      resolvedCaps = resolveSurfaceModelWindow(ctx.vault, model ?? undefined);
    } catch {
      resolvedCaps = null;
      windowWarning =
        `${MODEL_CONTEXT_WINDOW_ENV_KEY} is not a well-formed positive integer; ` +
        "pre-compress caps stay unbounded and nothing was derived from it";
    }
  }
  // The hint fallback rides along here exactly as it does in the
  // context-pack budget above: when the resolver's answer is the
  // default-sourced assumption, a hint-only model's caps come from its
  // hint preset, the same mapping the pack and `brain_context_presets`
  // suggest name - one model, one mapping on every surface.
  const derivedCaps =
    resolvedCaps !== null ? presetForResolvedWindow(model, resolvedCaps).pre_compress : null;
  const effMaxCharsPerMemory = maxCharsPerMemory ?? derivedCaps?.max_chars_per_memory;
  const effMaxTotalChars = maxTotalChars ?? derivedCaps?.max_total_chars;
  const receipt = receiptOptionsFromArgs("brain_pre_compress_pack", args, "pre_compress", "mcp");
  const telemetry = telemetryOptionsFromArgs("brain_pre_compress_pack", args, "mcp");
  const agentScope = coerceAgentScope(ctx, args, true);
  const readable = readableAtContextReachOrUndefined(ctx);
  const pack = buildPreCompressPack(ctx.vault, {
    topK,
    // A preference the caller cannot read at its reach is absent from the
    // head and from the top-K walk alike; a caller from whom nothing can
    // be withheld is handed no filter.
    ...(readable !== undefined ? { readable } : {}),
    restricted: contextReach(ctx) !== TRANSPORT_REACH.local,
    ...(agentScope !== undefined ? { agentScope } : {}),
    ...(effMaxCharsPerMemory !== undefined ? { maxCharsPerMemory: effMaxCharsPerMemory } : {}),
    ...(effMaxTotalChars !== undefined ? { maxTotalChars: effMaxTotalChars } : {}),
    ...(configuredDegradation(ctx.vault) !== undefined
      ? { degradation: configuredDegradation(ctx.vault)! }
      : {}),
    ...(receipt !== undefined ? { receipt } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
  });
  return {
    vault_path: vaultPathField(ctx),
    text: pack.text,
    active_head_included: pack.activeHeadIncluded,
    ...(pack.activeHeadSafety ? { active_head_safety: pack.activeHeadSafety } : {}),
    total_chars: pack.totalChars,
    // The pack's one degradation channel. This is the only surface the
    // builder has, so a warning dropped here is a broken `_brain.yaml`
    // nothing tells the caller about.
    ...(pack.warnings ? { warnings: pack.warnings } : {}),
    // The window channel's own warning: present only when the derivation
    // was skipped over an unparseable operator env value (M4), so a
    // normal answer stays byte-identical.
    ...(windowWarning !== undefined ? { window_warning: windowWarning } : {}),
    ...(pack.receiptId ? { receipt_id: pack.receiptId } : {}),
    ...(pack.telemetryId ? { telemetry_id: pack.telemetryId } : {}),
    items: pack.items.map((i) => ({
      id: i.id,
      principle: i.principle,
      trimmed: i.trimmed,
      ...(i.safety ? { safety: i.safety } : {}),
    })),
  };
}

export async function toolBrainPreCompactExtract(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sessionId = requiredStringArg("brain_pre_compact_extract", args, "session_id");
  const turnStart = requiredStringArg("brain_pre_compact_extract", args, "turn_start");
  const turnEnd = requiredStringArg("brain_pre_compact_extract", args, "turn_end");
  const text = requiredStringArg("brain_pre_compact_extract", args, "text");
  const maxChars = coercePositiveInteger(
    "brain_pre_compact_extract",
    "max_chars",
    args["max_chars"],
  );
  const result = extractPreCompactRecords(ctx.vault, {
    sessionId,
    turnStart,
    turnEnd,
    text,
    ...(optionalStringArg("brain_pre_compact_extract", args, "host") !== undefined
      ? { host: optionalStringArg("brain_pre_compact_extract", args, "host") }
      : {}),
    ...(maxChars !== undefined ? { maxChars } : {}),
    ...(coerceBool(args, "interrupted") === true ? { interrupted: true } : {}),
    ...(coerceBool(args, "dry_run") === true ? { dryRun: true } : {}),
  });
  return { count: result.records.length, dry_run: coerceBool(args, "dry_run") === true, ...result };
}

// ----- session recall DAG --------------------------------------------------

export async function toolBrainAnticipatoryContext(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sessionId = coerceStr(args, "session_id");
  if (sessionId === null || sessionId === undefined || sessionId.trim() === "") {
    throw new MCPError(INVALID_PARAMS, "'session_id' is required");
  }
  let ttlSeconds: number | undefined;
  let maxTokens: number | undefined;
  try {
    const anticipatory = loadBrainConfig(ctx.vault).anticipatory;
    ttlSeconds = anticipatory?.ttl_seconds;
    maxTokens = anticipatory?.max_tokens;
  } catch {
    // defaults apply; a broken config never blocks a read
  }
  const anticipatoryScope = coerceAgentScope(ctx, args, true);
  const now = new Date();
  // Below local reach the bundle is built for this caller with the same
  // candidate filter `brain_context_pack` applies, and the shared cache is
  // neither read nor written: a cached bundle may hold pages this caller
  // cannot read, and a filtered bundle must not replace the operator's.
  const view = reachView(ctx.vault, contextReach(ctx));
  const remote = view.reach !== TRANSPORT_REACH.local;
  if (remote) {
    // A refresh takes the caller's signal exactly as the cached path does;
    // a plain read has no cached signal to reuse here.
    const signal = coerceBool(args, "refresh") === true ? coerceStr(args, "signal_text") : null;
    const result = buildReaderAnticipatoryContext(ctx.vault, {
      sessionId,
      now,
      visible: (abs: string) => view.visible(vaultRelative(ctx.vault, abs)),
      ...(anticipatoryScope !== undefined ? { agentScope: anticipatoryScope } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(typeof signal === "string" ? { signalText: signal } : {}),
    });
    return anticipatoryAnswer(result);
  }
  if (coerceBool(args, "refresh") === true) {
    const signal = coerceStr(args, "signal_text");
    refreshAnticipatoryCache(ctx.vault, {
      sessionId,
      ...(anticipatoryScope !== undefined ? { agentScope: anticipatoryScope } : {}),
      ...(typeof signal === "string" && signal.trim() !== "" ? { signalText: signal } : {}),
      now,
      ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    });
  }
  const result = readAnticipatoryContext(ctx.vault, {
    sessionId,
    now,
    ...(anticipatoryScope !== undefined ? { agentScope: anticipatoryScope } : {}),
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  });
  return anticipatoryAnswer(result);
}

export function anticipatoryAnswer(result: ReadAnticipatoryContextResult): Record<string, unknown> {
  return {
    cache_state: result.cache_state,
    root_session_id: result.root_session_id,
    ...(result.generated_at !== undefined ? { generated_at: result.generated_at } : {}),
    // Present only when a fresh-by-the-clock entry was refused on its
    // provenance stamp or validity window, so an ordinary miss stays
    // byte-identical (context-integrity-gates, Unit B).
    ...(result.cache_refusal !== undefined ? { cache_refusal: result.cache_refusal } : {}),
    items: result.context.items.map((item) => ({
      id: item.id,
      tier: item.tier,
      tokens: item.tokens,
      principle: item.principle,
      body: item.body,
    })),
    session_hits: result.context.session_hits,
  };
}
