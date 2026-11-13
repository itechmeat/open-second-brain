/**
 * Targeted recompile of stale derived pages
 * (continuity-hygiene-freshness suite; kanban t_fe490119).
 *
 * Instead of a full re-ingestion, refresh exactly the pages whose
 * recorded sources changed: the planner maps freshness findings to a
 * typed plan, the executor re-derives through the page's ORIGINAL
 * pipeline. Today's known pipeline is the handoff note (session
 * transcript -> deterministic note); pages without a known pipeline
 * stay `manual` and orphaned pages stage an archive cleanup into
 * `Brain/.snapshots/` - moved, never deleted. Dry-run previews the
 * whole plan with zero writes.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";

import { appendAuditRecord } from "../reliability/audit.ts";
import { HYGIENE_AUDIT_DIR } from "./audit-dirs.ts";
import { scanFreshness } from "./freshness.ts";
import { legacyActiveIsStale, regenerateActive } from "./active.ts";
import { writeHandoffNote } from "./handoff.ts";
import { brainActivePath, brainDirsForWrite, snapshotsDir } from "./paths.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import { detectAdapter } from "./sessions/registry.ts";
import type { SessionTurn } from "./sessions/types.ts";
import { isoDate } from "./time.ts";
import { parseFrontmatter } from "../vault.ts";
import { renameWithRetry } from "../fs-atomic.ts";
import { lanePagesInStore, readLaneText, removeLanePage } from "../store/lane-pages.ts";
import { lanePlaceOf } from "../store/lane-paths.ts";
import { BRAIN_ROOT_REL } from "./path-constants.ts";

export type RecompileEntryKind = "rederive-handoff" | "rederive-active" | "cleanup" | "manual";

export interface RecompileEntry {
  readonly kind: RecompileEntryKind;
  readonly page: string;
  /** Transcript path for `rederive-handoff` entries. */
  readonly transcript?: string;
  readonly session_id?: string;
  /** Why the page landed in this bucket. */
  readonly reason: string;
}

export interface RecompilePlan {
  readonly entries: ReadonlyArray<RecompileEntry>;
}

export interface ExecuteRecompileOptions {
  readonly dryRun?: boolean;
  readonly agent: string;
  readonly now: Date;
}

export interface RecompileResult {
  readonly dry_run: boolean;
  readonly rederived: ReadonlyArray<string>;
  readonly archived: ReadonlyArray<string>;
  readonly manual: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<{ page: string; message: string }>;
}

function resolveSource(vault: string, source: string): string {
  return isAbsolute(source) ? source : join(vault, source);
}

/**
 * Build the recompile plan from the current freshness state. Read-only
 * and side-effect free - this IS the dry-run preview.
 */
export function planRecompile(
  vault: string,
  options: { now?: Date; includeActiveDigest?: boolean } = {},
): RecompilePlan {
  const freshness = scanFreshness(vault);
  const entries: RecompileEntry[] = [];
  // Comparing the shared digest reads preferences from the whole vault.
  // Only the operator's CLI refresh opts in; scoped planners keep their existing scope.
  const activePath = options.includeActiveDigest ? brainActivePath(vault) : null;
  if (activePath !== null && legacyActiveIsStale(vault, activePath, options.now ?? new Date())) {
    entries.push(
      Object.freeze({
        kind: "rederive-active" as const,
        page: activePath,
        reason: "the active preference digest differs from current memory state",
      }),
    );
  }

  for (const stale of freshness.stale) {
    if (stale.page === activePath) continue;
    const [meta] = parseFrontmatter(stale.page);
    const sessionId = typeof meta["session_id"] === "string" ? meta["session_id"] : null;
    const sources = Array.isArray(meta["source_paths"]) ? (meta["source_paths"] as string[]) : [];
    const transcript = sources.length === 1 ? resolveSource(vault, sources[0]!) : null;
    if (sessionId !== null && transcript !== null && existsSync(transcript)) {
      entries.push(
        Object.freeze({
          kind: "rederive-handoff" as const,
          page: stale.page,
          transcript,
          session_id: sessionId,
          reason: `changed source(s): ${[...stale.changed_sources, ...stale.missing_sources].join(", ")}`,
        }),
      );
      continue;
    }
    entries.push(
      Object.freeze({
        kind: "manual" as const,
        page: stale.page,
        reason: "no known derivation pipeline for this page",
      }),
    );
  }

  for (const orphan of freshness.orphaned) {
    if (orphan === activePath) continue;
    entries.push(
      Object.freeze({
        kind: "cleanup" as const,
        page: orphan,
        reason: "every recorded source is gone",
      }),
    );
  }

  return Object.freeze({ entries: Object.freeze(entries) });
}

/**
 * Trust model: transcript paths come from the derived page's own
 * `source_paths` frontmatter, i.e. from inside the vault trust
 * boundary (only the operator and their agents write vault pages).
 * Transcripts legitimately live OUTSIDE the vault (host session
 * directories), so an inside-vault check would break the feature; the
 * adapter format detection below bounds what a pointed-at file can be
 * parsed as.
 */
async function readTranscriptTurns(transcript: string): Promise<SessionTurn[] | null> {
  const text = readFileSync(transcript, "utf8");
  const nl = text.indexOf("\n");
  const adapter = detectAdapter(nl < 0 ? text : text.slice(0, nl));
  if (adapter === null) return null;
  const turns: SessionTurn[] = [];
  for await (const turn of adapter.iterate(transcript)) turns.push(turn);
  return turns.length > 0 ? turns : null;
}

