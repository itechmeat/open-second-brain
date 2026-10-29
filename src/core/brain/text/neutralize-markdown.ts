/**
 * Write-time neutralizer for structure-bearing markdown (lane A,
 * trust-and-responsiveness-hardening, t_c2ac4fc8).
 *
 * Third-party text written into the vault can plant structure the Brain
 * then treats as its own: a `[[wikilink]]` joins the link graph, an
 * `@osb` line joins the marker scanners, a ```osb fence plants a block
 * marker, and an ATX heading plants a semantic section the section
 * parsers read back. The read-time payload neutralizer
 * (`untrusted-source.ts`) and the ingest trust lane defend reads; nothing
 * defended writes. This module is the write-time leg: it escapes the
 * sigils of planted structure so the text keeps reading verbatim while
 * every line-grammar detector in src/core stops matching.
 *
 * ## Doctrine
 *
 *   - **Structure only, never vocabulary.** Detection keys on grammar a
 *     parser consumes, one family per consumer grammar, and on no word
 *     list: wikilinks (`wikilink.ts` regex family), `@osb` inline
 *     markers (the `inline.ts` parser itself, so "would a scanner parse
 *     this" has exactly one answer), ```osb fence lines (the
 *     `discoverMarkers` fence walk) and ATX headings (the CommonMark
 *     opening shape, which covers the semantic headings and the log
 *     heading). Task checkboxes, markdown links, reference definitions
 *     and tags are deliberately out of the set.
 *   - **Escape, never delete, never invisible characters.** One uniform
 *     mechanism: a backslash before each sigil of a detected span
 *     (brackets in wikilinks, `@` on marker lines, backticks on fence
 *     lines, the `#` run on headings). CommonMark renders a backslash
 *     before ASCII punctuation as the literal character, so the text
 *     stays readable and the bytes stay honest; no HTML entities, no
 *     zero-width anything.
 *   - **Fence-aware, per consumer grammar.** Every family is masked by the
 *     fence model the readers of that family actually run, because the
 *     grammars disagree about what a fence even is: the marker scanner
 *     (`inline.ts`) knows exactly-3-backtick lines and nothing else, the
 *     section readers (`source-links.ts` `fencedLineMask`, shared with the
 *     block resolver) know 3-or-more backtick or tilde runs, and the link
 *     readers share {@link codeRegions}. Masking an `@osb` row with the
 *     one model and scanning it with the other is how a planted marker
 *     inside a tilde fence would slip through: detection answers
 *     "would MY consumer parse this" for each family separately.
 *   - **Escape-aware detectors.** A sigil preceded by an odd backslash
 *     run is data the caller already escaped, not structure; it is never
 *     re-escaped. (Line-anchored families get this for free: `\@osb` and
 *     `\#\#` fail the anchor.)
 *   - **Idempotent by construction.** Escaping a fence line dissolves the
 *     fence, which can expose previously masked interior text - so
 *     {@link neutralizeMarkdown} re-detects its own output until the
 *     detector finds nothing left (bounded by
 *     {@link NEUTRALIZE_FIXPOINT_STEPS}). The walk terminates because
 *     each round only inserts backslashes before sigils that lacked an
 *     odd run - a backslashed sigil fails the same detection on the next
 *     pass (the odd-run rule, and the line anchors), so no sigil is ever
 *     escaped twice, and escaping cannot CREATE a sigil: a backslash
 *     before a sigil never starts a line the way `@osb`, `#` or ` ``` `
 *     must. A round can only ever EXPOSE sigils that were already in the
 *     text (a dissolved fence's interior), so the walk visits each sigil
 *     at most once and the bound is a safety net, never reached. The exit
 *     condition IS the doctrine: the output no longer matches the
 *     detector, therefore `neutralize(neutralize(x))` is byte-identical
 *     to `neutralize(x)`. Should the bound ever run out with live
 *     structure still detected - an input the walk cannot converge on -
 *     the walk fails CLOSED with a {@link MarkdownNeutralizeFixpointError}
 *     instead of returning those bytes as if they were neutralized: the
 *     bound guards against the impossible by refusing it, not by
 *     shipping it.
 *
 * ## One detection grammar, two consumers
 *
 * {@link detectMarkdownStructure} is the shared layer: the writer
 * ({@link neutralizeMarkdown}) escapes the spans it reports, and the
 * doctor's planted-rows planner counts them - so the finding, its count
 * and what enforce mode would change cannot drift apart.
 *
 * The gate ({@link resolveMarkdownNeutralizeMode}) is pure and defaults
 * to `off`, where the seams do not call this module at all and every
 * write stays byte-identical to before it existed.
 */

