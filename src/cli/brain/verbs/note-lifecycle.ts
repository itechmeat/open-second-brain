/**
 * `o2b brain note-lifecycle <action> <path> [<to>]` - rename, move,
 * archive and delete for note FILES (B2).
 *
 * CLI mirror of the `brain_note_lifecycle` MCP tool; both delegate to
 * `core/brain/notes/lifecycle.ts`, so the path envelope, the
 * confirmation ladder, the count guard and the recoverability verdict
 * cannot come to mean two different things on two surfaces.
 *
 * Distinct from `o2b brain lifecycle`, which is the BELIEF lifecycle and
 * moves no bytes. The two verbs sit beside each other on purpose rather
 * than merging: one annotates a memory's status, the other deletes files.
 *
 * Dry run is the default here as it is in the core. `--apply` performs
 * the operation, `--confirm` is additionally required by `delete`, and
 * `--expect N` / `--strict` assert the inbound-reference count before
 * anything is written.
 */

import { defaultConfigPath } from "../../../core/config.ts";
import {
  isNoteLifecycleAction,
  noteLifecycle,
  NOTE_LIFECYCLE_ACTIONS,
  type NoteLifecycleResult,
} from "../../../core/brain/notes/lifecycle.ts";
import { normalizeFlagString, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

const USAGE_ERROR_EXIT = 2;

function usageError(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return USAGE_ERROR_EXIT;
}

/** The receipt, snake_cased exactly as the MCP tool renders it. */
function renderJson(res: NoteLifecycleResult): Record<string, unknown> {
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

/**
 * The human line. It names the index state and the command that fixes it
 * on every run, because the operator reading a terminal is exactly the
 * person who has to decide whether the search index still describes the
 * vault they just changed.
 */
function renderText(res: NoteLifecycleResult): string {
  const where = res.to === null ? res.from : `${res.from} -> ${res.to}`;
  const mode = res.applied ? res.action : `${res.action} (plan)`;
  const refs = res.references;
  // A half-applied rename is the one outcome an operator must not scroll
  // past, so it gets its own line naming every file that kept the old
  // spelling - not a count, because the remedy is per file.
  const split =
    refs.rewriteFailures.length === 0
      ? ""
      : `  NOT rewritten (still naming ${res.from}):\n` +
        refs.rewriteFailures.map((f) => `    ${f.path}: ${f.reason}\n`).join("");
  return (
    `${mode}: ${where}\n` +
    `  inbound references: ${refs.inboundFiles.length} file(s) of ${refs.filesScanned} scanned, ` +
    `${refs.filesRewritten} rewritten (basename: ${refs.basename})\n` +
    split +
    `  recoverability: ${res.recoverability.state}` +
    (res.recoverability.blockers.length > 0 ? ` (${res.recoverability.blockers.join(", ")})` : "") +
    "\n" +
    `  search index: ${refs.index.state}` +
    (refs.index.lastIndexedAt === null ? "" : ` since ${refs.index.lastIndexedAt}`) +
    `; next: ${refs.index.nextCommand}`
  );
}

export async function cmdBrainNoteLifecycle(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    apply: { type: "boolean" },
    confirm: { type: "boolean" },
    expect: { type: "string" },
    strict: { type: "boolean" },
    json: { type: "boolean" },
  });

  const action = positional[0];
  if (action === undefined || !isNoteLifecycleAction(action)) {
    return usageError(
      `brain note-lifecycle requires an action: ${NOTE_LIFECYCLE_ACTIONS.join(" | ")}`,
    );
  }
  const path = positional[1];
  if (path === undefined) {
    return usageError(`brain note-lifecycle ${action} requires a vault-relative note path`);
  }
  const to = positional[2];

  const expectRaw = normalizeFlagString(flags["expect"]);
  const expectCount = expectRaw === null ? null : Number(expectRaw);
  if (expectCount !== null && (!Number.isInteger(expectCount) || expectCount < 0)) {
    return usageError("brain note-lifecycle --expect must be a non-negative integer");
  }

  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  try {
    const res = await noteLifecycle(vault, {
      action,
      path,
      ...(to !== undefined ? { to } : {}),
      apply: flags["apply"] === true,
      confirm: flags["confirm"] === true,
      expect: expectCount,
      strict: flags["strict"] === true,
    });
    if (flags["json"] === true) okJson(renderJson(res));
    else ok(renderText(res));
    return 0;
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message ?? String(exc)}\n`);
    return 1;
  }
}
