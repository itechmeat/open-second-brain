/**
 * Per-page write-time lint (evidence-at-the-boundary, task A4).
 *
 * A write used to land and say nothing about what it wrote. The only
 * quality pass over a page was `lintConsolidate`, a vault-wide walk
 * measured at 359 ms on a 2090-page vault, so an agent that wrote a
 * broken wikilink or a document with no frontmatter learned about it
 * from a sweep that may never run. Worse, `assertValidDocument` ran only
 * under `strict` on create: update, append and every batch operation
 * committed with NO document validation at all and returned a hardcoded
 * success flag.
 *
 * This module closes that hole with the detectors that already exist,
 * run against exactly the pages one call committed:
 *
 *   - {@link validateArtifact} for the error-severity codes, so a strict
 *     create and a linted update agree on what a valid document is.
 *   - merged-link, resolved through the canonical-id resolver rather than
 *     through a vault-wide merge map (see `lint-consolidate.ts`).
 *   - broken Brain-artifact wikilink against `collectAllBasenames`, the
 *     readdir-only basename index the doctor already builds (6 ms).
 *
 * `demote-stale-stable` is deliberately EXCLUDED, not overlooked: its
 * trigger is the page's creation age against the staleness cap, so it can
 * never fire on a page written this turn. Reporting it here would be a
 * check that is structurally incapable of finding anything.
 *
 * ## What this envelope does NOT cover, stated rather than implied
 *
 *   - `brain_write_session` keeps its own `errors[]` channel and its own
 *     correction prompt. It validates BEFORE committing and refuses, which
 *     is a different contract from an advisory computed after the fact;
 *     folding it in would give one tool two error channels.
 *   - `write-session/engine.ts` and `distill/distill-source.ts` write with
 *     their own lexical validation and bypass the note-write path
 *     entirely, so nothing here sees their bytes.
 *   - Log appends (`append_log_line`, `apply_evidence`) name no note path
 *     and are not linted: the log line is machine-composed, not authored.
 *
 * ## Shape
 *
 * The payload composes two conventions already in the codebase rather
 * than inventing a third: `WriteSessionError {code, path, message}` plus
 * a `severity` from `DoctorSeverity` plus the `next_command` idiom
 * resolved through `nextCommandField`. One field is added - `page` - for
 * the reason a batch needs it: one report spans several files, and a
 * finding that cannot name its file is unusable. `path` keeps its
 * `WriteSessionError` meaning, the location WITHIN the document.
 *
 * The report always carries `total`, `returned`, `truncated` and
 * `skipped`, so a capped list can never be read as a complete one, and a
 * page too large to validate lands in `skipped` with a reason instead of
 * vanishing.
 *
 * ## Attachment
 *
 * Modelled field for field on `write-advisory.ts`: computed AROUND the
 * write, never gating it, surfaced as an additive key that is ABSENT
 * ENTIRELY when there is nothing to say. Failure of the lint itself
 * degrades to a named {@link PageLintUnavailable} on the key rather than
 * to a missing key - an absent `lint` key must mean clean, and only that.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatterText } from "../vault.ts";
import { collectAllBasenames } from "./doctor/records.ts";
import {
  LINT_CONSOLIDATE_KIND,
  createMergedLinkResolver,
  type MergedLinkResolver,
} from "./lint-consolidate.ts";
import { nextCommandField, type NextCommandField } from "./next-step.ts";
import { loadSchemaPack } from "./schema-pack.ts";
import type { BrainSchemaVocabulary } from "./schema-vocab.ts";
import type { DoctorSeverity } from "./types.ts";
import { WIKILINK_TARGET_RE, isBrainArtifactId, normaliseWikilinkTarget } from "./wikilink.ts";
import { ARTIFACT_MAX_BYTES, validateArtifact } from "./write-session/validate.ts";

/** The additive JSON key every write surface carries the report in. */
export const PAGE_LINT_KEY = "lint";

/**
 * Longest finding list a write receipt carries. A write response is read
 * inline by the agent that made the write; past a couple of dozen lines
 * it stops being a fix list and becomes a payload. Everything beyond the
 * cap is still COUNTED - see `total` and `truncated`.
 */
export const PAGE_LINT_MAX_FINDINGS = 25;

/** Code the lint reports itself under when it could not run at all. */
export const PAGE_LINT_UNAVAILABLE_CODE = "page-lint-unavailable";

/** The doctor code an unresolvable Brain wikilink is already reported as. */
const BROKEN_WIKILINK_CODE = "broken-wikilink";

/** Why a written page was not linted. Never a silent omission. */
export const PAGE_LINT_SKIP_REASON = Object.freeze({
  overByteCap: "page-over-byte-cap",
  unreadable: "page-unreadable",
} as const);

