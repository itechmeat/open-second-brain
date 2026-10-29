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
 *   - **Fence-aware.** Text inside fenced code blocks and inline code
 *     spans is inert - the shared {@link codeRegions} masking decides,
 *     so the neutralizer can never escape what the link and mention
 *     readers could not see either. ```osb fence lines are boundaries,
 *     not masked content, and are detected through the same fence walk
 *     `discoverMarkers` uses.
 *   - **Escape-aware detectors.** A sigil preceded by an odd backslash
 *     run is data the caller already escaped, not structure; it is never
 *     re-escaped. (Line-anchored families get this for free: `\@osb` and
 *     `\#\#` fail the anchor.)
 *   - **Idempotent by construction.** Escaping a fence line dissolves
 *     the fence, which can expose previously masked interior text - so
 *     {@link neutralizeMarkdown} re-detects its own output until the
 *     detector finds nothing left (bounded by
 *     {@link NEUTRALIZE_FIXPOINT_STEPS}; each step only ever inserts
 *     backslashes before sigils that lacked an odd run, so every sigil
 *     is escaped at most once and the walk terminates). The exit
 *     condition IS the doctrine: the output no longer matches the
 *     detector, therefore `neutralize(neutralize(x))` is byte-identical
 *     to `neutralize(x)`.
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

import { codeRegions, WIKILINK_ALIAS_RE } from "../wikilink.ts";
import { parseInlineMarker } from "../inline.ts";
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
 * The fence-open shape `discoverMarkers` walks: exactly three backticks,
 * a plain info string, end of line. The marker grammar never learned
 * about longer runs or tilde fences, and this module does not teach it -
 * "would a marker scanner consume this" is the question the osb-fence
 * family answers.
 */
const OSB_FENCE_OPEN_RE = /^```([A-Za-z0-9_-]*)\s*$/;

/** The CommonMark ATX opening: up to three spaces, a `#` run of 1-6, then a space or the line end. */
const ATX_HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]|$)/;

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
 * Whether the character at `index` is preceded by an ODD run of
 * backslashes - the CommonMark shape of "already escaped by the author",
 * which the detectors treat as data rather than structure.
 */
function precededByOddBackslashRun(s: string, index: number): boolean {
  let n = 0;
  let i = index - 1;
  while (i >= 0 && s[i] === "\\") {
    n++;
    i--;
  }
  return n % 2 === 1;
}

/**
 * The ```osb fence lines, found by the same walk `discoverMarkers` runs:
 * an open fence line per {@link OSB_FENCE_OPEN_RE} consumes lines until a
 * line whose trimmed form starts with three backticks (or the end of
 * text), and an `osb`-info block contributes its open and close fence
 * lines. Fence lines are boundaries rather than masked content, so these
 * matches are exempt from the code-region filter below.
 */
function osbFenceMatches(lines: ReadonlyArray<Line>): MarkdownStructureMatch[] {
  const out: MarkdownStructureMatch[] = [];
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
      out.push({ kind: "osb-fence", start: line.start + indent, end: line.start + indent + 3 });
    }
    i++;
    while (i < lines.length) {
      const inner = lines[i]!;
      if (inner.text.trim().startsWith("```")) {
        if (isOsb) {
          const indent = inner.text.length - inner.text.trimStart().length;
          const run = backtickRun(inner.text.trimStart());
          out.push({
            kind: "osb-fence",
            start: inner.start + indent,
            end: inner.start + indent + run,
          });
        }
        i++;
        break;
      }
      i++;
    }
  }
  return out;
}

/** Whether `[start, end)` overlaps any code region (fences and inline code). */
function overlapsRegion(
  regions: ReadonlyArray<readonly [number, number]>,
  start: number,
  end: number,
): boolean {
  for (const [from, to] of regions) {
    if (from < end && start < to) return true;
  }
  return false;
}

/** The sigil span of a line's leading `@` when the line parses as a marker. */
function inlineMarkerMatch(line: Line, lineNo: number): MarkdownStructureMatch | null {
  if (parseInlineMarker(line.text, lineNo + 1) === null) return null;
  const at = line.text.length - line.text.trimStart().length;
  return { kind: "osb-inline", start: line.start + at, end: line.start + at + 1 };
}

