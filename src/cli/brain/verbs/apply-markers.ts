/**
 * `o2b brain apply-markers` - `@osb set` marker write-back verb
 * (today-operator-surface, t_d7be2a0c).
 *
 * Default is report mode (no writes): it lists every pending `set` marker
 * with its resolved target and validation verdict. `--apply` performs the
 * mutations; that path requires the `marker_writeback` guardrail, and the
 * engine's typed refusal (with the flag name) surfaces here as a clear
 * operator-facing error with a non-zero exit.
 *
 * The file list is composed with the shared note walker - explicit
 * repeatable `--path` narrows the roots, mirroring `scan-inline`; absent
 * paths fall back to `notes.read_paths`. The engine then does discovery,
 * fail-closed target resolution, guarded apply, auditing, and marker
 * consumption over that list. Clock resolved at the CLI boundary.
 */

import {
  applyMarkerWritebacks,
  MarkerWritebackGuardrailError,
  type MarkerWritebackEntry,
} from "../../../core/brain/marker-writeback.ts";
import {
  buildNoteWalkRules,
  resolveNoteRoots,
  walkMarkdownFiles,
} from "../../../core/brain/notes/note-walk.ts";
import { brainVerbContext, fail, ok, okJson, parse, resolveBrainAgent } from "../helpers.ts";

/** 1 MiB read cap, matching `scanInline`'s size limit for note walks. */
const MAX_FILE_SIZE_BYTES = 1024 * 1024;

function entryJson(entry: MarkerWritebackEntry): Record<string, unknown> {
  return {
    status: entry.status,
    source_path: entry.sourcePath,
    source_line: entry.sourceLine,
    target: entry.rawTarget,
    field: entry.field,
    value: entry.value,
    resolved_path: entry.resolvedPath,
    prior_value: entry.priorValue,
    error: entry.error,
    error_code: entry.errorCode,
    candidates: entry.candidates,
  };
}

function renderEntryLine(entry: MarkerWritebackEntry): string {
  const base =
    `- ${entry.status}  ${entry.sourcePath}:${entry.sourceLine}  ` +
    `note=${entry.rawTarget} field=${entry.field} value=${entry.value}`;
  if (entry.status === "invalid-target" || entry.status === "invalid-field") {
    const code = entry.errorCode !== null ? ` [${entry.errorCode}]` : "";
    const candidates =
      entry.candidates.length > 0 ? ` candidates: ${entry.candidates.toSorted().join(", ")}` : "";
    return `${base}${code} - ${entry.error ?? "invalid"}${candidates}`;
  }
  return base;
}

export async function cmdBrainApplyMarkers(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    agent: { type: "string" },
    apply: { type: "boolean" },
    json: { type: "boolean" },
    path: { type: "string-array" },
  });
  const { config, vault } = brainVerbContext(flags);
  const agent = resolveBrainAgent(flags, config);
  const apply = flags["apply"] === true;

  // Compose the file list with the shared walker. Explicit --path values
  // narrow the roots; when absent the roots come from notes.read_paths.
  const explicitPaths = (flags["path"] as string[] | undefined) ?? [];
  const roots = resolveNoteRoots(vault, explicitPaths);
  const rules = buildNoteWalkRules(vault);
  const files: string[] = [];
  for (const file of walkMarkdownFiles(vault, roots, rules, {
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
  })) {
    files.push(file.relPath);
  }

  let report;
  try {
    report = await applyMarkerWritebacks(vault, { files, apply, agent, now: new Date() });
  } catch (err) {
    if (err instanceof MarkerWritebackGuardrailError) {
      return fail(`apply-markers refused (guardrail ${err.flag} is off): ${err.message}`);
    }
    return fail(`apply-markers failed: ${(err as Error).message ?? err}`);
  }

  if (flags["json"]) {
    okJson({
      apply: report.apply,
      guardrail_enabled: report.guardrailEnabled,
      applied: report.appliedCount,
      pending: report.pendingCount,
      failed: report.failedCount,
      entries: report.entries.map(entryJson),
    });
    return 0;
  }

  ok(
    `applied: ${report.appliedCount}  pending: ${report.pendingCount}  failed: ${report.failedCount}`,
  );
  for (const entry of report.entries) ok(renderEntryLine(entry));
  return 0;
}
