/**
 * Brain write surface: taste signals, the dream learning pass, apply-evidence records, and narrative notes.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { resolve } from "node:path";
import { resolveAgentName } from "../../core/config.ts";
import {
  appendApplyEvidence,
  BrainPreferenceNotFoundError,
  type AppendApplyEvidenceInput,
} from "../../core/brain/apply-evidence.ts";
import { dream } from "../../core/brain/dream.ts";
import {
  applyDreamBundle,
  discardDreamBundle,
  listDreamBundles,
  stageDream,
  validateDreamBundle,
} from "../../core/brain/dream-stage.ts";
import { BRAIN_ROLES } from "../../core/brain/trust/role.ts";
import { resolveEffectiveScope, writeSignal } from "../../core/brain/signal.ts";
import { loadFeedbackDefaultScopeSafe } from "../../core/brain/policy.ts";
import { writePreference } from "../../core/brain/preference.ts";
import { validateBrainFeedbackInput } from "../../core/brain/sessions/validate-feedback.ts";
import { isoDate, isoSecond } from "../../core/brain/time.ts";
import { slugify } from "../../core/vault.ts";
import { normalizeAgentArgument } from "../../core/agent-identity.ts";
import {
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_APPLY_RESULT,
  type BrainApplyResult,
  type BrainSignalSign,
} from "../../core/brain/types.ts";
import { appendLogEvent } from "../../core/brain/log.ts";
import { appendBrainNote } from "../../core/brain/note.ts";
import { mirrorSignal, resolveSharedNamespace } from "../../core/brain/shared-namespace.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tools.ts";
import { coerceStr, coerceBool, coerceIsoDate } from "../coerce.ts";
import { vaultRelativeSafe } from "./shared.ts";

/**
 * Build the slug used in the signal / preference filename. We never let
 * the agent decide the slug directly — taking `topic` as the slug stem
 * is what the design doc §9.2 prescribes (slugs are deterministic from
 * topic). The slug is run through `slugify` defensively so a slightly
 * mis-shaped topic still yields a filesystem-safe basename.
 */
function deriveSlug(topic: string): string {
  return slugify(topic);
}

