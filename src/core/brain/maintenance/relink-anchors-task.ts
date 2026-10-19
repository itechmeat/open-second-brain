/**
 * The relink maintenance lane task (note-change truth maintenance, F4/C3).
 *
 * Anchors are facts of attachment: a signal whose `entities:` line omits
 * an entity it is about never reaches that entity's recall surface. The
 * anchoring kernel accepts caller-resolved link-derived ids beside the
 * text-derived ones, but that parameter is an extension seam - no shipped
 * extraction caller resolves its source page's links yet - so the
 * extraction callers write text-derived anchors only, and every signal
 * stored before and since holds just what its own text named. This pass
 * is the seam's shipped consumer: it walks the signal pages, and for
 * every PAGE-SOURCED signal (one whose `source:` pointer resolves to a
 * vault page) it recomputes the anchors with the shipped rules and unions
 * them into the stored line.
 *
 * ## The recomputation uses the shipped matchers, never new ones
 *
 * Text anchors come from the same build the capture path builds, matched
 * through the capture path's own occurrence rule: the fact text
 * normalized once and expanded through {@link matchFormVariants}, each
 * entity's precomputed variants tested with {@link matchVariantsOccurIn}
 * - the exact comparison `routeExtractedFacts` performs, so a form this
 * pass adds is exactly a form the extractor itself would attach today.
 * Link-derived ids come from the page-link resolver
 * ({@link ../intake/page-entity-links.ts}), the same resolver a
 * page-sourced extraction caller would use. The resolver's `visible`
 * predicate binds at the reach the SIGNAL ITSELF is readable at, not at
 * the lane's: a signal any remote-reach reader can list only ever
 * receives ids whose entity page and source page are readable at that
 * reach, because an id written into a listable signal is disclosed to
 * every reader that can list it - and this pass never removes an anchor,
 * so the disclosure would be permanent. The TEXT-derived matches answer
 * to the same per-signal predicate: the anchorable list is built at the
 * lane's reach, and a match against it unfiltered would write a private
 * entity's id into a remotely readable signal just the same. A signal
 * reserved against remote reads keeps {@link MAINTENANCE_LANE_REACH}:
 * the lane is a local repair pass, and what it heals for a local-only
 * page never leaves the host.
 *
 * ## Server-stamped sources only
 *
 * The pass also acts only on signals whose `source:` the SERVER derived -
 * `source_type: extracted`, the stamp every extraction caller writes. A
 * `brain_feedback` caller supplied its own pointer (a `live` signal
 * carries no source_type at all - absence IS the live stamp), and an
 * inline author marker is author-written the same way; a caller-chosen
 * page must not choose which entity ids attach, because the card's
 * invariant is that server-derived facts outrank caller-supplied claims.
 * Those signals are out of the pass's scope entirely: the pass never
 * reads their pointers, and they are counted by neither arm - the same
 * answer a signal whose pointer names no page gets.
 *
 * ## Additive only, and dry-run by default
 *
 * An anchor already stored is never removed, even when the recompute
 * would not produce it: the pass heals narrow anchor lists, it does not
 * second-guess wide ones (an id that outlived its entity is the doctor's
 * finding, not this pass's deletion). Absent {@link RelinkAnchorsOptions.apply}
 * the pass reports what it WOULD add and writes nothing - including the
 * `entity-anchor-skip` audit the shared anchorable build appends for a
 * junk-named entity: the dry run builds its anchorables through the same
 * gate, floor and variant expansion with the logging held back, because a
 * preview that wrote the log would not be a preview. With `apply` the
 * changed signal pages are rewritten in place through the atomic writer,
 * the stored ids first and the added ones appended, and the audit is
 * stamped exactly as the capture path stamps it. The rewrite's only safe
 * home is the extractor's own raw shape: one `entities: <ids>` line,
 * exactly what `routeExtractedFacts` writes for a fact that anchored. An
 * in-scope signal whose Raw holds anything else is carrying prose - a
 * verbatim quote - and a line-level rewrite there overwrote the quote's
 * own `entities:` line, spliced an anchor line into a quote, or landed
 * mid-quote past a heading; such a signal is skipped ENTIRELY, counted in
 * `signalsSkippedRawShape`, never written. A signal whose raw reads as
 * absent (no `## Raw` section, or the legacy placeholder) is not a shape
 * failure - the extractor writes no raw at all for a fact that anchored
 * nothing - and the rewrite's own support decides below whether the
 * anchor has a home, so a page without the section stays counted by
 * neither arm: a dry run never reports an addition no apply could make.
 * The same hold-out covers a codec-compressed section: the bytes on disk
 * hold the reversible compressed form, whose collapsed whitespace runs
 * can hide the `entities:` line from a line-level rewrite, so the pass
 * skips those signals outright rather than write a line the next parse
 * never reads - the gate the raw-shape check subsumes for prose sections,
 * kept for the shaped raw a codec stores. The apply arm writes against
 * the bytes it read (`expectBefore`): a page edited or moved between the
 * read and the rename fails the write instead of losing that edit, and
 * the next pass retries. The byte gates are re-run on those bytes too
 * ({@link decideRawRewrite}): a page edited between the parse and the
 * apply read is judged by what it now IS, not what the parse saw, so a
 * Raw turned quote or codec in that window is skipped like any other.
 *
 * The pass never calls a model: the recomputation is a file walk, an
 * index build and pure matching, bounded by the caller's safeguard like
 * every other lane task.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { ensureInsideVault } from "../../path-safety.ts";
import { MAINTENANCE_LANE_REACH, TRANSPORT_REACH } from "../../graph/transport-reach.ts";
import type { TransportReach } from "../../graph/transport-reach.ts";
import { isPathReadableAtReach, type FrontmatterCache } from "../../search/result-filters.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { buildEntityIndex } from "../entities/index-builder.ts";
import {
  entityMatchForms,
  matchFormVariants,
  matchVariantsOccurIn,
  MIN_ANCHOR_FORM_LENGTH,
  normalizeEntityName,
} from "../entities/canonical.ts";
import { resolveEntityLexicon } from "../entities/lexicon.ts";
import { ENTITY_STATUS_SCOPE, entityStatusInScope } from "../entities/status-scope.ts";
import { brainDirs } from "../paths.ts";
import { progressCounter, type ProgressSink } from "../progress.ts";
import { parseSignal } from "../signal.ts";
import { BRAIN_SIGNAL_SOURCE_TYPE } from "../types.ts";
import type { Safeguard } from "../safeguard.ts";
import { OPERATION } from "../safeguard.ts";
import {
  entityLinkResolver,
  pageEntityLinks,
  type EntityLinkAccessor,
} from "../intake/page-entity-links.ts";
import { buildAnchorables, type AnchorableEntity } from "../fact-extract.ts";

/** One source page's rollup in the relink report. */
export interface RelinkSourceReport {
  /** The vault-relative path the signal's source pointer resolved to. */
  readonly source: string;
  /** Page-sourced signals citing this page. */
  readonly signals: number;
  /** Anchors this pass adds (or would add) for those signals. */
  readonly anchorsAdded: number;
}

