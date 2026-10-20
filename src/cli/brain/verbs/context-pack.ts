/**
 * `o2b brain context-pack` - return the highest-tier, most recent
 * vault slice that fits under a caller-specified token budget.
 * Intended for agents priming a context window without manual page
 * curation. `--query <q>` adds a case/Unicode-insensitive substring
 * filter on topic + principle.
 *
 * `--max-tokens` is optional (t_a567cc12): when it is omitted, the
 * budget derives from the model context window the shared resolver
 * resolves - the vault's `context:` block, the environment override, or
 * `--model`, in that precedence - through the matching preset. A
 * hint-matching id budgets from its preset hint, the same mapping
 * `brain context-presets suggest` answers. An id nothing published
 * places - no table row, no `1m` suffix, no hint - is refused: pass
 * `--max-tokens` or set `context.window_tokens`. With nothing resolvable
 * the verb refuses exactly as it always has: never a silent default
 * budget.
 */

import {
  presetForResolvedWindow,
  unrecognisedModelBudgetRefusal,
} from "../../../core/brain/context-presets.ts";
import {
  resolveModelContextWindowTokens,
  type ModelWindowSource,
} from "../../../core/brain/model-window.ts";
import { resolveModelContextWindowEnvTokens } from "../../../core/config.ts";
import { packContext } from "../../../core/brain/context-pack.ts";
import { loadBrainConfig } from "../../../core/brain/policy.ts";
import { RECALL_CHANNEL } from "../../../core/brain/recall-telemetry.ts";
import { brainVerbContext, fail, okJson, parse } from "../helpers.ts";

