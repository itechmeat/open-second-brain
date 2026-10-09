import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { digestVerifies, sealWithDigest } from "../integrity/digest.ts";
import { appendLogEvent } from "./log.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_SNAPSHOT_REASON } from "./types.ts";
import { createSnapshot } from "./snapshot.ts";
import { isoSecond } from "./time.ts";
import { loadBrainConfig } from "./policy.ts";
import { DEFAULT_BRAIN_CONFIG } from "./policy/defaults.ts";
import { resolveAgentName } from "../config.ts";
import { loadManifest, saveManifest } from "./claude-memory-manifest.ts";
import { planAction, type PlannedFile } from "./claude-memory-plan.ts";
import { assertSafeMemoryPath, homeRelativePath } from "./claude-memory-paths.ts";
import { claudeMemoryBackend } from "./agent-backend/claude.ts";
import type { MemorySourceBackend } from "./agent-backend/types.ts";
import { BRAIN_PREFERENCES_REL, preferencePath } from "./paths.ts";
import { resolvedOwnerFor } from "./preference.ts";
import { TagSyntaxError } from "./tag-syntax.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

export interface ImportClaudeMemoryOpts {
  readonly vault: string;
  readonly memoryDir: string;
  readonly mode: "dry-run" | "apply";
  readonly allowArbitraryMemoryPath?: boolean;
  readonly now?: Date;
  /**
   * The plan digest a dry run computed and an operator approved (the CLI
   * plumbing is `--approval-digest`). Absent, apply behaves exactly as
   * it did before approval digests existed - the interactive path's
   * escape hatch. Present, it is checked against the freshly computed
   * plan BEFORE the snapshot or any write, and a mismatch is an
   * {@link ApprovalDigestError} that leaves the vault untouched.
   */
  readonly approvalDigest?: string;
  /**
   * Memory-format adapter (t_53f9f67f). Defaults to the Claude Code
   * backend - byte-identical to the pre-seam behavior. Resolve via
   * `resolveMemoryBackend()` to honor the `memory_backend` config key.
   */
  readonly backend?: MemorySourceBackend;
}

export interface ImportClaudeMemoryResult {
  readonly mode: "dry-run" | "apply";
  readonly plans: ReadonlyArray<PlannedFile>;
  readonly skipped: ReadonlyArray<{ basename: string; reason: string }>;
  readonly conflicts: ReadonlyArray<PlannedFile>;
  readonly applied: ReadonlyArray<PlannedFile>;
  readonly skippedUnchanged: ReadonlyArray<PlannedFile>;
  readonly snapshotRunId: string | null;
  readonly localDate: string;
  /**
   * The seal of the adoption plan (t_18fda844): sha256 of the plans,
   * skips, conflicts and unchanged rows, via the integrity module's
   * `sealWithDigest`. Wall-clock fields (`localDate`, the import
   * timestamps) are deliberately OUTSIDE the sealed body, so a dry run
   * and a later apply of the same content seal identically and an
   * approval binds the plan, never the moment it was printed.
   */
  readonly digest: string;
}

/**
 * The body an approval covers: what will land, what will not, and what
 * refuses. The one spelling of "the plan", shared by the dry run that
 * seals it and the apply that re-checks it.
 */
function planApprovalBody(parts: {
  plans: ReadonlyArray<PlannedFile>;
  skipped: ReadonlyArray<{ basename: string; reason: string }>;
  conflicts: ReadonlyArray<PlannedFile>;
  skippedUnchanged: ReadonlyArray<PlannedFile>;
}): Record<string, unknown> {
  return {
    conflicts: parts.conflicts,
    plans: parts.plans,
    skipped: parts.skipped,
    skipped_unchanged: parts.skippedUnchanged,
  };
}

/**
 * The apply-time refusal when the plan an operator approved no longer
 * matches the plan this run computed. Nothing has been written and no
 * snapshot has been taken; the remedy is a fresh dry run, whose digest
 * is what the next apply must carry.
 */
export class ApprovalDigestError extends Error {
  /** The digest the caller asked to apply against. */
  readonly approvalDigest: string;
  /** The digest of the plan this run just computed. */
  readonly planDigest: string;

  constructor(approvalDigest: string, planDigest: string) {
    super(
      `approval digest mismatch: the plan changed since the approved dry run ` +
        `(approved ${approvalDigest}, current plan ${planDigest}); nothing was written and ` +
        "no snapshot was taken. Re-run `o2b brain import-claude-memory --dry-run` to review " +
        "the current plan, then apply with its digest.",
    );
    this.name = "ApprovalDigestError";
    this.approvalDigest = approvalDigest;
    this.planDigest = planDigest;
  }
}