import {
  isLiveWikilinkSpan,
  maskCodeRegions,
  precededByOddBackslashRun,
  WIKILINK_TARGET_RE,
} from "../wikilink.ts";
import { parseInlineMarker } from "../inline.ts";
import { fencedLineMask } from "../source-links.ts";
import { envOrConfig } from "../../validate.ts";
import type { FrontmatterMap } from "../../types.ts";
import { discoverConfig } from "../../config.ts";

// ----- The shared detection grammar -----------------------------------------

/** The structure families the neutralizer escapes and the auditor counts. */
export const MARKDOWN_STRUCTURE_KIND = Object.freeze({
  wikilink: "wikilink",
  osbInline: "osb-inline",
  osbFence: "osb-fence",
  heading: "atx-heading",
} as const);

/** One {@link MARKDOWN_STRUCTURE_KIND} token. */
export type MarkdownStructureKind =
  (typeof MARKDOWN_STRUCTURE_KIND)[keyof typeof MARKDOWN_STRUCTURE_KIND];

/** One planted structure row: a span of `text` whose sigils are live. */
export interface MarkdownStructureMatch {
  readonly kind: MarkdownStructureKind;
  /** Inclusive start offset of the sigil span, in code units of `text`. */
  readonly start: number;
  /** Exclusive end offset of the sigil span. */
  readonly end: number;
}

/**
 * The ```osb fence-open shape `discoverMarkers` walks: exactly three backticks,
 * a plain info string, end of line. The marker grammar never learned
 * about longer runs or tilde fences, and this module does not teach it -
 * "would a marker scanner consume this" is the question the osb-fence
 * family answers.
 */
const OSB_FENCE_OPEN_RE = /^```([A-Za-z0-9_-]*)\s*$/;

/** The CommonMark ATX opening shape, widened to the union of consumer grammars: any
 * indentation (the section readers and the log reader disagree about how much a
 * heading may carry, so the detector under-cuts none of them), a `#` run of 1-6,
 * then a space, the CR of a CRLF body, or the line end. */
const ATX_HEADING_RE = /^[ \t]*(#{1,6})(?:[ \t\r]|$)/;

/** The fence marker both grammars are built from. */
const BACKTICK = "`";

/** One physical line and its start offset in the scanned text. */
interface Line {
  readonly text: string;
  readonly start: number;
}

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      out.push({ text: text.slice(start), start });
      return out;
    }
    out.push({ text: text.slice(start, nl), start });
    start = nl + 1;
  }
}

/** Length of the backtick run starting at `s[0]` (`s` is a pre-trimmed line head). */
function backtickRun(s: string): number {
  let n = 0;
  while (n < s.length && s[n] === BACKTICK) n++;
  return n;
}

/**
 * The ```osb fence lines plus the body mask, found by the same walk
 * `discoverMarkers` runs: an open fence line per {@link OSB_FENCE_OPEN_RE}
 * consumes lines until a line whose trimmed form starts with three backticks
 * (or the end of text), and an `osb`-info block contributes its open and
 * close fence lines. This is the marker grammar's ENTIRE fence concept -
 * exactly-3-backtick boundaries and nothing else: a tilde fence or a
 * 4-backtick fence fences nothing for the scanner, so the rows inside are
 * live and the mask must not cover them, while an unterminated fence
 * consumes the rest of the text and the mask must cover that.
 */
interface MarkerFenceStructure {
  /** The osb fence boundary-line sigil spans, in document order. */
  readonly spans: MarkdownStructureMatch[];
  /** True for body lines the marker scanner consumes as fenced (not parsed). */
  readonly bodyMasked: boolean[];
}