export async function cmdBrainContextPack(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "max-tokens": { type: "string" },
    model: { type: "string" },
    query: { type: "string" },
    lanes: { type: "boolean" },
    receipt: { type: "boolean" },
    "receipt-host": { type: "string" },
    telemetry: { type: "boolean" },
    "telemetry-host": { type: "string" },
    "session-id": { type: "string" },
    "turn-id": { type: "string" },
    "cache-stable": { type: "boolean" },
    "dedup-repeated": { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);

  const model = trimOrUndefined(flags["model"]);
  const maxTokensRaw = trimOrUndefined(flags["max-tokens"]);
  let maxTokens: number;
  let maxTokensSource: ModelWindowSource | undefined;
  if (maxTokensRaw !== undefined) {
    // Strict integer parsing - `Number()` rejects partial numeric
    // strings like "12abc" that `parseInt` would silently accept.
    maxTokens = Number(maxTokensRaw);
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      return fail(
        `brain context-pack: --max-tokens must be a positive integer; got ${maxTokensRaw}`,
      );
    }
  } else {
    // Derivation path (t_a567cc12). The vault channel is fail-soft: a
    // broken `_brain.yaml` raises later, inside `packContext`, exactly as
    // it always has. A malformed env value refuses here under its own
    // name - an operator typo must not silently shrink the budget to the
    // default.
    const operatorWindow = contextWindowConfigValue(vault);
    let envWindow: number | undefined;
    try {
      envWindow = resolveModelContextWindowEnvTokens();
    } catch (exc) {
      return fail(`brain context-pack: ${(exc as Error).message}`);
    }
    if (model === undefined && operatorWindow === undefined && envWindow === undefined) {
      return fail("brain context-pack: --max-tokens <n> is required");
    }
    const resolved = resolveModelContextWindowTokens({
      ...(model !== undefined ? { model } : {}),
      ...(operatorWindow !== undefined ? { operatorWindowTokens: operatorWindow } : {}),
      ...(envWindow !== undefined ? { envWindowTokens: envWindow } : {}),
    });
    // The hint fallback rides along exactly when the resolver's answer is
    // the default-sourced assumption, so a hint-only model budgets the
    // preset `brain context-presets suggest` names for it; the source
    // printed below stays the window's. An id NOTHING places - no table
    // row, no suffix, no hint - refuses instead: the conservative posture
    // this verb held before derivation existed, never the default
    // window's long-context budget an 8k local model cannot hold.
    const refusal = unrecognisedModelBudgetRefusal(model, resolved);
    if (refusal !== null) return fail(`brain context-pack: ${refusal}`);
    maxTokens = presetForResolvedWindow(model, resolved).context_pack.max_tokens;
    maxTokensSource = resolved.source;
  }

  // `packContext` reads the guardrail block and raises on a `_brain.yaml`
  // the operator wrote and broke. Without this boundary that raise left
  // the verb as a stack trace naming this repo's files instead of theirs;
  // every sibling verb on the same path already reports
  // `<verb> failed: <cause>`.
  let report;
  try {
    report = packContext(vault, {
      maxTokens,
      ...(flags["query"] ? { query: flags["query"] as string } : {}),
      ...(flags["lanes"] === true ? { includeLanes: true } : {}),
      ...(flags["receipt"] === true
        ? {
            receipt: {
              host: trimOrDefault(flags["receipt-host"], "cli"),
              trigger: "context_pack" as const,
              ...(trimOrUndefined(flags["session-id"]) !== undefined
                ? { sessionId: trimOrUndefined(flags["session-id"]) }
                : {}),
              ...(trimOrUndefined(flags["turn-id"]) !== undefined
                ? { turnId: trimOrUndefined(flags["turn-id"]) }
                : {}),
            },
          }
        : {}),
      ...(flags["cache-stable"] === true || flags["dedup-repeated"] === true
        ? {
            transforms: {
              ...(flags["cache-stable"] === true ? { cacheStableOrdering: true } : {}),
              ...(flags["dedup-repeated"] === true ? { deduplicateRepeatedContext: true } : {}),
            },
          }
        : {}),
      ...(flags["telemetry"] === true
        ? {
            telemetry: {
              host: trimOrDefault(flags["telemetry-host"], RECALL_CHANNEL.cli),
              channel: RECALL_CHANNEL.cli,
              ...(trimOrUndefined(flags["session-id"]) !== undefined
                ? { sessionId: trimOrUndefined(flags["session-id"]) }
                : {}),
              ...(trimOrUndefined(flags["turn-id"]) !== undefined
                ? { turnId: trimOrUndefined(flags["turn-id"]) }
                : {}),
            },
          }
        : {}),
    });
  } catch (exc) {
    return fail(`context-pack failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    okJson({
      max_tokens: report.maxTokens,
      ...(maxTokensSource !== undefined ? { max_tokens_source: maxTokensSource } : {}),
      tokens_used: report.tokensUsed,
      items: report.items.map((i) => ({
        id: i.id,
        path: i.path,
        tier: i.tier,
        tokens: i.tokens,
        epistemic: i.epistemic,
        ...(i.evidenceRefs.length > 0 ? { evidence_refs: i.evidenceRefs } : {}),
        ...(i.originalRank !== undefined ? { original_rank: i.originalRank } : {}),
        ...(i.stableRank !== undefined ? { stable_rank: i.stableRank } : {}),
        ...(i.dedupedFrom !== undefined ? { deduped_from: i.dedupedFrom } : {}),
        ...(i.referenceHint !== undefined ? { reference_hint: i.referenceHint } : {}),
      })),
      skipped: report.skipped,
      ...(report.receiptId ? { receipt_id: report.receiptId } : {}),
      ...(report.telemetryId ? { telemetry_id: report.telemetryId } : {}),
      ...(report.lanes ? { lanes: report.lanes } : {}),
    });
    return 0;
  }

  process.stdout.write(`tokens used: ${report.tokensUsed} / ${report.maxTokens}\n`);
  if (maxTokensSource !== undefined) {
    process.stdout.write(`budget source: ${maxTokensSource}\n`);
  }
  process.stdout.write(`pages included: ${report.items.length}\n`);
  process.stdout.write(`pages skipped: ${report.skipped.length}\n\n`);
  if (report.receiptId) process.stdout.write(`receipt: ${report.receiptId}\n`);
  for (const i of report.items) {
    process.stdout.write(`[${i.tier}] ${i.epistemic} ${i.id} (${i.tokens} tokens)\n`);
  }
  return 0;
}

/**
 * The vault's declared `context.window_tokens`; `undefined` when the
 * block is absent or the file cannot be read. Fail-soft on purpose: a
 * broken `_brain.yaml` raises later, inside `packContext`, exactly as it
 * always has.
 */
function contextWindowConfigValue(vault: string): number | undefined {
  try {
    return loadBrainConfig(vault).context?.window_tokens;
  } catch {
    return undefined;
  }
}

function trimOrDefault(value: string | boolean | string[] | undefined, fallback: string): string {
  return trimOrUndefined(value) ?? fallback;
}

function trimOrUndefined(value: string | boolean | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
