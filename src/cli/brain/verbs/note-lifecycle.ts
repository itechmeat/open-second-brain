/**
 * `o2b brain note-lifecycle <action> <path> [<to>]` - rename, move,
 * archive and delete for note FILES (B2), plus the folder actions
 * `move-folder` and `rename-folder` (t_9571a47f).
 *
 * CLI mirror of the `brain_note_lifecycle` MCP tool. The file actions
 * delegate to `core/brain/notes/lifecycle.ts`; the folder actions
 * delegate to `core/brain/notes/folder-lifecycle.ts`, the module that
 * runs them - the vocabulary is one constant, but the machinery is two
 * modules, and the surface owns the dispatch. The path envelope, the
 * confirmation ladder, the count guard and the recoverability verdict
 * therefore cannot come to mean two different things on two surfaces.
 *
 * Distinct from `o2b brain lifecycle`, which is the BELIEF lifecycle and
 * moves no bytes. The two verbs sit beside each other on purpose rather
 * than merging: one annotates a memory's status, the other deletes files.
 *
 * Dry run is the default here as it is in the core. `--apply` performs
 * the operation, `--confirm` is additionally required by `delete`, and
 * `--expect N` / `--strict` assert the count before anything is written -
 * the deletion set under `--delete-linked`, the inbound references
 * otherwise.
 *
 * `--delete-linked` widens a delete to the Brain files that declare the
 * note as their provenance and derive solely from it; a page that only
 * mentions it in prose is reported, never deleted. The receipt then
 * prints two lists rather than a count: what will go, and what is
 * reported and stays.
 *
 * A folder action moves MARKDOWN ONLY - the move set is the same note
 * population every lifecycle surface addresses - and the folder receipt
 * says what that honestly costs: attachments and other non-Notes files
 * are named in `left_behind`, and a moved note's relative Markdown links
 * or images whose target stayed behind are named in
 * `dangling_relative_links` (rendered on the human receipt beside the
 * residue, with the "only Markdown moves" statement in the line).
 */

import { defaultConfigPath } from "../../../core/config.ts";
import {
  folderLifecycle,
  isFolderLifecycleAction,
  type FolderLifecycleResult,
} from "../../../core/brain/notes/folder-lifecycle.ts";
import {
  isNoteLifecycleAction,
  noteLifecycle,
  NOTE_LIFECYCLE_ACTIONS,
  type NoteLifecycleResult,
  type NoteReferenceReport,
} from "../../../core/brain/notes/lifecycle.ts";
import { normalizeFlagString, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

const USAGE_ERROR_EXIT = 2;

function usageError(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return USAGE_ERROR_EXIT;
}

/**
 * The reference report, identical on both lifecycle machines - the folder
 * result carries the same {@link NoteReferenceReport} the file result
 * does, so the projection is written once.
 */
function renderReferences(refs: NoteReferenceReport): Record<string, unknown> {
  return {
    files_scanned: refs.filesScanned,
    inbound_files: [...refs.inboundFiles],
    files_rewritten: refs.filesRewritten,
    rewritten_spellings: refs.rewrittenSpellings.map((s) => ({
      from: s.from,
      to: s.to,
    })),
    rewrite_failures: refs.rewriteFailures.map((f) => ({
      path: f.path,
      reason: f.reason,
    })),
    basename: refs.basename,
    index: {
      state: refs.index.state,
      last_indexed_at: refs.index.lastIndexedAt,
      next_command: refs.index.nextCommand,
    },
    // `claimed` says a detached refresh run is IN FLIGHT, never that it
    // has landed; every other value names why nothing was started, and
    // `refresh_reason` spells that reason - the freshen machinery's own
    // skip token, or the error it raised - so `not_claimed` is never
    // the whole answer a caller receives.
    refresh: refs.refresh,
    refresh_reason: refs.refreshReason,
  };
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
    references: renderReferences(res.references),
    cascade:
      res.cascade === null
        ? null
        : {
            deletion_set: [...res.cascade.deletionSet],
            reported_files: [...res.cascade.reportedFiles],
            scanned_scope: res.cascade.scannedScope,
          },
  };
}