/**
 * Merge accumulated evidence fields from an existing preference file into a
 * freshly-rendered preference body. Preserves the 8 fields that track
 * evidence history so a re-import does not lose accumulated learning signals.
 *
 * Fields preserved: _applied_count, _violated_count, _evidenced_by,
 * _last_evidence_at, _confirmed_at, unconfirmed_until, pinned, scope.
 */
function mergePreservingEvidence(existingBody: string, freshBody: string): string {
  const PRESERVED = [
    "_applied_count",
    "_violated_count",
    "_evidenced_by",
    "_last_evidence_at",
    "_confirmed_at",
    "unconfirmed_until",
    "pinned",
    "scope",
  ] as const;

  // Extract key: value lines from existing frontmatter (between the --- fences).
  const fmMatch = existingBody.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return freshBody;
  const existingFm = fmMatch[1]!;

  let result = freshBody;
  for (const key of PRESERVED) {
    // Match `key: <anything up to end-of-line>` (also handles array notation).
    // Arrays in YAML inline form: `_evidenced_by: ['[[a.md]]', '[[b.md]]']`
    const existingMatch = existingFm.match(new RegExp(`^${key}:(.*)$`, "m"));
    if (!existingMatch) continue;
    const existingLine = `${key}:${existingMatch[1]!}`;
    // Replace the corresponding line in the fresh body.
    result = result.replace(new RegExp(`^${key}:.*$`, "m"), existingLine);
  }
  return result;
}