/** What one relink pass found (and, on `apply`, changed). */
export interface RelinkAnchorsReport {
  /** False for the default dry run: the report describes a would-be pass. */
  readonly apply: boolean;
  /** Every `sig-*.md` page the walk opened in the inbox and processed trees. */
  readonly signalsScanned: number;
  /** Pages that could not be parsed; counted, never fatal. */
  readonly signalsUnreadable: number;
  /**
   * In-scope signals (`source_type: extracted`) whose `source:` pointer
   * resolved to at least one vault page at the signal's own reach.
   */
  readonly signalsPageSourced: number;
  /**
   * In-scope signals skipped because their Raw section is not the
   * extractor's own single `entities:` line shape - counted, never
   * written: the rewrite's only safe home is the shape
   * `routeExtractedFacts` itself writes, and anything else in `## Raw`
   * is a quote the pass has no business editing.
   */
  readonly signalsSkippedRawShape: number;
  /** Signals with at least one anchor to add - rewritten on `apply`. */
  readonly signalsChanged: number;
  /** Total anchors added (or would be added) across every signal. */
  readonly anchorsAdded: number;
  /** Per-source rollup, sorted by source path. */
  readonly perSource: ReadonlyArray<RelinkSourceReport>;
}

export interface RelinkAnchorsOptions {
  /**
   * Injected clock; on the apply arm it stamps the skip-audit log events
   * the shared anchorable build emits, exactly as the capture path stamps
   * them. The dry run writes nothing and needs no stamp.
   */
  readonly now: Date;
  /**
   * Rewrite the changed signal pages. Absent or false (the default) the
   * pass is a dry run: the report says what would change and no byte is
   * written. The doctor repair-lane precedent: preview first, mutate on
   * an explicit ask.
   */
  readonly apply?: boolean;
  /** Safeguard budget handed down by the lane; checkpoints between files. */
  readonly safeguard?: Safeguard;
  /** Progress stream for the signal walk, when the caller has one. */
  readonly onProgress?: ProgressSink;
}

