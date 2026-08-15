/**
 * Note-FILE lifecycle MCP tool: `brain_note_lifecycle` (B2).
 *
 * One tool dispatching on `action` - rename, move, archive, delete - in
 * the shape `brain_lifecycle` established. The sibling name is
 * deliberate and so is the separation: `brain_lifecycle` is the BELIEF
 * lifecycle (tombstone, supersede, temporal-replace), which marks a
 * memory's status in frontmatter and never moves a byte. This one moves
 * and removes files. Merging them would put "mark this claim superseded"
 * and "delete this file" behind one `action` key, where a mistyped value
 * is the difference between an annotation and a deletion.
 *
 * The handler coerces arguments and renders the result; every guard -
 * the nine-step path envelope on BOTH paths, the confirmation ladder, the
 * count guard, the recovery point and its verdict - lives in
 * `core/brain/notes/lifecycle.ts`, so the CLI verb beside it cannot drift
 * into a different set of rules.
 *
 * Refusals carry their typed `code` in `data` rather than only in prose,
 * because the three an agent must branch on - a missing source, an
 * occupied destination, an unconfirmed delete - each have a different
 * next move.
 */

import {
  noteLifecycle,
  NoteLifecycleError,
  NOTE_LIFECYCLE_ACTIONS,
  isNoteLifecycleAction,
  type NoteLifecycleResult,
} from "../../core/brain/notes/lifecycle.ts";
import { CountGuardError } from "../../core/brain/count-guard.ts";
import { CreateNoteError } from "../../core/brain/notes/create-note.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "../protocol.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { coerceBoolOptional, coerceStr } from "../coerce.ts";
import { readCountGuardArgs } from "./shared.ts";

const TOOL = "brain_note_lifecycle";

/** The `data.code` a count-guard refusal reports itself under. */
const COUNT_GUARD_CODE = "count_guard";

/** Project the frozen core result into the tool's snake_cased response. */
function renderResult(res: NoteLifecycleResult): Record<string, unknown> {
  return {
    action: res.action,
    from: res.from,
    to: res.to,
    applied: res.applied,
    recoverability: {
      state: res.recoverability.state,
      coverage: [...res.recoverability.coverage],
      blockers: [...res.recoverability.blockers],
    },
    snapshot:
      res.snapshot === null ? null : { run_id: res.snapshot.runId, path: res.snapshot.path },
    references: {
      files_scanned: res.references.filesScanned,
      inbound_files: [...res.references.inboundFiles],
      files_rewritten: res.references.filesRewritten,
      rewritten_spellings: res.references.rewrittenSpellings.map((s) => ({
        from: s.from,
        to: s.to,
      })),
      basename: res.references.basename,
      index: {
        state: res.references.index.state,
        last_indexed_at: res.references.index.lastIndexedAt,
        next_command: res.references.index.nextCommand,
      },
    },
  };
}

async function toolBrainNoteLifecycle(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const action = coerceStr(args, "action", true)!;
  if (!isNoteLifecycleAction(action)) {
    // Refused rather than defaulted: a caller that asked for a
    // disposition this tool does not have must never be told its request
    // succeeded under a different one.
    throw new MCPError(
      INVALID_PARAMS,
      `${TOOL}: 'action' must be one of ${NOTE_LIFECYCLE_ACTIONS.join(", ")}`,
    );
  }
  const path = coerceStr(args, "path", true)!;
  const to = coerceStr(args, "to", false) ?? undefined;
  const apply = coerceBoolOptional(args, "apply");
  const confirm = coerceBoolOptional(args, "confirm");
  const { expect, strict } = readCountGuardArgs(args);

  try {
    const res = await noteLifecycle(ctx.vault, {
      action,
      path,
      ...(to !== undefined ? { to } : {}),
      ...(apply !== undefined ? { apply } : {}),
      ...(confirm !== undefined ? { confirm } : {}),
      expect,
      strict,
    });
    return renderResult(res);
  } catch (err) {
    // The three typed refusals reach the caller as the caller's fault,
    // each keeping the code it decides on. A count-guard mismatch also
    // carries the number it measured, because "you said 5, it is 1" is
    // the whole of the remedy.
    if (err instanceof NoteLifecycleError) {
      throw new MCPError(INVALID_PARAMS, `${TOOL}: ${err.message}`, { code: err.code });
    }
    if (err instanceof CreateNoteError) {
      throw new MCPError(INVALID_PARAMS, `${TOOL}: ${err.message}`, { code: err.code });
    }
    if (err instanceof CountGuardError) {
      throw new MCPError(INVALID_PARAMS, `${TOOL}: ${err.message}`, {
        code: COUNT_GUARD_CODE,
        matched: err.matched,
        expected: err.expected,
      });
    }
    if (err instanceof MCPError) throw err;
    throw new MCPError(
      INTERNAL_ERROR,
      `${TOOL}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export const LIFECYCLE_FILE_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    description:
      "Note-file lifecycle. action: rename changes the filename in place; move changes the directory; archive displaces the note under Archive/ mirroring its path; delete removes it. Dry-run unless apply; delete also needs confirm. Rewrites inbound [[links]] and reports how stale the index is.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...NOTE_LIFECYCLE_ACTIONS],
          description: "Which lifecycle operation to run on the note file.",
        },
        path: {
          type: "string",
          description:
            "Vault-relative path of the note; must end in .md and stay inside the vault.",
        },
        to: {
          type: "string",
          description:
            "rename/move: vault-relative destination. Forbidden for archive (it picks its own) and delete.",
        },
        apply: {
          type: "boolean",
          description:
            "Perform the operation. Absent means a dry run that reports the blast radius and writes nothing.",
        },
        confirm: {
          type: "boolean",
          description:
            "delete: explicit confirmation. Without it an applied delete is refused, because no archive covers a note outside Brain/.",
        },
        expect: {
          type: "integer",
          minimum: 0,
          description:
            "Assert the number of files holding an inbound reference; a mismatch aborts before any write.",
        },
        strict: {
          type: "boolean",
          description: "Refuse a mutation that carries no expect guard.",
        },
      },
      required: ["action", "path"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainNoteLifecycle,
  },
]);
