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
 *   - {@link NEAR_DUPLICATE_CODE}, the authored body compared against the
 *     pages it could plausibly duplicate - the SAME directory AND the SAME
 *     composite scope bucket - through the shared `tokenise`/`jaccard`
 *     primitives (t_d30c0548). A bounded, deterministic candidate set per
 *     write; the finding rides the receipt and never gates the write.
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
 *   - Body normalization on the write boundary is a recorded REFUSAL
 *     (t_d30c0548), not an omission: every candidate set (whitespace
 *     collapse, smart-quote folding, trailing-space trim) changes authored
 *     bytes that receipts, dedup and byte-stability tests pin. The
 *     near-duplicate score is computed over the body exactly as authored,
 *     and frontmatter is never compared and never touched.
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
 * vanishing. A page the lint THREW on lands there too: the failure is one
 * page's, and reporting it as a whole-report `unavailable` discarded the
 * findings already collected for the pages before it.
 *
 * Every string in the report is composed here from identifiers and
 * integers. A raw errno message would name an absolute path, which is the
 * operator's home directory in a write receipt - the leak
 * `writeFrontmatterAtomic` was rewritten to close in the same release.
 *
 * ## Attachment
 *
 * Modelled field for field on `write-advisory.ts`: computed AROUND the
 * write, never gating it, surfaced as an additive key that is ABSENT
 * ENTIRELY when there is nothing to say. Failure of the lint itself - of
 * the whole call, before any page has been read - degrades to a named
 * {@link PageLintUnavailable} on the key rather than to a missing key: an
 * absent `lint` key must mean clean, and only that.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { posix, resolve } from "node:path";

import { vaultRelative } from "../path-safety.ts";
import { compositeScopeKey, scopeFromFrontmatter } from "../scope-key.ts";
import { parseFrontmatterText } from "../vault.ts";
import type { FrontmatterMap } from "../types.ts";
import { collectAllBasenames } from "./doctor/records.ts";
import {
  LINT_CONSOLIDATE_KIND,
  createMergedLinkResolver,
  type MergedLinkResolver,
} from "./lint-consolidate.ts";
import { nextCommandField, type NextCommandField } from "./next-step.ts";
import { loadSchemaPack } from "./schema-pack.ts";
import type { BrainSchemaVocabulary } from "./schema-vocab.ts";
import { jaccard, tokenise } from "./similarity.ts";
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

/**
 * Near-duplicate bar (t_d30c0548): the jaccard score at or above which the
 * authored body counts as closely matching an existing page. Deliberately
 * high - near-DUPLICATE claims near-identity, unlike the 0.5 contradiction
 * precedent that answers "same subject" - and a named constant rather than
 * config, so promoting it after real-world noise is a one-line change.
 */
export const NEAR_DUPLICATE_JACCARD = 0.8;

/** Code the near-duplicate detector reports under. */
export const NEAR_DUPLICATE_CODE = "near-duplicate";

/**
 * Most sibling pages one directory contributes as near-duplicate
 * candidates: the newest by mtime. Every sibling is stat'ed (cheap), but
 * only these are read and tokenised, so a write into a folder of
 * thousands of notes costs a bounded read. Siblings past the cap are
 * counted on the report as `candidates_skipped`, never dropped silently.
 */
export const NEAR_DUPLICATE_MAX_CANDIDATES = 200;

/** Extension every candidate page on disk carries. */
const MARKDOWN_EXT = ".md";

/**
 * Canonical prefix of a vault-relative spelling that leaves the vault.
 * The write kernel refuses traversal, so such a page can only reach this
 * module from a caller - but the candidate walk must not depend on that:
 * enumerating outside the vault would read the operator's filesystem for
 * a receipt about the vault.
 */
const VAULT_ESCAPE_PREFIX = "../";

/** Absent-directory case for a candidate lookup: an empty list, never a miss. */
const NO_CANDIDATES: ReadonlyArray<NearDuplicateCandidate> = Object.freeze([]);