/** Largest source page this pass reads, matching the inline walk's cap. */
const SOURCE_PAGE_MAX_BYTES = 1_048_576;

/** The raw-section placeholder a signal with no stored raw content carries. */
const RAW_PLACEHOLDER = "_(not provided)_";

/**
 * The dry run's quiet twin of the capture path's anchorable build
 * (`buildAnchorables`): the same quality gate, the same length floor and
 * the same separator-variant expansion, minus the `entity-anchor-skip`
 * log events the shared build appends for a junk-named entity - those are
 * writes, and a preview must not write. The apply arm calls the shared
 * build, so the audit trail is stamped exactly where bytes change; the
 * two builds compute the same forms, which is what the dry/apply
 * agreement pin in the task's suite holds.
 */
function buildAnchorablesQuietly(
  vault: string,
  index: ReturnType<typeof buildEntityIndex>,
): AnchorableEntity[] {
  const lexicon = resolveEntityLexicon(vault);
  const out: AnchorableEntity[] = [];
  for (const entity of index.entities) {
    if (!entityStatusInScope(entity.status, ENTITY_STATUS_SCOPE.canonical)) continue;
    // The capture build's own form rule, verbatim: gate each label, keep
    // the forms at or above the length floor, expand each once into its
    // separator variants, Set-deduped in the generator's order. A
    // junk-named entity still anchors on its valid alias forms here,
    // exactly as it does on the capture path.
    const forms = [
      ...new Set(
        entityMatchForms([entity.name, ...entity.aliases], { lexicon })
          .filter((f) => f.length >= MIN_ANCHOR_FORM_LENGTH)
          .flatMap((f) => matchFormVariants(f)),
      ),
    ];
    if (forms.length === 0) continue;
    out.push({ id: entity.id, forms });
  }
  return out;
}

/** The `entities:` ids of a raw section, in stored order; empty when absent. */
function storedAnchorIds(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("entities:")) {
      return line
        .slice("entities:".length)
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
    }
  }
  return [];
}

/**
 * Is `raw` EXACTLY the shape the extractor writes - one `entities: <ids>`
 * line, nothing else? The rewrite's only safe home. `storedAnchorIds`
 * trusts the first `entities:` line it finds, and a Raw section holding
 * author prose - a verbatim quote - can carry such a line as its own
 * words: rewriting there overwrote the quote's text, spliced an anchor
 * line into it, or landed mid-quote past a heading the parser reads past
 * and the line-rewrite stops at. A single line, `entities: `-prefixed,
 * parsing to at least one id: anything else skips the signal (counted,
 * never written), and the section stays byte-identical.
 */
function isExtractorRawShape(raw: string): boolean {
  if (raw.includes("\n") || raw.includes("\r")) return false;
  if (!raw.startsWith("entities: ")) return false;
  return storedAnchorIds(raw).length > 0;
}

/**
 * The signal page rewritten with `nextLine` as its `entities:` line, or
 * `undefined` when the page has no `## Raw` section to rewrite in. The
 * stored line is replaced in place; a section without one gains the line
 * in place of the placeholder, or appended after its last content.
 */
