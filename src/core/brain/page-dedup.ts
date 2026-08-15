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

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import { join, posix, relative, sep } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { realpathInsideVault } from "../path-safety.ts";
import { parseFrontmatter } from "../vault.ts";
import { compositeScopeKey, scopeFromFrontmatter } from "../scope-key.ts";
import { matchScope, mayDescend, resolveVaultScope } from "../vault-scope/index.ts";
import { pathCovers, type VaultScopeRules } from "../vault-scope/defaults.ts";
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

/**
 * One file the rewrite pass could not write, and the reason the
 * filesystem gave.
 *
 * Carried rather than thrown because the pass has already written the
 * files before it, and a throw discards the record of which ones those
 * were - see {@link retargetWikilinks} for the argument.
 */
export interface WikilinkRewriteFailure {
  /** Vault-relative POSIX path of the file that kept its old spellings. */
  readonly path: string;
  /** The filesystem's own message, never a re-description of it. */
  readonly reason: string;
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
  /**
   * Files whose bytes changed but could not be written, sorted by path.
   * Always empty when `apply` is false.
   */
  readonly failed: ReadonlyArray<WikilinkRewriteFailure>;
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
  /**
   * Vault-relative POSIX prefixes this pass READS and REPORTS but never
   * writes, matched segment-wise via {@link pathCovers}.
   *
   * The note-file lifecycle passes `Brain/log` here. That tree is an
   * append-only record of what an agent said at an instant, so a rename
   * rewriting a spelling inside it would change what the record says was
   * said - and unlike a live wikilink, a log line is not a navigation
   * aid that goes stale, it is testimony. It is still read and still
   * reported as an inbound reference, because withholding the disclosure
   * would be the opposite defect.
   *
   * The page merge deliberately passes nothing: it repoints one page id
   * at the id it was declared a duplicate of, which is the same subject
   * under a new name rather than a different subject.
   */
  readonly neverRewrite?: ReadonlyArray<string>;
}

/**
 * Directory names never walked, whatever the root and whatever the
 * operator declared.
 *
 * These duplicate entries in `DEFAULT_VAULT_IGNORE_PATHS` on purpose: an
 * operator who declares `vault.ignore_paths` REPLACES that default list
 * rather than extending it, so a vault that excludes `Private` would
 * otherwise start walking `.git`. The vault scope below is the policy;
 * this set is the floor under it.
 */
const RETARGET_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".obsidian",
  ".trash",
  ".stversions",
  "node_modules",
]);

/**
 * Fenced blocks (``` / ~~~, closing on the same run length) and inline
 * code spans, as one alternation.
 *
 * A `[[Projects/Old]]` inside either is a QUOTATION of a link - a
 * tutorial showing the syntax, a design note quoting a vault's contents,
 * a README explaining how a rename behaves - and rewriting it edits
 * documentation into describing a vault that never existed. The
 * precedent is `link-graph/format-wikilink.ts`, which has masked code
 * regions since the wikilink formatter shipped; it matters more here now
 * that this walk's root reaches every user note rather than `Brain/`.
 */
