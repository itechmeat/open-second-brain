import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { appendLogEvent } from "./log.ts";
import { BRAIN_LOG_EVENT_KIND } from "./types.ts";
import { createSnapshot } from "./snapshot.ts";
import { isoSecond } from "./time.ts";
import { resolveAgentName } from "../config.ts";
import { loadManifest, saveManifest } from "./claude-memory-manifest.ts";
import { planAction, type PlannedFile } from "./claude-memory-plan.ts";
import { assertSafeMemoryPath } from "./claude-memory-paths.ts";
import { claudeMemoryBackend } from "./agent-backend/claude.ts";
import type { MemorySourceBackend } from "./agent-backend/types.ts";
import { BRAIN_PREFERENCES_REL, preferencePath } from "./paths.ts";

export interface ImportClaudeMemoryOpts {
  readonly vault: string;
  readonly memoryDir: string;
  readonly mode: "dry-run" | "apply";
  readonly allowArbitraryMemoryPath?: boolean;
  readonly now?: Date;
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
  const backend = opts.backend ?? claudeMemoryBackend;
  assertSafeMemoryPath(opts.memoryDir, opts.allowArbitraryMemoryPath ?? false);
  if (!existsSync(opts.memoryDir)) {
    throw new Error(`memory directory not found: ${opts.memoryDir}`);
  }
  const now = opts.now ?? new Date();
  const importedAt = isoSecond(now);
  const localDate = importedAt.slice(0, 10);

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
      seenPrefIds.set(prefId, entryKey);
      // preferencePath adds pref- prefix itself, so pass just the slug
      const prefFile = preferencePath(opts.vault, slug);
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
        const body = backend.renderPreference({
          name: parsed.name,
          description: parsed.description,
          body: parsed.body,
          memoryPath: join(baseDir, name),
          importedAt,
          bodySha256: parsed.bodySha256,
        });
        filesToWrite.push({ plan, body, sha256: parsed.bodySha256, slug });
      }
    });
  }

  const conflicts = plans.filter((p) => p.action === "CONFLICT");
  const skippedUnchanged = plans.filter((p) => p.action === "SKIP_UNCHANGED");

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
    };
  }

  // §E design: process the non-conflict files first; throw `ConflictsError`
  // at the end if any CONFLICT was detected. This matches design doc §E
  // line "The run still processes the remaining files; final exit code is
  // 0 only if every file is CREATE / UPDATE / RECREATE / SKIP_UNCHANGED."
  // Caller (CLI) uses the thrown error to exit 2 while the applied side
  // of the run still landed.

  let snapshotRunId: string | null = null;
  if (filesToWrite.length > 0) {
    const runId = `import-claude-memory-${importedAt.replace(/:/g, "-")}`;
    createSnapshot(opts.vault, runId);
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
