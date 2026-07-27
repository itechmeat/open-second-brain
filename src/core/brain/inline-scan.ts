/**
 * Vault walker for `o2b brain scan-inline` (§9). Finds `@osb` markers
 * in markdown files outside `Brain/`, dedups them against the
 * existing inbox via {@link computeDedupHash}, writes a new signal
 * via {@link writeSignal}, and annotates the source file in place
 * via {@link rewriteMarkers}.
 *
 * Walker invariants:
 *
 *   - Recursive walk from `<vault>/` over every `*.md` file.
 *   - Hard-skip set: `.git`, `node_modules`, `.open-second-brain`,
 *     `.obsidian/cache`, `.trash`, `.stversions`, `Brain/` (the
 *     derived layer — markers inside it would self-reference).
 *   - User excludes: passed via `opts.exclude` (vault-relative paths,
 *     matched against `<vault>/<exclude>` prefix).
 *   - User include narrowing: when `opts.paths` is non-empty, only
 *     files whose path starts with one of those prefixes are scanned.
 *   - Per-file size cap: 1 MiB. Larger files are skipped with an
 *     error entry in the report.
 *
 * Dedup: the in-memory `dedup_hash` → existing-signal-id index is
 * built once per run by scanning `Brain/inbox/` and
 * `Brain/inbox/processed/`. A marker whose hash already maps to an
 * existing signal triggers only a rewrite (annotate the source
 * file), not a new signal.
 *
 * Three marker kinds are routed here, each into a store that already
 * carries its own review gate: `feedback` into `Brain/inbox/`, `fact`
 * into the unconfirmed preferences, and `skill` into the pending
 * proposal queue (see `marker-routing.ts`). Every routed marker is
 * consumed through the same `@osb✓` sentinel, so a rescan is a no-op;
 * a marker whose destination REFUSED it is left live and its refusal
 * is reported, so the operator can fix the marker and rescan. `loop`
 * and `set` markers are not routed here - loops are live-derived and
 * set markers belong to the guarded write-back verb.
 */

import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";

import { emitIngestDedupReport, type IngestDedupSourceCount } from "./dedup-telemetry.ts";
import { buildDedupIndex, computeDedupHash, type DedupIndexEntry } from "./dedup-hash.ts";
import { discoverMarkersDetailed, isFeedbackMarker } from "./inline.ts";
import { rewriteMarkers, type RewriteOp } from "./inline-rewrite.ts";
import { routeCaptureMarker, ROUTED_MARKER_KINDS } from "./marker-routing.ts";
import { buildNoteWalkRules, resolveNoteRoots, walkMarkdownFiles } from "./notes/note-walk.ts";
import { writeSignal } from "./signal.ts";
import { isoDate, isoSecond } from "./time.ts";
import { BRAIN_SIGNAL_SOURCE_TYPE } from "./types.ts";

const MAX_FILE_SIZE_BYTES = 1_048_576; // 1 MiB

export interface ScanInlineOptions {
  /** Agent identity stamped on every signal created by this run. */
  readonly agent: string;
  /** When true, do not write signals or rewrite source files. */
  readonly dryRun?: boolean;
  /** Narrow the walker to vault-relative subdirs only. */
  readonly paths?: ReadonlyArray<string>;
  /** Additional vault-relative exclude prefixes. */
  readonly exclude?: ReadonlyArray<string>;
  /** Wall clock for `created_at` / `date` stamping. Tests pin this. */
  readonly now?: Date;
}

export interface ScanInlineErrorEntry {
  readonly path: string;
  readonly message: string;
}

export interface ScanInlineFileSummary {
  readonly path: string;
  readonly markers: number;
}

export interface ScanInlineResult {
  readonly scanned: number;
  readonly found: number;
  readonly created: number;
  readonly deduped: number;
  readonly malformed: number;
  /** Fact markers committed as unconfirmed preferences by this run. */
  readonly facts: number;
  /** Skill markers drafted into the pending proposal queue by this run. */
  readonly skills: number;
  readonly errors: ReadonlyArray<ScanInlineErrorEntry>;
  readonly filesWithMarkers: ReadonlyArray<ScanInlineFileSummary>;
}