async function toolBrainFeedback(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Single source of truth for the brain_feedback payload contract —
  // session-replay (sessions/import.ts) and the MCP live path now go
  // through the same validator so rule shape cannot drift between the
  // two surfaces.
  const validated = validateBrainFeedbackInput(args);
  if (!validated.ok) {
    throw new MCPError(INVALID_PARAMS, validated.reason);
  }
  const {
    topic,
    signal: signalRaw,
    principle,
    scope,
    raw,
    source,
    force_confirmed,
  } = validated.value;
  const forceConfirmed = force_confirmed ?? false;

  // Agent-fallback stays MCP-side: validator just hands back the user-
  // supplied value (or undefined); the live path resolves via config
  // when absent.
  const agent =
    normalizeAgentArgument(validated.value.agent ?? null) ??
    resolveAgentName(ctx.configPath ?? undefined);
  // Per-row event-time (A2 / t_7526e8d3): an optional caller-supplied
  // `event_time` lets a backfilled / imported "remember" carry when it
  // actually happened instead of the wall-clock. When present and valid,
  // it drives the signal's `created_at` / filename day and the
  // bi-temporal `valid_from` / `recorded_at` slots. The audit log and any
  // force-confirmed preference stay stamped at the real write moment
  // (`now`) so the audit chronology is not rewritten. Absent →
  // byte-identical to the historical wall-clock path.
  const eventTime = coerceIsoDate(args, "event_time");
  const now = new Date();
  const createdAt = isoSecond(now);
  const signalStamp = eventTime ?? now;
  const signalCreatedAt = isoSecond(signalStamp);
  const signalDate = isoDate(signalStamp);
  const slug = deriveSlug(topic);

  // Vault-configured fallback scope (`feedback.default_scope`). Applied
  // only when the call passes no explicit scope. Compute one effective
  // scope so the signal, its mirror, and any force-confirmed preference
  // all land on the same scope.
  const defaultScope = loadFeedbackDefaultScopeSafe(ctx.vault);
  const effectiveScope = resolveEffectiveScope(scope, defaultScope);
  const writeOpts = defaultScope !== undefined ? { defaultScope } : {};

  // 1. Always write the signal to inbox/. Mirrors the CLI handler so the
  //    audit trail in `Brain/log/` and `inbox/processed/` stays consistent
  //    across CLI and MCP entry points. `--force-confirmed` ADDITIONALLY
  //    creates a confirmed pref below.
  const signalInput = {
    topic,
    signal: signalRaw as BrainSignalSign,
    agent,
    principle,
    created_at: signalCreatedAt,
    date: signalDate,
    slug,
    ...(scope ? { scope } : {}),
    ...(source && source.length > 0 ? { source: [...source] } : {}),
    ...(raw ? { raw } : {}),
    // Stamp the bi-temporal slots only when an explicit event_time was
    // supplied, so a live "remember" stays byte-identical.
    ...(eventTime ? { valid_from: signalCreatedAt, recorded_at: signalCreatedAt } : {}),
  };
  const sigResult = writeSignal(ctx.vault, signalInput, writeOpts);
  // t_936a1a61: fail-soft mirror into the shared namespace AFTER the
  // primary write; `mirror` is reported only when the key is configured.
  const sharedNamespace = resolveSharedNamespace(ctx.configPath);
  const mirror =
    sharedNamespace === null
      ? undefined
      : mirrorSignal(sharedNamespace, ctx.vault, signalInput, writeOpts);

  try {
    appendLogEvent(ctx.vault, {
      timestamp: createdAt,
      eventType: BRAIN_LOG_EVENT_KIND.feedback,
      body: {
        signal: `[[${sigResult.id}]]`,
        topic: topic.trim(),
        sign: signalRaw,
        agent,
      },
    });
  } catch (err) {
    process.stderr.write(`warning: append feedback log failed: ${(err as Error).message}\n`);
  }

  let prefResult: { path: string; id: string } | null = null;
  if (forceConfirmed) {
    // Escape hatch: skip the dream pass and create the confirmed rule now.
    // `confirmed_at` is now; `unconfirmed_until` is also now so the trial
    // window collapses on inspection. The just-written signal is recorded
    // as the rule's origin under `evidenced_by`.
    prefResult = writePreference(ctx.vault, {
      slug,
      topic: topic.trim(),
      principle: principle.trim(),
      created_at: createdAt,
      unconfirmed_until: createdAt,
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: [`[[${sigResult.id}]]`],
      confirmed_at: createdAt,
      ...(effectiveScope !== undefined ? { scope: effectiveScope } : {}),
    });
    try {
      // Offset by 1s so the force-confirmed event sorts after the feedback
      // event on the same UTC second (parseLogDay is stable on ties, but a
      // visible chronology reads cleaner).
      appendLogEvent(ctx.vault, {
        timestamp: isoSecond(new Date(now.getTime() + 1000)),
        eventType: BRAIN_LOG_EVENT_KIND.forceConfirmed,
        body: {
          preference: `[[${prefResult.id}]]`,
          agent,
        },
      });
    } catch (err) {
      process.stderr.write(
        `warning: append force-confirmed log failed: ${(err as Error).message}\n`,
      );
    }
  }

  return {
    kind: prefResult ? "preference" : "signal",
    ...(mirror !== undefined ? { mirror } : {}),
    signal_path: vaultRelativeSafe(ctx.vault, sigResult.path),
    signal_absolute_path: resolve(sigResult.path),
    signal_id: sigResult.id,
    ...(prefResult
      ? {
          preference_path: vaultRelativeSafe(ctx.vault, prefResult.path),
          preference_absolute_path: resolve(prefResult.path),
          preference_id: prefResult.id,
          // Back-compat: top-level `path`/`id` previously pointed at the
          // pref on the force-confirmed branch. Keep them aligned for
          // callers that look at the bare fields.
          path: vaultRelativeSafe(ctx.vault, prefResult.path),
          absolute_path: resolve(prefResult.path),
          id: prefResult.id,
        }
      : {
          path: vaultRelativeSafe(ctx.vault, sigResult.path),
          absolute_path: resolve(sigResult.path),
          id: sigResult.id,
        }),
    agent,
  };
}

// ----- brain_dream ---------------------------------------------------------