/** Why a written page was not linted. Never a silent omission. */
export const PAGE_LINT_SKIP_REASON = Object.freeze({
  overByteCap: "page-over-byte-cap",
  unreadable: "page-unreadable",
  /** The page was read and the lint itself threw on it. See {@link lintOnePage}. */
  lintFailed: "page-lint-failed",
} as const);

export type PageLintSkipReason = (typeof PAGE_LINT_SKIP_REASON)[keyof typeof PAGE_LINT_SKIP_REASON];

/** Membership list, in the order a page meets the three gates. */
export const PAGE_LINT_SKIP_REASONS: ReadonlyArray<PageLintSkipReason> = Object.freeze([
  PAGE_LINT_SKIP_REASON.overByteCap,
  PAGE_LINT_SKIP_REASON.unreadable,
  PAGE_LINT_SKIP_REASON.lintFailed,
]);

/**
 * Narrow a string read back across a tool boundary. The reason crosses the
 * MCP wire on all four write tools, where a caller decides from it whether
 * the silence about that page means clean or means unread, so a reader needs
 * to be able to reject a value this build does not understand.
 */
export function isPageLintSkipReason(value: unknown): value is PageLintSkipReason {
  return (
    typeof value === "string" && (PAGE_LINT_SKIP_REASONS as ReadonlyArray<string>).includes(value)
  );
}

/** What a failure is called when it carries neither an errno nor a name. */
const UNNAMED_FAILURE_CODE = "unknown";

/**
 * The identity of a failure, with nothing of the operator's filesystem in it:
 * the errno code when the kernel supplied one, the error's class otherwise.
 *
 * The rejected alternative is `err.message`, which is what shipped. Node
 * renders an errno as `ENOENT: no such file or directory, stat
 * '/home/<user>/<vault>/Brain/x.md'` - an absolute home path, in a key that
 * rides back on every note-write response. The same release rewrote
 * `writeFrontmatterAtomic` (`src/core/vault.ts`) for precisely this reason:
 * identifiers and integers cross this boundary, never a path and never an OS
 * message.
 */
function failureCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  const name = (err as Error | null)?.name;
  return typeof name === "string" && name.length > 0 ? name : UNNAMED_FAILURE_CODE;
}

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
  /**
   * Location within the document: `body`, `frontmatter`, `tags`, or the
   * thing the finding points at - a link target for the link detectors,
   * the resembling page's vault-relative path for {@link NEAR_DUPLICATE_CODE}
   * (evidence in the same spirit the write-conflict advisory renders
   * `[[pref-id]] jaccard=…` into its log events).
   */
  readonly path: string;
  readonly message: string;
}

/** A written page the lint did not read, and why. */
export interface PageLintSkip {
  /** Vault-relative path of the page, never an absolute one. */
  readonly page: string;
  readonly reason: PageLintSkipReason;
  /**
   * The measurement or the errno CODE behind the skip, so the reason is
   * checkable. Identifiers and integers only - see {@link failureCode}.
   */
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
  /**
   * Sibling pages the near-duplicate check did not compare against
   * because their directory exceeded {@link NEAR_DUPLICATE_MAX_CANDIDATES}.
   * Present only when the cap applied.
   */
  readonly candidates_skipped?: number;
  /** Sibling pages the near-duplicate check could not read, each named. Present only when any. */
  readonly candidates_unreadable?: ReadonlyArray<PageLintCandidateSkip>;
}

/** A sibling page the near-duplicate check could not read, and the errno code why. */
export interface PageLintCandidateSkip {
  readonly page: string;
  readonly detail: string;
}

