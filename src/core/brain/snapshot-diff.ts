/**
 * Read-only diff between two materialised `Brain/` trees.
 *
 * Used by both `o2b brain snapshot diff <a> [<b>]` and
 * `o2b brain rollback --dry-run <id>` — they share the same tree-
 * comparison primitive; the renderer (markdown / json) is split out
 * into `snapshot-diff-render.ts` so the differ stays purely
 * computational.
 *
 * The walker classifies every file under each root into one of six
 * artifact kinds (preference, retired, signal, log, config, other).
 * Preferences and retired files get a typed field-level diff for the
 * canonical set of derived/identity fields; everything else compares
 * by byte equality so the renderer can flag "log file body changed"
 * without listing every byte.
 *
 * Inputs are expected to be Brain/ root directories (not vault
 * roots). Callers feed `extractSnapshotToTemp(...).brainRoot` for
 * snapshots and `<vault>/Brain` for the live tree.
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { parsePreference, parseRetired } from "./preference.ts";
import type { BrainPreference, BrainRetired } from "./types.ts";

// ----- Public types --------------------------------------------------------

export type BrainTreeEntryKind =
  | "preference"
  | "retired"
  | "signal"
  | "log"
  | "config"
  | "other";

export interface BrainTreeEntry {
  /** Vault-relative path under `Brain/<…>`. */
  readonly path: string;
  readonly kind: BrainTreeEntryKind;
  /** Artifact id when applicable (`pref-foo`, `ret-bar`, `sig-…`). */
  readonly id: string | null;
  /**
   * Human-readable title sourced from `principle` for preference and
   * retired entries — the markdown renderer uses it to build titled
   * wikilinks (§27). Empty string for other kinds and for entries
   * that failed to parse.
   */
  readonly principle: string;
}

export interface BrainFieldChange {
  readonly field: string;
  readonly before: string | number | boolean | null;
  readonly after: string | number | boolean | null;
}

export interface BrainTreeChange {
  readonly entry: BrainTreeEntry;
  /** Empty when only the body bytes differ. */
  readonly fields: ReadonlyArray<BrainFieldChange>;
  readonly bodyChanged: boolean;
}

export interface BrainTreeDiff {
  readonly added: ReadonlyArray<BrainTreeEntry>;
  readonly removed: ReadonlyArray<BrainTreeEntry>;
  readonly modified: ReadonlyArray<BrainTreeChange>;
}

const TRACKED_PREF_FIELDS: ReadonlyArray<keyof BrainPreference> = Object.freeze([
  "status",
  "applied_count",
  "violated_count",
  "confidence",
  "confidence_value",
  "pinned",
  "last_evidence_at",
  "confirmed_at",
]);

const TRACKED_RETIRED_FIELDS: ReadonlyArray<keyof BrainRetired> = Object.freeze([
  "retired_reason",
  "applied_count",
  "violated_count",
  "confidence",
  "confidence_value",
  "pinned",
  "last_evidence_at",
  "superseded_by",
]);

// ----- Public API ----------------------------------------------------------

/**
 * Compute the artifact-level diff between two `Brain/` trees.
 *
 * Both roots must exist; missing files inside either root are
 * treated as "not present", not as errors. The function never
 * mutates either tree. Returned arrays are frozen for caller safety.
 */