async function toolBrainDream(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const action = args["action"] ?? "run";
  if (
    action !== "run" &&
    action !== "stage" &&
    action !== "validate" &&
    action !== "apply" &&
    action !== "discard" &&
    action !== "list"
  ) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_dream: action must be run|stage|validate|apply|discard|list",
    );
  }
  const dryRun = coerceBool(args, "dry_run");
  const nowDate = coerceIsoDate(args, "now");
  const agentArg = coerceStr(args, "agent", false);
  const agent = normalizeAgentArgument(agentArg) ?? resolveAgentName(ctx.configPath ?? undefined);

  if (action !== "run") {
    // Staged lifecycle (t_ae8a8ec0): stage -> validate -> apply over a
    // persisted bundle; dream() stays the only promotion engine.
    const runIdArg = coerceStr(args, "run_id", false);
    if ((action === "validate" || action === "apply" || action === "discard") && !runIdArg) {
      throw new MCPError(INVALID_PARAMS, `brain_dream action=${action}: run_id is required`);
    }
    const now = nowDate ?? new Date();
    const stageOpts = { now, ...(agent ? { agentName: agent } : {}) };
    switch (action) {
      case "stage": {
        const bundle = stageDream(ctx.vault, stageOpts);
        return {
          action,
          run_id: bundle.runId,
          plan: bundle.plan,
          sources: bundle.sources.length,
          dir: `Brain/dream/staged/${bundle.runId}`,
        };
      }
      case "validate": {
        const verdict = validateDreamBundle(ctx.vault, runIdArg!, stageOpts);
        return { action, run_id: runIdArg, valid: verdict.valid, drift: [...verdict.drift] };
      }
      case "apply": {
        const outcome = applyDreamBundle(ctx.vault, runIdArg!, stageOpts);
        return {
          action,
          run_id: runIdArg,
          applied: outcome.applied,
          drift: [...outcome.validation.drift],
          ...(outcome.summary !== undefined
            ? {
                changed: outcome.summary.changed,
                new_unconfirmed: [...outcome.summary.new_unconfirmed],
                confirmed: [...outcome.summary.confirmed],
                retired: outcome.summary.retired.map((r) => ({ id: r.id, reason: r.reason })),
              }
            : {}),
        };
      }
      case "discard": {
        return { action, run_id: runIdArg, removed: discardDreamBundle(ctx.vault, runIdArg!) };
      }
      default: {
        return {
          action,
          bundles: listDreamBundles(ctx.vault).map((b) => ({
            run_id: b.runId,
            status: b.status,
            staged_at: b.stagedAt,
            proposals: b.proposals,
            sources: b.sources,
          })),
        };
      }
    }
  }

  const summary = dream(ctx.vault, {
    dryRun,
    ...(nowDate ? { now: nowDate } : {}),
    ...(agent ? { agentName: agent } : {}),
  });

  // The summary is already a Plain Old Frozen Object — JSON-serialise
  // verbatim. We surface `snapshot_path` / `log_path` as vault-relative
  // for caller convenience while preserving the absolute path as well.
  return {
    run_id: summary.run_id,
    changed: summary.changed,
    dry_run: dryRun,
    new_unconfirmed: [...summary.new_unconfirmed],
    confirmed: [...summary.confirmed],
    retired: summary.retired.map((r) => ({ id: r.id, reason: r.reason })),
    contradictions: [...summary.contradictions],
    moved_to_processed: [...summary.moved_to_processed],
    suppressed: [...summary.suppressed],
    warnings: summary.warnings.map((w) => ({
      code: w.code,
      message: w.message,
    })),
    uncertain: summary.uncertain.map((u) => ({
      code: u.code,
      ...(u.topic !== undefined ? { topic: u.topic } : {}),
      message: u.message,
    })),
    quarantined: summary.quarantined.map((q) => ({
      topic: q.topic,
      signal_count: q.signal_count,
      distinct_agents: q.distinct_agents,
      age_days: q.age_days,
      failed_gates: [...q.failed_gates],
    })),
    snapshot_path: summary.snapshot_path
      ? vaultRelativeSafe(ctx.vault, summary.snapshot_path)
      : null,
    log_path: summary.log_path ? vaultRelativeSafe(ctx.vault, summary.log_path) : null,
  };
}