function markerFenceStructure(lines: ReadonlyArray<Line>): MarkerFenceStructure {
  const spans: MarkdownStructureMatch[] = [];
  const bodyMasked = Array.from({ length: lines.length }, () => false);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const open = OSB_FENCE_OPEN_RE.exec(line.text.trim());
    if (open === null) {
      i++;
      continue;
    }
    const isOsb = (open[1] ?? "") === "osb";
    if (isOsb) {
      const indent = line.text.length - line.text.trimStart().length;
      spans.push({ kind: "osb-fence", start: line.start + indent, end: line.start + indent + 3 });
    }
    i++;
    while (i < lines.length) {
      const inner = lines[i]!;
      if (inner.text.trim().startsWith("```")) {
        if (isOsb) {
          const indent = inner.text.length - inner.text.trimStart().length;
          const run = backtickRun(inner.text.trimStart());
          spans.push({
            kind: "osb-fence",
            start: inner.start + indent,
            end: inner.start + indent + run,
          });
        }
        i++;
        break;
      }
      bodyMasked[i] = true;
      i++;
    }
  }
  return { spans, bodyMasked };
}

/** The sigil span of a line's leading `@` when the line parses as a marker. */
function inlineMarkerMatch(line: Line, lineNo: number): MarkdownStructureMatch | null {
  if (parseInlineMarker(line.text, lineNo + 1) === null) return null;
  const at = line.text.length - line.text.trimStart().length;
  return { kind: "osb-inline", start: line.start + at, end: line.start + at + 1 };
}

/**
 * Every planted structure row in `text`, left to right. Each family is
 * masked by the fence model its own readers run, because "is this row
 * inert?" has one answer per consumer grammar and they do not agree:
 *
 *   - the osb-inline and osb-fence families answer to the marker scanner
 *     (`inline.ts`): its exactly-3-backtick boundary walk is the only
 *     fencing that exists there, so a planted marker inside a tilde fence
 *     or a 4-backtick fence is live and gets reported;
 *   - the atx-heading family answers to the section readers
 *     (`source-links.ts` `fencedLineMask`, shared with the block
 *     resolver): 3-or-more backtick or tilde fences, and an unterminated
 *     fence fences nothing;
 *   - the wikilink family answers to the link readers (`vault.ts`
 *     `extractWikilinks`, page-lint) and runs the readers' own recipe:
 *     code regions (fences and inline spans) are masked out of the scan
 *     view first, then the multi-line-tolerant {@link WIKILINK_TARGET_RE}
 *     shape and {@link isLiveWikilinkSpan} run on that view, so a
 *     `[[...\n...]]` pair across a line break is detected exactly when
 *     they would extract it. The mask is length-preserving, so every
 *     match offset in the view is the same offset in the raw text and the
 *     brackets the readers can see are exactly the brackets this scan
 *     sees - a `[[target|`code`]]` span whose brackets sit outside the
 *     region is reported (and escaped) even though the raw span overlaps
 *     the region, which is the hole a raw-text scan with a region-overlap
 *     test left open: the readers still extracted the live target from
 *     their own masked view.
 *
 * Fence lines for the osb family are boundaries rather than masked
 * content. Pure and linear in the length of the text.
 */
export function detectMarkdownStructure(text: string): ReadonlyArray<MarkdownStructureMatch> {
  const lines = splitLines(text);
  const fence = markerFenceStructure(lines);
  const matches: MarkdownStructureMatch[] = [...fence.spans];
  // The wikilink family keys on the multi-line-tolerant shape its readers
  // run (`vault.ts` extractWikilinks, page-lint) over the same masked view
  // those readers match on. The fill preserves length, so match offsets
  // are raw-text offsets; the bracket-span match set itself is identical
  // under any space fill, because a code region contributes no bracket
  // characters in either view.
  const masked = maskCodeRegions(text, (region) => " ".repeat(region.length));
  for (const m of masked.matchAll(WIKILINK_TARGET_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (!isLiveWikilinkSpan(masked, start, end)) continue;
    matches.push({ kind: "wikilink", start, end });
  }
  const headingMasked = fencedLineMask(lines.map((line) => line.text));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!headingMasked[i]) {
      const heading = ATX_HEADING_RE.exec(line.text);
      if (heading !== null) {
        const runStart = line.start + heading[0].indexOf("#");
        const start = runStart;
        const end = runStart + heading[1]!.length;
        matches.push({ kind: "atx-heading", start, end });
      }
    }
    if (fence.bodyMasked[i]) continue;
    const marker = inlineMarkerMatch(line, i);
    if (marker !== null) matches.push(marker);
  }
  return matches.toSorted((a, b) => a.start - b.start || a.end - b.end);
}

// ----- The neutralizer ------------------------------------------------------

