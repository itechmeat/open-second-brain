/**
 * The `notes:` block — the user-authored folders the agent may READ.
 *
 * One reason to change: how the operator opts folders into the agent's
 * read scope. Agents never write to these paths, so the whole surface is
 * a list of vault-relative folders and the rules that keep that list
 * inside the vault.
 */

import type { BrainConfig, BrainNotesConfig, ResolvedBrainNotesConfig } from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { describe, requireArrayField } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const BLOCK = "notes";

/**
 * Default `notes:` block (v0.11.0). Empty `read_paths` list means
 * the agent does not scan any user-authored notes. The operator
 * opts in by listing folders in `_brain.yaml`.
 */
export const BRAIN_NOTES_DEFAULTS: ResolvedBrainNotesConfig = Object.freeze({
  read_paths: Object.freeze([]) as ReadonlyArray<string>,
}) as ResolvedBrainNotesConfig;

/**
 * Merge a parsed `notes` block (or `undefined`) with
 * `BRAIN_NOTES_DEFAULTS`. The resulting struct (and its inner array)
 * are frozen so consumers can pass the slice around without copying.
 */
export function resolveNotes(cfg: BrainConfig): ResolvedBrainNotesConfig {
  const block = cfg.notes;
  if (block === undefined || block.read_paths === undefined) {
    return BRAIN_NOTES_DEFAULTS;
  }
  return Object.freeze({
    read_paths: Object.freeze([...block.read_paths]) as ReadonlyArray<string>,
  }) as ResolvedBrainNotesConfig;
}

/**
 * Shape:
 *   notes:
 *     read_paths:
 *       - Daily
 *       - Journal/Weekly
 */
export function parseNotesBlock(ctx: BlockParseContext): BrainNotesConfig | undefined {
  const notesObj = openBlock(ctx, BLOCK);
  if (notesObj === undefined) return undefined;

  const partial: Record<string, unknown> = {};
  if ("read_paths" in notesObj) {
    const list = requireArrayField(
      notesObj["read_paths"],
      "notes.read_paths",
      ctx.source,
      "must be an array of vault-relative folder paths",
    );
    partial["read_paths"] = list.map((entry, idx) =>
      cleanReadPath(entry, `notes.read_paths[${idx}]`, ctx.source),
    );
  }
  warnUnknownKeys(ctx, notesObj, ["read_paths"], BLOCK);
  return partial as BrainNotesConfig;
}

function cleanReadPath(entry: unknown, field: string, source: string | null): string {
  if (typeof entry !== "string") {
    throw new BrainConfigError(`must be a string; got ${describe(entry)}`, field, source);
  }
  const trimmed = entry.trim();
  if (trimmed.length === 0) {
    throw new BrainConfigError("must be a non-empty string", field, source);
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    throw new BrainConfigError("must be a vault-relative path (no leading slash)", field, source);
  }
  if (trimmed.split(/[\\/]/).some((s) => s === "..")) {
    throw new BrainConfigError("must not contain '..' segments", field, source);
  }
  return trimmed;
}
