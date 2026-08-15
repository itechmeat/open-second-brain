/**
 * Page-level deduplication for Brain preferences and retired entries.
 *
 * The scope is intentionally narrow: detect EXACT duplicates after
 * Unicode/case normalisation of the rule text. This is the most
 * common case agents produce (two ingestion sessions covering the
 * same rule with different slugs), and it ships with a deterministic,
 * easily-auditable signal. Approximate near-duplicate detection
 * (shingle / MinHash / semantic) is a follow-up.
 *
 * The merge writes a `merged_into:` pointer on the secondary via
 * {@link setMergedInto} and optionally rewrites any `[[<secondary>]]`
 * wikilinks across the vault to point at the canonical page.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { parseFrontmatter } from "../vault.ts";
import { compositeScopeKey, scopeFromFrontmatter } from "../scope-key.ts";
import { brainDirs, BRAIN_ROOT_REL } from "./paths.ts";
import { setMergedInto } from "./page-meta/page-id.ts";
import { normalizeForDedup } from "./text/normalize.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

export interface PageRecord {
  /** Page identity (e.g. `pref-no-em-dashes`). */
  readonly id: string;
  /** Absolute path to the markdown file. */
  readonly path: string;
  /** Normalised dedup key (topic + principle, NFKC + casefold). */
  readonly key: string;
  /** Raw topic / principle for reporting. */
  readonly topic: string;
  readonly principle: string;
  /** Creation timestamp from frontmatter; missing entries fall back to mtime. */
  readonly createdAtMs: number;
}

export interface DedupCandidate {
  readonly key: string;
  /** All pages sharing this key, ordered by createdAtMs ascending. */
  readonly pages: ReadonlyArray<PageRecord>;
  /** Recommended canonical (oldest createdAtMs; ties broken by id ascending). */
  readonly canonical: PageRecord;
  /** Pages to merge into the canonical. */
  readonly secondaries: ReadonlyArray<PageRecord>;
}

export interface DedupReport {
  readonly candidates: ReadonlyArray<DedupCandidate>;
  /** Total pages scanned (preferences + retired). */
  readonly scanned: number;
}

function readPageRecords(vault: string): PageRecord[] {
  const dirs = brainDirs(vault);
  const out: PageRecord[] = [];
  const sources: Array<{ dir: string; prefix: string }> = [
    { dir: dirs.preferences, prefix: "pref-" },
    { dir: dirs.retired, prefix: "ret-" },
  ];
  for (const { dir, prefix } of sources) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md") || !name.startsWith(prefix)) continue;
      const path = join(dir, name);
      let meta: Record<string, unknown>;
      try {
        [meta] = parseFrontmatter(path);
      } catch {
        continue;
      }
      const id = typeof meta["id"] === "string" ? meta["id"] : name.replace(/\.md$/, "");
      const topic = typeof meta["topic"] === "string" ? meta["topic"] : "";
      const principle = typeof meta["principle"] === "string" ? meta["principle"] : "";
      const createdAtIso = typeof meta["created_at"] === "string" ? meta["created_at"] : "";
      const createdAtMs = createdAtIso ? Date.parse(createdAtIso) : statSync(path).mtimeMs;
      // Per-scope keying (t_37c05a34): fold the page's composite scope
      // (owner/session/project) into the dedup key so identical text in two
      // scopes is not collapsed. Additive: a scopeless page yields an empty
      // scope key, so its dedup key is byte-identical to the pre-scope world
      // and existing merges are never re-collapsed.
      const scopeKey = compositeScopeKey(scopeFromFrontmatter(meta));
      const contentKey = normalizeForDedup(`${topic}\0${principle}`);
      const key = scopeKey === "" ? contentKey : `${contentKey} ${scopeKey}`;
      out.push({
        id,
        path,
        key,
        topic,
        principle,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
      });
    }
  }
  return out;
}

/**
 * Scan the vault and group pages by their dedup key. Only groups
 * with at least 2 members are returned. The "canonical" pick is the
 * page with the oldest `created_at` (and the lowest id as
 * tie-breaker), which biases toward keeping the first-recorded
 * version of any rule.
 */