/**
 * How many detect-and-escape rounds {@link neutralizeMarkdown} may run
 * before it refuses: two rounds are the deep case (round one escapes an
 * ```osb fence's boundary lines, the escape dissolves the fence for the
 * line-grammar consumers, and round two escapes the interior the dissolve
 * exposed), and no round can create a sigil or escape one twice (see the
 * doctrine block above), so the walk converges and the bound is a safety
 * net honest input never reaches. The post-condition is asserted, not
 * assumed: a bound exhausted with the output's own detection still
 * non-empty is a {@link MarkdownNeutralizeFixpointError}, never a
 * `changed: true` carrying live structure.
 */
const NEUTRALIZE_FIXPOINT_STEPS = 8;

/**
 * Backslash-escape the minimal sigil characters of one detected span.
 * The heading, marker and fence spans are pure sigil runs (`#`s, the
 * `@`, backticks) so every character escapes; a wikilink span covers its
 * whole `[[target]]` body, of which only the brackets are sigils - the
 * target stays verbatim, and a bracket the caller already escaped (an odd
 * backslash run before it, e.g. the closing `]` of `[[a\]]`) is data the
 * same rule the span's opening pair was held to, and is left alone. Each
 * bracket's run is read against the span as detected, so the backslashes
 * this pass inserts never make a later bracket look escaped.
 */
