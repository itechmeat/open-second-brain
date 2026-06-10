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

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import { appendAuditRecord } from "../reliability/audit.ts";
import { scanFreshness } from "./freshness.ts";
import { writeHandoffNote } from "./handoff.ts";
import { brainDirs, BRAIN_SNAPSHOTS_REL } from "./paths.ts";
import { detectAdapter } from "./sessions/registry.ts";
import type { SessionTurn } from "./sessions/types.ts";
import { isoDate } from "./time.ts";
import { parseFrontmatter } from "../vault.ts";

export type RecompileEntryKind = "rederive-handoff" | "cleanup" | "manual";

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
export function planRecompile(vault: string): RecompilePlan {
  const freshness = scanFreshness(vault);
  const entries: RecompileEntry[] = [];

  for (const stale of freshness.stale) {
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
  const dir = join(vault, BRAIN_SNAPSHOTS_REL, `hygiene-${isoDate(now)}`);
  mkdirSync(dir, { recursive: true });
  let target = join(dir, basename(page));
  let suffix = 1;
  while (existsSync(target)) {
    target = join(dir, `${basename(page, ".md")}-${suffix}.md`);
    suffix++;
  }
  renameSync(page, target);
  return target;
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

  if (!dryRun && (rederived.length > 0 || archived.length > 0 || errors.length > 0)) {
    appendAuditRecord(join(brainDirs(vault).log, "hygiene"), {
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
    });
  }

  return Object.freeze({
    dry_run: dryRun,
    rederived: Object.freeze(rederived),
    archived: Object.freeze(archived),
    manual: Object.freeze(manual),
    errors: Object.freeze(errors),
  });
}