// ----- brain_review_candidates --------------------------------------------

async function toolBrainApplyEvidence(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const prefId = coerceStr(args, "pref_id", true)!;
  const artifact = coerceStr(args, "artifact", true)!;
  const resultRaw = coerceStr(args, "result", true)!;
  if (
    resultRaw !== BRAIN_APPLY_RESULT.applied &&
    resultRaw !== BRAIN_APPLY_RESULT.violated &&
    resultRaw !== BRAIN_APPLY_RESULT.outdated
  ) {
    throw new MCPError(
      INVALID_PARAMS,
      `argument 'result' must be 'applied', 'violated', or 'outdated'`,
    );
  }
  const agentArg = coerceStr(args, "agent", false);
  const note = coerceStr(args, "note", false);
  const outcomeRaw = coerceStr(args, "outcome", false);
  if (
    outcomeRaw !== null &&
    outcomeRaw !== "success" &&
    outcomeRaw !== "failure" &&
    outcomeRaw !== "unknown"
  ) {
    throw new MCPError(
      INVALID_PARAMS,
      `argument 'outcome' must be 'success', 'failure', or 'unknown'`,
    );
  }

  const agent = normalizeAgentArgument(agentArg) ?? resolveAgentName(ctx.configPath ?? undefined);

  const input: AppendApplyEvidenceInput = {
    pref_id: prefId,
    artifact,
    result: resultRaw as BrainApplyResult,
    agent,
    ...(outcomeRaw !== null ? { outcome: outcomeRaw } : {}),
    ...(note ? { note } : {}),
  };

  // Surface BrainPreferenceNotFoundError as a tool-level error envelope
  // (isError: true) rather than an MCP protocol error. The design doc
  // says "not an error condition" — the agent should see an informative
  // payload that explains what to do next, not a JSON-RPC error frame.
  // v0.10.16: assert applier role at the MCP boundary so the structural
  // permission gate fires before any I/O.
  try {
    const res = appendApplyEvidence(ctx.vault, input, {
      role: BRAIN_ROLES.applier,
    });
    return {
      logged_at: res.logged_at,
      log_path: vaultRelativeSafe(ctx.vault, res.log_path),
      absolute_log_path: resolve(res.log_path),
      agent,
    };
  } catch (exc) {
    if (exc instanceof BrainPreferenceNotFoundError) {
      // Re-throw as a non-MCPError so `server.handleToolsCall` packs it
      // into a `toolError` envelope (isError: true, single-text content).
      throw new Error(exc.message, { cause: exc });
    }
    throw exc;
  }
}

// ----- brain_note (§32B, v0.10.8) ------------------------------------------

/**
 * Append one narrative-milestone line to today's Brain log. Agents
 * record release / merged-PR / discovered-fact lines under the `note`
 * event kind in `Brain/log/<today>.md` (and the JSONL sidecar).
 *
 * The body lives in `appendBrainNote` so the CLI verb (`o2b brain
 * note`) and this MCP handler share one code path. Validation errors
 * land in MCP's `INVALID_PARAMS` envelope here; the CLI wrapper
 * pre-validates usage shape and surfaces the same condition as exit 2.
 */
async function toolBrainNote(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rawText = coerceStr(args, "text", true)!;
  const agentArg = coerceStr(args, "agent", false);

  let res;
  try {
    res = appendBrainNote({
      vault: ctx.vault,
      text: rawText,
      ...(agentArg ? { agent: agentArg } : {}),
      ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
    });
  } catch (err) {
    // `appendBrainNote` throws one validation error ("text is required");
    // any other failure is an I/O / filesystem fault from `appendLogEvent`
    // and must not be reported as a client-side INVALID_PARAMS.
    const message = (err as Error).message ?? String(err);
    const code = message.startsWith("brain_note:") ? INVALID_PARAMS : INTERNAL_ERROR;
    throw new MCPError(code, message);
  }
  return {
    logged_at: res.logged_at,
    log_path: res.log_path,
    absolute_log_path: res.absolute_log_path,
    agent: res.agent,
  };
}

// ----- brain_write_session (Agent Write Contract Suite, v0.41.0) ------------

