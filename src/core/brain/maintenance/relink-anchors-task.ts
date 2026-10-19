/**
 * The relink maintenance lane task (note-change truth maintenance, F4/C3).
 *
 * Anchors are facts of attachment: a signal whose `entities:` line omits
 * an entity it is about never reaches that entity's recall surface. The
 * write side now attaches link-derived ids beside the text-derived ones
 * (the extraction callers resolve the source page's outbound links), but
 * every signal written before that change - and every text anchor the
 * older matcher could not see - stays narrow until something recomputes
 * it. This pass is that something: it walks the signal pages, and for
 * every PAGE-SOURCED signal (one whose `source:` pointer resolves to a
 * vault page) it recomputes the anchors with the shipped rules and unions
 * them into the stored line.
 *
 * ## The recomputation uses the shipped matchers, never new ones
 *
 * Text anchors come from the same build the capture path builds
 * (`buildAnchorables`) matched through the capture path's own occurrence
 * rule: the fact text normalized once and expanded through
 * {@link matchFormVariants}, each entity's precomputed variants tested
 * with {@link matchVariantsOccurIn} - the exact comparison
 * `routeExtractedFacts` performs, so a form this pass adds is exactly a
 * form the extractor itself would attach today. Link-derived ids come
 * from the page-link resolver ({@link ../intake/page-entity-links.ts}),
 * the same resolver the extraction callers use, with the entity pages
 * filtered at {@link MAINTENANCE_LANE_REACH} - the lane's declared local
 * reach, the one at which a repair pass may see everything it is
 * repairing.
 *
 * ## Additive only, and dry-run by default
 *
 * An anchor already stored is never removed, even when the recompute
 * would not produce it: the pass heals narrow anchor lists, it does not
 * second-guess wide ones (an id that outlived its entity is the doctor's
 * finding, not this pass's deletion). Absent {@link RelinkAnchorsOptions.apply}
 * the pass reports what it WOULD add and writes nothing; with `apply` the
 * changed signal pages are rewritten in place through the atomic writer,
 * the stored ids first and the added ones appended. A signal without a
 * `## Raw` section is out of the rewrite's reach - the section is the
 * anchor's only home, and this pass does not restructure pages.
 *
 * The pass never calls a model: the recomputation is a file walk, an
 * index build and pure matching, bounded by the caller's safeguard like
 * every other lane task.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { ensureInsideVault } from "../../path-safety.ts";
import { MAINTENANCE_LANE_REACH } from "../../graph/transport-reach.ts";
import { isPathReadableAtReach, type FrontmatterCache } from "../../search/result-filters.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { buildEntityIndex } from "../entities/index-builder.ts";
import {
  matchFormVariants,
  matchVariantsOccurIn,
  normalizeEntityName,
} from "../entities/canonical.ts";
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
import { buildAnchorables } from "../fact-extract.ts";

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
   * Injected clock; it stamps the skip-audit log events the shared
   * anchorable build may emit, exactly as the capture path stamps them.
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

/** The vault-relative page path a source ref names, or `undefined`. */
function resolveSourcePage(vault: string, ref: string): string | undefined {
  let inside: string;
  try {
    inside = ensureInsideVault(join(vault, ref), vault);
  } catch {
    return undefined;
  }
  if (existsSync(inside)) return inside;
  const withMd = `${inside}.md`;
  return existsSync(withMd) ? withMd : undefined;
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
  // The lane's declared reach: everything it reads, it reads as a local
  // repair pass, and the same predicate decides what the link-derived
  // half may name.
  const visible = (rel: string): boolean =>
    isPathReadableAtReach(vault, rel, MAINTENANCE_LANE_REACH, reachCache);

  let index: ReturnType<typeof buildEntityIndex>;
  try {
    index = buildEntityIndex(vault);
  } catch {
    index = { entities: [], byKey: new Map(), byAlias: new Map(), conflicts: [] };
  }
  const anchorables = buildAnchorables(vault, index, agent, now);
  const linkResolver: EntityLinkAccessor = entityLinkResolver(vault, { visible });

  const progress = progressCounter(OPERATION.relink, opts.onProgress);
  const perSource = new Map<string, { signals: number; anchorsAdded: number }>();
  let scanned = 0;
  let unreadable = 0;
  let pageSourced = 0;
  let changed = 0;
  let addedTotal = 0;

  const dirs = [brainDirs(vault).inbox, brainDirs(vault).processed];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir)
        .filter((n) => n.startsWith("sig-") && n.endsWith(".md"))
        .toSorted();
    } catch {
      continue;
    }
    progress.start("signals", names.length);
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
      // Every source pointer that resolves to a real page in this vault.
      // A session pointer names no page and resolves to nothing, which is
      // exactly the out-of-scope answer.
      const sourcePaths = (signal.source ?? []).flatMap((entry) => {
        const ref = sourceRefOf(entry);
        if (ref === undefined) return [];
        const resolved = resolveSourcePage(vault, ref);
        if (resolved === undefined) return [];
        const rel = resolved.slice(vault.length + 1);
        return visible(rel) ? [resolved] : [];
      });
      if (sourcePaths.length === 0) continue;
      pageSourced++;

      const stored = storedAnchorIds(signal.raw);
      const added: string[] = [];
      const push = (id: string): void => {
        if (!stored.includes(id) && !added.includes(id)) added.push(id);
      };
      // Text-derived first, through the capture path's own comparison, so a
      // form the extractor would anchor today is the form this pass adds.
      if (signal.raw !== undefined) {
        const haystackVariants = matchFormVariants(normalizeEntityName(signal.principle));
        for (const anchorable of anchorables) {
          if (matchVariantsOccurIn(anchorable.forms, haystackVariants)) push(anchorable.id);
        }
      }
      // Then link-derived, in body order, from each resolvable source page.
      for (const sourcePath of sourcePaths) {
        const rel = sourcePath.slice(vault.length + 1);
        const rollup = perSource.get(rel) ?? { signals: 0, anchorsAdded: 0 };
        rollup.signals++;
        perSource.set(rel, rollup);
        try {
          if (statSync(sourcePath).size > SOURCE_PAGE_MAX_BYTES) continue;
          const content = readFileSync(sourcePath, "utf8");
          for (const id of pageEntityLinks(content, linkResolver)) push(id);
        } catch {
          // A source page that cannot be read contributes no links; the
          // signal's stored anchors are untouched either way.
          continue;
        }
      }
      if (added.length === 0) continue;
      changed++;
      addedTotal += added.length;
      for (const sourcePath of sourcePaths) {
        const rollup = perSource.get(sourcePath.slice(vault.length + 1))!;
        rollup.anchorsAdded += added.length;
      }
      if (!apply) continue;
      const nextLine = `entities: ${[...stored, ...added].join(", ")}`;
      try {
        const next = rewriteRawEntitiesLine(readFileSync(path, "utf8"), nextLine);
        if (next !== undefined) atomicWriteFileSync(path, next);
      } catch {
        // A page that cannot be rewritten is reported by its absence: the
        // next pass recomputes the same additions, idempotently.
        changed--;
        addedTotal -= added.length;
        for (const sourcePath of sourcePaths) {
          const rollup = perSource.get(sourcePath.slice(vault.length + 1))!;
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
