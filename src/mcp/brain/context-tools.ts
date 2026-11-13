/**
 * Context assembly: write sessions, pinned scratchpad, session bootstrap, context packing, receipts, presets, and pre-compress/pre-compact surfaces.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { SCOPED_RULE_AXES } from "../../core/brain/scoped-rules.ts";
import { CURSOR_SCHEMA } from "./pagination.ts";
import { type ToolDefinition } from "../tool-contract.ts";
import { VAULT_PATH_OUTPUT_SCHEMA } from "../vault-path-field.ts";
import { toolBrainWriteSession } from "./context-session-tools.ts";
import { toolBrainPinnedContext } from "./context-pinned-tools.ts";
import { toolBrainContext } from "./context-active-tools.ts";

/**
 * One agent-facing surface for the write-session kernel: `op`
 * discriminates the lifecycle operation, `kind` (open only) picks
 * artifact vs panel. Envelopes are the same JSON the CLI prints -
 * status, step, prompt, errors, attempts_left, expires_at, target.
 * Structured request failures surface as INVALID_PARAMS with the
 * machine-readable error list in the message.
 */

// ----- brain_context (v0.10.10) --------------------------------------------

// ----- brain_digest --------------------------------------------------------

const PINNED_CONTEXT_OUTPUT_SCHEMA: NonNullable<ToolDefinition["outputSchema"]> = {
  type: "object",
  required: ["present", "path", "absolute_path", "content"],
  properties: {
    operation: { type: "string", enum: ["read", "write", "append", "clear"] },
    present: { type: "boolean" },
    path: { type: "string" },
    absolute_path: { type: "string" },
    content: { type: "string" },
    done: { type: "boolean" },
    operations_applied: { type: "integer" },
  },
  additionalProperties: false,
};

