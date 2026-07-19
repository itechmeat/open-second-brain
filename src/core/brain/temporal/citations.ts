/**
 * Inline source-citation promotion (Source pipeline integrity suite,
 * Q1, t_a3d1adb0).
 *
 * Notes carry prose provenance as a fixed structural marker:
 *
 *     [Source: <name>, YYYY-MM-DD]
 *
 * This module parses that marker out of note prose and promotes each
 * well-formed citation into the temporal timeline as a dated
 * `source-citation` provenance event, stamped at the citation date so it
 * lands on the timeline where the source was dated rather than when it
 * was scanned.
 *
 * The marker is a FIXED grammar (the literal `[Source:` prefix and a
 * comma separator), never a natural-language heuristic. The date is
 * parsed purely structurally: an ISO `YYYY-MM-DD` shape validated as a
 * real calendar date. Month names or other localized date forms are NOT
 * recognised - they surface as malformed markers, never silently parsed.
 *
 * Dedup key is (normalized name, date) against already-logged
 * `source-citation` events, so a re-scan of an unchanged vault promotes
 * nothing and leaves the log byte-identical. Malformed markers are
 * reported explicitly and skipped; they never abort the surrounding scan.
 */

import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";

import { appendLogEvent } from "../log.ts";
import { readLogDay } from "../log-jsonl.ts";
import { buildNoteWalkRules, resolveNoteRoots, walkMarkdownFiles } from "../notes/note-walk.ts";
import { BRAIN_LOG_EVENT_KIND } from "../types.ts";

/** Per-file scan cap, matching the inline-marker scanner (1 MiB). */
const MAX_FILE_SIZE_BYTES = 1_048_576;

/**
 * Candidate marker: the literal `[Source:` prefix, an inner payload with
 * no closing bracket, then `]`. The inner payload is validated
 * separately so a bracket-shaped-but-invalid marker is reported as
 * malformed rather than missed.
 */
const CANDIDATE_RE = /\[Source:\s*([^\]]*)\]/g;

/**
 * Structural split of a candidate's inner payload into `<name>` and an
 * ISO `YYYY-MM-DD` date anchored at the end. The name is everything up
 * to the LAST comma that precedes the trailing date, so names may
 * themselves contain commas. The date shape is validated for real
 * calendar bounds by {@link isRealIsoDate}.
 */
const INNER_RE = /^(.*\S)\s*,\s*(\d{4})-(\d{2})-(\d{2})$/;

const DAYS_IN_MONTH: ReadonlyArray<number> = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** One well-formed citation marker parsed from note prose. */
export interface CitationMarker {
  /** Raw citation name, trimmed. Whitespace preserved as written. */
  readonly name: string;
  /** ISO `YYYY-MM-DD` citation date (validated as a real calendar date). */
  readonly date: string;
  /** 1-based line number the marker was found on. */
  readonly line: number;
}

/** A bracket-shaped marker that failed structural validation. */
export interface MalformedCitation {
  /** 1-based line number the candidate was found on. */
  readonly line: number;
  /** The raw candidate text, verbatim. */
  readonly raw: string;
  /** Structural reason the candidate was rejected. */
  readonly reason: string;
}

export interface CitationParseResult {
  readonly markers: ReadonlyArray<CitationMarker>;
  readonly malformed: ReadonlyArray<MalformedCitation>;
}

/**
 * Normalize a citation name for dedup: trim, collapse internal runs of
 * whitespace to a single space, and case-fold. Case folding is Unicode
 * general (`toLowerCase`), never a per-language table.
 */
export function normalizeCitationName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** True when `y-m-d` is a real calendar date (leap years accounted for). */
function isRealIsoDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12) return false;
  if (d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const max = m === 2 && leap ? 29 : DAYS_IN_MONTH[m - 1]!;
  return d <= max;
}