export function diffBrainTrees(
  rootA: string,
  rootB: string,
): BrainTreeDiff {
  const a = walkBrain(rootA);
  const b = walkBrain(rootB);

  const aByPath = new Map<string, ScannedFile>();
  const bByPath = new Map<string, ScannedFile>();
  for (const f of a) aByPath.set(f.entry.path, f);
  for (const f of b) bByPath.set(f.entry.path, f);

  const added: BrainTreeEntry[] = [];
  const removed: BrainTreeEntry[] = [];
  const modified: BrainTreeChange[] = [];

  for (const f of b) {
    if (!aByPath.has(f.entry.path)) {
      added.push(f.entry);
    }
  }
  for (const f of a) {
    if (!bByPath.has(f.entry.path)) {
      removed.push(f.entry);
    }
  }
  for (const f of a) {
    const right = bByPath.get(f.entry.path);
    if (!right) continue;
    const change = diffFile(f, right);
    if (change !== null) modified.push(change);
  }

  // Deterministic ordering: kind ascending, then path ascending. Two
  // runs on identical inputs must produce identical output bytes so
  // operators can grep a stable diff.
  const sortFn = (
    x: { readonly path: string; readonly kind: BrainTreeEntryKind },
    y: { readonly path: string; readonly kind: BrainTreeEntryKind },
  ): number => {
    if (x.kind !== y.kind) return x.kind.localeCompare(y.kind);
    return x.path.localeCompare(y.path);
  };
  added.sort((x, y) => sortFn(x, y));
  removed.sort((x, y) => sortFn(x, y));
  modified.sort((x, y) => sortFn(x.entry, y.entry));

  return Object.freeze({
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    modified: Object.freeze(modified),
  });
}

// ----- Walker + classifier -------------------------------------------------

interface ScannedFile {
  readonly entry: BrainTreeEntry;
  readonly absolutePath: string;
  readonly pref?: BrainPreference;
  readonly retired?: BrainRetired;
  readonly bytes?: string;
}

function walkBrain(root: string): ReadonlyArray<ScannedFile> {
  if (!existsSync(root)) return [];
  const out: ScannedFile[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: ReadonlyArray<string>;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let st;
      try {
        // `lstatSync` (NOT `statSync`) so we never follow a symlink.
        // A malicious snapshot tarball that contained a symlink
        // under `Brain/` pointing at `/etc/passwd` would otherwise
        // have the walker read the target file as if it were a
        // Brain artifact and surface its bytes inside the diff.
        // Skipping symlinks is the cheapest, most honest defense.
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      const rel = relative(root, abs).replaceAll("\\", "/");
      // `.snapshots/` is the snapshot family itself — comparing
      // archives across snapshots is not meaningful (each snapshot
      // owns its own archive set). Skip the tree entirely.
      if (rel === ".snapshots" || rel.startsWith(".snapshots/")) continue;
      // Defense-in-depth: an entry whose relative path escapes the
      // walker root (`..` segment) cannot legitimately be inside
      // a Brain snapshot — drop it rather than classify under a
      // bogus path. `relative()` returning `..` is the canonical
      // marker for "out of root".
      if (rel.startsWith("..")) continue;
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!st.isFile()) continue;
      out.push(scanFile(root, abs, rel));
    }
  }
  return out;
}