export function rewriteRawEntitiesLine(contents: string, nextLine: string): string | undefined {
  const lines = contents.split("\n");
  const rawIdx = lines.findIndex((line) => line.trim() === "## Raw");
  if (rawIdx < 0) return undefined;
  let end = lines.length;
  for (let i = rawIdx + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) {
      end = i;
      break;
    }
  }
  for (let i = rawIdx + 1; i < end; i++) {
    if (lines[i]!.startsWith("entities:")) {
      lines[i] = nextLine;
      return lines.join("\n");
    }
  }
  for (let i = rawIdx + 1; i < end; i++) {
    if (lines[i]!.trim() === RAW_PLACEHOLDER) {
      lines[i] = nextLine;
      return lines.join("\n");
    }
  }
  let insertAt = end;
  for (let i = end - 1; i > rawIdx; i--) {
    if (lines[i]!.trim() !== "") {
      insertAt = i + 1;
      break;
    }
  }
  lines.splice(insertAt, 0, nextLine);
  return lines.join("\n");
}

/**
 * The Raw section the BYTES carry - the span the parser itself reads
 * (everything after the `## Raw` heading through EOF, the schema's one
 * section), trimmed, or `undefined` when the bytes hold no such heading
 * or only blank lines. The drift re-check below re-runs the shape gate
 * on this span, so the gate and the parse-time gate judge the same
 * bytes: a heading after `## Raw` is part of the section - multi-line,
 * not the extractor's shape - and answers `unsafe-shape` here exactly
 * as the parse gate would, instead of being cut off and the remainder
 * mistaken for a rewritable one-liner.
 */
function rawSectionBytes(contents: string): string | undefined {
  const lines = contents.split("\n");
  const rawIdx = lines.findIndex((line) => line.trim() === "## Raw");
  if (rawIdx < 0) return undefined;
  const section = lines
    .slice(rawIdx + 1)
    .join("\n")
    .trim();
  return section.length > 0 ? section : undefined;
}

/**
 * True when the bytes' frontmatter carries the `_raw_codec` marker: the
 * body on disk is the reversible COMPRESSED form, whatever it spells.
 * The parse-time codec gate reads the same marker from the parsed
 * frontmatter; the drift re-check reads it from the raw bytes because
 * the parse's copy can go stale.
 */
function hasRawCodecMarker(contents: string): boolean {
  const lines = contents.split("\n");
  if (lines[0]?.trim() !== "---") return false;
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (close < 0) return false;
  return lines.slice(1, close).some((line) => line.trim().startsWith("_raw_codec:"));
}

/** What the byte-level drift re-check decided about one signal page. */
export type RawRewriteDecision =
  | {
      readonly action: "rewrite";
      readonly next: string;
      /** The ids the rewrite actually appends - not one of them was stored. */
      readonly appended: ReadonlyArray<string>;
    }
  | { readonly action: "no-home" }
  | { readonly action: "codec" }
  | { readonly action: "unsafe-shape" };

const NO_REWRITE_HOME: RawRewriteDecision = Object.freeze({ action: "no-home" } as const);

/**
 * Decide the raw-line rewrite against the bytes a fresh read just
 * returned - the drift re-check for the window between the pass's
 * `parseSignal` (whose bytes every gate above judged) and this read. A
 * page edited in that window would otherwise have the rewrite run on
 * bytes no gate checked: a Raw turned prose - a verbatim quote - is the
 * overwrite the shape gate exists to prevent, and a line rebuilt from
 * the parse's stored ids would drop an id the edit stored. The decision
 * re-runs the SAME hold-outs, with the parse gates' own semantics, on
 * the rewrite's own bytes: a codec marker beside a real section is the
 * parse-time codec gate's answer (`codec` - skipped like that gate,
 * counted by neither arm); a section that is neither the extractor's
 * one-line shape nor a fillable placeholder (nor absent) is
 * `unsafe-shape` and the caller skips the signal entirely, counted where
 * the parse-time shape gate counts; a page with no Raw section at all is
 * `no-home`; anything else rewrites with the ids the bytes themselves
 * store, so an edit that widened the list keeps its ids, one that
 * withdrew them is not resurrected, and one that already stored a
 * computed id makes `appended` - not the parse's additions - the truth
 * about what this rewrite adds. The caller still writes through
 * `expectBefore`, so an edit landing after this read fails the write
 * instead of being discarded.
 */
