/**
 * Write-time absolute-path advisory (p4-silent-failure-hardening, Task 3).
 *
 * A note body embedding an absolute home path used to land with no word
 * about it: the egress redactor works on OUTBOUND tool output, the
 * hygiene scanner runs CI-only over the repo tree, and the write seam
 * - the one moment the authoring agent is listening - said nothing. This
 * module closes that hole the same way the write-time page lint does:
 * an advisory computed at the write, carried on the receipt, never a
 * refusal. A write that embeds a home path still lands; the receipt says
 * so, and the next call can do better.
 *
 * The grammar is {@link scanText} from core/hygiene/hardcoded-paths.ts,
 * reused AS-IS rather than widened: its detectors (POSIX and Windows home
 * prefixes naming a specific account), its placeholder-segment filter
 * (`alice`, `user`, `you`, ... are intended examples, not leaks), its
 * home-prefix scope, and the `hygiene:allow-path` escape hatch are all
 * the hygiene module's decisions and stay there. Widening any of them is
 * a hygiene-module change that this lane must not shadow.
 *
 * Scope: the AUTHORED content of one call (a create's body, an update's
 * replacement body, an append's text) - the bytes this caller is asking
 * to put into the vault. Body only: frontmatter values are never
 * scanned, whether or not the caller named them, and bytes already on
 * disk are not this call's authorship either. Log-line and evidence ops are machine-composed, not authored,
 * and never reach this module.
 *
 * Shape, and the two rules the receipt inherits from page-lint:
 *
 *   - byte-identical-when-absent - a clean scan contributes NO field,
 *     so a receipt for a clean write is exactly the receipt that shipped
 *     before this module existed;
 *   - identifiers and integers only - a finding names the vault-relative
 *     page, the 1-based line within the authored text, and the detector.
 *     The matched path fragment (an operator home directory) is
 *     deliberately dropped, the same leak `writeFrontmatterAtomic`'s
 *     error re-wrap closes.
 *
 * The scan is over the authored string alone, so `line` indexes THAT
 * string - line 1 is the first line the caller sent, not the first line
 * of the file it lands in.
 */

import { scanText, type HardcodedPathDetector } from "../hygiene/hardcoded-paths.ts";

/** Key under which the advisory rides a note-write result or MCP receipt. */
export const WRITE_PATH_ADVISORY_KEY = "path_advisory";

/** One hit, composed from identifiers and integers only. */
export interface WritePathAdvisoryFinding {
  /** Vault-relative page the authored content lands in. */
  readonly page: string;
  /** 1-based line within the authored text (not within the note). */
  readonly line: number;
  /** Which hygiene detector fired. */
  readonly detector: HardcodedPathDetector;
}

/** The advisory payload: every hit, with the total a reader can count on. */
export interface WritePathAdvisoryReport {
  readonly total: number;
  readonly findings: ReadonlyArray<WritePathAdvisoryFinding>;
}

/**
 * The optional advisory field. Absent - the key itself, not an empty
 * report - when the authored content is clean, so consumers pinning the
 * receipt's key set see no change.
 */
export type WritePathAdvisoryField = Readonly<{
  readonly [WRITE_PATH_ADVISORY_KEY]?: WritePathAdvisoryReport;
}>;

/**
 * Scan one call's authored note content for absolute home paths and
 * render the advisory field for a write result targeting `page`.
 *
 * Returns the empty field (no key at all) when there is nothing authored
 * or nothing found, so callers spread this straight into the result:
 * `...writePathAdvisoryField(op.content, target.relPath)`. Never throws,
 * never gates the write - the caller keeps committing regardless of what
 * this finds.
 */
export function writePathAdvisoryField(
  authored: string | undefined,
  page: string,
): WritePathAdvisoryField {
  if (authored === undefined || authored.length === 0) return {};
  const findings = scanText(authored, page).map((finding) => ({
    page,
    line: finding.line,
    detector: finding.detector,
  }));
  if (findings.length === 0) return {};
  return Object.freeze({
    [WRITE_PATH_ADVISORY_KEY]: Object.freeze({
      total: findings.length,
      findings: Object.freeze(findings),
    }),
  });
}