/**
 * Parse every `[Source: <name>, YYYY-MM-DD]` marker out of `content`.
 * Well-formed markers land in `markers`; bracket-shaped candidates that
 * fail structural validation land in `malformed` with a reason. Pure and
 * deterministic; performs no I/O.
 */
export function parseCitations(content: string): CitationParseResult {
  const markers: CitationMarker[] = [];
  const malformed: MalformedCitation[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNumber = i + 1;
    CANDIDATE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CANDIDATE_RE.exec(line)) !== null) {
      const raw = match[0]!;
      const inner = match[1]!.trim();
      const parsed = INNER_RE.exec(inner);
      if (parsed === null) {
        malformed.push({
          line: lineNumber,
          raw,
          reason: "expected '<name>, YYYY-MM-DD' (missing comma or non-ISO date shape)",
        });
        continue;
      }
      const name = parsed[1]!.trim();
      const year = Number(parsed[2]!);
      const month = Number(parsed[3]!);
      const day = Number(parsed[4]!);
      if (name.length === 0) {
        malformed.push({ line: lineNumber, raw, reason: "empty citation name" });
        continue;
      }
      if (!isRealIsoDate(year, month, day)) {
        malformed.push({
          line: lineNumber,
          raw,
          reason: `not a real calendar date: ${parsed[2]}-${parsed[3]}-${parsed[4]}`,
        });
        continue;
      }
      markers.push({ name, date: `${parsed[2]}-${parsed[3]}-${parsed[4]}`, line: lineNumber });
    }
  }

  return Object.freeze({
    markers: Object.freeze(markers),
    malformed: Object.freeze(malformed),
  });
}

export interface ScanCitationsOptions {
  /** Agent identity stamped on every promoted event. */
  readonly agent: string;
  /** When true, report promotions without writing any events. */
  readonly dryRun?: boolean;
  /** Narrow the walker to vault-relative subdirs only. */
  readonly paths?: ReadonlyArray<string>;
  /** Additional vault-relative exclude prefixes. */
  readonly exclude?: ReadonlyArray<string>;
}

export interface CitationScanError {
  readonly path: string;
  readonly message: string;
}

export interface CitationScanMalformed {
  readonly path: string;
  readonly line: number;
  readonly raw: string;
  readonly reason: string;
}

export interface CitationScanFileSummary {
  readonly path: string;
  readonly citations: number;
}

export interface CitationScanResult {
  /** Files walked. */
  readonly scanned: number;
  /** Well-formed markers found. */
  readonly found: number;
  /** Events written (0 on a dry run). */
  readonly promoted: number;
  /** Well-formed markers skipped as duplicates of already-logged events. */
  readonly deduped: number;
  /** Malformed marker count. */
  readonly malformed: number;
  readonly malformedMarkers: ReadonlyArray<CitationScanMalformed>;
  readonly errors: ReadonlyArray<CitationScanError>;
  readonly filesWithCitations: ReadonlyArray<CitationScanFileSummary>;
}

/**
 * Lazily-built per-date set of `${normalizedName}` keys already present
 * as `source-citation` events in that day's log. Because a promoted
 * event is always stamped at its citation date, dedup only needs that
 * one day's log rather than the whole timeline.
 */
class DedupIndex {
  private readonly byDate = new Map<string, Set<string>>();

  constructor(private readonly vault: string) {}

  private forDate(date: string): Set<string> {
    const cached = this.byDate.get(date);
    if (cached !== undefined) return cached;
    const seen = new Set<string>();
    const { entries } = readLogDay(this.vault, date);
    for (const entry of entries) {
      if (entry.eventType !== BRAIN_LOG_EVENT_KIND.sourceCitation) continue;
      const name = entry.body["name"];
      const at = entry.body["date"];
      if (typeof name === "string" && typeof at === "string" && at === date) {
        seen.add(normalizeCitationName(name));
      }
    }
    this.byDate.set(date, seen);
    return seen;
  }

  has(name: string, date: string): boolean {
    return this.forDate(date).has(normalizeCitationName(name));
  }