export const FEEDBACK_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_feedback",
    description:
      "Record one Brain taste signal in `Brain/inbox/sig-*.md`. With `force_confirmed: true`, create the preference directly (skips the dream trial window).",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Stable kebab-slug for the rule, e.g. `no-internal-abbrev`.",
        },
        signal: {
          type: "string",
          enum: ["positive", "negative"],
          description:
            "`positive` when the principle is the rule to follow, `negative` when it's what to avoid.",
        },
        principle: {
          type: "string",
          description: "One-line, agent-readable formulation of the rule (imperative voice).",
        },
        scope: {
          type: "string",
          description:
            "Optional soft category for later application-scope matching, e.g. `writing`, `coding`.",
        },
        source: {
          type: "array",
          items: { type: "string" },
          description: "Optional wikilinks to the artifacts or notes that triggered the signal.",
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
        raw: {
          type: "string",
          description: "Optional free-form raw quote (rendered under `## Raw` in the signal file).",
        },
        force_confirmed: {
          type: "boolean",
          description:
            "When true, also creates an immediately-active confirmed `pref-*` alongside the inbox signal, skipping the dream-pass promotion step.",
        },
        event_time: {
          type: "string",
          description:
            "Optional ISO-8601 event-time for a backfilled signal (when it actually happened). Stamps `created_at`/`valid_from`/`recorded_at`; absent uses wall-clock.",
        },
      },
      required: ["topic", "signal", "principle"],
      additionalProperties: false,
    },
    handler: toolBrainFeedback,
  },
  {
    name: "brain_dream",
    description:
      "Deterministic learning pass over `Brain/inbox/`. action=run (default) promotes inline; the staged lifecycle persists a reviewable bundle: stage -> validate -> apply (or discard), plus list. Typically scheduled via cron.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["run", "stage", "validate", "apply", "discard", "list"],
          description:
            "run executes inline; stage persists a proposal bundle; validate/apply/discard manage one bundle by run_id; list shows bundles.",
        },
        run_id: {
          type: "string",
          description: "Bundle id for validate/apply/discard (from action=stage or list).",
        },
        dry_run: {
          type: "boolean",
          description: "action=run only: compute the plan without writing any files.",
        },
        now: {
          type: "string",
          description:
            "Optional ISO-8601 timestamp used as the wall clock for the run (testing / replay).",
        },
        agent: {
          type: "string",
          description:
            "Optional caller identity; a mismatch with the configured primary agent emits a warning. Defaults to the server-resolved name.",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainDream,
  },
  {
    name: "brain_apply_evidence",
    description:
      "Record whether an active preference was applied, violated, or marked outdated against a freshly-produced durable artifact. Appends one event to `Brain/log/<today>.md`. A single `outdated` event triggers retire on the next dream pass.",
    inputSchema: {
      type: "object",
      properties: {
        pref_id: {
          type: "string",
          description: "Preference id (`pref-<slug>` or bare `<slug>`).",
        },
        artifact: {
          type: "string",
          description:
            "Wikilink identifying the artifact; optional inclusive line-range suffix, e.g. `[[src/cli/main.ts:120-145]]`.",
        },
        result: {
          type: "string",
          enum: ["applied", "violated", "outdated"],
          description:
            "`applied` if the rule held, `violated` if broken, `outdated` if the artifact shows the rule itself is obsolete.",
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
        outcome: {
          type: "string",
          enum: ["success", "failure", "unknown"],
          description:
            "Optional downstream outcome of the artifact (t_d478df53): did the work the rule was applied to actually succeed? `unknown` is treated like an absent outcome.",
        },
        note: {
          type: "string",
          description: "Optional one-line context.",
        },
      },
      required: ["pref_id", "artifact", "result"],
      additionalProperties: false,
    },
    handler: toolBrainApplyEvidence,
  },
  {
    name: "brain_note",
    description:
      "Append one narrative-milestone line (release shipped, PR merged, fact discovered) to today's Brain log under the `note` event kind. Use when neither brain_feedback nor brain_apply_evidence fits.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "One-line narrative description. Newlines collapse to single spaces; the shared redactor strips secret-shaped tokens.",
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    handler: toolBrainNote,
  },
]);
