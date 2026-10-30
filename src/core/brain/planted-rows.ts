/**
 * The planted-rows audit planner (lane A, trust-and-responsiveness-hardening,
 * t_c2ac4fc8).
 *
 * The write-time neutralizer keeps third-party text from planting
 * structure; this planner reports the rows that are ALREADY planted - the
 * pages written before the gate existed or while it is off. It is the
 * pure half of the doctor's `planted-structure-rows` counting check (the
 * `planPrivacyMarkerRestamp` shape: planner module, one counting check),
 * so the finding, its count and what enforce mode would change cannot
 * drift apart: both this audit and the neutralizer read the one
 * detection grammar in `text/neutralize-markdown.ts`.
 *
 * The population is split the way authorship actually splits. For the
 * marker and osb-fence families it is EVERY readable page under `Brain/`:
 * no Brain writer ever emits a live `@osb` marker line or a live ```osb
 * fence (the consumed `@osb✓` sentinel is not detection), so a live one
 * anywhere in the derived layer is planted by construction - the same
 * structure the §9 vault scan would harvest into signals from any page
 * it walks. For the wikilink and atx-heading families it stays the
 * third-party lanes keyed off PROVENANCE, because the Brain's own
 * writers render those by design on pages outside the lanes - the
 * manual's section headings, the log's `[[Brain/log/...]]` refs, the
 * digests' links - and reporting them regardless of provenance would
 * report the vault's own structure as planted on every run.
 *
 * The provenance classification therefore also rides along as CONTEXT on
 * each finding ({@link PlantedRowsPage.thirdParty}), and the doctor names
 * lane pages first - a lane page and an operator note with the same rows
 * are equally live, but not equally expected.
 *
 * The scan over each page's body is the neutralizer's own detection, so
 * an inert excerpt inside a fenced code block counts nothing while a
 * planted ```osb fence line does. Staged copies under `Brain/pending/`
 * are deduplicated against their publish targets by content: the pending
 * directory holds a byte-verbatim copy of the page under review, so the
 * same rows would otherwise be reported twice. The dedupe answers to the
 * caller's readability when one is supplied: the consuming check filters
 * its rows by `ctx.readable` AFTER planning, so a hash-equal published
 * twin the caller may not read must never stand in for a readable staged
 * copy - the dedupe would drop the copy, the check would drop the twin,
 * and both would vanish from the report.
 *
 * The writers' own output is not planted, and the scan knows it. A
 * capture's trailing `## Guidance` section, a source summary's citation
 * and derivation sections (`## Sources`, `## Premises (level)`,
 * `## Entities`, `## Connections to existing notes`, `## Parts`,
 * `## Table`, `### Rows a-b`), a quarantined entity page's writer H1 and
 * provenance citation, and a distillation page's `## Claims`, `## Excerpt`
 * and `## Sources` sections are shapes THIS vault rendered on its lane
 * pages - without the exclusion a clean capture carrying guidance, a
 * clean ingest carrying its citations, a clean untrusted intake carrying
 * the entity H1 or a clean distillation reports the vault's own writer as
 * planted. The exclusion is a static list keyed by page kind and section
 * heading ({@link WRITER_AUTHORED_SECTIONS}), never a whole-page pass,
 * and the capture heading only counts as the writer's when the
 * `capture_guidance` frontmatter marker authorizes it.
 *
 * Authorship follows what the writer actually rendered, not the heading
 * text alone. The citation, link and derivation sections render only
 * AFTER the writer's own `## Sources` heading - the writer's prose
 * boundary, since caller text occupies only the leading prose region of
 * these pages - so an occurrence before that boundary is a caller
 * quotation and stays planted even when the writer rendered its own
 * occurrence later, and a section the writer did not render at all is
 * never exempt (a summary quoting `## Entities` over planted bullets
 * while the extraction named no entities reports). A fenced `## Sources`
 * line never bounds anything: the boundary is the last one the section
 * readers render as a heading. The entity H1 exemption covers the
 * writer's heading sigil only - the name content is caller text, so a
 * wikilink planted inside the name counts. A distillation claim bullet's
 * writer citation is exempt only where its target ties to the page's own
 * `source_path` frontmatter; the claim TEXT around it is caller content
 * and every other wikilink on the line stays planted.
 *
 * Read-only by contract: nothing here writes, and a page that cannot be
 * read between the walk and the body scan is skipped rather than thrown
 * - the doctor never throws.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { listVaultPages, parseFrontmatter } from "../vault.ts";
import { vaultRelative } from "../path-safety.ts";
import { BRAIN_PENDING_REL, isUnderBrainRoot } from "./path-constants.ts";
import { MAINTENANCE_LANE_REACH } from "../graph/transport-reach.ts";
import { hasUntrustedSourceMarker } from "./trust/untrusted-provenance.ts";
import { BRAIN_CAPTURE_KIND } from "./capture/capture-note.ts";
import { BRAIN_SOURCE_KIND } from "./ingest/ingest.ts";
import { BRAIN_DISTILLATION_KIND } from "./distill/claim.ts";
import { BRAIN_ENTITY_KIND, BRAIN_ENTITY_STATUS } from "./entities/types.ts";
import { PROVENANCE_LEVELS } from "./provenance/provenance.ts";
import { fencedLineMask } from "./source-links.ts";
import {
  MARKDOWN_STRUCTURE_KIND,
  detectMarkdownStructure,
  type MarkdownStructureKind,
  type MarkdownStructureMatch,
} from "./text/neutralize-markdown.ts";
import type { FrontmatterMap, VaultPage } from "../types.ts";

/** Where the review queue holds staged copies, `/`-separated and vault-relative. */
const PENDING_DIR = `${BRAIN_PENDING_REL}/`;