/** The folder receipt, snake_cased exactly as the MCP tool renders it. */
function renderFolderJson(res: FolderLifecycleResult): Record<string, unknown> {
  return {
    action: res.action,
    from: res.from,
    to: res.to,
    applied: res.applied,
    // The report style the folder module answers in: the list of what
    // relocated, and the per-file list of what did not and why.
    moved: res.moved.map((m) => ({ from: m.from, to: m.to })),
    move_failures: res.moveFailures.map((f) => ({ path: f.path, reason: f.reason })),
    // Absent-when-empty: a move that emptied its source folder carried
    // nothing through, so the key's presence is the signal.
    ...(res.leftBehind.length > 0 ? { left_behind: [...res.leftBehind] } : {}),
    // Absent-when-empty: the relative Markdown links and images the move
    // left pointing at nothing, named per note and target - a folder move
    // is a MARKDOWN move, and without this a `files_rewritten: 0` would
    // read as "nothing broke" while every relative embed dangled.
    ...(res.danglingRelativeLinks.length > 0
      ? {
          dangling_relative_links: res.danglingRelativeLinks.map((l) => ({
            note: l.note,
            target: l.target,
          })),
        }
      : {}),
    recoverability: {
      state: res.recoverability.state,
      coverage: [...res.recoverability.coverage],
      blockers: [...res.recoverability.blockers],
    },
    // Always null on this surface: a relocation destroys nothing, so no
    // recovery point is taken (the rewrite's risk is the verdict's).
    snapshot: null,
    references: renderReferences(res.references),
  };
}

/**
 * The human line. It names the index state and the command that fixes it
 * on every run, because the operator reading a terminal is exactly the
 * person who has to decide whether the search index still describes the
 * vault they just changed - and it names whether the write claimed the
 * detached refresh, so "claimed" is never read as "already caught up".
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
  // The cascade's two lists are printed IN FULL and separately, not
  // counted. An operator authorising a multi-file delete has to be able
  // to read every path that will go and every path that will not, and a
  // count is precisely the summary that hides the one wrong entry.
  const cascade =
    res.cascade === null
      ? ""
      : `  deletion set (${res.cascade.deletionSet.length}, scope ${res.cascade.scannedScope}):\n` +
        res.cascade.deletionSet.map((p) => `    ${p}\n`).join("") +
        `  reported, not deleted (${res.cascade.reportedFiles.length}):\n` +
        (res.cascade.reportedFiles.length === 0
          ? "    (none)\n"
          : res.cascade.reportedFiles.map((p) => `    ${p}\n`).join(""));
  return (
    `${mode}: ${where}\n` +
    `  inbound references: ${refs.inboundFiles.length} file(s) of ${refs.filesScanned} scanned, ` +
    `${refs.filesRewritten} rewritten (basename: ${refs.basename})\n` +
    cascade +
    split +
    `  recoverability: ${res.recoverability.state}` +
    (res.recoverability.blockers.length > 0 ? ` (${res.recoverability.blockers.join(", ")})` : "") +
    "\n" +
    `  search index: ${refs.index.state}` +
    (refs.index.lastIndexedAt === null ? "" : ` since ${refs.index.lastIndexedAt}`) +
    // The reason rides the token in prose too: an operator reading a
    // terminal is exactly the person who has to tell a deliberate
    // config-off from a held claim or a broken spawn.
    `; refresh: ${refs.refresh}` +
    (refs.refreshReason === null ? "" : ` (${refs.refreshReason})`) +
    `; next: ${refs.index.nextCommand}`
  );
}

/**
 * The folder receipt's human line, in the same shape the file receipt
 * uses - the shared evidence tail rendered identically, with the move
 * report in the folder module's own style: the moved list printed IN
 * FULL (a dry run's preview IS this list, so an empty set is printed as
 * a measurement, never omitted) and a mid-set failure named per file,
 * never counted.
 */
