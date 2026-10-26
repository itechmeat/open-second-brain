/**
 * `o2b brain validate --paths <p>... | --dirty` - the standalone
 * validation gate (t_dc782fd5, task C4).
 *
 * An agent that patches vault files outside a hook or a tool call has
 * had no way to block its own commit: `brain lint` always exits 0 and
 * `brain doctor` is a whole-vault invariant pass that cannot be pointed
 * at a subset. This verb is the gate. It runs the EXACT write-receipt
 * page-lint vocabulary over a caller-named page set - the same
 * `lintWrittenPages` pass a note-write receipt carries, plus nothing
 * new - and maps findings onto doctor's exit contract, so both gates
 * share one document:
 *
 *   - an `error` finding blocks: exit 1;
 *   - warnings block only under `--strict`: exit 2;
 *   - a page the caller NAMED that the lint could not read (skipped as
 *     `page-unreadable` or `page-lint-failed`) is itself blocking: a
 *     gate that could not read what it was pointed at may not report
 *     clean. An `page-over-byte-cap` skip is reported and non-blocking
 *     - the content was measured, it is just too big to read whole;
 *   - clean: exit 0.
 *
 * The verb is read-only and non-interactive by construction: no prompts,
 * therefore no `--yes`, and no fix modes - report-only in v1, with each
 * finding's existing `next_command` pointing at the established fixers
 * (`brain doctor --repair --apply`, `brain lint --consolidate --apply`).
 * A third fix vocabulary is the failure mode the card warns about.
 *
 * The documented split from doctor: doctor is the whole-vault structural
 * invariant pass (config, ids, logs, drift, store integrity) with repair
 * modes; validate is per-page authored-content lint over a named subset,
 * no vault walk beyond those pages, with the exit code as the product.
 */

import {
  PAGE_LINT_SKIP_REASON,
  lintWrittenPages,
  type PageLintReport,
} from "../../../core/brain/page-lint.ts";
import { READ_ALL_REFS } from "../../../core/brain/near-duplicate.ts";
import {
  VaultDirtyError,
  listDirtyMarkdownPaths,
  vaultRelativeOrNull,
} from "../../../core/brain/vault-dirty.ts";
import { brainVerbContext, ok, okJson, parse, usageError } from "../helpers.ts";

const USAGE =
  "usage: o2b brain validate --paths <path> [--paths <path>...] [--strict] [--vault <path>] [--json]\n" +
  "       o2b brain validate --dirty [--strict] [--vault <path>] [--json]\n" +
  "\n" +
  "Exactly one of --paths / --dirty: an explicit vault-relative page set, or\n" +
  "every git-dirty Markdown note under the vault. --paths is repeatable, one\n" +
  "flag per page. Errors exit 1; warnings exit 2 under --strict; a named page\n" +
  "the lint could not read exits 1; clean exits 0. Report-only - the fixers\n" +
  "stay `brain doctor --repair --apply` and `brain lint --consolidate --apply`,\n" +
  "which the findings' next_command name.";

const SELECTION_RULE = "brain validate needs exactly one of --paths / --dirty";

/** Whether the report means "blocked", under the strictness in force. */
function blockingSkips(report: PageLintReport): ReadonlyArray<string> {
  return report.skipped
    .filter(
      (s) =>
        s.reason === PAGE_LINT_SKIP_REASON.unreadable ||
        s.reason === PAGE_LINT_SKIP_REASON.lintFailed,
    )
    .map((s) => s.page);
}