function scanFile(_root: string, abs: string, rel: string): ScannedFile {
  const baseName = rel.split("/").pop() ?? rel;
  if (rel.startsWith("preferences/") && baseName.startsWith("pref-")) {
    try {
      const pref = parsePreference(abs);
      return {
        entry: {
          path: `Brain/${rel}`,
          kind: "preference",
          id: pref.id,
          principle: pref.principle,
        },
        absolutePath: abs,
        pref,
        bytes: readFileSafe(abs),
      };
    } catch {
      return {
        entry: {
          path: `Brain/${rel}`,
          kind: "preference",
          id: baseName.replace(/\.md$/, ""),
          principle: "",
        },
        absolutePath: abs,
        bytes: readFileSafe(abs),
      };
    }
  }
  if (rel.startsWith("retired/") && baseName.startsWith("ret-")) {
    try {
      const retired = parseRetired(abs);
      return {
        entry: {
          path: `Brain/${rel}`,
          kind: "retired",
          id: retired.id,
          principle: retired.principle,
        },
        absolutePath: abs,
        retired,
        bytes: readFileSafe(abs),
      };
    } catch {
      return {
        entry: {
          path: `Brain/${rel}`,
          kind: "retired",
          id: baseName.replace(/\.md$/, ""),
          principle: "",
        },
        absolutePath: abs,
        bytes: readFileSafe(abs),
      };
    }
  }
  if (
    (rel.startsWith("inbox/") || rel.startsWith("processed/"))
    && baseName.startsWith("sig-")
  ) {
    return {
      entry: {
        path: `Brain/${rel}`,
        kind: "signal",
        id: baseName.replace(/\.md$/, ""),
        principle: "",
      },
      absolutePath: abs,
      bytes: readFileSafe(abs),
    };
  }
  if (rel.startsWith("log/") && /^log\/\d{4}-\d{2}-\d{2}\.md$/.test(rel)) {
    return {
      entry: {
        path: `Brain/${rel}`,
        kind: "log",
        id: null,
        principle: "",
      },
      absolutePath: abs,
      bytes: readFileSafe(abs),
    };
  }
  if (
    rel === "_brain.yaml"
    || rel === "_BRAIN.md"
    || rel === "active.md"
  ) {
    return {
      entry: {
        path: `Brain/${rel}`,
        kind: "config",
        id: null,
        principle: "",
      },
      absolutePath: abs,
      bytes: readFileSafe(abs),
    };
  }
  return {
    entry: {
      path: `Brain/${rel}`,
      kind: "other",
      id: null,
      principle: "",
    },
    absolutePath: abs,
    bytes: readFileSafe(abs),
  };
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// ----- Per-file diff -------------------------------------------------------

function diffFile(a: ScannedFile, b: ScannedFile): BrainTreeChange | null {
  // Bytes-equal is the cheapest path. Both sides identical → no
  // change row in the diff.
  if (a.bytes !== undefined && b.bytes !== undefined && a.bytes === b.bytes) {
    return null;
  }
  if (a.entry.kind === "preference" && a.pref && b.pref) {
    return diffPreference(a, b);
  }
  if (a.entry.kind === "retired" && a.retired && b.retired) {
    return diffRetired(a, b);
  }
  // Signals, logs, config, other — body-only diff.
  return {
    entry: b.entry.principle.length > 0 ? b.entry : a.entry,
    fields: [],
    bodyChanged: true,
  };
}

function diffPreference(a: ScannedFile, b: ScannedFile): BrainTreeChange {
  const fields: BrainFieldChange[] = [];
  if (a.pref && b.pref) {
    for (const field of TRACKED_PREF_FIELDS) {
      const before = normaliseValue(a.pref[field]);
      const after = normaliseValue(b.pref[field]);
      if (before !== after) {
        fields.push({ field, before, after });
      }
    }
  }
  // Strip frontmatter region from the byte comparison so a pure
  // body change is still visible without claiming "fields changed".
  // The cheap heuristic: when the rendered field set is empty but
  // bytes differ, mark `bodyChanged: true`.
  const bodyChanged = fields.length === 0 && a.bytes !== b.bytes;
  return { entry: b.entry, fields, bodyChanged };
}

function diffRetired(a: ScannedFile, b: ScannedFile): BrainTreeChange {
  const fields: BrainFieldChange[] = [];
  if (a.retired && b.retired) {
    for (const field of TRACKED_RETIRED_FIELDS) {
      const before = normaliseValue(a.retired[field]);
      const after = normaliseValue(b.retired[field]);
      if (before !== after) {
        fields.push({ field, before, after });
      }
    }
  }
  const bodyChanged = fields.length === 0 && a.bytes !== b.bytes;
  return { entry: b.entry, fields, bodyChanged };
}

function normaliseValue(
  v: unknown,
): string | number | boolean | null {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return v;
  }
  // Arrays / objects are not currently in TRACKED_*_FIELDS; collapse
  // anything unexpected to a JSON string so the diff stays
  // human-readable rather than emitting `[object Object]`.
  return JSON.stringify(v);
}