export function importClaudeMemory(opts: ImportClaudeMemoryOpts): ImportClaudeMemoryResult {
  // Vault-identity write guard (context-integrity-gates, Unit J). The
  // dry-run form writes nothing, so it stays a read and is not gated -
  // guarding a preview would refuse the very inspection an operator
  // runs to decide whether the resolved vault is the intended one.
  if (opts.mode === "apply") assertVaultIdentityForWrite(opts.vault);
  const backend = opts.backend ?? claudeMemoryBackend;
  assertSafeMemoryPath(opts.memoryDir, opts.allowArbitraryMemoryPath ?? false);
  if (!existsSync(opts.memoryDir)) {
    throw new Error(
      `memory directory not found: ${homeRelativePath(opts.memoryDir)} ` +
        `(pass --memory with an existing directory, or create it)`,
    );
  }
  const now = opts.now ?? new Date();
  const importedAt = isoSecond(now);
  const localDate = importedAt.slice(0, 10);
  // Every import lands under trial (t_sec_memory_trial): MEMORY.md is
  // session-derived - agent-writable from conversation content - so a
  // poisoned entry must not become a live rule on landing. Same window
  // source as every first-party unconfirmed write, read fail-soft.
  const unconfirmedUntil = isoSecond(addDays(now, unconfirmedWindowDays(opts.vault)));

  const manifest = loadManifest(opts.vault);
  const newImports: Record<string, { pref_id: string; sha256: string; imported_at: string }> = {
    ...manifest.imports,
  };

  const plans: PlannedFile[] = [];
  const skipped: Array<{ basename: string; reason: string }> = [];
  const filesToWrite: Array<{ plan: PlannedFile; body: string; sha256: string; slug: string }> = [];
  // Two MEMORY files with different basenames can slugify to the same
  // preference id (e.g. `feedback_no_em_dashes.md` and
  // `feedback no-em-dashes.md`). Without this guard, both would land
  // `pref-no-em-dashes.md`, and the second `atomicWriteFileSync` would
  // silently overwrite the first one. Track seen prefIds and route
  // any duplicate into the skipped list with a clear reason.
  const seenPrefIds = new Map<string, string>();

  // A backend either walks a directory of per-memory files (Claude Code) or is
  // pointed at a single export file that holds many records (mem0 / generic
  // JSON). When `memoryDir` resolves to a file, that file is the sole input and
  // its extension is trusted (the operator chose it); otherwise the backend's
  // own `discoverMemoryFiles` selects the ingestible basenames.
  const memIsFile = statSync(opts.memoryDir).isFile();
  const baseDir = memIsFile ? dirname(opts.memoryDir) : opts.memoryDir;
  const files = memIsFile
    ? [basename(opts.memoryDir)]
    : backend.discoverMemoryFiles(opts.memoryDir);

  for (const name of files) {
    const text = readFileSync(join(baseDir, name), "utf8");
    const entries = backend.parseMemoryEntries(text);
    const multi = entries.length > 1;
    entries.forEach((parsed, idx) => {
      // The manifest/dedup key is the source basename for a single-entry file
      // (byte-identical to the pre-seam Claude behavior) and `basename#slug`
      // for one of many entries in a collection file, so a single JSON export
      // maps to many preferences without colliding manifest rows.
      if (parsed.kind === "skip") {
        skipped.push({ basename: multi ? `${name}#${idx}` : name, reason: parsed.skipReason });
        return;
      }
      const slug = backend.slugifyName(parsed.name);
      const prefId = `pref-${slug}`;
      const entryKey = multi ? `${name}#${slug}` : name;
      const dupOf = seenPrefIds.get(prefId);
      if (dupOf) {
        skipped.push({
          basename: entryKey,
          reason: `duplicate target preference id ${prefId} (also produced by ${dupOf}); rename the memory entry to disambiguate`,
        });
        return;
      }
      // preferencePath adds pref- prefix itself, so pass just the slug
      const prefFile = preferencePath(opts.vault, slug);
      // Render BEFORE any plan row exists. A render that refuses THIS entry -
      // a name whose slug fails the one shared tag rule, e.g. a purely
      // numeric memory name (t_11ee559f) - is a per-entry data problem like a
      // skip parse or a duplicate id: it lands a named skip row (file and
      // rule both named) and the import continues. Rendering first keeps the
      // refusal out of `plans`, so the sealed approval body never offers a
      // file that would not land, and one legacy MEMORY file cannot abort the
      // whole run with a message that names only the field.
      let body: string;
      try {
        // This module renders its own frontmatter and writes it with
        // `atomicWriteFileSync`, so it never reaches `writePreference`
        // and never got the ownership stamp every other preference
        // writer applies (a-label-is-not-a-boundary, U3). Asking the
        // shared resolver is the fix; rendering a second copy of the
        // rule here is how the next writer would get it wrong again.
        // `prefFile` is passed so an UPDATE carries the existing owner
        // forward instead of re-owning the page, exactly as a rewrite
        // through `writePreference` does.
        body = backend.renderPreference({
          name: parsed.name,
          description: parsed.description,
          body: parsed.body,
          memoryPath: join(baseDir, name),
          importedAt,
          unconfirmedUntil,
          bodySha256: parsed.bodySha256,
          owner: resolvedOwnerFor(opts.vault, prefFile, undefined, undefined),
        });
      } catch (err) {
        if (!(err instanceof TagSyntaxError)) throw err;
        skipped.push({ basename: entryKey, reason: err.message });
        return;
      }
      seenPrefIds.set(prefId, entryKey);
      const manifestEntry = manifest.imports[entryKey];
      const plan = planAction({
        basename: entryKey,
        prefId,
        sha256: parsed.bodySha256,
        inManifest: manifestEntry ? { sha256: manifestEntry.sha256 } : null,
        prefExists: existsSync(prefFile),
      });
      plans.push(plan);
      if (plan.action === "CREATE" || plan.action === "RECREATE" || plan.action === "UPDATE") {
        filesToWrite.push({ plan, body, sha256: parsed.bodySha256, slug });
      }
    });
  }

  const conflicts = plans.filter((p) => p.action === "CONFLICT");
  const skippedUnchanged = plans.filter((p) => p.action === "SKIP_UNCHANGED");

  // Seal the adoption plan (t_18fda844). The apply below re-checks the
  // operator's approval against THIS seal before the snapshot or any
  // write, so what lands is what was approved or nothing is.
  const approvalBody = planApprovalBody({ plans, skipped, conflicts, skippedUnchanged });
  const planDigest = sealWithDigest(approvalBody).digest;

  if (opts.mode === "dry-run") {
    return {
      mode: "dry-run",
      plans,
      skipped,
      conflicts,
      applied: [],
      skippedUnchanged,
      snapshotRunId: null,
      localDate,
      digest: planDigest,
    };
  }

  // The approved plan is checked against the one just computed BEFORE
  // the snapshot/write loop. Drift between dry run and apply is the
  // case this exists for: a vault or memory source that moved in
  // between must be re-reviewed, never written over.
  if (opts.approvalDigest !== undefined && !digestVerifies(approvalBody, opts.approvalDigest)) {
    throw new ApprovalDigestError(opts.approvalDigest, planDigest);
  }

  // §E design: process the non-conflict files first; throw `ConflictsError`
  // at the end if any CONFLICT was detected. This matches design doc §E
  // line "The run still processes the remaining files; final exit code is
  // 0 only if every file is CREATE / UPDATE / RECREATE / SKIP_UNCHANGED."
  // Caller (CLI) uses the thrown error to exit 2 while the applied side
  // of the run still landed.

  let snapshotRunId: string | null = null;
  if (filesToWrite.length > 0) {
    // The run-id prefix and the recorded reason are one constant, so the
    // archive's filename can never disagree with its stamped provenance.
    const runId = `${BRAIN_SNAPSHOT_REASON.importClaudeMemory}-${importedAt.replace(/:/g, "-")}`;
    createSnapshot(opts.vault, runId, {
      reason: BRAIN_SNAPSHOT_REASON.importClaudeMemory,
      now,
    });
    snapshotRunId = runId;
  }

  const applied: PlannedFile[] = [];
  if (filesToWrite.length > 0) {
    mkdirSync(join(opts.vault, BRAIN_PREFERENCES_REL), { recursive: true });
  }
  for (const { plan, body: freshBody, sha256, slug } of filesToWrite) {
    const prefFile = preferencePath(opts.vault, slug);
    let finalBody = freshBody;
    if (plan.action === "UPDATE") {
      // Preserve evidence fields by merging frontmatter.
      finalBody = mergePreservingEvidence(readFileSync(prefFile, "utf8"), freshBody);
    }
    atomicWriteFileSync(prefFile, finalBody);
    newImports[plan.basename] = { pref_id: plan.prefId, sha256, imported_at: importedAt };
    applied.push(plan);
  }

  // Only persist the manifest and emit a log event if the run actually
  // did something (wrote files OR observed conflicts). A no-op apply
  // (every plan SKIP_UNCHANGED, no conflicts) should not bloat the log.
  const didSomething = applied.length > 0 || conflicts.length > 0;
  if (didSomething) {
    saveManifest(opts.vault, { version: 1, imports: newImports });

    const counts = {
      created: plans.filter((p) => p.action === "CREATE").length,
      updated: plans.filter((p) => p.action === "UPDATE").length,
      recreated: plans.filter((p) => p.action === "RECREATE").length,
      skipped_unchanged: skippedUnchanged.length,
      skipped_non_feedback: skipped.length,
      conflicts: conflicts.length,
    };
    appendLogEvent(opts.vault, {
      timestamp: importedAt,
      eventType: BRAIN_LOG_EVENT_KIND.importClaudeMemory,
      body: {
        created: String(counts.created),
        updated: String(counts.updated),
        recreated: String(counts.recreated),
        skipped_unchanged: String(counts.skipped_unchanged),
        skipped_non_feedback: String(counts.skipped_non_feedback),
        conflicts: String(counts.conflicts),
        snapshot: snapshotRunId ?? "none",
        agent: resolveAgentName(),
      },
    });
  }

  if (conflicts.length > 0) {
    // Throw AFTER landing the safe writes so partial progress is preserved.
    // The error carries the conflict list; the CLI prints them and exits 2.
    throw new ConflictsError(conflicts, {
      applied,
      skipped,
      skippedUnchanged,
      snapshotRunId,
      localDate,
    });
  }

  return {
    mode: "apply",
    plans,
    skipped,
    conflicts,
    applied,
    skippedUnchanged,
    snapshotRunId,
    localDate,
    digest: planDigest,
  };
}

