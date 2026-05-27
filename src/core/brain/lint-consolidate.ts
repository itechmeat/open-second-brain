/**
 * Self-healing vault lint. Detects structural drift in Brain/* and,
 * with `--apply`, applies the smallest possible fix.
 *
 * Two operations ship in v0.10.15:
 *   1. `fix-merged-link` - wikilinks pointing at a page that carries
 *      `merged_into: <canonical>` get rewritten to `[[canonical]]`.
 *      This is the natural follow-up to a page-dedup merge so old
 *      log entries do not keep referencing the secondary.
 *   2. `demote-stale-stable` - preferences with `_lifecycle: stable`,
 *      `created_at` older than the staleness cap, and no recent
 *      apply-evidence get marked for demotion to `_lifecycle: draft`.
 *      The signal is operator-actionable: the rule has aged out of
 *      the "trusted current" set without earning a verification.
 *
 * The function never mutates without `apply: true`. The diff shape
 * is identical between dry-run and apply runs so a CI step can
 * snapshot-test the report independently of writes.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { parseFrontmatter } from "../vault.ts";
import { BRAIN_ROOT_REL, brainDirs } from "./paths.ts";
import {
  PAGE_LIFECYCLE,
  PAGE_STALE_DAYS_DEFAULT,
  ageDaysFromIso,
  readLifecycle,
} from "./page-meta/lifecycle.ts";
import { readMergedInto } from "./page-meta/page-id.ts";

export interface LintFix {
  readonly kind: "fix-merged-link";
  readonly path: string;
  readonly from: string;
  readonly to: string;
}

export interface LintDemotion {
  readonly kind: "demote-stale-stable";
  readonly id: string;
  readonly path: string;
  readonly ageDays: number;
}

export interface LintReport {
  readonly scanned: number;
  readonly fixes: ReadonlyArray<LintFix>;
  readonly demotions: ReadonlyArray<LintDemotion>;
  readonly applied: boolean;
  readonly filesWritten: number;
}

export interface LintOptions {
  readonly apply: boolean;
  readonly now?: Date;
  readonly staleDays?: number;
}

interface MergeMap {
  /** secondary id → canonical id */
  readonly forward: ReadonlyMap<string, string>;
}

function buildMergeMap(vault: string): MergeMap {
  const forward = new Map<string, string>();
  const dirs = brainDirs(vault);
  for (const dir of [dirs.preferences, dirs.retired]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const full = join(dir, name);
      try {
        const [meta] = parseFrontmatter(full);
        const target = readMergedInto(meta);
        if (target !== null) {
          const id = typeof meta["id"] === "string" ? meta["id"] : name.replace(/\.md$/, "");
          forward.set(id, target);
        }
      } catch {
        // ignore
      }
    }
  }
  return Object.freeze({ forward });
}

const WIKILINK_RE = /\[\[([^\]|#]+)([#|][^\]]*)?\]\]/g;

function scanFileForMergedLinks(
  path: string,
  raw: string,
  merge: MergeMap,
): { fixes: LintFix[]; rewritten: string } {
  const fixes: LintFix[] = [];
  const rewritten = raw.replace(WIKILINK_RE, (match, target, suffix) => {
    const canonical = merge.forward.get(target);
    if (!canonical) return match;
    fixes.push({ kind: "fix-merged-link", path, from: target, to: canonical });
    return `[[${canonical}${suffix ?? ""}]]`;
  });
  return { fixes, rewritten };
}

function detectStaleStable(vault: string, now: Date, staleDays: number): LintDemotion[] {
  const out: LintDemotion[] = [];
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.preferences)) return out;
  for (const name of readdirSync(dirs.preferences)) {
    if (!name.endsWith(".md") || !name.startsWith("pref-")) continue;
    const path = join(dirs.preferences, name);
    let meta: Record<string, unknown>;
    try {
      [meta] = parseFrontmatter(path);
    } catch {
      continue;
    }
    const lifecycle = readLifecycle(meta);
    if (lifecycle !== PAGE_LIFECYCLE.stable) continue;
    const lastEv =
      typeof meta["_last_evidence_at"] === "string"
        ? meta["_last_evidence_at"]
        : typeof meta["last_evidence_at"] === "string"
          ? meta["last_evidence_at"]
          : "";
    if (lastEv && lastEv !== "null") {
      const evAge = ageDaysFromIso(lastEv, now);
      if (evAge < staleDays) continue;
    }
    const createdAt = typeof meta["created_at"] === "string" ? meta["created_at"] : "";
    const age = ageDaysFromIso(createdAt, now);
    if (age < staleDays) continue;
    const id = typeof meta["id"] === "string" ? meta["id"] : name.replace(/\.md$/, "");
    out.push({
      kind: "demote-stale-stable",
      id,
      path,
      ageDays: Math.floor(age),
    });
  }
  return out;
}

function applyDemotion(path: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  // Accept either LF or CRLF frontmatter delimiters so Windows-written
  // vaults (Syncthing peer on Windows, manual hand-edit) still demote.
  if (!/^---\r?\n/.test(raw)) return false;
  const closeMatch = /\r?\n---\r?\n/.exec(raw.slice(3));
  const close = closeMatch ? 3 + closeMatch.index : -1;
  if (close < 0) return false;
  const head = raw.slice(0, close);
  const tail = raw.slice(close);
  // Replace `_lifecycle: stable` (or legacy `lifecycle: stable`) with draft.
  // Preserve indentation/spacing.
  const updatedHead = head.replace(/^(_?lifecycle:\s+)stable\s*$/m, `$1draft`);
  if (updatedHead === head) return false;
  atomicWriteFileSync(path, updatedHead + tail);
  return true;
}

export function lintConsolidate(vault: string, opts: LintOptions): LintReport {
  const now = opts.now ?? new Date();
  const staleDays = opts.staleDays ?? PAGE_STALE_DAYS_DEFAULT;
  const merge = buildMergeMap(vault);

  // Phase 1: scan + collect fix candidates.
  const fixes: LintFix[] = [];
  let scanned = 0;
  let filesWritten = 0;
  const brainRoot = join(vault, BRAIN_ROOT_REL);
  if (existsSync(brainRoot)) {
    const stack: string[] = [brainRoot];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const full = join(dir, name);
        let info;
        try {
          info = statSync(full);
        } catch {
          continue;
        }
        if (info.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!name.endsWith(".md")) continue;
        scanned += 1;
        let raw: string;
        try {
          raw = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        const { fixes: fileFixes, rewritten } = scanFileForMergedLinks(full, raw, merge);
        if (fileFixes.length === 0) continue;
        fixes.push(...fileFixes);
        if (opts.apply && rewritten !== raw) {
          atomicWriteFileSync(full, rewritten);
          filesWritten += 1;
        }
      }
    }
  }

  // Phase 2: stale-stable demotions.
  const demotions = detectStaleStable(vault, now, staleDays);
  if (opts.apply) {
    for (const d of demotions) {
      if (applyDemotion(d.path)) filesWritten += 1;
    }
  }

  return Object.freeze({
    scanned,
    fixes: Object.freeze(fixes),
    demotions: Object.freeze(demotions),
    applied: opts.apply,
    filesWritten,
  });
}