export async function cmdBrainValidate(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    paths: { type: "string-array" },
    dirty: { type: "boolean" },
    strict: { type: "boolean" },
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const asJson = flags["json"] === true;
  const strict = flags["strict"] === true;
  // The schema declares `paths` a string-array; the flags record's value
  // union is wider, so the read narrows it the way every sibling verb does.
  const paths = flags["paths"] as string[] | undefined;
  const dirty = flags["dirty"] === true;
  if (paths !== undefined && paths.length > 0 && dirty) {
    return usageError(`${SELECTION_RULE}, never both\n\n${USAGE}`);
  }
  if ((paths === undefined || paths.length === 0) && !dirty) {
    return usageError(
      `${SELECTION_RULE} (whole-vault validation stays brain doctor's job)\n\n${USAGE}`,
    );
  }
  if (positional.length > 0) {
    return usageError(
      `brain validate takes no positional arguments (got ${JSON.stringify(positional[0])})`,
    );
  }
  const { vault } = brainVerbContext(flags);

  let selection: "paths" | "dirty";
  let pages: ReadonlyArray<string>;
  if (dirty) {
    selection = "dirty";
    try {
      pages = listDirtyMarkdownPaths(vault);
    } catch (err) {
      if (err instanceof VaultDirtyError) return usageError(err.message);
      throw err;
    }
  } else {
    selection = "paths";
    const named: string[] = [];
    for (const raw of paths ?? []) {
      const rel = vaultRelativeOrNull(vault, raw);
      if (rel === null) {
        return usageError(
          `brain validate --paths: ${JSON.stringify(raw)} resolves outside the vault`,
        );
      }
      named.push(rel);
    }
    pages = named;
  }

  // Operator reach: the gate is run by the operator or an agent with the
  // operator's rights, so every vault page is readable - the same
  // `READ_ALL_REFS` the doctor's own lint callers pass.
  const report = lintWrittenPages(vault, pages, { readable: READ_ALL_REFS });

  const errors = report.findings.filter((f) => f.severity === "error");
  const warnings = report.findings.filter((f) => f.severity === "warning");
  const unread = blockingSkips(report);
  const gate =
    report.unavailable !== undefined ||
    errors.length > 0 ||
    unread.length > 0 ||
    (strict && warnings.length > 0);

  // Errors, unreadable named pages and a lint that could not run at all
  // are exit 1; only the strict-warnings block reads exit 2, matching
  // the doctor contract's one meaning for each code.
  const exit = !gate
    ? 0
    : errors.length > 0 || unread.length > 0 || report.unavailable !== undefined
      ? 1
      : 2;

  if (asJson) {
    // The PageLintReport field names verbatim - the shape a write
    // receipt carries - plus the gate's own verdict. No advisory-rail
    // lines under --json.
    okJson({
      ok: !gate,
      selection,
      strict,
      selected: pages.length,
      total: report.total,
      returned: report.returned,
      truncated: report.truncated,
      findings: report.findings,
      skipped: report.skipped,
      ...(report.unavailable !== undefined ? { unavailable: report.unavailable } : {}),
    });
    return exit;
  }

  ok(`validate: ${pages.length} page(s) selected (${selection}${strict ? ", strict" : ""})`);
  for (const p of pages) ok(`  linted ${p}`);
  if (report.unavailable !== undefined) {
    ok(`the lint could not run: ${report.unavailable.code} (${report.unavailable.message})`);
    return 1;
  }
  for (const f of report.findings) {
    ok(`  ${f.severity} ${f.page} ${f.code}: ${f.message}`);
    if (f.next_command !== undefined) ok(`    next: ${f.next_command}`);
  }
  for (const s of report.skipped) {
    ok(`  skipped ${s.page} (${s.reason}: ${s.detail})`);
  }
  if (errors.length > 0 || unread.length > 0) {
    ok(
      `blocked: ${errors.length} error(s)` +
        (unread.length > 0 ? `, ${unread.length} unreadable page(s)` : ""),
    );
    return 1;
  }
  if (strict && warnings.length > 0) {
    ok(`blocked under --strict: ${warnings.length} warning(s)`);
    return 2;
  }
  ok(
    warnings.length > 0
      ? `ok with ${warnings.length} warning(s) (re-run with --strict to block on them)`
      : "ok: nothing to say",
  );
  return 0;
}