export async function scanInline(
  vault: string,
  opts: ScanInlineOptions,
): Promise<ScanInlineResult> {
  const now = opts.now ?? new Date();
  const errors: ScanInlineErrorEntry[] = [];
  const filesWithMarkers: ScanInlineFileSummary[] = [];
  /** Per-file exact-hash drop counts, persisted once at the end of the run. */
  const dedupBySource: IngestDedupSourceCount[] = [];

  let scanned = 0;
  let found = 0;
  let created = 0;
  let deduped = 0;
  let malformed = 0; // reserved — not surfaced separately yet
  let facts = 0;
  let skills = 0;

  // v0.11.0: explicit `opts.paths` always wins. When absent or empty,
  // fall back to `notes.read_paths` from `_brain.yaml`. An empty
  // resolved list means "no folders to scan" — return immediately so
  // the agent never walks the vault without an operator opt-in.
  // v0.22.0: read-path `{{role}}` tokens are resolved inside
  // resolveNoteRoots via the optional vault-map.
  const roots = resolveNoteRoots(vault, opts.paths);
  if (roots.length === 0) {
    return Object.freeze({
      scanned: 0,
      found: 0,
      created: 0,
      deduped: 0,
      malformed: 0,
      facts: 0,
      skills: 0,
      errors: Object.freeze([]) as ReadonlyArray<ScanInlineErrorEntry>,
      filesWithMarkers: Object.freeze([]) as ReadonlyArray<ScanInlineFileSummary>,
    });
  }

  // Build dedup index once per run. Parse failures get surfaced
  // through the per-file errors array so the JSON report exposes
  // them; doctor flags malformed signals separately.
  const dedupIndex: Map<string, DedupIndexEntry> = buildDedupIndex(vault, {
    onError: (path, message) => errors.push({ path, message }),
  });

  // Effective rule set (v0.10.9): shared `vault.ignore_paths`, the hard
  // `Brain/` root skip, and any `--exclude` prefixes - all assembled by
  // the shared walker helper.
  const rules = buildNoteWalkRules(vault, opts.exclude);

  for (const file of walkMarkdownFiles(vault, roots, rules, {
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    onOversize: (oversize, size) => {
      errors.push({
        path: oversize.absPath,
        message: `file too large to scan (${size} bytes; cap ${MAX_FILE_SIZE_BYTES})`,
      });
    },
  })) {
    const filePath = file.absPath;
    scanned++;
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (err) {
      errors.push({
        path: filePath,
        message: `read failed: ${(err as Error).message ?? String(err)}`,
      });
      continue;
    }
    const discovery = discoverMarkersDetailed(content);
    malformed += discovery.malformed;
    const vaultRelSource = relative(vault, filePath).split(sep).join("/");
    // A named-field rejection on a ROUTED kind is an operator mistake with
    // a destination behind it, so it is surfaced by name instead of only
    // counted. Rejections of the other kinds keep their historical
    // count-only treatment, which `--strict` already turns into an exit.
    for (const issue of discovery.issues) {
      if (!ROUTED_MARKER_KINDS.has(issue.kind)) continue;
      errors.push({ path: filePath, message: issue.message });
    }

    const rewriteOps: RewriteOp[] = [];

    // Feedback markers become inbox signals. Loop markers are live-derived
    // and never consumed; set markers belong to the guarded write-back
    // verb. Neither may be turned into a signal or rewritten here.
    const markers = discovery.markers.filter(isFeedbackMarker);
    if (markers.length > 0) {
      found += markers.length;
      filesWithMarkers.push({ path: filePath, markers: markers.length });
    }
    let fileDeduped = 0;
    for (const marker of markers) {
      const hash = computeDedupHash({
        topic: marker.topic,
        signal: marker.signal,
        principle: marker.principle,
        ...(marker.scope ? { scope: marker.scope } : {}),
      });
      const existing = dedupIndex.get(hash);
      if (existing) {
        deduped++;
        fileDeduped++;
        if (!opts.dryRun) {
          rewriteOps.push({ marker, signalId: existing.id });
        }
        continue;
      }
      if (opts.dryRun) continue;
      // Create the signal.
      const sourceList = marker.source
        ? [...marker.source, `[[${vaultRelSource}]]`]
        : [`[[${vaultRelSource}]]`];
      try {
        const res = writeSignal(vault, {
          topic: marker.topic,
          signal: marker.signal,
          agent: marker.agent ?? opts.agent,
          principle: marker.principle,
          created_at: isoSecond(now),
          date: isoDate(now),
          slug: marker.topic,
          ...(marker.scope ? { scope: marker.scope } : {}),
          source: sourceList,
          source_type: BRAIN_SIGNAL_SOURCE_TYPE.inline,
          dedup_hash: hash,
          ...(marker.note ? { raw: marker.note } : {}),
        });
        dedupIndex.set(hash, { id: res.id, path: res.path });
        rewriteOps.push({ marker, signalId: res.id });
        created++;
      } catch (err) {
        errors.push({
          path: filePath,
          message: `writeSignal failed: ${(err as Error).message ?? String(err)}`,
        });
      }
    }

    if (fileDeduped > 0) {
      dedupBySource.push({
        ref: relative(vault, filePath).split(sep).join("/"),
        exactDeduped: fileDeduped,
      });
    }

    // Fact and skill markers reach their own gated stores. Per-marker
    // isolation: a destination that refuses one marker leaves it live and
    // reports why, and the remaining markers in the file still run.
    if (!opts.dryRun) {
      for (const marker of discovery.markers) {
        if (!ROUTED_MARKER_KINDS.has(marker.kind)) continue;
        try {
          const routed = routeCaptureMarker(vault, marker, {
            sourceRef: `[[${vaultRelSource}]]`,
            now,
          });
          if (routed.created) {
            if (marker.kind === "fact") facts++;
            else skills++;
          }
          rewriteOps.push({ marker, signalId: routed.id });
        } catch (err) {
          errors.push({
            path: filePath,
            message: `${marker.kind} marker at line ${marker.originLine} was refused: ${
              (err as Error).message ?? String(err)
            }`,
          });
        }
      }
    }

    if (rewriteOps.length > 0 && !opts.dryRun) {
      try {
        await rewriteMarkers(filePath, rewriteOps);
      } catch (err) {
        errors.push({
          path: filePath,
          message: `rewriteMarkers failed: ${(err as Error).message ?? String(err)}`,
        });
      }
    }
  }

  // Dedup observability (Unit F): one record per run that actually
  // dropped something, keyed by the note being re-ingested. A dry run
  // reports its count but writes nothing, here as everywhere else.
  if (!opts.dryRun) {
    emitIngestDedupReport(vault, {
      surface: "scan_inline",
      sources: dedupBySource,
      createdAt: now.toISOString(),
    });
  }

  return Object.freeze({
    scanned,
    found,
    created,
    deduped,
    malformed,
    facts,
    skills,
    errors: Object.freeze(errors),
    filesWithMarkers: Object.freeze(filesWithMarkers),
  });
}