export function decideRawRewrite(before: string, added: ReadonlyArray<string>): RawRewriteDecision {
  const bytesRaw = rawSectionBytes(before);
  // The codec gate, on the marker the bytes themselves carry - but only
  // where the parse gate fires too: `rawCodec` is true for a marker AND
  // a real section, so a marker over an absent or placeholder section is
  // not a codec page and falls through to the shape logic below, where
  // the old flow already answered it. The compression is out of the line
  // rewrite's reach even where the compressed SPELLING happens to read
  // as the extractor's one line - the collapse that hid the section's
  // real content is the whole reason the gate skips codec pages.
  if (hasRawCodecMarker(before) && bytesRaw !== undefined && bytesRaw !== RAW_PLACEHOLDER) {
    return { action: "codec" };
  }
  if (bytesRaw !== undefined && bytesRaw !== RAW_PLACEHOLDER && !isExtractorRawShape(bytesRaw)) {
    return { action: "unsafe-shape" };
  }
  const byteStored =
    bytesRaw === undefined || bytesRaw === RAW_PLACEHOLDER ? [] : storedAnchorIds(bytesRaw);
  const appended = added.filter((id) => !byteStored.includes(id));
  if (appended.length === 0) {
    // Every id the pass computed is already on the page - a concurrent
    // edit stored it after the parse. Nothing to add, nothing to count:
    // the truthful answer is the same no-op the no-home path gives.
    return NO_REWRITE_HOME;
  }
  const nextLine = `entities: ${[...byteStored, ...appended].join(", ")}`;
  // `rewriteRawEntitiesLine` is a pure string fold and never throws.
  const next = rewriteRawEntitiesLine(before, nextLine);
  return next === undefined ? NO_REWRITE_HOME : { action: "rewrite", next, appended };
}

/** The wikilink target inside a signal `source:` entry, without the alias tail. */
function sourceRefOf(entry: string): string | undefined {
  const match = /^\[\[([^\]]+)\]\]$/.exec(entry.trim());
  if (match === null) return undefined;
  const target = match[1]!.split("|")[0]!.trim();
  return target.length > 0 ? target : undefined;
}

/** True when `path` exists as a regular file - a directory is not a page. */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The absolute page path a source ref names, or `undefined`. */
function resolveSourcePage(vault: string, ref: string): string | undefined {
  let inside: string;
  try {
    inside = ensureInsideVault(join(vault, ref), vault);
  } catch {
    return undefined;
  }
  // Only a regular file resolves. A directory that happens to share the
  // page's name must not swallow the ref: the pass reads the page the
  // author linked, so the `.md` form is tried before the ref is given up
  // as unresolved.
  if (isRegularFile(inside)) return inside;
  const withMd = `${inside}.md`;
  return isRegularFile(withMd) ? withMd : undefined;
}

/**
 * Recompute the entity anchors of every page-sourced signal in the
 * vault. Dry-run by default; see the module and options documentation.
 */