export type PageLintSkipReason = (typeof PAGE_LINT_SKIP_REASON)[keyof typeof PAGE_LINT_SKIP_REASON];

/** Rank by severity: errors are what a strict create would have refused. */
const SEVERITY_RANK: Readonly<Record<DoctorSeverity, number>> = Object.freeze({
  error: 0,
  warning: 1,
});

/**
 * One finding about one written page. `code`, `path` and `message` are
 * the `WriteSessionError` triple verbatim; `severity` and `next_command`
 * are the two conventions layered on top; `page` names the file.
 */
export interface PageLintFinding extends NextCommandField {
  readonly severity: DoctorSeverity;
  readonly code: string;
  /** Vault-relative path of the page the finding is about. */
  readonly page: string;
  /** Location within the document: `body`, `frontmatter`, `tags`, or a link target. */
  readonly path: string;
  readonly message: string;
}

/** A written page the lint did not read, and why. */
export interface PageLintSkip {
  readonly page: string;
  readonly reason: PageLintSkipReason;
  /** The measurement or errno behind the skip, so the reason is checkable. */
  readonly detail: string;
}

/** The lint itself failed. Reported, never swallowed into an absent key. */
export interface PageLintUnavailable {
  readonly code: string;
  readonly message: string;
}

export interface PageLintReport {
  /** Ranked, capped at {@link PAGE_LINT_MAX_FINDINGS}. */
  readonly findings: ReadonlyArray<PageLintFinding>;
  /** Findings detected, including those the cap dropped. */
  readonly total: number;
  /** Findings actually carried in {@link findings}. */
  readonly returned: number;
  /** True iff `total > returned`. */
  readonly truncated: boolean;
  /** Written pages that were not linted, each with its reason. */
  readonly skipped: ReadonlyArray<PageLintSkip>;
  /** Present iff the lint could not run; the counters above are then zero. */
  readonly unavailable?: PageLintUnavailable;
}

/**
 * Rank findings: errors ahead of warnings (an error is what a strict
 * create would have refused), then page, then code, then location. Named
 * and exported once so a CLI surface and an MCP surface cannot drift into
 * two orderings of one list.
 */
export function comparePageLintFindings(a: PageLintFinding, b: PageLintFinding): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.page.localeCompare(b.page) ||
    a.code.localeCompare(b.code) ||
    a.path.localeCompare(b.path)
  );
}

function finding(
  severity: DoctorSeverity,
  code: string,
  page: string,
  path: string,
  message: string,
): PageLintFinding {
  return Object.freeze({ severity, code, page, path, message, ...nextCommandField(code) });
}

/**
 * The schema type the document declares, or `null`. Mirrors
 * `assertValidDocument`: the validator judges the declared type against
 * the pack, and a document whose frontmatter will not parse is already
 * reported by the validator itself.
 */
function declaredSchemaType(raw: string): string | null {
  try {
    const [meta] = parseFrontmatterText(raw);
    const declared = meta["type"];
    return typeof declared === "string" && declared.trim() !== "" ? declared : null;
  } catch {
    return null;
  }
}

/**
 * Every distinct wikilink target on the page, in first-appearance order.
 * Distinct rather than per-occurrence: a page that names one dead target
 * five times has one thing wrong with it, and five identical rows would
 * spend the finding cap saying so.
 */
function distinctLinkTargets(raw: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  for (const match of raw.matchAll(WIKILINK_TARGET_RE)) {
    const target = normaliseWikilinkTarget(match[1] ?? "");
    if (target !== "") seen.add(target);
  }
  return [...seen];
}

/** Everything the lint computes once per call and threads per page. */
interface LintContext {
  readonly basenames: ReadonlySet<string>;
  readonly vocabulary: BrainSchemaVocabulary;
  readonly mergedLinks: MergedLinkResolver;
}

function lintOnePage(ctx: LintContext, page: string, raw: string): PageLintFinding[] {
  const out: PageLintFinding[] = [];
  const schemaType = declaredSchemaType(raw);
  for (const violation of validateArtifact(raw, { schemaType, vocabulary: ctx.vocabulary })) {
    out.push(finding("error", violation.code, page, violation.path, violation.message));
  }
  for (const target of distinctLinkTargets(raw)) {
    // A link outside the Brain id space is user prose or a cross-layer
    // note, and is nobody's here to flag - the same boundary the doctor
    // and the orphaned-reference fixer draw.
    if (!isBrainArtifactId(target)) continue;
    const merged = ctx.mergedLinks.resolve(target);
    if (merged.unresolvable !== null) {
      out.push(
        finding(
          "warning",
          LINT_CONSOLIDATE_KIND.mergedLink,
          page,
          target,
          `wikilink [[${target}]] has a merge chain with no canonical end: ${merged.unresolvable}`,
        ),
      );
      continue;
    }
    if (merged.canonical !== null) {
      out.push(
        finding(
          "warning",
          LINT_CONSOLIDATE_KIND.mergedLink,
          page,
          target,
          `wikilink [[${target}]] points at a page merged into ${merged.canonical}`,
        ),
      );
      continue;
    }
    if (!ctx.basenames.has(target)) {
      out.push(
        finding(
          "warning",
          BROKEN_WIKILINK_CODE,
          page,
          target,
          `wikilink [[${target}]] resolves to no Brain artifact`,
        ),
      );
    }
  }
  return out;
}