const CODE_REGION_RE = /(`{3,}|~{3,})[\s\S]*?\1|`[^`]+`/g;

/** One stretch of a document, and whether it is code. */
interface DocumentSegment {
  readonly text: string;
  readonly code: boolean;
}

/**
 * Split `raw` into alternating prose and code segments. Concatenating
 * every `text` back together reproduces `raw` byte for byte, which is
 * what lets the rewrite below transform the prose halves in place
 * without needing a second opinion about where the code was.
 */
function segmentCode(raw: string): DocumentSegment[] {
  const out: DocumentSegment[] = [];
  let last = 0;
  for (const m of raw.matchAll(CODE_REGION_RE)) {
    if (m.index > last) out.push({ text: raw.slice(last, m.index), code: false });
    out.push({ text: m[0], code: true });
    last = m.index + m[0].length;
  }
  out.push({ text: raw.slice(last), code: false });
  return out;
}

/** Escape a literal for use inside a regular expression. */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Apply one retarget to one stretch of prose. Wikilinks can carry
 * aliases (`[[target|some alias]]`) and section anchors
 * (`[[target#heading]]`); the target portion alone is replaced.
 */
function rewriteOne(raw: string, retarget: WikilinkRetarget): string {
  const to = retarget.to;
  if (to === undefined || to === retarget.from) return raw;
  const pattern = new RegExp(`\\[\\[${escapeForRegExp(retarget.from)}(?=[#|\\]])`, "g");
  return raw.replaceAll(`[[${retarget.from}]]`, `[[${to}]]`).replace(pattern, `[[${to}`);
}

/**
 * True when `segment` carries at least one `[[<from>]]`-shaped reference.
 *
 * CASE-SENSITIVE, and deliberately so. Obsidian resolves a wikilink
 * case-insensitively, so `[[projects/old]]` is a live reference this pass
 * leaves dangling while reporting `filesRewritten: 0` - a real gap, and
 * one that is NOT this module's to close alone. Every other resolver in
 * this project is case-sensitive on the same question:
 * `store/links.ts`'s ladder compares `d.basename = l.target_path` with
 * SQLite's default binary collation, and
 * `notes/note-title-resolver.ts:120` compares titles with `===`. Making
 * only the rewriter case-insensitive would give this pass a different
 * opinion of "a live reference" than the index and the title resolver
 * have, so a rename would repoint spellings the rest of the project still
 * reads as naming something else. Case-insensitive resolution is a
 * project-wide decision with a migration behind it, and taking it here
 * would be taking it in the one place least able to hold it.
 */
function mentionsIn(segment: string, from: string): boolean {
  return new RegExp(`\\[\\[${escapeForRegExp(from)}(?=[#|\\]])`).test(segment);
}

/** One Markdown file the walk admitted. */
interface WalkedFile {
  readonly abs: string;
  /** Vault-relative POSIX path. */
  readonly rel: string;
}

/** Vault-relative POSIX form of an absolute path under `vault`. */
function relOf(vault: string, abs: string): string {
  return relative(vault, abs).split(sep).join(posix.sep);
}

/** Realpath, or `null` when it cannot be resolved. */
function realpathOrNull(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * Every `.md` file under `dir` this pass may read, depth-first, carrying
 * the vault-relative path every rule is judged on.
 *
 * Three refusals, none of which the walk needed while its only root was
 * `Brain/` and all of which it needs now that a note rename points it at
 * the vault:
 *
 *   - a symlink whose realpath leaves the vault is not followed, for
 *     files and directories alike. `vault/linked -> /tmp/OUTSIDE` is an
 *     ordinary Obsidian arrangement, and the previous walk read those
 *     bytes, rewrote them, and reported them under a vault-relative
 *     path they do not have. {@link realpathInsideVault} is the same
 *     predicate the doctor's `symlink-escape` lint asks.
 *   - a directory whose realpath has already been walked is not walked
 *     again, so a symlink cycle terminates at the first repeat instead
 *     of at the kernel's `ELOOP` some forty levels down - which read the
 *     same file dozens of times, rewrote it dozens of times, and
 *     inflated the carrier count the bare-basename decision is made
 *     from until one note read as two.
 *   - `vault.ignore_paths` / `vault.include_paths` are obeyed, through
 *     the {@link matchScope} / {@link mayDescend} pair every other
 *     walker in this project uses. A path the operator declared out of
 *     scope must not be rewritten, and must not be NAMED in a report
 *     that crosses a tool boundary either: the filenames inside an
 *     excluded directory are exactly what the exclusion was for.
 */
function markdownFilesUnder(vault: string, dir: string, rules: VaultScopeRules): WalkedFile[] {
  const out: WalkedFile[] = [];
  const stack: WalkedFile[] = [{ abs: dir, rel: relOf(vault, dir) }];
  const walkedDirs = new Set<string>();
  const dirReal = realpathOrNull(dir);
  if (dirReal !== null) walkedDirs.add(dirReal);
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    // Sorted so that which of two aliasing spellings of one directory
    // wins the visited-set race is a property of the vault rather than
    // of readdir order, and a report crossing a tool boundary is
    // reproducible.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = join(current.abs, entry.name);
      const rel = current.rel === "" ? entry.name : `${current.rel}${posix.sep}${entry.name}`;
      if (entry.isSymbolicLink() && !realpathInsideVault(abs, vault)) continue;
      let info;
      try {
        info = statSync(abs);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (RETARGET_SKIP_DIRS.has(entry.name)) continue;
        if (!mayDescend(rel, rules)) continue;
        const real = realpathOrNull(abs);
        if (real === null || walkedDirs.has(real)) continue;
        walkedDirs.add(real);
        stack.push({ abs, rel });
        continue;
      }
      if (!info.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      if (!matchScope(rel, rules).inScope) continue;
      out.push({ abs, rel });
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
 *
 * A write that FAILS is recorded in {@link WikilinkRetargetReport.failed}
 * and the pass continues. Throwing was the previous behaviour and it is
 * the worse of the two: by the time one file cannot be written the pass
 * has already rewritten the files before it, and the throw discards the
 * only record of which those were - leaving the caller unable to tell a
 * rename that half-applied from one that never started. A caller that
 * needs a failure to be fatal reads `failed` and raises it itself, which
 * is what {@link patchWikilinks} does.
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
    failed: Object.freeze([]),
  });
  if (!existsSync(abs)) return empty;

  const rules = resolveVaultScope(vault).rules;
  const neverRewrite = opts.neverRewrite ?? [];
  const ordered = [...retargets].toSorted((a, b) => b.from.length - a.from.length);
  const files: string[] = [];
  const matched: string[] = [];
  const rewritten: string[] = [];
  const failed: WikilinkRewriteFailure[] = [];

  for (const file of markdownFilesUnder(vault, abs, rules)) {
    let raw: string;
    try {
      raw = readFileSync(file.abs, "utf8");
    } catch {
      continue;
    }
    files.push(file.rel);
    const segments = segmentCode(raw);
    const prose = segments.filter((segment) => !segment.code);
    if (ordered.some((retarget) => prose.some((s) => mentionsIn(s.text, retarget.from)))) {
      matched.push(file.rel);
    }
    if (!apply) continue;
    if (neverRewrite.some((prefix) => pathCovers(prefix, file.rel))) continue;
    const next = segments
      .map((segment) => (segment.code ? segment.text : ordered.reduce(rewriteOne, segment.text)))
      .join("");
    if (next === raw) continue;
    try {
      atomicWriteFileSync(file.abs, next);
      rewritten.push(file.rel);
    } catch (err) {
      failed.push({ path: file.rel, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return Object.freeze({
    files: Object.freeze(files.toSorted()),
    matched: Object.freeze(matched.toSorted()),
    rewritten: Object.freeze(rewritten.toSorted()),
    failed: Object.freeze(
      failed.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ),
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
 *
 * Raises on a write failure rather than reporting it. The merge's caller
 * counts files and has nowhere to put the identity of one that did not
 * take, so for THIS spelling a failure has to be an error; the note-file
 * lifecycle, which does have somewhere to put it, reads `failed`.
 */
export function patchWikilinks(vault: string, oldTarget: string, newTarget: string): number {
  if (oldTarget === newTarget) {
    // Vault-identity write guard (context-integrity-gates, Unit J):
    // asserted on the no-op path too, so a caller pointed at a foreign
    // vault is refused whether or not its arguments happened to be equal.
    assertVaultIdentityForWrite(vault);
    return 0;
  }
  const report = retargetWikilinks(vault, [{ from: oldTarget, to: newTarget }]);
  const first = report.failed[0];
  if (first !== undefined) {
    throw new Error(
      `patchWikilinks: rewrote ${report.rewritten.length} file(s), then could not write ` +
        `${first.path}: ${first.reason}`,
    );
  }
  return report.rewritten.length;
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