/** One page whose body carries live structure rows. */
export interface PlantedRowsPage {
  /** Vault-relative path with `/` separators. */
  readonly path: string;
  /** The structure families planted in the body, sorted, unique. */
  readonly kinds: ReadonlyArray<MarkdownStructureKind>;
  /** How many live rows the fence-masked scan found. */
  readonly count: number;
  /**
   * True when the page sits in a third-party provenance lane (a capture,
   * a source summary, an untrusted-stamped page, a quarantined entity) -
   * the lanes the enforce-mode seams neutralize. Context for the finding,
   * not the population filter: every Brain page is scanned.
   */
  readonly thirdParty: boolean;
}

export interface PlantedRowsPlan {
  /** Pages the population selector admitted. */
  readonly scanned: number;
  /** Pages whose body carries live structure, sorted by path. */
  readonly planted: ReadonlyArray<PlantedRowsPage>;
}

/** A tolerant status read: the scalar as written, trimmed and lowered. */
function entityStatus(meta: FrontmatterMap): string {
  const raw = meta["status"];
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** Does this page belong to a lane that receives third-party text? */
function inThirdPartyLane(meta: FrontmatterMap): boolean {
  const kind = typeof meta["kind"] === "string" ? meta["kind"] : "";
  if (kind === BRAIN_CAPTURE_KIND) return true;
  if (kind === BRAIN_SOURCE_KIND) return true;
  if (hasUntrustedSourceMarker(meta)) return true;
  return kind === BRAIN_ENTITY_KIND && entityStatus(meta) === BRAIN_ENTITY_STATUS.quarantine;
}

/**
 * The families no Brain writer ever authors - a live row is planted
 * wherever it sits, so these scan every readable Brain page. The
 * wikilink and heading families are excluded because the Brain's own
 * writers render them by design outside the third-party lanes (see the
 * module docblock); there the lane key IS the authorship signal.
 */
const ALWAYS_PLANTED_KINDS: ReadonlySet<MarkdownStructureKind> = new Set([
  MARKDOWN_STRUCTURE_KIND.osbInline,
  MARKDOWN_STRUCTURE_KIND.osbFence,
]);

/** Heading of the body section the capture contract renders for guidance (capture-note.ts). */
const CAPTURE_GUIDANCE_HEADING = "## Guidance";

/**
 * Frontmatter field authorizing that section (capture-note.ts's
 * `GUIDANCE_MARKER_FIELD`): the writer sets it exactly when IT rendered
 * the heading, which is what keeps a caller's quoted `## Guidance` on
 * the planted side of the line.
 */
const CAPTURE_GUIDANCE_MARKER = "capture_guidance";

/**
 * One writer-rendered section shape: the heading line that opens it and
 * how much of what follows is the writer's too.
 */
interface WriterSectionRule {
  /** The exact heading line the writer renders (a trailing CR is tolerated). */
  readonly heading: string;
  /** Match headings that BEGIN with this text (the ranged `### Rows a-b` shape). */
  readonly prefix?: boolean;
  /** Also mask the `- ` bullet lines under the heading (the `- [[id]]` citation rows). */
  readonly bullets?: boolean;
  /** The section is the writer's only when this frontmatter field is set true. */
  readonly requiresMarker?: string;
  /**
   * Only the LAST occurrence of the heading in the body is the writer's.
   * True for the headings each writer renders once: caller text occupies
   * only the leading prose region of these pages, so an earlier
   * occurrence is a caller quotation and stays planted.
   */
  readonly trailingOnly?: boolean;
  /**
   * The occurrence counts as the writer's only when it sits AFTER the
   * writer's own `## Sources` citation heading - the writer's prose
   * boundary. The citation, link and derivation sections render only
   * after that heading (ingest.ts composes caller prose first, then the
   * provenance and link sections), so an occurrence before the boundary
   * is a caller quotation and stays planted EVEN when the writer rendered
   * its own occurrence of the same heading later, and a section the
   * writer did not render at all is never exempt. Absent from the body
   * entirely, the `## Sources` heading bounds nothing and every
   * after-boundary rule exempts nothing (fail closed toward reporting).
   */
  readonly afterBoundary?: boolean;
  /**
   * The `- ` bullet lines under the heading are the writer's ONLY where a
   * live wikilink on them targets the page's own value of this frontmatter
   * field (the writer's `([[source#^block]])` block citation, whose target
   * is the cited source exactly or with a `#` block suffix). The claim
   * TEXT around that citation is caller content: any other wikilink on the
   * line stays planted, so a claim bullet is reported per wikilink rather
   * than masked per line.
   */
  readonly bulletsTiedToSource?: string;
}

/**
 * The section shapes the Brain's own writers render on third-party lane
 * pages, keyed by frontmatter `kind` - the pure exclusion list that keeps
 * this audit from reporting the vault's own writer as planted.
 *
 *   - `brain-capture` renders ONE section, the trailing
 *     {@link CAPTURE_GUIDANCE_HEADING}, and only under its marker
 *     (capture-note.ts). The guidance CONTENT is caller text (the
 *     neutralizer's business at write time), so only the heading line is
 *     the writer's.
 *   - `brain-source` composes every summary page as caller prose plus
 *     rendered sections (ingest.ts): the provenance citation sections
 *     (`## Sources`, `## Premises (<level>)` per provenance.ts, their
 *     `- [[id]]` bullets the writer's own citation rows), the two link
 *     sections, and the html/table derivation sections
 *     (`## Parts` per extract-html.ts, `## Table` with one
 *     `### Rows a-b` heading per group per table-note.ts - the writer
 *     renders many, so every occurrence in the writer's own region is its
 *     own). Every section but `## Sources` renders after it, so all of
 *     them answer to the writer's prose boundary.
 *   - `brain-entity` composes every quarantined entity page as the
 *     writer's `# <name>` H1 plus the provenance citation
 *     (extract-intake.ts bodyOnCreate over renderProvenanceSection): the
 *     H1's heading sigil is the writer's template, its provenance
 *     sections are the citation sections. The NAME content is caller
 *     text - the H1 exemption covers the heading row only, and a
 *     wikilink planted inside the name is reported.
 *   - `brain-distillation` composes every page from its own sections
 *     (distill-source.ts): `## Claims` (whose bullets carry caller claim
 *     text plus the writer's source-tied block citation), the optional
 *     `## Excerpt` heading (its content is fenced, inert), and the
 *     `## Sources` provenance citation.
 *
 * Keyed by KIND, not by lane membership: an untrusted-stamped page whose
 * kind renders no such sections gets no exclusion, and a lane page keeps
 * its exclusions whether or not it is also untrusted-stamped.
 */
const WRITER_AUTHORED_SECTIONS: ReadonlyMap<string, readonly WriterSectionRule[]> = new Map([
  [
    BRAIN_CAPTURE_KIND,
    [
      {
        heading: CAPTURE_GUIDANCE_HEADING,
        requiresMarker: CAPTURE_GUIDANCE_MARKER,
        trailingOnly: true,
      },
    ],
  ],
  [
    BRAIN_SOURCE_KIND,
    [
      { heading: "## Sources", bullets: true, trailingOnly: true },
      ...PROVENANCE_LEVELS.map((level): WriterSectionRule => ({
        heading: `## Premises (${level})`,
        bullets: true,
        trailingOnly: true,
        afterBoundary: true,
      })),
      { heading: "## Entities", bullets: true, trailingOnly: true, afterBoundary: true },
      {
        heading: "## Connections to existing notes",
        bullets: true,
        trailingOnly: true,
        afterBoundary: true,
      },
      { heading: "## Parts", trailingOnly: true, afterBoundary: true },
      { heading: "## Table", trailingOnly: true, afterBoundary: true },
      { heading: "### Rows ", prefix: true, afterBoundary: true },
    ],
  ],
  [
    BRAIN_ENTITY_KIND,
    [
      { heading: "## Sources", bullets: true, trailingOnly: true },
      ...PROVENANCE_LEVELS.map((level): WriterSectionRule => ({
        heading: `## Premises (${level})`,
        bullets: true,
        trailingOnly: true,
        afterBoundary: true,
      })),
    ],
  ],
  [
    BRAIN_DISTILLATION_KIND,
    [
      // The writer's `## Claims` is the page's opening line; a claim text
      // can never reproduce it (claims are single `- ` bullet lines), and
      // an occurrence inside the fenced `## Excerpt` renders as no heading
      // at all - so every exact occurrence is the writer's or inert.
      { heading: "## Claims", bulletsTiedToSource: "source_path" },
      { heading: "## Excerpt" },
      { heading: "## Sources", bullets: true, trailingOnly: true },
    ],
  ],
]);

/** A frontmatter boolean in both spellings the reader produces (true and "true"). */
function frontmatterMarked(meta: FrontmatterMap, field: string): boolean {
  const value = meta[field];
  return value === true || value === "true";
}

/**
 * The writer's prose boundary on citation-section pages: the LAST
 * `## Sources` heading the section readers render as a heading. A fenced
 * occurrence (a quoted document's fence carrying the heading) bounds
 * nothing - it renders as no heading at all, so it must not move the
 * writer region into the caller's prose.
 */
const WRITER_BOUNDARY_HEADING = "## Sources";

/**
 * True when `text` is the writer's H1 template shape on an entity page:
 * the registry renders every entity body opening with `# <name>`.
 */
function isEntityH1(line: string): boolean {
  return line.startsWith("# ");
}

/**
 * Does the wikilink matched at `spanText` target the page's own source?
 * The writer's block citation renders `[[source#^block]]`, so the target
 * is the frontmatter source exactly or with a `#` block suffix; an alias
 * pipe is decoration on the same target.
 */
function wikilinkTiesToSource(spanText: string, source: string): boolean {
  const inner = spanText.slice(2, -2);
  const target = inner.split("|")[0] ?? "";
  const hash = target.indexOf("#");
  return (hash === -1 ? target : target.slice(0, hash)) === source;
}

/**
 * The writer-authored lines of `body` for the page's kind, with each
 * line's start offset, or `null` when the kind renders no writer
 * sections. Heading comparisons are exact (CR-tolerant); a bullet mask
 * runs from the heading past blank lines and stops at the first line
 * that is neither blank nor a `- ` item. `citationLines` names the `- `
 * lines where a source-tied wikilink is the writer's own citation
 * (masked per match, never per line - the claim text around the
 * citation is caller content).
 */
interface WriterMask {
  readonly masked: Set<number>;
  readonly lineStarts: number[];
  readonly citationLines: Set<number>;
}

function writerAuthoredLines(meta: FrontmatterMap, body: string): WriterMask | null {
  const kind = typeof meta["kind"] === "string" ? meta["kind"] : "";
  const rules = WRITER_AUTHORED_SECTIONS.get(kind);
  if (rules === undefined) return null;
  const lines = body.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  // The heading mask the section readers run: a heading inside a fence
  // renders as no heading, so a fenced occurrence neither bounds the
  // writer region nor needs masking (its lines are inert to every family
  // the section rules could otherwise over-mask).
  const fenced = fencedLineMask(lines.map((line) => line.replace(/\r$/, "")));
  const boundaryIndex = rules.some((rule) => rule.afterBoundary === true)
    ? lines.findLastIndex(
        (line, i) => !fenced[i] && line.replace(/\r$/, "") === WRITER_BOUNDARY_HEADING,
      )
    : -1;
  const masked = new Set<number>();
  const citationLines = new Set<number>();
  for (const rule of rules) {
    if (rule.requiresMarker !== undefined && !frontmatterMarked(meta, rule.requiresMarker)) {
      continue;
    }
    const at: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!.replace(/\r$/, "");
      const hit = rule.prefix === true ? text.startsWith(rule.heading) : text === rule.heading;
      if (hit) at.push(i);
    }
    if (at.length === 0) continue;
    const occurrences = rule.trailingOnly === true ? [at[at.length - 1]!] : at;
    for (const i of occurrences) {
      if (rule.afterBoundary === true && (boundaryIndex < 0 || i <= boundaryIndex)) continue;
      masked.add(i);
      if (rule.bullets !== true) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const text = lines[j]!.replace(/\r$/, "");
        if (text === "") continue;
        if (text.startsWith("- ")) {
          masked.add(j);
          continue;
        }
        break;
      }
    }
    if (rule.bulletsTiedToSource === undefined) continue;
    const source = meta[rule.bulletsTiedToSource];
    if (typeof source !== "string" || source.length === 0) continue;
    // The `- ` bullet lines of THIS section: from the heading until the
    // next heading line. The claim text on them is caller content, so
    // they are never masked wholesale - the match-level tie check in
    // {@link excludeWriterAuthoredRows} keeps only the writer's citation.
    const sectionStart = at[0]!;
    for (let j = sectionStart + 1; j < lines.length; j++) {
      const text = lines[j]!.replace(/\r$/, "");
      if (text.startsWith("#")) break;
      if (text.startsWith("- ")) citationLines.add(j);
    }
  }
  return { masked, lineStarts, citationLines };
}

