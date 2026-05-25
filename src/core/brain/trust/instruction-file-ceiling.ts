/**
 * Instruction-file compliance ceiling (v0.10.16).
 *
 * Vault-root instruction files (`CLAUDE.md`, `AGENTS.md`,
 * `GEMINI.md`) keep agents pointed at the project's norms. Past a
 * line-count ceiling, compliance drops sharply because important
 * rules get buried in noise. This helper walks a fixed list of
 * tracked filenames at the vault root and returns a warning for
 * each one that exceeds the configured ceiling.
 *
 * The list is intentionally short and explicit - discovery is by
 * existence, not by pattern. Files that are not present return no
 * warning. Empty files return no warning either (zero is not above
 * any non-negative ceiling).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { InstructionFileCeilingWarning } from "../doctor.ts";

const TRACKED_FILES: ReadonlyArray<string> = Object.freeze([
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
]);

export interface CheckInstructionFileCeilingOptions {
  readonly maxLines: number;
}

export function checkInstructionFileCeiling(
  vault: string,
  opts: CheckInstructionFileCeilingOptions,
): ReadonlyArray<InstructionFileCeilingWarning> {
  const warnings: InstructionFileCeilingWarning[] = [];
  for (const name of TRACKED_FILES) {
    const absolute = join(vault, name);
    if (!existsSync(absolute)) continue;
    try {
      const stat = statSync(absolute);
      if (!stat.isFile()) continue;
    } catch {
      // Race: file vanished between existsSync and statSync. Skip.
      continue;
    }
    let content: string;
    try {
      content = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (content.length === 0) continue;
    const lines = countLines(content);
    if (lines > opts.maxLines) {
      warnings.push(
        Object.freeze({
          path: name,
          lines,
          ceiling: opts.maxLines,
        }),
      );
    }
  }
  return Object.freeze(warnings);
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  // Count `\n` and add one when the file does not end with one.
  let n = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 0x0a) n += 1;
  }
  if (content.charCodeAt(content.length - 1) !== 0x0a) n += 1;
  return n;
}
