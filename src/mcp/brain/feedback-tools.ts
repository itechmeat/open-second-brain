/**
 * Brain write surface: taste signals, the dream learning pass, apply-evidence records, and narrative notes.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { DREAM_GATE_NAMES } from "../../core/brain/dream-gates.ts";
import { DREAM_STEP_RUNNABLE } from "../../core/brain/dream-step.ts";
import { EXPIRATION_CLEAR } from "../../core/brain/expiration-set.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { type ToolDefinition } from "../tool-contract.ts";
import { toolBrainFeedback } from "./feedback-tool.ts";
import { toolBrainDream } from "./dream-tools.ts";
import { toolBrainApplyEvidence, toolBrainNote, toolBrainObservedUse } from "./evidence-tools.ts";
import { EXPIRE_TOOL, toolBrainExpire } from "./expire-tools.ts";

/**
 * The registered exit the force-confirmed refusal names (write-side
 * trust, Task 12). Resolved at module scope on the write-binding
 * precedent: an unregistered code is registry drift and fails at import
 * rather than inside the refusal it was meant to explain.
 */

export const FEEDBACK_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_feedback",
    kind: "write",
    description:
      "Record one Brain taste signal in the signal inbox. With `force_confirmed: true`, create the preference directly (skips the dream trial window).",
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
        idempotency_key: {
          type: "string",
          description:
            "Optional client key that dedupes retried calls: same key + same payload is a no-op; same key + different payload is rejected.",
        },
        expires: {
          type: "string",
          description:
            "Optional YYYY-MM-DD or ISO-8601 lifetime. Past it the signal (and any force-confirmed preference) drops out of default reads; the file is never deleted.",
        },
      },
      required: ["topic", "signal", "principle"],
      additionalProperties: false,
    },
    handler: toolBrainFeedback,
  },
  {
    name: "brain_dream",
    kind: "write",
    description:
      "Deterministic learning pass over the signal inbox. action=run (default) promotes inline; the staged lifecycle persists a reviewable bundle: stage -> validate -> apply (or discard), plus list and retriage. Typically scheduled via cron.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["run", "stage", "validate", "apply", "retriage", "discard", "list"],
          description:
            "run executes inline; stage persists a bundle; validate/apply/discard manage one by run_id; retriage re-scores a bundle's salience gate; list shows bundles.",
        },
        run_id: {
          type: "string",
          description: "Bundle id for validate/apply/retriage/discard (from action=stage or list).",
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
        expect: {
          type: "integer",
          minimum: 0,
          description:
            "action=run count guard: assert the pass will create/confirm/retire/move exactly N preferences. On mismatch it aborts without writing.",
        },
        strict: {
          type: "boolean",
          description: "action=run: refuse a guardless run (no `expect`). Default false.",
        },
        step: {
          // Deliberately NOT an enum. A closed schema would reject a
          // non-runnable step with a generic validation error, losing the
          // specific reason `DreamStepNotRunnableError` carries - which
          // is the whole deliverable for the steps that are refused.
          type: "string",
          description:
            `action=run: run ONE step (${DREAM_STEP_RUNNABLE.join(", ")}) and return a partial ` +
            `result, not a run summary. Any other token is refused with the reason it cannot run alone.`,
        },
        gates: {
          type: "object",
          description:
            `action=run: override a phase gate for THIS RUN ONLY, never written back to ` +
            `the brain settings. Known gates: ${DREAM_GATE_NAMES.join(", ")}.`,
          properties: {
            heal_enrich: {
              type: "boolean",
              description:
                "Overrides dream.heal_enrich_enabled for this run. Omitted: the configured value decides.",
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainDream,
  },
  {
    name: "brain_apply_evidence",
    kind: "write",
    description:
      "Record whether an active preference was applied, violated, or marked outdated against a freshly-produced durable artifact. Appends one event to today's brain log. A single `outdated` event triggers retire on the next dream pass.",
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
    kind: "write",
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
  {
    name: "brain_observed_use",
    kind: "write",
    description:
      "Record session-end observed-use verdicts (USED/IGNORED/CONTRADICTED) per injected memory. The host supplies structured verdicts; the kernel stores and aggregates them into the observed-reuse recall-ranking signal (no LLM).",
    inputSchema: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          description: "One verdict per injected memory.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Injected memory id (e.g. docId:chunkId)." },
              path: { type: "string", description: "Vault-relative path when known." },
              verdict: {
                type: "string",
                enum: ["USED", "IGNORED", "CONTRADICTED"],
                description: "Observed use of this memory in the session.",
              },
            },
            required: ["id", "verdict"],
            additionalProperties: false,
          },
        },
        host: { type: "string", description: "Host label; defaults to 'mcp'." },
        session_id: { type: "string", description: "Correlation id for the session." },
        turn_id: { type: "string", description: "Correlation id for the prompt-submit turn." },
      },
      required: ["entries"],
      additionalProperties: false,
    },
    handler: toolBrainObservedUse,
  },
  {
    name: EXPIRE_TOOL,
    kind: "write",
    description:
      "Set, change or clear the expiration_date of one signal or preference, by id. An expired memory is filtered out of default reads and never deleted or moved. Clearing is the explicit word 'none'.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Artifact id: sig-<date>-<slug>, pref-<slug> or ret-<slug>. Never a path - this surface does not accept one.",
        },
        expires: {
          type: "string",
          description: `YYYY-MM-DD, an ISO-8601 timestamp, or '${EXPIRATION_CLEAR}' to clear. An unparseable value is refused before any write.`,
        },
        agent: {
          type: "string",
          description: "Optional agent identity stamped on the audit event.",
        },
      },
      required: ["id", "expires"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainExpire,
  },
]);