/**
 * Drop the writer-authored rows from `matches`: a row whose span starts
 * on a writer-rendered line is this vault's own output, not planted
 * structure. `matches` arrive sorted by start offset, so one forward
 * line walk answers every row. Two per-match exemptions ride beside the
 * line mask, for the shapes whose lines carry caller content too: an
 * entity page's H1 line exempts the writer's heading sigil only (the
 * name content is caller text), and a distillation claim bullet exempts
 * the writer's source-tied citation only (the claim text around it is
 * caller content).
 */
function excludeWriterAuthoredRows(
  meta: FrontmatterMap,
  body: string,
  matches: ReadonlyArray<MarkdownStructureMatch>,
): ReadonlyArray<MarkdownStructureMatch> {
  const mask = writerAuthoredLines(meta, body);
  if (mask === null) return matches;
  const { masked, lineStarts, citationLines } = mask;
  const kind = typeof meta["kind"] === "string" ? meta["kind"] : "";
  const sourcePath =
    typeof meta["source_path"] === "string" ? (meta["source_path"] as string) : undefined;
  const entityH1 =
    kind === BRAIN_ENTITY_KIND && isEntityH1((body.split("\n")[0] ?? "").replace(/\r$/, ""));
  const live: MarkdownStructureMatch[] = [];
  let line = 0;
  for (const match of matches) {
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= match.start) line++;
    if (masked.has(line)) continue;
    if (entityH1 && line === 0 && match.kind === MARKDOWN_STRUCTURE_KIND.heading) continue;
    if (
      citationLines.has(line) &&
      match.kind === MARKDOWN_STRUCTURE_KIND.wikilink &&
      sourcePath !== undefined &&
      wikilinkTiesToSource(body.slice(match.start, match.end), sourcePath)
    ) {
      continue;
    }
    live.push(match);
  }
  return live;
}

