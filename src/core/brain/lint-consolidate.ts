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
 *
 * ## Merged links resolve through the canonical-id resolver
 *
 * evidence-at-the-boundary, task A4. This pass used to build its own
 * merge map: one readdir over `preferences/` and `retired/`, parsing
 * every file to read `merged_into:` ONE LEVEL DEEP. That map was 25 ms of
 * the 359 ms pass (and `retired/` grows monotonically), and it was wrong:
 * after a two-step merge A -> B -> C it rewrote `[[A]]` to `[[B]]`,
 * reported a `to` that was itself merged away, and needed a second run to
 * converge. `resolveCanonicalId` already walks the chain with cycle and
 * depth guards, so the map is gone and the walk exists once.
 *
 * Two consequences worth naming rather than leaving to be discovered:
 *
 *   - The merged-page universe is the `pref-` / `ret-` id space the
 *     resolver's strict grammar defines, while the REWRITE covers every
 *     `.md` under `Brain/`. A page elsewhere in the tree carrying
 *     `merged_into:` is therefore invisible to this pass. That is
 *     unchanged from the merge map, which scanned the same two
 *     directories, and it is left that way deliberately: the strict page
 *     id grammar is what stops a crafted `merged_into:` value from
 *     naming a rewrite target outside `Brain/`, and widening the source
 *     set would mean admitting arbitrary basenames into that position
 *     plus a full parse of every page in the vault.
 *   - Identity now comes from the page's FILENAME rather than its `id:`
 *     frontmatter field, because that is what a wikilink resolves by.
 *     The two agree for every page this project writes.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { parseFrontmatter } from "../vault.ts";
import { WIKILINK_TARGET_RE, isBrainArtifactId } from "./wikilink.ts";
import { BRAIN_ROOT_REL, brainDirs } from "./paths.ts";
import {
  PAGE_LIFECYCLE,
  PAGE_STALE_DAYS_DEFAULT,
  ageDaysFromIso,
  readLifecycle,
} from "./page-meta/lifecycle.ts";
import { MergeChainError, resolveCanonicalId } from "./page-meta/page-id.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

/**
 * The two structural repairs this pass performs, spelled once. They are
 * also the codes the applier capability table publishes for this module,
 * and the capability test binds the two together.
 */
export const LINT_CONSOLIDATE_KIND = Object.freeze({
  mergedLink: "fix-merged-link",
  staleStableDemotion: "demote-stale-stable",
} as const);

export interface LintFix {
  readonly kind: typeof LINT_CONSOLIDATE_KIND.mergedLink;
  readonly path: string;
  readonly from: string;
  readonly to: string;
}

export interface LintDemotion {
  readonly kind: typeof LINT_CONSOLIDATE_KIND.staleStableDemotion;
  readonly id: string;
  readonly path: string;
  readonly ageDays: number;
}

/**
 * A wikilink whose merge chain could not be walked to a canonical target
 * - a cycle, or a chain past the depth cap. The link is left exactly
 * where it is, because rewriting into a chain that does not terminate
 * would be a guess. It is REPORTED rather than skipped in silence: a
 * merged-link pass that quietly drops the links it could not resolve
 * looks like a pass that found nothing wrong.
 */
export interface LintUnresolvedLink {
  readonly kind: typeof LINT_CONSOLIDATE_KIND.mergedLink;
  readonly path: string;
  readonly target: string;
  readonly reason: string;
}

export interface LintReport {
  readonly scanned: number;
  readonly fixes: ReadonlyArray<LintFix>;
  readonly demotions: ReadonlyArray<LintDemotion>;
  /** Merge chains that terminate in nothing; never rewritten, always named. */
  readonly unresolved: ReadonlyArray<LintUnresolvedLink>;
  readonly applied: boolean;
  readonly filesWritten: number;
}

export interface LintOptions {
  readonly apply: boolean;
  readonly now?: Date;
  readonly staleDays?: number;
}

/**
 * What one wikilink target is, as far as the merge chain is concerned.
 * Both fields absent (`null`) is the overwhelmingly common answer: the
 * target names a page that was never merged, so there is nothing to do.
 */
export interface MergedLinkResolution {
  /** The canonical id when `target` names a merged-away page, else null. */
  readonly canonical: string | null;
  /** Why the chain could not be walked to a canonical id, else null. */
  readonly unresolvable: string | null;
}

const NOT_MERGED: MergedLinkResolution = Object.freeze({ canonical: null, unresolvable: null });