/** What building the near-duplicate candidate index left out, by count and by name. */
export interface NearDuplicateCensus {
  readonly candidatesSkipped: number;
  readonly unreadable: ReadonlyArray<PageLintCandidateSkip>;
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
 * the pack. Fed the frontmatter {@link parseFrontmatterText} already
 * produced for the near-duplicate scan, so one page parses exactly once;
 * that parse is total (a document without frontmatter parses to an empty
 * map), so the null case is simply a document that declares nothing.
 */
function declaredSchemaType(meta: FrontmatterMap): string | null {
  const declared = meta["type"];
  return typeof declared === "string" && declared.trim() !== "" ? declared : null;
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

/**
 * One page that can serve the near-duplicate detector as a candidate: its
 * vault-relative path, composite scope bucket, and body tokens, read once
 * per call. The written pages themselves are in here too - a batch can
 * write two near-identical pages into one directory and each should see
 * the other - so self-comparison is excluded at detection time, not here.
 */
export interface NearDuplicateCandidate {
  /** Vault-relative path of the candidate page. */
  readonly page: string;
  /** The page's composite scope bucket, `compositeScopeKey` spelling. */
  readonly scopeKey: string;
  /** The authored body through the shared `tokenise` primitive. */
  readonly tokens: ReadonlySet<string>;
}

/**
 * Everything the lint computes once per call and threads per page.
 *
 * Exported with {@link lintPagesWithContext} so the per-page failure path can
 * be exercised: no filesystem state reaches it - every reader inside
 * {@link lintOnePage} either cannot throw or catches its own errors - and an
 * accumulation that is only correct in theory is the kind this release keeps
 * finding. A caller already holding the indexes can lint with them too.
 */
export interface LintContext {
  readonly basenames: ReadonlySet<string>;
  readonly vocabulary: BrainSchemaVocabulary;
  readonly mergedLinks: MergedLinkResolver;
  /**
   * The near-duplicate candidates, keyed by the vault-relative directory
   * they live in. Built once per call from exactly the directories the
   * written pages landed in - the bounded candidate set (same directory,
   * same scope bucket) needs nothing vault-wide.
   */
  readonly nearDuplicateCandidates: ReadonlyMap<string, ReadonlyArray<NearDuplicateCandidate>>;
  /** What the candidate index left out; absent means nothing was. */
  readonly nearDuplicateCensus?: NearDuplicateCensus;
}

/**
 * The near-duplicate findings for one written page: the authored body
 * against every candidate in the same directory and the same composite
 * scope bucket, at or above {@link NEAR_DUPLICATE_JACCARD}. The page
 * itself is never its own candidate - a batch can write two lookalikes,
 * but a single write cannot resemble itself - and the score rides the
 * message so an operator judgement call is informed.
 */
function nearDuplicateFindings(
  ctx: LintContext,
  page: string,
  meta: FrontmatterMap,
  body: string,
): PageLintFinding[] {
  const out: PageLintFinding[] = [];
  const scopeKey = compositeScopeKey(scopeFromFrontmatter(meta));
  const tokens = tokenise(body);
  for (const candidate of ctx.nearDuplicateCandidates.get(posix.dirname(page)) ?? NO_CANDIDATES) {
    if (candidate.page === page) continue;
    if (candidate.scopeKey !== scopeKey) continue;
    const sim = jaccard(tokens, candidate.tokens);
    if (sim < NEAR_DUPLICATE_JACCARD) continue;
    out.push(
      finding(
        "warning",
        NEAR_DUPLICATE_CODE,
        page,
        candidate.page,
        `body resembles [[${candidate.page}]] jaccard=${sim.toFixed(3)} (threshold ${NEAR_DUPLICATE_JACCARD})`,
      ),
    );
  }
  return out;
}

function lintOnePage(ctx: LintContext, page: string, raw: string): PageLintFinding[] {
  const out: PageLintFinding[] = [];
  const [meta, body] = parseFrontmatterText(raw);
  const schemaType = declaredSchemaType(meta);
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
  out.push(...nearDuplicateFindings(ctx, page, meta, body));
  return out;
}

function skip(page: string, reason: PageLintSkipReason, detail: string): PageLintSkip {
  return Object.freeze({ page, reason, detail });
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
 * The vault-relative spelling of a page, whatever spelling the caller
 * handed in. The ONE derivation for every string that names a page on
 * this report - findings, skips, and near-duplicate candidates alike -
 * so the map keys and the page strings compared against them can never
 * drift into two normalizations.
 */
function canonicalPage(vault: string, page: string): string {
  return vaultRelative(resolve(vault, page), vault);
}

/**
 * The near-duplicate candidate index for one call: every Markdown page in
 * exactly the directories the written pages landed in, keyed by that
 * directory, each carrying its composite scope bucket and body tokens.
 *
 * Only the newest {@link NEAR_DUPLICATE_MAX_CANDIDATES} siblings per
 * directory are read; the rest are counted in the census. A candidate
 * that cannot be read is not a candidate - it cannot provide evidence -
 * but it is NAMED in the census with its errno code, never skipped
 * silently. A candidate over the artifact byte cap is
 * skipped for the same cost reason a written page over the cap is skipped
 * rather than validated. The directory enumerations themselves are NOT
 * guarded: the write just committed into them, so a failure to list one
 * is a failure of the lint's inputs and belongs in the report's
 * `unavailable` slot like every other context-building failure. A page
 * spelled outside the vault ({@link VAULT_ESCAPE_PREFIX}) collects no
 * candidates at all: the walk stops at the vault boundary.
 */
function collectNearDuplicateCandidates(
  vault: string,
  pages: ReadonlyArray<string>,
): {
  readonly index: ReadonlyMap<string, ReadonlyArray<NearDuplicateCandidate>>;
  readonly census: NearDuplicateCensus;
} {
  const directories = new Set<string>();
  for (const named of pages) {
    const canonical = canonicalPage(vault, named);
    if (canonical.startsWith(VAULT_ESCAPE_PREFIX)) continue;
    directories.add(posix.dirname(canonical));
  }
  const index = new Map<string, NearDuplicateCandidate[]>();
  const unreadable: PageLintCandidateSkip[] = [];
  let candidatesSkipped = 0;
  for (const directory of directories) {
    // Stat every sibling (cheap), then read only the newest few.
    const siblings: Array<{ absolute: string; size: number; mtimeMs: number }> = [];
    for (const name of readdirSync(resolve(vault, directory))) {
      if (!name.endsWith(MARKDOWN_EXT)) continue;
      const absolute = resolve(vault, directory, name);
      try {
        const stat = statSync(absolute);
        siblings.push({ absolute, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch (err) {
        unreadable.push({ page: canonicalPage(vault, absolute), detail: failureCode(err) });
      }
    }
    const newest = siblings.toSorted((a, b) => b.mtimeMs - a.mtimeMs);
    candidatesSkipped += Math.max(0, newest.length - NEAR_DUPLICATE_MAX_CANDIDATES);
    const candidates: NearDuplicateCandidate[] = [];
    for (const sibling of newest.slice(0, NEAR_DUPLICATE_MAX_CANDIDATES)) {
      // Size from the inode: reading an over-cap page to find that out is
      // the cost the cap exists to avoid.
      if (sibling.size > ARTIFACT_MAX_BYTES) continue;
      try {
        const [meta, body] = parseFrontmatterText(readFileSync(sibling.absolute, "utf8"));
        candidates.push({
          page: canonicalPage(vault, sibling.absolute),
          scopeKey: compositeScopeKey(scopeFromFrontmatter(meta)),
          tokens: tokenise(body),
        });
      } catch (err) {
        unreadable.push({ page: canonicalPage(vault, sibling.absolute), detail: failureCode(err) });
      }
    }
    index.set(directory, candidates);
  }
  return { index, census: { candidatesSkipped, unreadable } };
}

/**
 * Lint exactly the pages a write committed, reading what is on disk.
 *
 * Runs AFTER the commit on purpose: the batch kernel wrote the bytes and
 * the handler never composed them, so the only honest subject is the
 * file. It never gates the write and it NEVER throws: a failure that
 * leaves nothing to lint AGAINST is reported as
 * {@link PageLintReport.unavailable}, and a failure on one page is a
 * {@link PAGE_LINT_SKIP_REASON.lintFailed} entry beside the results of the
 * pages that did lint.
 *
 * Cost discipline: the basename index and the schema pack are computed
 * ONCE per call and threaded, the merge resolver memoises per call, and
 * nothing here walks vault content beyond the written pages' own
 * directories - the near-duplicate candidate index reads each of those
 * once per call, sized against the same artifact cap as the pages.
 */
export function lintWrittenPages(vault: string, pages: ReadonlyArray<string>): PageLintReport {
  if (pages.length === 0) return emptyReport();
  let ctx: LintContext;
  try {
    const nearDuplicates = collectNearDuplicateCandidates(vault, pages);
    ctx = {
      basenames: collectAllBasenames(vault),
      vocabulary: loadSchemaPack(vault).vocabulary,
      mergedLinks: createMergedLinkResolver(vault),
      nearDuplicateCandidates: nearDuplicates.index,
      nearDuplicateCensus: nearDuplicates.census,
    };
  } catch (err) {
    return emptyReport({
      code: PAGE_LINT_UNAVAILABLE_CODE,
      message: `write-time page lint could not start: ${failureCode(err)}`,
    });
  }
  return lintPagesWithContext(vault, ctx, pages);
}

/**
 * Lint pages against indexes that are already built. The body of
 * {@link lintWrittenPages}, split at the one seam that matters: everything
 * above it fails the whole report (there are no indexes to lint against),
 * everything below it fails at most one page.
 */
export function lintPagesWithContext(
  vault: string,
  ctx: LintContext,
  pages: ReadonlyArray<string>,
): PageLintReport {
  const detected: PageLintFinding[] = [];
  const skipped: PageLintSkip[] = [];
  for (const named of pages) {
    // Rendered through the same derivation every other reporting surface
    // uses, so the page a finding names is vault-relative whichever
    // spelling the caller handed in - an absolute path here would be the
    // operator's home directory in a write receipt.
    const page = canonicalPage(vault, named);
    const absolute = resolve(vault, page);
    let raw: string;
    try {
      // Size first, from the inode: an over-cap page must be REPORTED as
      // skipped, and reading it to find that out is the cost the cap
      // exists to avoid.
      const bytes = statSync(absolute).size;
      if (bytes > ARTIFACT_MAX_BYTES) {
        skipped.push(
          skip(
            page,
            PAGE_LINT_SKIP_REASON.overByteCap,
            `${bytes} bytes exceeds the ${ARTIFACT_MAX_BYTES}-byte artifact cap`,
          ),
        );
        continue;
      }
      raw = readFileSync(absolute, "utf8");
    } catch (err) {
      skipped.push(skip(page, PAGE_LINT_SKIP_REASON.unreadable, failureCode(err)));
      continue;
    }
    try {
      detected.push(...lintOnePage(ctx, page, raw));
    } catch (err) {
      // One page's failure is one page's news. Reporting it as `unavailable`
      // threw away the findings already collected for EARLIER pages and the
      // skip list with them, and left the pages after it silently unlinted -
      // a report that reads clean about work that was never done. The report
      // already has an honest shape for "this page was not linted".
      skipped.push(skip(page, PAGE_LINT_SKIP_REASON.lintFailed, failureCode(err)));
    }
  }

  const ranked = detected.toSorted(comparePageLintFindings);
  const returned = ranked.slice(0, PAGE_LINT_MAX_FINDINGS);
  const census = ctx.nearDuplicateCensus;
  return Object.freeze({
    findings: Object.freeze(returned),
    total: ranked.length,
    returned: returned.length,
    truncated: ranked.length > returned.length,
    skipped: Object.freeze(skipped),
    ...(census !== undefined && census.candidatesSkipped > 0
      ? { candidates_skipped: census.candidatesSkipped }
      : {}),
    ...(census !== undefined && census.unreadable.length > 0
      ? { candidates_unreadable: Object.freeze([...census.unreadable]) }
      : {}),
  });
}

export type PageLintField = { readonly [PAGE_LINT_KEY]?: PageLintReport };

/** Absent case: nothing to say contributes no key whatsoever. */
const NO_PAGE_LINT: PageLintField = Object.freeze({});

/** Whether a report carries anything a caller needs to see. */
function hasSomethingToSay(report: PageLintReport): boolean {
  return (
    report.total > 0 ||
    report.skipped.length > 0 ||
    report.unavailable !== undefined ||
    report.candidates_skipped !== undefined ||
    report.candidates_unreadable !== undefined
  );
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