/**
 * Every planted structure row in `text`, left to right: the ```osb fence
 * lines plus the per-line families (wikilinks, inline markers, ATX
 * headings) with every span that falls inside a fenced block or an inline
 * code span dropped. Pure and linear in the length of the text.
 */
export function detectMarkdownStructure(text: string): ReadonlyArray<MarkdownStructureMatch> {
  const lines = splitLines(text);
  const matches = osbFenceMatches(lines);
  const regions = codeRegions(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const m of line.text.matchAll(WIKILINK_ALIAS_RE)) {
      const start = line.start + m.index;
      const end = start + m[0].length;
      if (overlapsRegion(regions, start, end)) continue;
      if (precededByOddBackslashRun(line.text, m.index)) continue;
      matches.push({ kind: "wikilink", start, end });
    }
    const heading = ATX_HEADING_RE.exec(line.text);
    if (heading !== null) {
      const runStart = line.start + heading[0].indexOf("#");
      const start = runStart;
      const end = runStart + heading[1]!.length;
      if (!overlapsRegion(regions, start, end)) matches.push({ kind: "atx-heading", start, end });
    }
    const marker = inlineMarkerMatch(line, i);
    if (marker !== null && !overlapsRegion(regions, marker.start, marker.end)) {
      matches.push(marker);
    }
  }
  return matches.toSorted((a, b) => a.start - b.start || a.end - b.end);
}

// ----- The neutralizer ------------------------------------------------------

/**
 * How many detect-and-escape rounds {@link neutralizeMarkdown} may run
 * before it returns the text it has. One round is the common case; the
 * extra rounds exist because escaping a fence line dissolves the fence
 * and can expose its interior to the next round. Each round only inserts
 * backslashes before sigils that had no odd run, so no sigil is ever
 * escaped twice and the bound is never reached in practice.
 */
const NEUTRALIZE_FIXPOINT_STEPS = 8;

/**
 * Backslash-escape the minimal sigil characters of one detected span.
 * The heading, marker and fence spans are pure sigil runs (`#`s, the
 * `@`, backticks) so every character escapes; a wikilink span covers its
 * whole `[[target|alias]]` body, of which only the brackets are sigils -
 * the target and alias stay verbatim.
 */
function escapeSigils(span: string, kind: MarkdownStructureKind): string {
  if (kind !== MARKDOWN_STRUCTURE_KIND.wikilink) {
    return [...span].map((ch) => `\\${ch}`).join("");
  }
  return [...span].map((ch) => (ch === "[" || ch === "]" ? `\\${ch}` : ch)).join("");
}

function escapeRound(
  text: string,
): { text: string; kinds: ReadonlyArray<MarkdownStructureKind> } | null {
  const matches = detectMarkdownStructure(text);
  if (matches.length === 0) return null;
  let out = "";
  let last = 0;
  const kinds = new Set<MarkdownStructureKind>();
  for (const m of matches) {
    if (m.start < last) continue; // by construction disjoint; a guard, not a contract
    out += text.slice(last, m.start) + escapeSigils(text.slice(m.start, m.end), m.kind);
    last = m.end;
    kinds.add(m.kind);
  }
  out += text.slice(last);
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

/**
 * Escape the structure-bearing markdown in third-party text.
 *
 * Returns the input unchanged - `changed: false`, identical bytes, zero
 * added bytes - when the detector finds nothing, which is the shape of
 * the overwhelming majority of caller text. When structure was found,
 * each detected span's sigils are backslash-escaped (see the module
 * docblock for the doctrine) and {@link kinds} names every family that
 * was neutralized, for the seams' conditional provenance key.
 */
export function neutralizeMarkdown(text: string): NeutralizedMarkdown {
  let current = text;
  let kinds = new Set<MarkdownStructureKind>();
  for (let step = 0; step <= NEUTRALIZE_FIXPOINT_STEPS; step++) {
    const round = escapeRound(current);
    if (round === null) break;
    current = round.text;
    for (const kind of round.kinds) kinds.add(kind);
  }
  if (kinds.size === 0) {
    return { text, changed: false, kinds: UNCHANGED.kinds };
  }
  return Object.freeze({
    text: current,
    changed: true,
    kinds: Object.freeze([...kinds].toSorted()),
  });
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
 *   - `shadow`  - the seams run the pure neutralizer and discard its
 *                 output; no disk change, the would-be kinds surface
 *                 through the doctor audit wording,
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