/**
 * Move a vault page into a dated hygiene snapshot directory - the
 * shared "archive, never delete" primitive for recompile cleanups and
 * hygiene `archive` / `forget` actions.
 */
export function archivePage(vault: string, page: string, now: Date): string {
  // Vault-identity write guard (context-integrity-gates, Unit J). This is
  // a public export reached from hygiene `archive`/`forget` as well as
  // from the recompile executor, so it carries its own assertion ahead of
  // the `mkdirSync` + `renameSync` pair rather than relying on a caller.
  assertVaultIdentityForWrite(vault);
  const dir = join(snapshotsDir(vault), `hygiene-${isoDate(now)}`);
  mkdirSync(dir, { recursive: true });
  let target = join(dir, basename(page));
  let suffix = 1;
  while (existsSync(target)) {
    target = join(dir, `${basename(page, ".md")}-${suffix}.md`);
    suffix++;
  }
  moveIntoArchive(vault, page, target);
  return target;
}

/**
 * Move `page` to `target`. A `Brain/` lane page on a store-only machine is
 * its lane record: it is copied out of the store and its entry removed,
 * and a leftover pre-switch file at `page` (the legacy tree a switch
 * leaves in place) is left alone, as nothing under `Brain/` changes once
 * switched. A file is renamed; the snapshots folder sits in the
 * device-local state once switched, which can be another volume, so a
 * cross-device rename is a copy, then the removal of the source.
 */
function moveIntoArchive(vault: string, page: string, target: string): void {
  const rel = relative(join(vault, BRAIN_ROOT_REL), page);
  const inBrain = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  const lanePage = inBrain && lanePlaceOf(rel.split(sep).join("/")) !== null;
  if (lanePage && lanePagesInStore(vault)) {
    const text = readLaneText(vault, page);
    if (text === null) {
      const error = new Error(`ENOENT: no such page, '${page}'`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    archiveStoredPage(vault, page, target, text);
    return;
  }
  try {
    renameWithRetry(page, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    copyFileSync(page, target);
    rmSync(page, { force: true });
  }
}

/**
 * Write the archive copy of a stored lane page, then remove its entry. The
 * copy is written whole under a temporary name and renamed into place (a
 * crash leaves no partial archive under the name the suffix loop proved
 * free), and removed again when the entry's tombstone fails, so the page
 * is never both archived and live.
 */
function archiveStoredPage(vault: string, page: string, target: string, text: string): void {
  const temp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx" });
    renameWithRetry(temp, target);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
  try {
    removeLanePage(vault, page);
  } catch (err) {
    rmSync(target, { force: true });
    throw err;
  }
}

/**
 * Execute a recompile plan. Per-entry fail-soft: one broken page lands
 * in `errors` and the rest still process. Every mutation is audited.
 */
export async function executeRecompile(
  vault: string,
  plan: RecompilePlan,
  opts: ExecuteRecompileOptions,
): Promise<RecompileResult> {
  const dryRun = opts.dryRun === true;
  // Vault-identity write guard (context-integrity-gates, Unit J). The
  // per-entry loop is fail-soft, so a guard reached only from inside it
  // would be recorded as an ordinary entry error instead of refusing the
  // run; a dry run previews and writes nothing, so it stays ungated.
  if (!dryRun) assertVaultIdentityForWrite(vault);
  const rederived: string[] = [];
  const archived: string[] = [];
  const manual: string[] = [];
  const errors: { page: string; message: string }[] = [];

  for (const entry of plan.entries) {
    if (entry.kind === "manual") {
      manual.push(entry.page);
      continue;
    }
    if (dryRun) continue;
    try {
      if (entry.kind === "rederive-handoff") {
        const turns = await readTranscriptTurns(entry.transcript!);
        if (turns === null) {
          errors.push({ page: entry.page, message: "transcript is no longer readable" });
          continue;
        }
        writeHandoffNote(vault, {
          sessionId: entry.session_id!,
          agent: opts.agent,
          now: opts.now,
          turns,
          sourcePaths: [entry.transcript!],
          targetPath: entry.page,
        });
        rederived.push(entry.page);
      } else if (entry.kind === "rederive-active") {
        const digest = regenerateActive(vault, { now: opts.now });
        if (digest.changed) rederived.push(digest.path);
      } else {
        archived.push(archivePage(vault, entry.page, opts.now));
      }
    } catch (error) {
      errors.push({
        page: entry.page,
        message: error instanceof Error ? error.message : "recompile failed",
      });
    }
  }

  if (
    !dryRun &&
    (rederived.length > 0 || archived.length > 0 || manual.length > 0 || errors.length > 0)
  ) {
    appendAuditRecord(
      join(brainDirsForWrite(vault).log, HYGIENE_AUDIT_DIR),
      {
        timestamp: opts.now.toISOString(),
        actor: opts.agent,
        action: "targeted_recompile",
        target: "Brain",
        ok: errors.length === 0,
        details: {
          rederived: rederived.length,
          archived: archived.length,
          manual: manual.length,
          errors: errors.length,
        },
      },
      vault,
    );
  }

  return Object.freeze({
    dry_run: dryRun,
    rederived: Object.freeze(rederived),
    archived: Object.freeze(archived),
    manual: Object.freeze(manual),
    errors: Object.freeze(errors),
  });
}