const BRAIN_CONTEXT_OUTPUT_SCHEMA: NonNullable<ToolDefinition["outputSchema"]> = {
  type: "object",
  required: [
    "vault_path",
    "present",
    "active_path",
    "content",
    "counts",
    "generated_at",
    "pinned",
    "maintenance_overdue",
  ],
  properties: {
    vault_path: VAULT_PATH_OUTPUT_SCHEMA,
    present: { type: "boolean" },
    active_path: { type: "string" },
    content: { type: "string" },
    counts: {
      type: "object",
      required: ["confirmed", "quarantine", "retired_recent", "most_applied_30d"],
      properties: {
        confirmed: { type: "integer" },
        quarantine: { type: "integer" },
        retired_recent: { type: "integer" },
        most_applied_30d: { type: "integer" },
      },
      additionalProperties: false,
    },
    generated_at: {},
    pinned: PINNED_CONTEXT_OUTPUT_SCHEMA,
    // `boolean | null` (empty schema, matching `generated_at` above): a
    // cheap, bounded proxy over the single newest `Brain/log/` day only -
    // `null` when there is no log history yet or the newest day could
    // not be read. See `computeMaintenanceOverdueFlag`'s docblock
    // (`src/core/brain/status.ts`) for exactly what it measures and its
    // cost bound; it is NOT the precise `maintenance_debt` figure that
    // `second_brain_status` / `osb://status` report.
    maintenance_overdue: {},
    // Declared but deliberately NOT required: a vault whose operator has
    // written no standing rules omits the key entirely, exactly as the
    // vault-instruction field does, so hosts that strip unknown fields
    // stay byte-identical on the common path.
    standing_rules: {
      type: "object",
      required: ["path", "content", "truncated"],
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        truncated: { type: "boolean" },
      },
      additionalProperties: false,
    },
    // Declared, not required: present only at local reach and only when a
    // scoped rule file matched this server's project, harness or host (or
    // the host notice applies), so the common path stays byte-identical.
    scoped_rules: {
      type: "object",
      required: ["scope", "files"],
      properties: {
        scope: {
          type: "object",
          required: ["project", "harness", "host"],
          // `string | null` each (empty schema, as `generated_at` above):
          // the descriptor subset has no union type.
          properties: { project: {}, harness: {}, host: {} },
          additionalProperties: false,
        },
        files: {
          type: "array",
          items: {
            type: "object",
            required: ["path", "axis", "truncated"],
            properties: {
              path: { type: "string" },
              axis: { type: "string", enum: SCOPED_RULE_AXES },
              truncated: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    // Present only when the instruction-file read failed; see the
    // "a throw is not an absence" note on the handler.
    vault_instruction_error: { type: "string" },
  },
};

export const CONTEXT_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_write_session",
    kind: "write",
    description:
      "Provider-agnostic Brain write sessions (artifact and decision-panel kinds): open returns a generation prompt, submit validates the text, only clean artifacts commit. Correction loop, retry cap, collision guard, optional operator review. The calling agent generates; the Brain never does.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["open", "submit", "approve", "abandon", "status", "list"],
          description: "Lifecycle operation.",
        },
        kind: {
          type: "string",
          enum: ["artifact", "panel"],
          description: "Session kind for op=open. Defaults to artifact.",
        },
        session_id: {
          type: "string",
          description: "Session id (`ws-...`) for submit/approve/abandon/status.",
        },
        target: {
          type: "string",
          description:
            "Commit target: Brain/sources/, reports/, distillations/, notes/ or decisions/panels/ (artifact open; panel override). The rest of Brain/ is refused.",
        },
        text: {
          type: "string",
          description:
            "Generated text for op=submit: the full artifact, a persona answer, or the synthesis.",
        },
        topic: { type: "string", description: "Decision topic (panel open)." },
        personas: {
          type: "array",
          items: { type: "string" },
          description:
            "Persona slugs to convene in order (panel open). Defaults to every loaded persona.",
        },
        schema_type: {
          type: "string",
          description: "Schema-pack page type the artifact must declare (artifact open).",
        },
        intent: {
          type: "string",
          enum: ["create", "overwrite", "merge"],
          description:
            "Commit intent against an existing target (artifact open). Default create - never overwrites.",
        },
        prompt: { type: "string", description: "Custom generation instruction (artifact open)." },
        require_review: {
          type: "boolean",
          description: "Park the validated artifact at needs-review until an operator approves.",
        },
        retry_cap: { type: "number", description: "Failed submits allowed per step (default 3)." },
        limit: {
          type: "number",
          description: "Max sessions returned by op=list (default 100, cap 500).",
        },
        cursor: CURSOR_SCHEMA,
        agent: { type: "string", description: "Agent identity override (open)." },
      },
      required: ["op"],
      additionalProperties: false,
    },
    handler: toolBrainWriteSession,
  },
  {
    name: "brain_pinned_context",
    kind: "write",
    description:
      "Read, write, append, or clear the transient current-task scratchpad (pinned context). Use for facts that should survive context rotation but should not become permanent preferences. Pass `operations` to apply an ordered batch atomically (all-or-nothing).",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["read", "write", "append", "clear"],
          description:
            "Single operation to perform. Defaults to read. Ignored when `operations` is given.",
        },
        content: {
          type: "string",
          description: "Pinned context body for write/append operations.",
        },
        operations: {
          type: "array",
          description:
            "Ordered batch applied atomically; any invalid op aborts the whole batch with no write.",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: ["write", "append", "clear", "replace"],
                description: "What this step does to the pinned body.",
              },
              content: { type: "string", description: "Body for write/append ops." },
              find: { type: "string", description: "Exact segment to locate for a replace op." },
              replace: { type: "string", description: "Replacement text for a replace op." },
            },
            required: ["op"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    outputSchema: PINNED_CONTEXT_OUTPUT_SCHEMA,
    handler: toolBrainPinnedContext,
  },
  {
    name: "brain_context",
    // Write-mode-dominant (tool-contract.ts), not "read": the bootstrap
    // path calls `regenerateActive`, which writes the shared
    // `Brain/active.md` whenever the body is absent or stale. A read
    // classification would let concurrent session starts regenerate that
    // one shared file beside each other on the stdio read path.
    kind: "write",
    description:
      "Pull the active-preferences digest, pinned current-task context, and active-preference counts. Use at session start when SessionStart hook is unavailable (Cursor, Aider, raw Claude API). Regenerates the digest when absent or stale.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: BRAIN_CONTEXT_OUTPUT_SCHEMA,
    handler: toolBrainContext,
  },
]);
