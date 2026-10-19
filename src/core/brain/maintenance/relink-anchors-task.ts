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
 * so the disclosure would be permanent. A signal reserved against remote
 * reads keeps {@link MAINTENANCE_LANE_REACH}: the lane is a local repair
 * pass, and what it heals for a local-only page never leaves the host.
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
 * stamped exactly as the capture path stamps it. A signal without a
 * `## Raw` section is out of the rewrite's reach - the section is the
 * anchor's only home, and this pass does not restructure pages - so it is
 * counted by neither arm: a dry run never reports an addition no apply
 * could make. The same holds for a codec-compressed section: the bytes
 * on disk hold the reversible compressed form, whose collapsed whitespace
 * runs can hide the `entities:` line from a line-level rewrite, so the
 * pass skips those signals outright rather than write a line the next
 * parse never reads. The apply arm writes against the bytes it read
 * (`expectBefore`): a page edited or moved between the read and the
 * rename fails the write instead of losing that edit, and the next pass
 * retries.
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
  /** Signals whose `source:` pointer resolved to at least one vault page. */
  readonly signalsPageSourced: number;
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
      // the WRITE below waits on the rewrite's support.
      const haystackVariants = matchFormVariants(normalizeEntityName(signal.principle));
      for (const anchorable of anchorables) {
        if (matchVariantsOccurIn(anchorable.forms, haystackVariants)) push(anchorable.id);
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
      const nextLine = `entities: ${[...stored, ...added].join(", ")}`;
      let before: string | null = null;
      try {
        before = readFileSync(path, "utf8");
      } catch {
        before = null;
      }
      // `rewriteRawEntitiesLine` is a pure string fold and never throws;
      // an unreadable page lands here as `null` and reads as no Raw
      // section below.
      const next = before === null ? undefined : rewriteRawEntitiesLine(before, nextLine);
      // No `## Raw` section: the anchor has no home on this page, so no
      // arm counts it - a dry run never reports an addition no apply
      // could make, and run-to-run numbers stay idempotent.
      if (next === undefined) continue;
      changed++;
      addedTotal += added.length;
      for (const source of sources) {
        const rollup = perSource.get(source.rel)!;
        rollup.anchorsAdded += added.length;
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
        addedTotal -= added.length;
        for (const source of sources) {
          const rollup = perSource.get(source.rel)!;
          rollup.anchorsAdded -= added.length;
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
    signalsChanged: changed,
    anchorsAdded: addedTotal,
    perSource: [...perSource.entries()]
      .map(([source, counts]) => ({ source, ...counts }))
      .toSorted((a, b) => a.source.localeCompare(b.source)),
  };
}
