/**
 * Vault Scope — single source of truth for what is part of the vault.
 *
 * Anchored in docs/plans/2026-05-19-vault-scope-design.md §5, extended
 * in v1.46.0 with the positive `vault.include_paths` allowlist
 * (GitHub #155).
 *
 * ## Two polarities, one verdict
 *
 * The scope used to be a list of exclusions, so a matcher named for
 * that polarity could answer the whole question. It cannot any more: a
 * path is in scope iff it is NOT excluded AND (no allowlist is declared
 * OR it is under one of the declared roots). `matchIgnore` was deleted
 * rather than kept as an alias, because a function named for one
 * polarity that answers half the question reports "not excluded" for a
 * path the walkers skip - the most expensive kind of wrong answer this
 * module can give.
 *
 * What is left is one polarity-free {@link matchRules} - does any of
 * these rules cover this path - composed once in {@link matchScope},
 * which returns the verdict and, when the path is out, WHICH polarity
 * refused it.
 *
 * ## Why walkers need a second predicate
 *
 * The allowlist narrows FILES, not descent. A declared root of
 * `Notes/Daily` says nothing about whether `Notes` may be entered, and
 * a walker that read the file verdict as a descent verdict would never
 * reach the root the operator named. {@link mayDescend} is that second
 * question, and it is separate precisely because it is easy to get
 * backwards.
 *
 * Public surface:
 *   - `DEFAULT_VAULT_IGNORE_PATHS`, `VaultPathRule`, `VaultScopeRules` —
 *     re-exported from `./defaults.ts`; that submodule is the
 *     cycle-safe home used by `src/core/brain/policy.ts`.
 *   - `matchRules` / `matchScope` / `mayDescend` — pure predicates.
 *   - `resolveVaultScope` — reads `Brain/_brain.yaml` and produces
 *     a `VaultScope` with classified rules for both polarities.
 */

import { existsSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { join, sep } from "node:path";

import { loadBrainConfig } from "../brain/policy.ts";
import { brainConfigPath } from "../brain/paths.ts";
import { toPosix } from "../path-safety.ts";
import {
  DEFAULT_VAULT_IGNORE_PATHS,
  classifyVaultPathRule,
  pathCovers,
  type VaultPathRule,
  type VaultScopeRules,
} from "./defaults.ts";
import { admitToIndex } from "./index-admission.ts";

export {
  DEFAULT_VAULT_IGNORE_PATHS,
  classifyVaultPathRule,
  type VaultPathRule,
  type VaultScopeRules,
};

// ----- the matchers --------------------------------------------------------

/** POSIX separator, the one this grammar knows. */
const SEP = "/";

/** Why vault-scope POLICY refuses a path. */
export type OutOfScopeReason = "ignored" | "not-included";

/**
 * Why a path a walker saw does not reach the search index: either
 * policy refusal, plus the lane refusal {@link admitToIndex} owns.
 * Admission is not a scope question - `Brain/state` is part of the
 * vault, it just never enters the index - so it is composed at the
 * walkers rather than folded into {@link matchScope}.
 */
export type IndexRefusal = OutOfScopeReason | "not-admitted";

const REASON_IGNORED: OutOfScopeReason = "ignored";
const REASON_NOT_INCLUDED: OutOfScopeReason = "not-included";
const REASON_NOT_ADMITTED: IndexRefusal = "not-admitted";

export interface RuleMatch {
  readonly matched: boolean;
  readonly rule: VaultPathRule | null;
  /** POSIX rel-path of the prefix that triggered the match, or null. */
  readonly matchedAt: string | null;
}

const NO_MATCH: RuleMatch = Object.freeze({
  matched: false,
  rule: null,
  matchedAt: null,
});

/**
 * Walk `relPath` segment by segment. For each prefix, check name- and
 * path-rules. Return the SHORTEST prefix any rule covers, or
 * `{matched: false}` when none does.
 *
 * Polarity-free: it says whether the rules cover the path, never what
 * covering means. Both `vault.ignore_paths` and `vault.include_paths`
 * are read through it, which is why a bare name means the same thing on
 * either key and why the include side needs no matcher of its own.
 *
 * `relPath` must be POSIX (forward-slash separated), vault-relative,
 * and free of `.` / `..` components — this does no normalisation.
 * Callers (`walkVaultScope`, `inspectPath`) prepare the input.
 */
export function matchRules(relPath: string, rules: ReadonlyArray<VaultPathRule>): RuleMatch {
  if (relPath === "" || rules.length === 0) return NO_MATCH;
  const segments = relPath.split(SEP).filter((s) => s.length > 0);
  let prefix = "";
  for (const seg of segments) {
    prefix = prefix === "" ? seg : `${prefix}${SEP}${seg}`;
    for (const rule of rules) {
      if (rule.kind === "name") {
        if (rule.raw === seg) {
          return { matched: true, rule, matchedAt: prefix };
        }
        continue;
      }
      // kind === "path": exact prefix match.
      if (rule.raw === prefix) {
        return { matched: true, rule, matchedAt: prefix };
      }
    }
  }
  return NO_MATCH;
}

export interface ScopeMatch {
  readonly inScope: boolean;
  /** Which polarity refused, or `null` when the path is in scope. */
  readonly reason: OutOfScopeReason | null;
  /**
   * The exclusion rule that fired. Null for an in-scope path AND for a
   * `not-included` refusal: nothing refused that path by name, only the
   * absence of a rule admitting it, and naming a rule there would send
   * the operator looking for a line they never wrote.
   */
  readonly rule: VaultPathRule | null;
  readonly matchedAt: string | null;
}

const IN_SCOPE: ScopeMatch = Object.freeze({
  inScope: true,
  reason: null,
  rule: null,
  matchedAt: null,
});

const NOT_INCLUDED: ScopeMatch = Object.freeze({
  inScope: false,
  reason: REASON_NOT_INCLUDED,
  rule: null,
  matchedAt: null,
});

/**
 * The composed verdict: in scope, or out and which polarity said so.
 *
 * Exclusion is evaluated FIRST and wins. An operator who excluded
 * `Brain/.snapshots` and included `Brain` gets the exclusion, and the
 * refusal names the entry they wrote rather than the allowlist that
 * would have admitted it — the CLI's `--path` narrowing has always had
 * the same rule (design §6.2: narrowing never re-includes).
 *
 * The vault ROOT is in scope under every declaration. It is not "a path
 * outside every include root", it is the container of all of them, and
 * a fast negative there would stop every walk at the first step.
 */
export function matchScope(relPath: string, rules: VaultScopeRules): ScopeMatch {
  const ignored = matchRules(relPath, rules.ignore);
  if (ignored.matched && ignored.rule !== null) {
    return {
      inScope: false,
      reason: REASON_IGNORED,
      rule: ignored.rule,
      matchedAt: ignored.matchedAt,
    };
  }
  if (rules.include === null || relPath === "") return IN_SCOPE;
  return matchRules(relPath, rules.include).matched ? IN_SCOPE : NOT_INCLUDED;
}

/**
 * Whether a walker must enter `relDir` — a DIFFERENT question from
 * whether files in it are in scope.
 *
 * An excluded directory is never entered: the exclusion covers the
 * whole subtree. An allowlist, though, narrows files only, so a
 * directory is entered when it could hold an included file, which is
 * true in three cases:
 *
 *   - it is under a declared root (`Notes/Daily/2026` under `Notes/Daily`);
 *   - a declared root is under IT (`Notes`, on the way to `Notes/Daily`);
 *   - the root is a bare NAME, which matches at any depth, so no
 *     directory can be ruled out on the way to one.
 *
 * The first two are the same {@link pathCovers} question asked in both
 * directions, which is why this reuses the shared predicate instead of
 * growing a sixth private copy of segment-wise coverage.
 */
export function mayDescend(relDir: string, rules: VaultScopeRules): boolean {
  if (matchRules(relDir, rules.ignore).matched) return false;
  const include = rules.include;
  if (include === null || relDir === "") return true;
  return include.some(
    (rule) => rule.kind === "name" || pathCovers(rule.raw, relDir) || pathCovers(relDir, rule.raw),
  );
}

// ----- resolveVaultScope ---------------------------------------------------

export interface VaultScope {
  /** Final exclusion list in declaration order. */
  readonly ignorePaths: ReadonlyArray<string>;
  /**
   * The declared allowlist in declaration order, or `null` when the
   * operator declared none. Never an empty array — see
   * {@link VaultScopeRules}.
   */
  readonly includePaths: ReadonlyArray<string> | null;
  /** Both lists, classified as `name | path`. */
  readonly rules: VaultScopeRules;
  readonly source: "_brain.yaml" | "defaults";
  /**
   * Which polarities the OPERATOR wrote, as opposed to inherited.
   *
   * `source` answers "did this vault have a config at all", and that was
   * enough while `ignore_paths` was the only key: a `_brain.yaml` source
   * meant every rule in the scope had been typed by someone. With two
   * independent keys it stopped being enough. A vault that declares only
   * `include_paths` still reports `source: "_brain.yaml"` while every
   * exclusion comes from the built-in defaults, and a lint that reads
   * `source` alone then warns about a default entry the operator has never
   * seen, naming a key their config does not contain.
   */
  readonly declared: { readonly ignore: boolean; readonly include: boolean };
}

function buildScope(
  ignorePaths: ReadonlyArray<string>,
  includePaths: ReadonlyArray<string> | null,
  source: VaultScope["source"],
  declaredIgnore: boolean = source === "_brain.yaml",
): VaultScope {
  const ignore = Object.freeze([...ignorePaths]);
  const include = includePaths === null ? null : Object.freeze([...includePaths]);
  return Object.freeze({
    ignorePaths: ignore,
    includePaths: include,
    rules: Object.freeze({
      ignore: Object.freeze(ignore.map(classifyVaultPathRule)),
      include: include === null ? null : Object.freeze(include.map(classifyVaultPathRule)),
    }),
    source,
    declared: Object.freeze({ ignore: declaredIgnore, include: include !== null }),
  });
}

const DEFAULT_SCOPE: VaultScope = buildScope(DEFAULT_VAULT_IGNORE_PATHS, null, "defaults");

/**
 * Read `<vault>/Brain/_brain.yaml` and project the `vault:` block into a
 * `VaultScope`. If the file is missing, or the block declares neither
 * `ignore_paths` nor `include_paths`, return the default scope.
 *
 * The two keys are INDEPENDENT. Declaring only `include_paths` leaves
 * the built-in exclusions in force — an allowlist narrows what is
 * walked, it never re-admits `.git` — and declaring only `ignore_paths`
 * leaves the allowlist undeclared, which is the historical behaviour of
 * every vault.
 *
 * A missing file is not an error here — existing vaults may predate
 * `_brain.yaml`. A present-but-invalid config is different: fail closed
 * so walkers do not silently index or scan paths the operator meant to
 * exclude.
 */
export function resolveVaultScope(vault: string): VaultScope {
  if (!existsSync(brainConfigPath(vault))) return DEFAULT_SCOPE;
  const cfg = loadBrainConfig(vault);
  const ignore = cfg.vault?.ignore_paths;
  const include = cfg.vault?.include_paths ?? null;
  if (ignore === undefined && include === null) return DEFAULT_SCOPE;
  return buildScope(
    ignore ?? DEFAULT_VAULT_IGNORE_PATHS,
    include,
    "_brain.yaml",
    ignore !== undefined,
  );
}

// ----- walkVaultScope ------------------------------------------------------

export interface ExcludedEntry {
  readonly relPath: string;
  /**
   * The rule that fired, or `null` when no rule did: a path outside the
   * allowlist and a lane-owned path are both refused by the absence of
   * a permission rather than by an entry the operator wrote.
   */
  readonly rule: VaultPathRule | null;
  readonly reason: IndexRefusal;
}

export interface VaultScopeWalk {
  readonly includedFiles: number;
  readonly includedDirs: number;
  readonly excludedDirs: ReadonlyArray<ExcludedEntry>;
  readonly excludedFiles: ReadonlyArray<ExcludedEntry>;
}

/**
 * Recursive fs walk over `<vault>/` that applies `scope.rules` and
 * records every excluded subtree root (one entry per top of an
 * excluded subtree — descendants are NOT enumerated again, per
 * design §5.2).
 *
 * Applies {@link admitToIndex} as well, which it did not before
 * v1.46.0: the search walker refused lane-owned paths and this one did
 * not, so `o2b vault status` reported index coverage for files the
 * indexer skips. The two walkers now answer the same question about the
 * same vault, and the refusal is reported with its own reason rather
 * than being silently uncounted.
 *
 * Acyclic-symlink guarded via realpath + `seenDirs`; symlinks that
 * escape the vault root are dropped. Every file and directory is
 * counted regardless of extension — scope policy applies uniformly, the
 * `.md` filter belongs to the search walker.
 */
/**
 * Why this DIRECTORY is not walked, or `null` when it is.
 *
 * The include question is asked through {@link mayDescend}, never
 * through {@link matchScope}: a directory that holds no included file
 * itself may still be the only route to a declared root.
 */
function refuseDirectory(relPath: string, rules: VaultScopeRules): ExcludedEntry | null {
  const ignored = matchRules(relPath, rules.ignore);
  if (ignored.matched && ignored.rule !== null) {
    return { relPath, rule: ignored.rule, reason: REASON_IGNORED };
  }
  if (!admitToIndex(relPath).admit) {
    return { relPath, rule: null, reason: REASON_NOT_ADMITTED };
  }
  if (!mayDescend(relPath, rules)) {
    return { relPath, rule: null, reason: REASON_NOT_INCLUDED };
  }
  return null;
}

/** Why this FILE is not counted as included, or `null` when it is. */
function refuseFile(relPath: string, rules: VaultScopeRules): ExcludedEntry | null {
  const scoped = matchScope(relPath, rules);
  if (scoped.reason !== null) {
    return { relPath, rule: scoped.rule, reason: scoped.reason };
  }
  if (!admitToIndex(relPath).admit) {
    return { relPath, rule: null, reason: REASON_NOT_ADMITTED };
  }
  return null;
}

export function walkVaultScope(vault: string, scope: VaultScope): VaultScopeWalk {
  const vaultReal = (() => {
    try {
      return realpathSync(vault);
    } catch {
      return vault;
    }
  })();
  const excludedDirs: ExcludedEntry[] = [];
  const excludedFiles: ExcludedEntry[] = [];
  let includedFiles = 0;
  let includedDirs = 0;
  const seenDirs = new Set<string>([vaultReal]);

  function walk(absDir: string, relDir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      const rel = relDir === "" ? toPosix(entry.name) : `${relDir}/${toPosix(entry.name)}`;
      const isLinkHint = entry.isSymbolicLink();
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        const refusal = refuseDirectory(rel, scope.rules);
        if (refusal !== null) {
          excludedDirs.push(refusal);
          continue;
        }
        let real: string;
        try {
          real = realpathSync(abs);
        } catch {
          continue;
        }
        if (real !== vaultReal && !real.startsWith(vaultReal + sep)) continue;
        if (seenDirs.has(real)) continue;
        seenDirs.add(real);
        includedDirs++;
        walk(abs, rel);
        continue;
      }
      if (!stat.isFile()) continue;
      // Symmetric with src/core/search/walker.ts: a symlinked file
      // that resolves outside the vault must not be counted as
      // included. Without this check the policy-walker and the
      // search-walker would disagree on the same vault — exactly
      // the kind of drift v0.10.9 is meant to eliminate.
      if (isLinkHint) {
        let real: string;
        try {
          real = realpathSync(abs);
        } catch {
          continue;
        }
        if (real !== vaultReal && !real.startsWith(vaultReal + sep)) continue;
      }
      const refusal = refuseFile(rel, scope.rules);
      if (refusal !== null) {
        excludedFiles.push(refusal);
        continue;
      }
      includedFiles++;
    }
  }

  walk(vaultReal, "");

  return Object.freeze({
    includedFiles,
    includedDirs,
    excludedDirs: Object.freeze(excludedDirs),
    excludedFiles: Object.freeze(excludedFiles),
  });
}

