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
import {
  listDanglingTargets,
  scaffoldStub,
  ScaffoldStubError,
} from "../../core/brain/notes/scaffold-stub.ts";
import { CountGuardError } from "../../core/brain/count-guard.ts";
import { gatedOwnerScopeView } from "../../core/brain/owner-scope-view.ts";
import {
  CreateNoteError,
  CREATE_NOTE_IF_EXISTS,
  type CreateNoteIfExists,
} from "../../core/brain/notes/create-note.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "../protocol.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { coerceBoolOptional, coerceStr } from "../coerce.ts";
import { coerceNonNegativeInteger, readCountGuardArgs } from "./shared.ts";

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
      // Non-empty means the operation is half-applied: the note is at
      // `to` and these files still name `from`. Rendered on every
      // response, empty included, so a caller reading the field is
      // reading an answer rather than guessing from its absence.
      rewrite_failures: res.references.rewriteFailures.map((f) => ({
        path: f.path,
        reason: f.reason,
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

/**
 * The two things a caller can do about an unresolved wikilink target
 * (B3): find out which ones there are, and materialise one.
 *
 * A separate tool from {@link TOOL} rather than a fifth action on it, and
 * the reason is the subject. Every note-lifecycle action names an
 * EXISTING note by path; a dangling target has no path yet - that is what
 * makes it dangling. Folding them together would give one required
 * parameter two meanings and one vocabulary two shapes.
 */
const STUB_TOOL = "brain_scaffold_stub";

export const STUB_SCAFFOLD_ACTION = Object.freeze({
  /** Read the vault's unresolved targets from the index, or say why not. */
  list: "list",
  /** Materialise a stub for one target. */
  write: "write",
} as const);

/** Closed union over {@link STUB_SCAFFOLD_ACTION}. */
export type StubScaffoldAction = (typeof STUB_SCAFFOLD_ACTION)[keyof typeof STUB_SCAFFOLD_ACTION];

/** Membership list, read before write. */
export const STUB_SCAFFOLD_ACTIONS: ReadonlyArray<StubScaffoldAction> = Object.freeze(
  Object.values(STUB_SCAFFOLD_ACTION),
);

/** See {@link isNoteLifecycleAction} for why the parameter is `unknown`. */
export function isStubScaffoldAction(value: unknown): value is StubScaffoldAction {
  return (
    typeof value === "string" && (STUB_SCAFFOLD_ACTIONS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Which arguments belong to which action, so one sent to the other is
 * refused rather than dropped.
 *
 * `brain_scaffold_stub` dispatches on `action` and its two actions share
 * one flat argument list, so `{"action":"list","target":"Foo","apply":true}`
 * used to return a normal `state: "measured", targets: []` envelope - an
 * agent holding a stale `action` reads that as a write that happened.
 * `argument-guard.ts` calls a silently ignored argument "the worst kind
 * of fallback", and the sibling tool in this file has taken the other
 * road since it shipped: `to` on an archive or a delete is a typed
 * `destination_forbidden`, not a no-op.
 */
const STUB_ACTION_ARGUMENTS: Readonly<Record<StubScaffoldAction, ReadonlyArray<string>>> =
  Object.freeze({
    [STUB_SCAFFOLD_ACTION.list]: Object.freeze(["limit"]),
    [STUB_SCAFFOLD_ACTION.write]: Object.freeze([
      "target",
      "path",
      "sources",
      "if_exists",
      "apply",
    ]),
  });

/** The `data.code` an action-incompatible argument is refused under. */
const ARGUMENT_FORBIDDEN_CODE = "argument_forbidden";

/**
 * Refuse every argument that belongs to the OTHER action. `action`
 * itself is the dispatch key and belongs to both; anything the schema
 * does not declare at all is already refused upstream by the
 * unknown-argument gate, so this reads the declared vocabulary only.
 */
function assertArgumentsMatchAction(
  args: Record<string, unknown>,
  action: StubScaffoldAction,
): void {
  const mine = STUB_ACTION_ARGUMENTS[action];
  const foreign = STUB_SCAFFOLD_ACTIONS.flatMap((other) =>
    other === action ? [] : [...STUB_ACTION_ARGUMENTS[other]],
  )
    .filter((name) => !mine.includes(name))
    .filter((name) => args[name] !== undefined && args[name] !== null)
    .toSorted();
  if (foreign.length === 0) return;
  throw new MCPError(
    INVALID_PARAMS,
    `${STUB_TOOL}: action=${action} takes none of ${foreign.join(", ")}; ` +
      `it reads ${mine.join(", ")}`,
    { code: ARGUMENT_FORBIDDEN_CODE, action, forbidden: foreign, accepted: [...mine] },
  );
}

/** Read an optional string array argument, refusing a non-array. */
function coerceStringArray(args: Record<string, unknown>, field: string): string[] {
  const raw = args[field];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
    throw new MCPError(INVALID_PARAMS, `${STUB_TOOL}: ${field} must be an array of strings`);
  }
  return raw as string[];
}

async function toolBrainScaffoldStub(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const action = coerceStr(args, "action", true)!;
  if (!isStubScaffoldAction(action)) {
    throw new MCPError(
      INVALID_PARAMS,
      `${STUB_TOOL}: 'action' must be one of ${STUB_SCAFFOLD_ACTIONS.join(", ")}`,
    );
  }

  assertArgumentsMatchAction(args, action);

  if (action === STUB_SCAFFOLD_ACTION.list) {
    const limit = coerceNonNegativeInteger(STUB_TOOL, "limit", args["limit"]);
    // `sources` are vault-relative document paths and `target` is the
    // link spelling, so an unscoped listing published both for a note
    // this caller may not read (a-label-is-not-a-boundary, U3).
    const scan = await listDanglingTargets(ctx.vault, {
      ...(limit !== undefined ? { limit } : {}),
      ownerScope: gatedOwnerScopeView(ctx.vault, ctx.agentName).scope,
    });
    return {
      action,
      state: scan.state,
      targets: scan.targets.map((t) => ({ target: t.target, sources: [...t.sources] })),
      detail: scan.detail,
      next_command: scan.nextCommand,
    };
  }

  const target = coerceStr(args, "target", true)!;
  const path = coerceStr(args, "path", false) ?? undefined;
  const ifExists = coerceStr(args, "if_exists", false) ?? undefined;
  if (ifExists !== undefined && !CREATE_NOTE_IF_EXISTS.includes(ifExists as CreateNoteIfExists)) {
    throw new MCPError(
      INVALID_PARAMS,
      `${STUB_TOOL}: if_exists must be one of ${CREATE_NOTE_IF_EXISTS.join(", ")}`,
    );
  }
  const apply = coerceBoolOptional(args, "apply");

  try {
    const res = scaffoldStub(ctx.vault, {
      target,
      ...(path !== undefined ? { path } : {}),
      sources: coerceStringArray(args, "sources"),
      ...(ifExists !== undefined ? { ifExists: ifExists as CreateNoteIfExists } : {}),
      ...(apply !== undefined ? { apply } : {}),
    });
    return {
      action,
      target: res.target,
      path: res.path,
      applied: res.applied,
      outcome: res.outcome,
      sources: [...res.sources],
    };
  } catch (err) {
    if (err instanceof ScaffoldStubError) {
      throw new MCPError(INVALID_PARAMS, `${STUB_TOOL}: ${err.message}`, {
        code: err.code,
        ...(err.candidates.length > 0 ? { candidates: [...err.candidates] } : {}),
      });
    }
    if (err instanceof CreateNoteError) {
      throw new MCPError(INVALID_PARAMS, `${STUB_TOOL}: ${err.message}`, { code: err.code });
    }
    if (err instanceof MCPError) throw err;
    throw new MCPError(
      INTERNAL_ERROR,
      `${STUB_TOOL}: ${err instanceof Error ? err.message : String(err)}`,
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
  {
    name: STUB_TOOL,
    description:
      "Unresolved wikilink targets. action: list reads them from the search index and refuses with a state and a next_command when that index is missing or partly resolved, rather than reporting zero; write materialises a stub for one target, its body linking back to the sources. Dry-run unless apply.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...STUB_SCAFFOLD_ACTIONS],
          description: "list reads the dangling targets; write materialises one.",
        },
        target: {
          type: "string",
          description: "write: the unresolved wikilink target, e.g. Projects/Foo or Foo.",
        },
        path: {
          type: "string",
          description:
            "write: explicit vault-relative destination. Absent derives <target>.md, the path the link itself named.",
        },
        sources: {
          type: "array",
          items: { type: "string" },
          description:
            "write: vault-relative paths that referenced the target; they become the stub's body wikilinks.",
        },
        if_exists: {
          type: "string",
          enum: [...CREATE_NOTE_IF_EXISTS],
          description:
            "write: occupied-destination policy. Default refuse; skip returns outcome=skipped, never created.",
        },
        apply: {
          type: "boolean",
          description:
            "write: materialise the stub. Absent means a dry run that reports the destination and writes nothing.",
        },
        limit: {
          type: "integer",
          minimum: 0,
          description: "list: maximum targets returned.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainScaffoldStub,
  },
]);