/**
 * Scan every readable Brain page for live structure rows. Pure over the
 * vault's bytes: nothing is written, nothing is mutated, and the result
 * is deterministic for a given vault state (paths sorted, kinds sorted).
 *
 * `readable` is the CALLER's readability over vault-relative paths (the
 * doctor's `ctx.readable`), and it is NOT a population filter here - the
 * consuming check applies it to the report after planning. It informs
 * one decision only: which published pages may stand in for a staged
 * copy in the dedupe. The planner hashes with filesystem access while
 * the check filters by this predicate, so without it a readable staged
 * copy deduped against a hash-equal twin the caller may not read would
 * leave the report with neither row.
 */
export function planPlantedRows(
  vault: string,
  readable?: (rel: string) => boolean,
): PlantedRowsPlan {
  const selected = listVaultPages(vault, { reach: MAINTENANCE_LANE_REACH }).filter((page) =>
    isUnderBrainRoot(vaultRelative(page.path, vault)),
  );

  const isStaged = (page: VaultPage): boolean =>
    vaultRelative(page.path, vault).startsWith(PENDING_DIR);

  // Scan FIRST, dedupe after. Deduping before the scan trades report
  // completeness for one skipped parse: the scan of a staged page whose
  // twin survives is wasted work at worst, while a twin that later
  // leaves the report (the check's readable filter) would take the
  // staged copy's rows with it if the copy had already been dropped.
  const hits: { entry: PlantedRowsPage; page: VaultPage }[] = [];
  for (const page of selected) {
    let body: string;
    try {
      [, body] = parseFrontmatter(page.path);
    } catch {
      // Vanished or unreadable between the walk and the read: a page the
      // audit cannot scan is a page it does not name, never a throw.
      continue;
    }
    const matches = detectMarkdownStructure(body);
    const lane = inThirdPartyLane(page.metadata);
    const scoped = lane ? matches : matches.filter((m) => ALWAYS_PLANTED_KINDS.has(m.kind));
    const live = excludeWriterAuthoredRows(page.metadata, body, scoped);
    if (live.length === 0) continue;
    hits.push({
      entry: {
        path: vaultRelative(page.path, vault),
        kinds: [...new Set(live.map((m) => m.kind))].toSorted(),
        count: live.length,
        thirdParty: lane,
      },
      page,
    });
  }

  // Staged-vs-published dedupe: a Brain/pending copy is the publish
  // target's bytes verbatim, so when a staged page's content equals a
  // published page's content the publish target is the report and the
  // staged copy is dropped - but ONLY when the twin actually reports.
  // A twin the caller may not read is filtered out of the report by the
  // consuming check, so its hash must not stand in for anything: the
  // readable staged copy is the one that must be reported. An UNDEFINED
  // hash - a page that could not be read between the scan and the hash -
  // never enters the set and never matches: two unreadable pages are not
  // the same page, and a staged copy the audit cannot hash is reported,
  // never silently dropped.
  //
  // The hash is memoized by path: only pages that reported are hashed at
  // all (a page with no rows never meets a dedupe question), and each of
  // those is read for hashing exactly once, however the two passes below
  // consult it - the walk and the body scan already read every page, so
  // this keeps the audit's synchronous reads per reported page at three
  // and per skipped page at two, instead of hashing the whole population
  // whenever a staged copy exists.
  const hashMemo = new Map<string, string | undefined>();
  const hashOf = (absPath: string): string | undefined => {
    if (!hashMemo.has(absPath)) hashMemo.set(absPath, contentHash(absPath));
    return hashMemo.get(absPath);
  };
  const publishedReportedHashes = new Set<string>();
  for (const hit of hits) {
    if (isStaged(hit.page)) continue;
    if (readable !== undefined && !readable(hit.entry.path)) continue;
    const hash = hashOf(hit.page.path);
    if (hash !== undefined) publishedReportedHashes.add(hash);
  }
  const planted = hits
    .filter((hit) => {
      if (!isStaged(hit.page)) return true;
      const stagedHash = hashOf(hit.page.path);
      return stagedHash === undefined || !publishedReportedHashes.has(stagedHash);
    })
    .map((hit) => hit.entry);
  planted.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { scanned: selected.length, planted };
}

function contentHash(absPath: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(absPath)).digest("hex");
  } catch {
    return undefined;
  }
}