export function runRelinkAnchors(vault: string, opts: RelinkAnchorsOptions): RelinkAnchorsReport {
  const apply = opts.apply === true;
  // Vault-identity write guard (context-integrity-gates, Unit J).
  // A dry run reports would-be additions and writes nothing.
  if (apply) assertVaultIdentityForWrite(vault);
  const agent = "maintenance";
  const now = opts.now;
  const reachCache: FrontmatterCache = new Map();
  // Reach-matched resolution: the visible predicate a signal's
  // attachments bind is the one at the reach the SIGNAL ITSELF is
  // readable at, not the lane's. A signal any remote-reach reader can
  // list must never receive an id whose entity page - or whose source
  // page - that reader cannot open: the id would sit in a file the
  // reader can list, and this pass never removes an anchor, so the
  // disclosure would be permanent. A local-only signal keeps the lane's
  // reach: the pass is a local repair pass, and what it heals for a
  // local-only page never leaves the host.
  const visibleAt =
    (reach: TransportReach) =>
    (rel: string): boolean =>
      isPathReadableAtReach(vault, rel, reach, reachCache);
  const laneVisible = visibleAt(MAINTENANCE_LANE_REACH);
  const remoteVisible = visibleAt(TRANSPORT_REACH.remote);
  // Vault-relative form of an absolute path. Derived with `relative`
  // rather than a length-based slice so a caller that handed down a
  // non-normalized vault root (a trailing separator, a redundant segment)
  // still yields the same relative paths as the normalized spelling.
  const relOf = (abs: string): string => relative(vault, abs).split(sep).join("/");

  let index: ReturnType<typeof buildEntityIndex>;
  try {
    index = buildEntityIndex(vault);
  } catch {
    index = { entities: [], byKey: new Map(), byAlias: new Map(), conflicts: [] };
  }
  // The apply arm builds through the capture path's own build and stamps
  // its skip audit; the dry run builds quietly, because a preview must
  // not write - not even a log event.
  const anchorables = apply
    ? buildAnchorables(vault, index, agent, now)
    : buildAnchorablesQuietly(vault, index);
  // Each anchorable's own page, so the TEXT-derived half can answer the
  // same per-signal visible predicate the link-derived half resolves
  // through: the anchorable list is built at the lane's reach and holds
  // every canonical entity the lane can see, and a match against it
  // without this filter wrote a private entity's id into a signal any
  // remote-reach reader can list - the leak the resolver's predicate
  // already closed for links, entering through the text arm instead.
  // Canonical scope, the same population the two builds admit, so every
  // matchable id resolves here.
  const entityRelById = new Map<string, string>();
  for (const entity of index.entities) {
    if (!entityStatusInScope(entity.status, ENTITY_STATUS_SCOPE.canonical)) continue;
    entityRelById.set(entity.id, relOf(entity.path));
  }
  // One resolver per reach, built on first use: each resolves through
  // its own view of the entity index (a page the predicate refuses is
  // dropped before any spelling can answer), and a vault with no
  // page-sourced signal in scope pays for neither. The link-derived ids
  // cache beside them, keyed per reach - the same source page answers a
  // remote-readable signal with its visible links and a local-only
  // signal with all of them, so one shared map would let whichever
  // signal read the page first decide for the other.
  let laneResolver: EntityLinkAccessor | undefined;
  let remoteResolver: EntityLinkAccessor | undefined;
  const laneLinkIds = new Map<string, ReadonlyArray<string>>();
  const remoteLinkIds = new Map<string, ReadonlyArray<string>>();

  const progress = progressCounter(OPERATION.relink, opts.onProgress);
  const perSource = new Map<string, { signals: number; anchorsAdded: number }>();
  let scanned = 0;
  let unreadable = 0;
  let pageSourced = 0;
  let skippedRawShape = 0;
  let changed = 0;
  let addedTotal = 0;

  // Listed first, so the walk is ONE stage with the whole denominator
  // (both trees) - a per-directory start would reset the counter an
  // operator is watching mid-stage.
  const dirs = [brainDirs(vault).inbox, brainDirs(vault).processed];
  const batches: Array<{ dir: string; names: string[] }> = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      batches.push({
        dir,
        names: readdirSync(dir)
          .filter((n) => n.startsWith("sig-") && n.endsWith(".md"))
          .toSorted(),
      });
    } catch {
      continue;
    }
  }
  progress.start(
    "signals",
    batches.reduce((sum, batch) => sum + batch.names.length, 0),
  );
  for (const { dir, names } of batches) {
    for (const name of names) {
      opts.safeguard?.checkpoint();
      const path = join(dir, name);
      scanned++;
      progress.advance("signals");
      let signal;
      try {
        signal = parseSignal(path);
      } catch {
        unreadable++;
        continue;
      }
      // Server-stamped sources only: the pass acts on signals whose
      // `source:` the SERVER derived - `source_type: extracted`, the
      // stamp every extraction caller writes. A `brain_feedback` caller
      // supplied its own pointer (a `live` signal carries no source_type
      // at all - absence IS the live stamp), and an inline author marker
      // is author-written the same way; a caller-chosen page must not
      // choose which entity ids attach, so the pass never reads those
      // pointers. Out of the pass's scope entirely: counted by neither
      // arm, the same answer a signal whose pointer names no page gets.
      if (signal.source_type !== BRAIN_SIGNAL_SOURCE_TYPE.extracted) continue;
      // Every source pointer that resolves to a real page in this vault
      // AT THE SIGNAL'S OWN REACH. A session pointer names no page and
      // resolves to nothing, which is exactly the out-of-scope answer; a
      // page the signal's reach withholds is identical to absent, so a
      // remotely readable signal is never fed the links of a page its
      // readers cannot open. Deduped: two pointers to one page are one
      // source - it is read once and counted once.
      const remotelyReadable = isPathReadableAtReach(
        vault,
        relOf(path),
        TRANSPORT_REACH.remote,
        reachCache,
      );
      const visible = remotelyReadable ? remoteVisible : laneVisible;
      const linkResolver = remotelyReadable
        ? (remoteResolver ??= entityLinkResolver(vault, { visible: remoteVisible }))
        : (laneResolver ??= entityLinkResolver(vault, { visible: laneVisible }));
      // The per-page id cache of THIS signal's reach: one stat + read +
      // parse per DISTINCT source page, not per signal - the inbox
      // commonly holds several signals citing the same page, and the
      // page's link-derived ids cannot change mid-pass. A page that
      // cannot be read (or is oversized) caches an empty list - the same
      // contributes-no-links answer the uncached path gave.
      const linkIdsByPage = remotelyReadable ? remoteLinkIds : laneLinkIds;
      const sources = [
        ...new Set(
          (signal.source ?? []).flatMap((entry) => {
            const ref = sourceRefOf(entry);
            if (ref === undefined) return [];
            const resolved = resolveSourcePage(vault, ref);
            if (resolved === undefined) return [];
            const rel = relOf(resolved);
            return visible(rel) ? [resolved] : [];
          }),
        ),
      ].map((abs) => ({ abs, rel: relOf(abs) }));
      if (sources.length === 0) continue;
      pageSourced++;

      // A codec-compressed raw section is out of the rewrite's reach,
      // like a page without a Raw section: `raw` above is the EXPANDED
      // text, but the bytes on disk hold the compressed form, where a
      // collapsed whitespace run can merge the `entities:` line into the
      // line above it - a byte-level rewrite would append a second line
      // the next parse never reads. Counted by neither arm: a dry run
      // never reports an addition no apply could make, and run-to-run
      // numbers stay idempotent.
      if (signal.rawCodec === true) continue;

      // The rewrite's only safe home is the extractor's own raw shape:
      // one `entities: <ids>` line, exactly what `routeExtractedFacts`
      // writes for a fact that anchored. An in-scope signal whose Raw
      // holds anything else is carrying prose - a verbatim quote - and a
      // line-level rewrite there overwrote the quote's own `entities:`
      // line, spliced an anchor line into a quote, or landed mid-quote
      // past a heading (the parser reads the section to EOF; the rewrite
      // stopped at the first `## ` line). Skipped ENTIRELY, counted,
      // never written; the check runs on the PARSED raw - the expanded
      // text for a codec signal - and the codec gate above still owns
      // the byte form, since a shaped raw compressed on disk is just as
      // out of the byte-level rewrite's reach as before. A signal whose
      // raw reads as absent (no `## Raw` section, or the legacy
      // placeholder) is not a shape failure: the extractor writes no raw
      // at all for a fact that anchored nothing, and the rewrite's own
      // support decides below whether one can be filled.
      if (signal.raw !== undefined && !isExtractorRawShape(signal.raw)) {
        skippedRawShape++;
        continue;
      }
      // The apply arm re-runs this same gate on the bytes it actually
      // rewrites ({@link decideRawRewrite}): the parse's bytes can go
      // stale before the write, and the rewrite trusts only its own
      // read.

      const stored = storedAnchorIds(signal.raw);
      const added: string[] = [];
      const push = (id: string): void => {
        if (!stored.includes(id) && !added.includes(id)) added.push(id);
      };
      // Text-derived first, through the capture path's own comparison, so a
      // form the extractor would anchor today is the form this pass adds.
      // The match runs UNCONDITIONALLY: a signal whose Raw section holds
      // only the placeholder still earns its text-derived anchors - the
      // placeholder is exactly the line the rewrite can fill - and only
      // the WRITE below waits on the rewrite's support. Each match is
      // then filtered through THIS signal's visible predicate - the same
      // one the source pointers passed above: the anchorables were built
      // at the lane's reach, so a remotely readable signal whose
      // principle names a private entity would otherwise store that
      // entity's id, the disclosure the link half's reach binding
      // already refuses.
      const haystackVariants = matchFormVariants(normalizeEntityName(signal.principle));
      for (const anchorable of anchorables) {
        if (!matchVariantsOccurIn(anchorable.forms, haystackVariants)) continue;
        const entityRel = entityRelById.get(anchorable.id);
        if (entityRel === undefined || !visible(entityRel)) continue;
        push(anchorable.id);
      }
      // Then link-derived, in body order, from each resolvable source page.
      for (const source of sources) {
        const rollup = perSource.get(source.rel) ?? { signals: 0, anchorsAdded: 0 };
        rollup.signals++;
        perSource.set(source.rel, rollup);
        let ids = linkIdsByPage.get(source.abs);
        if (ids === undefined) {
          try {
            ids =
              statSync(source.abs).size > SOURCE_PAGE_MAX_BYTES
                ? []
                : pageEntityLinks(readFileSync(source.abs, "utf8"), linkResolver);
          } catch {
            // A source page that cannot be read contributes no links; the
            // signal's stored anchors are untouched either way.
            ids = [];
          }
          linkIdsByPage.set(source.abs, ids);
        }
        for (const id of ids) push(id);
      }
      if (added.length === 0) continue;
      let before: string | null = null;
      try {
        before = readFileSync(path, "utf8");
      } catch {
        before = null;
      }
      // The gates above judged the bytes the PARSE read; these are the
      // bytes the rewrite would touch. A page edited between the parse
      // and this read would have the rewrite run on bytes no gate
      // checked, and a line rebuilt from the parse's `stored` would drop
      // an id the edit stored. The decision re-runs the shape gate on
      // the rewrite's own bytes and rebuilds the stored half from them;
      // `expectBefore` still pins these bytes to the rename below.
      const decision = before === null ? NO_REWRITE_HOME : decideRawRewrite(before, added);
      if (decision.action === "codec") {
        // The parse-time codec gate's answer, on the truth bytes:
        // skipped, counted by neither arm - the same page condition gets
        // the same report numbers whatever the timing.
        continue;
      }
      if (decision.action === "unsafe-shape") {
        // The same hold-out as the parse-time gate, on the truth bytes:
        // skipped ENTIRELY, counted, never written. The next pass reads
        // the page as it now stands and answers the same way.
        skippedRawShape++;
        continue;
      }
      // No `## Raw` section in the bytes (an unreadable page lands here
      // as `null` and reads the same): the anchor has no home on this
      // page, so no arm counts it - a dry run never reports an addition
      // no apply could make, and run-to-run numbers stay idempotent.
      if (decision.action === "no-home") continue;
      const next = decision.next;
      // The appended half, not the computed `added`, is what this
      // rewrite actually adds: a concurrent edit that stored some or all
      // of `added` between the parse and the read made the rest of the
      // count a no-op write - and a dry run must never report an
      // addition the apply arm would not make.
      const appended = decision.appended;
      changed++;
      addedTotal += appended.length;
      for (const source of sources) {
        const rollup = perSource.get(source.rel)!;
        rollup.anchorsAdded += appended.length;
      }
      if (!apply) continue;
      try {
        // The bytes read above are the write's expectation, re-checked
        // immediately before the rename: an edit that lands between the
        // read and the write fails here instead of being discarded, and
        // a concurrent move fails instead of recreating the page at its
        // old path. The rollback below covers the drift failure too -
        // the signal is reported by its absence, and the next pass
        // recomputes the same additions, idempotently.
        atomicWriteFileSync(path, next, { expectBefore: before });
      } catch {
        // A page that cannot be rewritten is reported by its absence: the
        // next pass recomputes the same additions, idempotently.
        changed--;
        addedTotal -= appended.length;
        for (const source of sources) {
          const rollup = perSource.get(source.rel)!;
          rollup.anchorsAdded -= appended.length;
        }
      }
    }
  }
  progress.finish();

  return {
    apply,
    signalsScanned: scanned,
    signalsUnreadable: unreadable,
    signalsPageSourced: pageSourced,
    signalsSkippedRawShape: skippedRawShape,
    signalsChanged: changed,
    anchorsAdded: addedTotal,
    perSource: [...perSource.entries()]
      .map(([source, counts]) => ({ source, ...counts }))
      .toSorted((a, b) => a.source.localeCompare(b.source)),
  };
}