  add(name: string, date: string): void {
    this.forDate(date).add(normalizeCitationName(name));
  }
}

/**
 * Walk the configured note folders, parse citation markers, and promote
 * each unique well-formed citation into a dated `source-citation` event.
 * Read-only when `dryRun` is set. Malformed markers and per-file read
 * errors are collected and reported, never silently swallowed.
 */
export function scanCitations(vault: string, opts: ScanCitationsOptions): CitationScanResult {
  const errors: CitationScanError[] = [];
  const malformedMarkers: CitationScanMalformed[] = [];
  const filesWithCitations: CitationScanFileSummary[] = [];

  let scanned = 0;
  let found = 0;
  let promoted = 0;
  let deduped = 0;

  const roots = resolveNoteRoots(vault, opts.paths);
  if (roots.length === 0) {
    return freezeResult({
      scanned,
      found,
      promoted,
      deduped,
      malformedMarkers,
      errors,
      filesWithCitations,
    });
  }

  const rules = buildNoteWalkRules(vault, opts.exclude);
  const dedup = new DedupIndex(vault);

  for (const file of walkMarkdownFiles(vault, roots, rules, {
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    onOversize: (oversize, size) => {
      errors.push({
        path: oversize.absPath,
        message: `file too large to scan (${size} bytes; cap ${MAX_FILE_SIZE_BYTES})`,
      });
    },
  })) {
    scanned++;
    let content: string;
    try {
      content = readFileSync(file.absPath, "utf8");
    } catch (err) {
      errors.push({
        path: file.absPath,
        message: `read failed: ${(err as Error).message ?? String(err)}`,
      });
      continue;
    }

    const parsed = parseCitations(content);
    for (const bad of parsed.malformed) {
      malformedMarkers.push({
        path: file.absPath,
        line: bad.line,
        raw: bad.raw,
        reason: bad.reason,
      });
    }
    if (parsed.markers.length === 0) continue;
    found += parsed.markers.length;
    filesWithCitations.push({ path: file.absPath, citations: parsed.markers.length });

    const vaultRelSource = relative(vault, file.absPath).split(sep).join("/");
    for (const marker of parsed.markers) {
      if (dedup.has(marker.name, marker.date)) {
        deduped++;
        continue;
      }
      if (opts.dryRun) {
        // Count the promotion the run WOULD make, and record it in the
        // in-memory index so repeated markers within one dry run still
        // dedup against the first.
        promoted++;
        dedup.add(marker.name, marker.date);
        continue;
      }
      try {
        appendLogEvent(vault, {
          timestamp: `${marker.date}T00:00:00Z`,
          eventType: BRAIN_LOG_EVENT_KIND.sourceCitation,
          body: {
            agent: opts.agent,
            name: marker.name,
            date: marker.date,
            source: `[[${vaultRelSource}]]`,
          },
        });
        dedup.add(marker.name, marker.date);
        promoted++;
      } catch (err) {
        errors.push({
          path: file.absPath,
          message: `promote failed: ${(err as Error).message ?? String(err)}`,
        });
      }
    }
  }

  return freezeResult({
    scanned,
    found,
    promoted,
    deduped,
    malformedMarkers,
    errors,
    filesWithCitations,
  });
}

function freezeResult(r: {
  scanned: number;
  found: number;
  promoted: number;
  deduped: number;
  malformedMarkers: CitationScanMalformed[];
  errors: CitationScanError[];
  filesWithCitations: CitationScanFileSummary[];
}): CitationScanResult {
  return Object.freeze({
    scanned: r.scanned,
    found: r.found,
    promoted: r.promoted,
    deduped: r.deduped,
    malformed: r.malformedMarkers.length,
    malformedMarkers: Object.freeze(r.malformedMarkers),
    errors: Object.freeze(r.errors),
    filesWithCitations: Object.freeze(r.filesWithCitations),
  });
}