export function findDuplicateCandidates(vault: string): DedupReport {
  const records = readPageRecords(vault);
  const byKey = new Map<string, PageRecord[]>();
  for (const r of records) {
    if (r.key.trim().length === 0) continue; // skip empty / malformed pages
    const arr = byKey.get(r.key);
    if (arr) arr.push(r);
    else byKey.set(r.key, [r]);
  }
  const candidates: DedupCandidate[] = [];
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    group.sort((a, b) => {
      if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const canonical = group[0]!;
    candidates.push({
      key,
      pages: Object.freeze(group.slice()),
      canonical,
      secondaries: Object.freeze(group.slice(1)),
    });
  }
  candidates.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return Object.freeze({
    scanned: records.length,
    candidates: Object.freeze(candidates),
  });
}

/**
 * One wikilink target spelling, and what it should become.
 *
 * `to` is OPTIONAL, and that is the whole reason this shape exists
 * rather than a pair of strings. A note-file delete has to know how many
 * inbound references it is about to strand and must rewrite none of
 * them, while a rename has to rewrite exactly the same set; running the
 * two through one matcher is what stops "what would change" and "what
 * changed" from becoming two different opinions of the same vault. An
 * absent `to` is match-only.
 */
export interface WikilinkRetarget {
  /** Target spelling to match, e.g. `Projects/Old` or `pref-foo`. */
  readonly from: string;
  /** Replacement spelling. Absent means count the matches, rewrite nothing. */
  readonly to?: string;
}

/** What one {@link retargetWikilinks} pass read, matched and wrote. */
export interface WikilinkRetargetReport {
  /**
   * Every Markdown file the walk read, vault-relative POSIX, sorted.
   *
   * Carried rather than counted because a caller deciding whether a bare
   * `[[Basename]]` spelling unambiguously names one note needs the
   * population the rewrite would act on - and that is exactly this list,
   * not a second walk under a second rule set.
   */
  readonly files: ReadonlyArray<string>;
  /** Files holding at least one matched spelling, vault-relative, sorted. */
  readonly matched: ReadonlyArray<string>;
  /** Files this pass rewrote. Always empty when `apply` is false. */
  readonly rewritten: ReadonlyArray<string>;
}

export interface RetargetWikilinksOptions {
  /**
   * Vault-relative directory to walk. Defaults to the Brain root, which
   * is where this function's first caller (the page merge) lives.
   *
   * A note-file rename passes `""` - the vault root - because a user
   * note is referenced from user notes and from Brain artifacts alike,
   * and a rewrite that saw only one of those would report a number that
   * looked like coverage and was not.
   */
  readonly root?: string;
  /** False walks and counts without writing a byte. Defaults to true. */
  readonly apply?: boolean;
}

/** Directory names never walked, whatever the root. */
const RETARGET_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".obsidian",
  ".trash",
  ".stversions",
  "node_modules",
]);

/** Escape a literal for use inside a regular expression. */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Apply one retarget to one file's text. Wikilinks can carry aliases
 * (`[[target|some alias]]`) and section anchors (`[[target#heading]]`);
 * the target portion alone is replaced.
 */
function rewriteOne(raw: string, retarget: WikilinkRetarget): string {
  const to = retarget.to;
  if (to === undefined || to === retarget.from) return raw;
  const pattern = new RegExp(`\\[\\[${escapeForRegExp(retarget.from)}(?=[#|\\]])`, "g");
  return raw.replaceAll(`[[${retarget.from}]]`, `[[${to}]]`).replace(pattern, `[[${to}`);
}

/** True when `raw` carries at least one `[[<from>]]`-shaped reference. */
function mentions(raw: string, from: string): boolean {
  return new RegExp(`\\[\\[${escapeForRegExp(from)}(?=[#|\\]])`).test(raw);
}

/** Absolute paths of every `.md` file under `dir`, depth-first. */
function markdownFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = join(current, name);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (!RETARGET_SKIP_DIRS.has(name)) stack.push(full);
        continue;
      }
      if (name.endsWith(".md")) out.push(full);
    }
  }
  return out;
}

