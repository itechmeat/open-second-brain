/**
 * Vault Scope — single source of truth for vault-wide exclusion
 * policy.
 *
 * Anchored in docs/plans/2026-05-19-vault-scope-design.md §5.
 *
 * Public surface:
 *   - `DEFAULT_VAULT_IGNORE_PATHS`, `VaultIgnoreRule` — re-exported
 *     from `./defaults.ts`; that submodule is the cycle-safe home
 *     used by `src/core/brain/policy.ts`.
 *   - `matchIgnore` — pure matcher.
 *   - `resolveVaultScope` — reads `Brain/_brain.yaml` and produces
 *     a `VaultScope` with classified rules.
 */

import { existsSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { join, sep } from "node:path";

import { loadBrainConfig } from "../brain/policy.ts";
import { brainConfigPath } from "../brain/paths.ts";
import { toPosix } from "../path-safety.ts";
import {
  DEFAULT_VAULT_IGNORE_PATHS,
  classifyVaultIgnoreRule,
  type VaultIgnoreRule,
} from "./defaults.ts";

export { DEFAULT_VAULT_IGNORE_PATHS, classifyVaultIgnoreRule, type VaultIgnoreRule };

// ----- matchIgnore ---------------------------------------------------------

export interface IgnoreMatch {
  readonly excluded: boolean;
  readonly rule: VaultIgnoreRule | null;
  /** POSIX rel-path of the prefix that triggered the match, or null. */
  readonly matchedAt: string | null;
}

const NEGATIVE_MATCH: IgnoreMatch = Object.freeze({
  excluded: false,
  rule: null,
  matchedAt: null,
});

/**
 * Walk `relPath` segment by segment. For each prefix, check name-
 * and path-rules. Return the shortest prefix that excludes, or
 * `{excluded: false}` if no rule fires.
 *
 * `relPath` must be POSIX (forward-slash separated), vault-relative,
 * and free of `.` / `..` components — `matchIgnore` does no
 * normalisation. Callers (`walkVaultScope`, `inspectPath`) prepare
 * the input.
 */
export function matchIgnore(relPath: string, rules: ReadonlyArray<VaultIgnoreRule>): IgnoreMatch {
  if (relPath === "" || rules.length === 0) return NEGATIVE_MATCH;
  const segments = relPath.split("/").filter((s) => s.length > 0);
  let prefix = "";
  for (const seg of segments) {
    prefix = prefix === "" ? seg : `${prefix}/${seg}`;
    for (const rule of rules) {
      if (rule.kind === "name") {
        if (rule.raw === seg) {
          return { excluded: true, rule, matchedAt: prefix };
        }
        continue;
      }
      // kind === "path": exact prefix match.
      if (rule.raw === prefix) {
        return { excluded: true, rule, matchedAt: prefix };
      }
    }
  }
  return NEGATIVE_MATCH;
}

// ----- resolveVaultScope ---------------------------------------------------

export interface VaultScope {
  /** Final list of paths in declaration order. */
  readonly ignorePaths: ReadonlyArray<string>;
  /** Same list, classified as `name | path`. */
  readonly rules: ReadonlyArray<VaultIgnoreRule>;
  readonly source: "_brain.yaml" | "defaults";
}

function buildScope(paths: ReadonlyArray<string>, source: VaultScope["source"]): VaultScope {
  const ignorePaths = Object.freeze([...paths]);
  const rules = Object.freeze(ignorePaths.map(classifyVaultIgnoreRule));
  return Object.freeze({ ignorePaths, rules, source });
}

const DEFAULT_SCOPE: VaultScope = buildScope(DEFAULT_VAULT_IGNORE_PATHS, "defaults");

/**
 * Read `<vault>/Brain/_brain.yaml` and project the `vault.ignore_paths`
 * declaration into a `VaultScope`. If the file is missing or omits the
 * `vault` block (or the `ignore_paths` key inside it), return the
 * default scope.
 *
 * A missing file is not an error here — existing vaults may predate
 * `_brain.yaml`. A present-but-invalid config is different: fail closed
 * so walkers do not silently index or scan paths the operator meant to
 * exclude.
 */
export function resolveVaultScope(vault: string): VaultScope {
  if (!existsSync(brainConfigPath(vault))) return DEFAULT_SCOPE;
  const cfg = loadBrainConfig(vault);
  const declared = cfg.vault?.ignore_paths;
  if (declared === undefined) return DEFAULT_SCOPE;
  return buildScope(declared, "_brain.yaml");
}

// ----- walkVaultScope ------------------------------------------------------

export interface ExcludedEntry {
  readonly relPath: string;
  readonly rule: VaultIgnoreRule;
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
 * Acyclic-symlink guarded via realpath + `seenDirs`; symlinks that
 * escape the vault root are dropped. Every file and directory is
 * counted regardless of extension — exclusion policy applies
 * uniformly, the `.md` filter belongs to the search walker.
 */
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
        const m = matchIgnore(rel, scope.rules);
        if (m.excluded && m.rule) {
          excludedDirs.push({ relPath: rel, rule: m.rule });
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
      const m = matchIgnore(rel, scope.rules);
      if (m.excluded && m.rule) {
        excludedFiles.push({ relPath: rel, rule: m.rule });
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
  readonly excluded: boolean;
  readonly rule: VaultIgnoreRule | null;
  readonly matchedAt: string | null;
  readonly source: VaultScope["source"];
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
  const normalised = segments.join("/");
  const m = matchIgnore(normalised, scope.rules);
  const existsOnDisk = normalised !== "" && existsSync(join(vault, normalised));
  return Object.freeze({
    relPath: normalised,
    excluded: m.excluded,
    rule: m.rule,
    matchedAt: m.matchedAt,
    source: scope.source,
    existsOnDisk,
  });
}
