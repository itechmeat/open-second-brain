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
 */

import {
  Dirent,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

import {
  buildDedupIndex,
  computeDedupHash,
  type DedupIndexEntry,
} from "./dedup-hash.ts";
import { discoverMarkersDetailed } from "./inline.ts";
import { rewriteMarkers, type RewriteOp } from "./inline-rewrite.ts";
import { writeSignal } from "./signal.ts";
import { isoDate, isoSecond } from "./time.ts";
import { BRAIN_SIGNAL_SOURCE_TYPE } from "./types.ts";
import {
  matchIgnore,
  resolveVaultScope,
  type VaultIgnoreRule,
} from "../vault-scope/index.ts";

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

  // Build dedup index once per run. Parse failures get surfaced
  // through the per-file errors array so the JSON report exposes
  // them; doctor flags malformed signals separately.
  const dedupIndex: Map<string, DedupIndexEntry> = buildDedupIndex(vault, {
    onError: (path, message) => errors.push({ path, message }),
  });

  let scanned = 0;
  let found = 0;
  let created = 0;
  let deduped = 0;
  let malformed = 0; // reserved — not surfaced separately yet

  const includePrefixes = (opts.paths ?? []).map((p) => normalisePrefix(p));

  // Effective rule set (v0.10.9):
  //   - shared `vault.ignore_paths` from Brain/_brain.yaml (or defaults)
  //   - hardcoded `Brain` name-rule: scan-inline must never recurse
  //     into the derived layer regardless of operator policy
  //   - user `--exclude` entries, classified as path-prefix rules
  const scope = resolveVaultScope(vault);
  const rules: VaultIgnoreRule[] = [
    ...scope.rules,
    // `path` (not `name`) so the hard-skip targets only the top-level
    // `<vault>/Brain/` directory; a project file like
    // `projects/Brain/notes.md` keeps being scanned.
    { raw: "Brain", kind: "path" },
    ...(opts.exclude ?? []).map(
      (raw): VaultIgnoreRule => ({ raw: normalisePrefix(raw), kind: "path" }),
    ),
  ];

  for (const filePath of walkVault(vault, includePrefixes, rules)) {
    scanned++;
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      errors.push({
        path: filePath,
        message: `file too large to scan (${stat.size} bytes; cap ${MAX_FILE_SIZE_BYTES})`,
      });
      continue;
    }
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
    const markers = discovery.markers;
    if (markers.length === 0) continue;
    found += markers.length;
    filesWithMarkers.push({ path: filePath, markers: markers.length });

    const rewriteOps: RewriteOp[] = [];
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
        if (!opts.dryRun) {
          rewriteOps.push({ marker, signalId: existing.id });
        }
        continue;
      }
      if (opts.dryRun) continue;
      // Create the signal.
      const vaultRelSource = relative(vault, filePath).split(sep).join("/");
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

  return Object.freeze({
    scanned,
    found,
    created,
    deduped,
    malformed,
    errors: Object.freeze(errors),
    filesWithMarkers: Object.freeze(filesWithMarkers),
  });
}

// ----- Walker ---------------------------------------------------------------

function normalisePrefix(rel: string): string {
  // POSIX-normalise: replace OS-native separator with `/` FIRST, then
  // strip leading/trailing slashes. On Windows `notes\\` must become
  // `notes` (not `notes/`), so the separator conversion has to happen
  // before the slash trim. `matchIgnore` expects POSIX rel-paths.
  return rel.split(sep).join("/").replace(/^\/+|\/+$/g, "");
}

function* walkVault(
  vault: string,
  includePrefixes: ReadonlyArray<string>,
  rules: ReadonlyArray<VaultIgnoreRule>,
): Generator<string> {
  const stack: Array<{ abs: string; rel: string }> = [
    { abs: vault, rel: "" },
  ];
  while (stack.length > 0) {
    const { abs: dir, rel: relDir } = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const relPosix = relDir === "" ? entry.name : `${relDir}/${entry.name}`;

      if (matchIgnore(relPosix, rules).excluded) continue;

      if (entry.isDirectory()) {
        // Include-narrowing applies only to files: descend so subtree
        // files under an include prefix are still reached.
        stack.push({ abs: full, rel: relPosix });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;

      if (includePrefixes.length > 0) {
        const matches = includePrefixes.some(
          (p) => relPosix === p || relPosix.startsWith(p + "/"),
        );
        if (!matches) continue;
      }

      yield full;
    }
  }
}