/**
 * Rewrite wikilink targets across a subtree of the vault, or count what
 * a rewrite would touch.
 *
 * This used to be `patchWikilinks`: Brain-scoped by a hard-coded
 * `join(vault, "Brain")` and keyed on one id-shaped target at a time. A
 * user note lives outside `Brain/`, is referenced from both sides of
 * that boundary, and is spelled three different ways in Obsidian
 * (`[[Projects/Old]]`, `[[Projects/Old.md]]`, `[[Old]]`), so neither
 * narrowing survived contact with a note-file rename. Both are now
 * caller decisions and the default is the old behaviour exactly.
 *
 * Retargets are applied longest-spelling-first so a shorter prefix
 * cannot consume a longer one's match, and every replacement is anchored
 * at `[[`, so a spelling that has already been rewritten is not a
 * candidate for the next retarget in the list.
 *
 * Reads each Markdown file once; writes only where the bytes change.
 */
export function retargetWikilinks(
  vault: string,
  retargets: ReadonlyArray<WikilinkRetarget>,
  opts: RetargetWikilinksOptions = {},
): WikilinkRetargetReport {
  const apply = opts.apply !== false;
  // Vault-identity write guard (context-integrity-gates, Unit J). A
  // counting pass writes nothing, so it asserts nothing: refusing to
  // COUNT against a foreign vault would deny a caller the blast radius
  // it needs in order to decide not to write.
  if (apply) assertVaultIdentityForWrite(vault);

  const root = opts.root === undefined ? BRAIN_ROOT_REL : opts.root;
  const abs = root === "" ? vault : join(vault, root);
  const empty = Object.freeze({
    files: Object.freeze([]),
    matched: Object.freeze([]),
    rewritten: Object.freeze([]),
  });
  if (!existsSync(abs)) return empty;

  const ordered = [...retargets].toSorted((a, b) => b.from.length - a.from.length);
  const files: string[] = [];
  const matched: string[] = [];
  const rewritten: string[] = [];

  for (const full of markdownFilesUnder(abs)) {
    let raw: string;
    try {
      raw = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const rel = relative(vault, full).split(sep).join(posix.sep);
    files.push(rel);
    if (ordered.some((retarget) => mentions(raw, retarget.from))) matched.push(rel);
    if (!apply) continue;
    let next = raw;
    for (const retarget of ordered) next = rewriteOne(next, retarget);
    if (next !== raw) {
      atomicWriteFileSync(full, next);
      rewritten.push(rel);
    }
  }

  return Object.freeze({
    files: Object.freeze(files.toSorted()),
    matched: Object.freeze(matched.toSorted()),
    rewritten: Object.freeze(rewritten.toSorted()),
  });
}

/**
 * Rewrite every `[[<oldTarget>]]` reference inside `<vault>/Brain/`
 * to `[[<newTarget>]]`. Returns the number of files touched.
 *
 * The page merge's spelling of {@link retargetWikilinks}: one id-shaped
 * target, the Brain root, applied. Kept as its own name because that IS
 * the merge's whole vocabulary - a page id is not a path and has no
 * basename spelling - and widening the merge's call site would have made
 * it answer questions it does not ask.
 */
export function patchWikilinks(vault: string, oldTarget: string, newTarget: string): number {
  if (oldTarget === newTarget) {
    // Vault-identity write guard (context-integrity-gates, Unit J):
    // asserted on the no-op path too, so a caller pointed at a foreign
    // vault is refused whether or not its arguments happened to be equal.
    assertVaultIdentityForWrite(vault);
    return 0;
  }
  return retargetWikilinks(vault, [{ from: oldTarget, to: newTarget }]).rewritten.length;
}

export interface MergePageResult {
  readonly canonical: string;
  readonly secondary: string;
  /** Files whose wikilinks were rewritten to point at the canonical. */
  readonly wikilinksUpdated: number;
}

/**
 * Merge a secondary page into a canonical one:
 *   1. Stamp `merged_into:` on the secondary.
 *   2. Rewrite `[[<secondary>]]` wikilinks to `[[<canonical>]]`.
 *
 * Returns the number of vault files touched by the wikilink patcher
 * so the caller can report it. Idempotent: calling twice with the
 * same arguments leaves the merged-into pointer in place and yields
 * `wikilinksUpdated: 0` on the second call.
 */
export function mergePage(
  vault: string,
  secondaryId: string,
  canonicalId: string,
): MergePageResult {
  setMergedInto(vault, secondaryId, canonicalId);
  const touched = patchWikilinks(vault, secondaryId, canonicalId);
  return Object.freeze({
    canonical: canonicalId,
    secondary: secondaryId,
    wikilinksUpdated: touched,
  });
}