// ----- inspectPath ---------------------------------------------------------

export interface InspectResult {
  /** Vault-relative POSIX path after `./` / `//` / trailing-slash normalisation. */
  readonly relPath: string;
  /** True when vault-scope POLICY refuses the path — either polarity. */
  readonly excluded: boolean;
  /** Which polarity refused, or `null` when the path is in scope. */
  readonly reason: OutOfScopeReason | null;
  readonly rule: VaultPathRule | null;
  readonly matchedAt: string | null;
  readonly source: VaultScope["source"];
  /**
   * Whether the search index would accept the path. A SEPARATE verdict
   * from `excluded`: `Brain/state/x.md` is part of the vault and is
   * never indexed, and reporting it as simply "included" told an
   * operator their exact-state file was searchable.
   */
  readonly indexAdmitted: boolean;
  /** The admission refusal reason, or `null` when admitted. */
  readonly admissionReason: string | null;
  /**
   * `true` when `<vault>/<relPath>` exists on disk, `false` otherwise.
   * Surfaces design §7.2: the operator wants to know whether the
   * rule decision applies to a real file or to a hypothetical one
   * (e.g. checking the policy before authoring a path). Inspectors
   * that don't need this info can ignore the field.
   */
  readonly existsOnDisk: boolean;
}

/**
 * Point-check whether `<vault>/<relPath>` is included by the given
 * scope.
 *
 * Normalises `relPath` to POSIX, strips leading `./` and surrounding
 * slashes, and throws on `..` traversal so callers cannot
 * accidentally inspect something outside the vault root. Touches
 * the filesystem only to set `existsOnDisk`; the rule decision is
 * determined by `scope.rules` alone.
 */
export function inspectPath(relPath: string, scope: VaultScope, vault: string): InspectResult {
  // Segment-based normalisation: tolerate leading `./`, trailing
  // slashes, double slashes. Throw on any `..` component — silently
  // resolving them would let the caller probe outside the vault.
  const segments: string[] = [];
  for (const raw of toPosix(relPath).split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      throw new Error(`relPath must not traverse outside the vault: ${relPath}`);
    }
    segments.push(raw);
  }
  const normalised = segments.join(SEP);
  const m = matchScope(normalised, scope.rules);
  const admission = admitToIndex(normalised);
  const existsOnDisk = normalised !== "" && existsSync(join(vault, normalised));
  return Object.freeze({
    relPath: normalised,
    excluded: !m.inScope,
    reason: m.reason,
    rule: m.rule,
    matchedAt: m.matchedAt,
    source: scope.source,
    indexAdmitted: admission.admit,
    admissionReason: admission.reason ?? null,
    existsOnDisk,
  });
}