/**
 * Answers "has this wikilink target been merged away, and into what" for
 * one pass over one vault, memoised.
 *
 * The single owner of that question, shared by this vault-wide pass and
 * the per-page write-time lint (`page-lint.ts`) so the two cannot drift
 * into two definitions of a merged link. The memo is per resolver
 * instance and therefore per pass: a link repeated across a thousand log
 * days costs one chain walk.
 */
export interface MergedLinkResolver {
  resolve(target: string): MergedLinkResolution;
}

export function createMergedLinkResolver(vault: string): MergedLinkResolver {
  const memo = new Map<string, MergedLinkResolution>();
  return {
    resolve(target: string): MergedLinkResolution {
      const cached = memo.get(target);
      if (cached !== undefined) return cached;
      const resolved = resolveOnce(vault, target);
      memo.set(target, resolved);
      return resolved;
    },
  };
}

function resolveOnce(vault: string, target: string): MergedLinkResolution {
  // Cheap prefix gate before the resolver, which answers MALFORMED for
  // every ordinary note link by throwing. `isBrainArtifactId` asks the
  // wider "is this a Brain artifact at all" question; the strict page-id
  // grammar stays where it belongs, inside the resolver.
  if (!isBrainArtifactId(target)) return NOT_MERGED;
  try {
    const canonical = resolveCanonicalId(vault, target);
    return canonical === target ? NOT_MERGED : Object.freeze({ canonical, unresolvable: null });
  } catch (err) {
    if (err instanceof MergeChainError) {
      // MALFORMED on the id we STARTED from means the link is outside the
      // merge namespace (a `sig-` artifact, say), which is not a defect: it
      // is the resolver saying this link is not its business.
      //
      // MALFORMED raised further down the chain is the opposite. It means a
      // page this link reaches declares a `merged_into:` value the page-id
      // grammar rejects, so the chain terminates in nothing and the link can
      // neither be followed nor left alone honestly. Returning "not merged"
      // for it made `o2b brain lint` print a clean vault over a link pointing
      // at a page that has been merged away, which is precisely the silence
      // this pass exists to break. The error carries the id it failed on, so
      // the two cases are distinguishable rather than guessed at.
      if (err.code === "MALFORMED" && err.id === target) return NOT_MERGED;
      return Object.freeze({ canonical: null, unresolvable: err.message });
    }
    throw err;
  }
}

function scanFileForMergedLinks(
  path: string,
  raw: string,
  merge: MergedLinkResolver,
): { fixes: LintFix[]; unresolved: LintUnresolvedLink[]; rewritten: string } {
  const fixes: LintFix[] = [];
  const unresolved: LintUnresolvedLink[] = [];
  const rewritten = raw.replace(WIKILINK_TARGET_RE, (match, target: string, suffix?: string) => {
    const resolved = merge.resolve(target);
    if (resolved.unresolvable !== null) {
      unresolved.push({
        kind: LINT_CONSOLIDATE_KIND.mergedLink,
        path,
        target,
        reason: resolved.unresolvable,
      });
      return match;
    }
    if (resolved.canonical === null) return match;
    fixes.push({
      kind: LINT_CONSOLIDATE_KIND.mergedLink,
      path,
      from: target,
      to: resolved.canonical,
    });
    return `[[${resolved.canonical}${suffix ?? ""}]]`;
  });
  return { fixes, unresolved, rewritten };
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
      kind: LINT_CONSOLIDATE_KIND.staleStableDemotion,
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
  // Vault-identity write guard (context-integrity-gates, Unit J), placed
  // per the one rule the appliers share: at the entry point, before any
  // other work, and only when the call will write. See the write-guard
  // section of `applier-capability.ts`.
  //
  // It used to run unconditionally, ahead of this branch. The read-only
  // `o2b brain actions` verb calls this function in report mode, so a
  // root the guard refuses took down a ranking command that never
  // intended to write a byte - the guard's own contract inverted.
  if (opts.apply) assertVaultIdentityForWrite(vault);
  const now = opts.now ?? new Date();
  const staleDays = opts.staleDays ?? PAGE_STALE_DAYS_DEFAULT;
  const merge = createMergedLinkResolver(vault);

  // Phase 1: scan + collect fix candidates.
  const fixes: LintFix[] = [];
  const unresolved: LintUnresolvedLink[] = [];
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
        const {
          fixes: fileFixes,
          unresolved: fileUnresolved,
          rewritten,
        } = scanFileForMergedLinks(full, raw, merge);
        unresolved.push(...fileUnresolved);
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
    unresolved: Object.freeze(unresolved),
    applied: opts.apply,
    filesWritten,
  });
}