function renderFolderText(res: FolderLifecycleResult): string {
  const mode = res.applied ? res.action : `${res.action} (plan)`;
  const refs = res.references;
  const moved =
    `  moved (${res.moved.length}):\n` +
    (res.moved.length === 0
      ? "    (none)\n"
      : res.moved.map((m) => `    ${m.from} -> ${m.to}\n`).join(""));
  // A half-applied move is the one outcome an operator must not scroll
  // past, so it gets its own line naming every file that kept its old
  // path - not a count, because the remedy is per file.
  const split =
    res.moveFailures.length === 0
      ? ""
      : `  NOT moved (still at their old paths):\n` +
        res.moveFailures.map((f) => `    ${f.path}: ${f.reason}\n`).join("");
  // Non-Markdown residue is not a failure and not a count - it is named,
  // in place, so a receipt that reads clean really is clean.
  const residue =
    res.leftBehind.length === 0
      ? ""
      : `  left behind (still in ${res.from}):\n` +
        res.leftBehind.map((p) => `    ${p}\n`).join("");
  // A relative embed the move broke is named in full, not counted - and
  // the line says what a folder move IS, so the residue reads as the
  // settled cost of a Markdown-only move rather than as an omission.
  const dangling =
    res.danglingRelativeLinks.length === 0
      ? ""
      : `  relative links now dangling (only Markdown moves; the target stayed behind):\n` +
        res.danglingRelativeLinks.map((l) => `    ${l.note}: ${l.target}\n`).join("");
  return (
    `${mode}: ${res.from} -> ${res.to}\n` +
    moved +
    split +
    residue +
    dangling +
    `  inbound references: ${refs.inboundFiles.length} file(s) of ${refs.filesScanned} scanned, ` +
    `${refs.filesRewritten} rewritten (basename: ${refs.basename})\n` +
    `  recoverability: ${res.recoverability.state}` +
    (res.recoverability.blockers.length > 0 ? ` (${res.recoverability.blockers.join(", ")})` : "") +
    "\n" +
    `  search index: ${refs.index.state}` +
    (refs.index.lastIndexedAt === null ? "" : ` since ${refs.index.lastIndexedAt}`) +
    `; refresh: ${refs.refresh}` +
    (refs.refreshReason === null ? "" : ` (${refs.refreshReason})`) +
    `; next: ${refs.index.nextCommand}`
  );
}

export async function cmdBrainNoteLifecycle(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    apply: { type: "boolean" },
    confirm: { type: "boolean" },
    "delete-linked": { type: "boolean" },
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
    // The surface owns the dispatch: one vocabulary, two machines. A
    // folder action sent to the file module would be refused
    // `wrong_action` - the action exists and the caller named it
    // correctly, so it runs where it lives.
    if (isFolderLifecycleAction(action)) {
      // Refused rather than dropped, the file surface's own rule for a
      // flag its action cannot honour: a folder action is never a
      // delete, so neither flag has anything to extend.
      if (flags["confirm"] !== undefined || flags["delete-linked"] !== undefined) {
        return usageError(
          `brain note-lifecycle ${action} takes neither --confirm nor --delete-linked: ` +
            "a folder action is never a delete",
        );
      }
      const res = await folderLifecycle(vault, {
        action,
        path,
        ...(to !== undefined ? { to } : {}),
        apply: flags["apply"] === true,
        expect: expectCount,
        strict: flags["strict"] === true,
        // The post-write refresh resolves through the config file this
        // invocation already resolved the vault from, the same rule the
        // file arm below reads.
        refreshConfigPath: config,
      });
      if (flags["json"] === true) okJson(renderFolderJson(res));
      else ok(renderFolderText(res));
      return 0;
    }
    const res = await noteLifecycle(vault, {
      action,
      path,
      ...(to !== undefined ? { to } : {}),
      apply: flags["apply"] === true,
      confirm: flags["confirm"] === true,
      deleteLinked: flags["delete-linked"] === true,
      expect: expectCount,
      strict: flags["strict"] === true,
      // The post-write refresh resolves through the config file this
      // invocation already resolved the vault from, the same rule the
      // search verbs read (`--config`, else the default): a non-default
      // config's index path and freshen settings are the ones the claim
      // reads and the child spawns with.
      refreshConfigPath: config,
    });
    if (flags["json"] === true) okJson(renderJson(res));
    else ok(renderText(res));
    return 0;
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message ?? String(exc)}\n`);
    return 1;
  }
}
