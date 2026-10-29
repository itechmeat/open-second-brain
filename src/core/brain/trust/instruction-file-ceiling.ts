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
 *
 * This is an EXISTENCE loop, not a precedence order (t_00b617b6 sweep):
 * it asks which of the known instruction files exist and how long each
 * runs, and the order here (CLAUDE.md first) is only warning reporting
 * order - no host is claimed to read these in this sequence. The
 * reading-order question, which file an operative host actually reads,
 * belongs to `HOST_INSTRUCTION_PRECEDENCE` beside `AGENT_INSTRUCTION_FILES`
 * in `src/core/brain/writeback-contract.ts`. The tree carries exactly the
 * three instruction-file lists (this existence loop, the write-back
 * contract audit's candidate list, and `ROOT_INSTRUCTION_FILES` in
 * `src/core/brain/doctor/removed-tool-checks.ts`) plus that one precedence
 * table referencing them; they cross-reference instead of unifying, so no
 * fourth divergent list appears. Open question, recorded rather than
 * resolved: whether gemini-cli reads `GEMINI.md` at all is name-implied
 * only (see the precedence table's docblock), and this list includes it
 * where the removed-tool sweep's list omits it - possibly deliberate,
 * to be answered behaviorally as a follow-up, never by a silent merge.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { InstructionFileCeilingWarning } from "../types.ts";

const TRACKED_FILES: ReadonlyArray<string> = Object.freeze(["CLAUDE.md", "AGENTS.md", "GEMINI.md"]);

export interface CheckInstructionFileCeilingOptions {
  readonly maxLines: number;
  /**
   * The vault-relative paths the reader may read. A file it rejects is
   * skipped before it is read, so its existence and length cross no
   * answer. Absent: every tracked file.
   */
  readonly readable?: (rel: string) => boolean;
}

export function checkInstructionFileCeiling(
  vault: string,
  opts: CheckInstructionFileCeilingOptions,
): ReadonlyArray<InstructionFileCeilingWarning> {
  const warnings: InstructionFileCeilingWarning[] = [];
  for (const name of TRACKED_FILES) {
    if (opts.readable !== undefined && !opts.readable(name)) continue;
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