function escapeSigils(span: string, kind: MarkdownStructureKind): string {
  if (kind !== MARKDOWN_STRUCTURE_KIND.wikilink) {
    return [...span].map((ch) => `\\${ch}`).join("");
  }
  let out = "";
  for (let i = 0; i < span.length; i++) {
    const ch = span[i]!;
    if ((ch === "[" || ch === "]") && !precededByOddBackslashRun(span, i)) out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

function escapeRound(
  context: string,
  text: string,
): { text: string; kinds: ReadonlyArray<MarkdownStructureKind> } | null {
  // Detection runs over the exact bytes the page's scanners see before
  // `text`; only spans reaching past the context are this call's business
  // (see {@link NeutralizeMarkdownOptions.precedingContext}).
  const stitched = context + text;
  const matches = detectMarkdownStructure(stitched).filter((m) => m.end > context.length);
  if (matches.length === 0) return null;
  let out = "";
  let last = context.length;
  const kinds = new Set<MarkdownStructureKind>();
  for (const m of matches) {
    const start = Math.max(m.start, context.length);
    if (start < last) continue; // by construction disjoint; a guard, not a contract
    out += text.slice(last - context.length, start - context.length);
    out += escapeSigils(stitched.slice(start, m.end), m.kind);
    last = m.end;
    kinds.add(m.kind);
  }
  out += text.slice(last - context.length);
  return { text: out, kinds: [...kinds].toSorted() };
}

/** What {@link neutralizeMarkdown} returns. */
export interface NeutralizedMarkdown {
  /** The text with planted structure escaped; byte-identical input when `changed` is false. */
  readonly text: string;
  /** Whether any structure was found and escaped. */
  readonly changed: boolean;
  /** The families that were neutralized, sorted, unique; empty when unchanged. */
  readonly kinds: ReadonlyArray<MarkdownStructureKind>;
}

const UNCHANGED: NeutralizedMarkdown = Object.freeze({
  text: "",
  changed: false,
  kinds: Object.freeze([]),
});

/** Optional inputs of {@link neutralizeMarkdown}. */
export interface NeutralizeMarkdownOptions {
  /**
   * The bytes rendered before `text` on the same page, verbatim: an
   * already-neutralized caller half plus whatever renderer-authored
   * separator and heading the writer placed between the halves (the
   * capture seam passes the neutralized body, the blank-line separator
   * and its own `## Guidance` heading).
   *
   * The seam needs this because a rendered page is ONE text to every
   * scanner: a fence the preceding half opens and `text`'s own bytes close
   * (or leave open) has combined-page meaning that neither half's
   * standalone scan can see - the split-fence hole, where a planted marker
   * live on the combined page scanned clean in both halves. The three
   * fence models the families answer to also disagree about what a fence
   * even is, and the boundary state differs per model in ways a boolean
   * cannot carry (an unterminated fence masks the rest of the page for the
   * marker scanner while fencing nothing for the section readers unless a
   * later fence closes it). So no state is summarized: detection runs over
   * `precedingContext + text` - the exact bytes the page's scanners see
   * ahead of `text` - and only spans reaching past the context are
   * escaped, which makes the half's verdict agree with the combined page's
   * in both directions.
   *
   * Skipping the context's own rows is safe by construction: caller
   * context is the output of an earlier neutralize call, whose detection
   * is empty (the fixpoint exit), and renderer-authored rows are the
   * writer's, never this call's business. No span can straddle the
   * boundary when the context carries the writer heading - the wikilink
   * target grammar stops at its `#`, and every other family is
   * line-anchored - so each escaped span lies wholly in `text`; a custom
   * context that let one straddle would have only its `text`-side sigils
   * escaped and fail closed at the fixpoint bound rather than ship a
   * half-escaped span.
   */
  readonly precedingContext?: string;
}

/**
 * Escape the structure-bearing markdown in third-party text.
 *
 * Returns the input unchanged - `changed: false`, identical bytes, zero
 * added bytes - when the detector finds nothing, which is the shape of
 * the overwhelming majority of caller text. When structure was found,
 * each detected span's sigils are backslash-escaped (see the module
 * docblock for the doctrine) and {@link kinds} names every family that
 * was neutralized, for the seams' conditional provenance key.
 *
 * The walk is bounded by {@link NEUTRALIZE_FIXPOINT_STEPS} and FAILS
 * CLOSED: a bound exhausted with live structure still detected throws
 * {@link MarkdownNeutralizeFixpointError} rather than returning the exact
 * bytes this module exists to neutralize (see
 * {@link neutralizeMarkdownWithBound}).
 */
export function neutralizeMarkdown(
  text: string,
  options: NeutralizeMarkdownOptions = {},
): NeutralizedMarkdown {
  return neutralizeMarkdownWithBound(text, NEUTRALIZE_FIXPOINT_STEPS, options);
}

/**
 * {@link neutralizeMarkdown} with the fixpoint bound made explicit -
 * `maxRounds` is the highest step index the detect-and-escape loop may
 * reach, so `0` still runs the one round that decides "nothing to do"
 * versus "escape once". Exported as the seam that lets tests force the
 * bound low (the production bound is a safety net that honest input
 * cannot reach); callers in the vault lanes use
 * {@link neutralizeMarkdown} and its settled bound.
 *
 * The post-condition is the doctrine's exit condition: the returned text
 * no longer matches {@link detectMarkdownStructure} on the spans that
 * reach past {@link NeutralizeMarkdownOptions.precedingContext} (the
 * context's own rows are skipped by construction, see there). If the
 * bound runs out with detection still finding such spans, the walk did
 * not converge and returning `changed: true` would ship live structure as
 * if it were neutralized - so the refusal is thrown, by name
 * ({@link MarkdownNeutralizeFixpointError}), and the caller's write dies
 * before any bytes are persisted.
 */
export function neutralizeMarkdownWithBound(
  text: string,
  maxRounds: number,
  options: NeutralizeMarkdownOptions = {},
): NeutralizedMarkdown {
  const context = options.precedingContext ?? "";
  let current = text;
  let kinds = new Set<MarkdownStructureKind>();
  for (let step = 0; step <= maxRounds; step++) {
    const round = escapeRound(context, current);
    if (round === null) break;
    current = round.text;
    for (const kind of round.kinds) kinds.add(kind);
  }
  if (kinds.size === 0) {
    return { text, changed: false, kinds: UNCHANGED.kinds };
  }
  const remaining = detectMarkdownStructure(context + current).filter(
    (m) => m.end > context.length,
  );
  if (remaining.length > 0) {
    throw new MarkdownNeutralizeFixpointError(
      `markdown neutralization did not reach its fixpoint within ` +
        `${maxRounds + 1} detect-and-escape round(s): ` +
        `${remaining.length} planted structure span(s) would remain in the output`,
    );
  }
  return Object.freeze({
    text: current,
    changed: true,
    kinds: Object.freeze([...kinds].toSorted()),
  });
}

/**
 * Refusal raised when {@link neutralizeMarkdown}'s fixpoint bound ran out
 * with live structure still detected - the fail-closed posture for the
 * safety net honest input never reaches (see the doctrine block: the exit
 * condition IS an empty detection, so anything else is a refusal, never a
 * silently under-neutralized write).
 */
export class MarkdownNeutralizeFixpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownNeutralizeFixpointError";
  }
}

// ----- The provenance record ------------------------------------------------

/**
 * Frontmatter key recording the structure families an enforce-mode write
 * neutralized. A page carrying it says "these bytes are not what the
 * caller sent" - the audit trail for the one mode that edits content -
 * and a write that changed nothing adds nothing, keeping the untouched
 * shape byte-identical to before the gate existed.
 */