export interface ConflictsPartialProgress {
  readonly applied: ReadonlyArray<PlannedFile>;
  readonly skipped: ReadonlyArray<{ basename: string; reason: string }>;
  readonly skippedUnchanged: ReadonlyArray<PlannedFile>;
  readonly snapshotRunId: string | null;
  readonly localDate: string;
}

export class ConflictsError extends Error {
  readonly conflicts: ReadonlyArray<PlannedFile>;
  readonly partial: ConflictsPartialProgress | null;
  constructor(
    conflicts: ReadonlyArray<PlannedFile>,
    partial: ConflictsPartialProgress | null = null,
  ) {
    super(`import-claude-memory: ${conflicts.length} conflict(s)`);
    this.conflicts = conflicts;
    this.partial = partial;
  }
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * The trial window an import grants, in days. Same source as every
 * first-party unconfirmed write (`dream.unconfirmed_window_days`), read
 * fail-soft for the same reason the restore's is: a vault with no
 * readable `_brain.yaml` still gets the shipped default, not a live rule.
 */
function unconfirmedWindowDays(vault: string): number {
  try {
    return loadBrainConfig(vault).dream.unconfirmed_window_days;
  } catch {
    return DEFAULT_BRAIN_CONFIG.dream.unconfirmed_window_days;
  }
}