/** The empty report: nothing detected, nothing skipped, nothing to say. */
function emptyReport(unavailable?: PageLintUnavailable): PageLintReport {
  return Object.freeze({
    findings: Object.freeze([]),
    total: 0,
    returned: 0,
    truncated: false,
    skipped: Object.freeze([]),
    ...(unavailable !== undefined ? { unavailable } : {}),
  });
}

/**
 * Lint exactly the pages a write committed, reading what is on disk.
 *
 * Runs AFTER the commit on purpose: the batch kernel wrote the bytes and
 * the handler never composed them, so the only honest subject is the
 * file. It never gates the write and it NEVER throws - a failure of the
 * lint is reported as {@link PageLintReport.unavailable}.
 *
 * Cost discipline: the basename index and the schema pack are computed
 * ONCE per call and threaded, the merge resolver memoises per call, and
 * nothing here walks vault content.
 */
export function lintWrittenPages(vault: string, pages: ReadonlyArray<string>): PageLintReport {
  if (pages.length === 0) return emptyReport();
  let ctx: LintContext;
  try {
    ctx = {
      basenames: collectAllBasenames(vault),
      vocabulary: loadSchemaPack(vault).vocabulary,
      mergedLinks: createMergedLinkResolver(vault),
    };
  } catch (err) {
    return emptyReport({
      code: PAGE_LINT_UNAVAILABLE_CODE,
      message: `write-time page lint could not start: ${(err as Error).message}`,
    });
  }

  const detected: PageLintFinding[] = [];
  const skipped: PageLintSkip[] = [];
  for (const page of pages) {
    const absolute = join(vault, page);
    let raw: string;
    try {
      // Size first, from the inode: an over-cap page must be REPORTED as
      // skipped, and reading it to find that out is the cost the cap
      // exists to avoid.
      const bytes = statSync(absolute).size;
      if (bytes > ARTIFACT_MAX_BYTES) {
        skipped.push(
          Object.freeze({
            page,
            reason: PAGE_LINT_SKIP_REASON.overByteCap,
            detail: `${bytes} bytes exceeds the ${ARTIFACT_MAX_BYTES}-byte artifact cap`,
          }),
        );
        continue;
      }
      raw = readFileSync(absolute, "utf8");
    } catch (err) {
      skipped.push(
        Object.freeze({
          page,
          reason: PAGE_LINT_SKIP_REASON.unreadable,
          detail: (err as Error).message,
        }),
      );
      continue;
    }
    try {
      detected.push(...lintOnePage(ctx, page, raw));
    } catch (err) {
      return emptyReport({
        code: PAGE_LINT_UNAVAILABLE_CODE,
        message: `write-time page lint failed on ${page}: ${(err as Error).message}`,
      });
    }
  }

  const ranked = detected.toSorted(comparePageLintFindings);
  const returned = ranked.slice(0, PAGE_LINT_MAX_FINDINGS);
  return Object.freeze({
    findings: Object.freeze(returned),
    total: ranked.length,
    returned: returned.length,
    truncated: ranked.length > returned.length,
    skipped: Object.freeze(skipped),
  });
}

export type PageLintField = { readonly [PAGE_LINT_KEY]?: PageLintReport };

/** Absent case: nothing to say contributes no key whatsoever. */
const NO_PAGE_LINT: PageLintField = Object.freeze({});

/** Whether a report carries anything a caller needs to see. */
function hasSomethingToSay(report: PageLintReport): boolean {
  return report.total > 0 || report.skipped.length > 0 || report.unavailable !== undefined;
}

/**
 * Resolve a report into the object to spread onto a write receipt. A
 * clean report - and `null` - yields the empty object, so the key is
 * ABSENT rather than present-and-empty. That absence is the whole
 * contract: it means the lint ran and found nothing, which is why a lint
 * that could NOT run reports `unavailable` instead of returning nothing.
 */
export function pageLintField(report: PageLintReport | null): PageLintField {
  if (report === null || !hasSomethingToSay(report)) return NO_PAGE_LINT;
  return Object.freeze({ [PAGE_LINT_KEY]: report });
}