export const MARKDOWN_NEUTRALIZED_FRONTMATTER_KEY = "neutralized_markers";

/**
 * The frontmatter fragment a seam merges when neutralization changed
 * bytes: the key naming the neutralized kinds, sorted. An empty kind set
 * adds NOTHING - the `untrustedSourceFrontmatter` conditional-spread
 * precedent, so an unchanged body gains zero bytes.
 */
export function neutralizedMarkersFrontmatter(
  kinds: ReadonlyArray<MarkdownStructureKind>,
): FrontmatterMap {
  return kinds.length === 0 ? {} : { [MARKDOWN_NEUTRALIZED_FRONTMATTER_KEY]: [...kinds] };
}

// ----- The gate -------------------------------------------------------------

/**
 * The resolved posture of the write-time neutralization gate:
 *   - `off`     - the seams never invoke the neutralizer; every write
 *                 stays byte-identical to a build without this module,
 *   - `shadow`  - byte-identical to `off` at the seams. Shadow has no
 *                 work to do there: the doctor's planted-rows audit
 *                 recomputes the would-be rows from the vault's bytes on
 *                 its own and reads this mode only for its wording, so a
 *                 seam call under shadow would compute an answer nobody
 *                 consumes,
 *   - `enforce` - the seams write neutralized bytes.
 */
export const MARKDOWN_NEUTRALIZE_MODE = Object.freeze({
  off: "off",
  shadow: "shadow",
  enforce: "enforce",
} as const);

export type MarkdownNeutralizeMode =
  (typeof MARKDOWN_NEUTRALIZE_MODE)[keyof typeof MARKDOWN_NEUTRALIZE_MODE];

/** Environment variable for the markdown neutralization gate mode. */
export const MARKDOWN_NEUTRALIZE_MODE_ENV = "OPEN_SECOND_BRAIN_MARKDOWN_NEUTRALIZE_MODE";

/** Machine-config key for the markdown neutralization gate mode. */
export const MARKDOWN_NEUTRALIZE_MODE_CONFIG = "markdown_neutralize_mode";

/** True when `value` is one of the three mode tokens. */
export function isMarkdownNeutralizeMode(value: string): value is MarkdownNeutralizeMode {
  return (Object.values(MARKDOWN_NEUTRALIZE_MODE) as string[]).includes(value);
}

/** Refusal raised for a gate mode value that is not in the vocabulary. */
export class MarkdownNeutralizeModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownNeutralizeModeError";
  }
}

/**
 * Resolve the gate's mode: an explicit mode key wins (env over machine
 * config; an invalid value is a misconfiguration refused with a
 * {@link MarkdownNeutralizeModeError} naming the key actually in force -
 * never silently defaulted); with neither set the default is `off`, the
 * posture every write had before the gate existed. The
 * `resolveSearchTrustGateMode` shape minus the legacy boolean: this gate
 * never had one. Reads only its arguments.
 */
export function resolveMarkdownNeutralizeMode(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: Readonly<Record<string, string>>;
}): MarkdownNeutralizeMode {
  const env = input.env ?? {};
  const config = input.config ?? {};
  const raw = envOrConfig(
    env,
    config,
    MARKDOWN_NEUTRALIZE_MODE_ENV,
    MARKDOWN_NEUTRALIZE_MODE_CONFIG,
  );
  if (raw !== null) {
    if (isMarkdownNeutralizeMode(raw)) return raw;
    const inForce = env[MARKDOWN_NEUTRALIZE_MODE_ENV]
      ? MARKDOWN_NEUTRALIZE_MODE_ENV
      : MARKDOWN_NEUTRALIZE_MODE_CONFIG;
    throw new MarkdownNeutralizeModeError(
      `${inForce} must be 'off', 'shadow' or 'enforce', got '${raw}'`,
    );
  }
  return MARKDOWN_NEUTRALIZE_MODE.off;
}

/**
 * Resolve the gate's mode the way the write seams do: the live process
 * env over the machine config at its default discovery path. The one
 * impure wrapper, so the capture and ingest seams cannot drift about
 * where the inputs come from; tests drive the pure
 * {@link resolveMarkdownNeutralizeMode} instead.
 */
export function resolveMarkdownNeutralizeModeForProcess(): MarkdownNeutralizeMode {
  return resolveMarkdownNeutralizeMode({ env: process.env, config: discoverConfig().data });
}
