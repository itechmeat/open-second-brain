/**
 * Shared note-space walker.
 *
 * The single home for the "walk the configured note folders" logic that
 * `scanInline` (src/core/brain/inline-scan.ts) and the open-loop /
 * note-title scanners all need. Before this module the rules were
 * duplicated: `inline-scan.ts` owned the canonical copy and
 * `note-title-resolver.ts` carried a private mirror because the walker
 * was not exported. Both now delegate here.
 *
 * Walker rule set (identical to the historical `scanInline` behaviour):
 *
 *   - Roots come from explicit caller paths when given, else from
 *     `notes.read_paths` in `Brain/_brain.yaml`; both are `{{role}}`
 *     token-resolved via the optional vault-map.
 *   - The shared vault scope via {@link resolveVaultScope} /
 *     {@link matchScope} — `vault.ignore_paths` exclusion AND the
 *     `vault.include_paths` allowlist when the operator declared one.
 *   - A hard skip of the top-level `Brain/` machinery root (the derived
 *     layer must never be walked as note content), added as a `path`
 *     rule so a nested `projects/Brain/` folder keeps being walked.
 *   - Optional extra `exclude` prefixes, classified as `path` rules.
 *   - `.md` files only; `.git` / `node_modules` and friends fall out of
 *     the shared `vault.ignore_paths` defaults.
 *   - Include-narrowing: a file is yielded only when its vault-relative
 *     path sits under one of the resolved roots, segment-wise via the
 *     shared {@link pathCovers} — a root of `Notes` must not reach
 *     `Notes-archive/`.
 *
 * Size cap is an option, not a fixed rule: `scanInline` reads file bytes
 * and passes a 1 MiB cap so oversize files are reported and skipped; the
 * title/loop scanners that only read directory entries pass no cap and
 * never stat.
 */

import { readdirSync, statSync, type Dirent } from "node:fs";
import { join, sep } from "node:path";

import { BRAIN_ROOT_REL } from "../paths.ts";
import { loadNotesConfigSafe } from "../policy.ts";
import { loadVaultMap, resolveTokens } from "../portability/role-tokens.ts";
import { matchScope, mayDescend, resolveVaultScope } from "../../vault-scope/index.ts";
import { pathCovers, type VaultScopeRules } from "../../vault-scope/defaults.ts";

/** One markdown file discovered by {@link walkMarkdownFiles}. */
export interface NoteWalkFile {
  /** Absolute filesystem path. */
  readonly absPath: string;
  /** Vault-relative POSIX path (forward slashes, no leading slash). */
  readonly relPath: string;
}

/** Options for {@link walkMarkdownFiles}. */
export interface WalkMarkdownOptions {
  /**
   * When set, a file whose byte size exceeds this cap is skipped and
   * reported through {@link WalkMarkdownOptions.onOversize} instead of
   * being yielded. When absent, files are never stat-ed for size.
   */
  readonly maxFileSizeBytes?: number;
  /** Invoked for each file skipped because it exceeded the size cap. */
  readonly onOversize?: (file: NoteWalkFile, sizeBytes: number) => void;
}

/**
 * POSIX-normalise a vault-relative prefix: convert the OS-native
 * separator to `/` FIRST, then strip leading / trailing slashes. On
 * Windows `notes\\` must become `notes` (not `notes/`), so the
 * separator conversion has to happen before the slash trim.
 * {@link matchScope} expects POSIX rel-paths.
 */
export function normalisePrefix(rel: string): string {
  return rel
    .split(sep)
    .join("/")
    .replace(/^\/+|\/+$/g, "");
}

/**
 * Resolve the note roots to walk, as normalised POSIX prefixes.
 *
 * Explicit caller paths always win; when absent or all-blank the roots
 * come from `notes.read_paths`. Both sources are `{{role}}` token-
 * resolved through the optional vault-map (absent map -> unchanged).
 * Empty results after normalisation are dropped, so an empty return
 * means "no folders to walk" and the caller should not walk the vault.
 */
export function resolveNoteRoots(vault: string, explicitPaths?: ReadonlyArray<string>): string[] {
  const explicit = (explicitPaths ?? []).filter((p) => p.trim().length > 0);
  const vaultMap = loadVaultMap(vault);
  const base = explicit.length > 0 ? explicit : [...loadNotesConfigSafe(vault).read_paths];
  return base
    .map((p) => resolveTokens(vaultMap, p))
    .map(normalisePrefix)
    .filter((p) => p.length > 0);
}

/**
 * Build the effective rule set for a note walk: the shared vault scope,
 * plus the hard `Brain/` root skip, plus any caller `exclude` prefixes
 * (classified as `path` rules).
 *
 * The exclusions are the note walk's own, so they extend the scope's
 * exclude side. The allowlist is carried through UNCHANGED: it is the
 * operator's vault-wide declaration, and this walk has no business
 * widening or narrowing it — the note roots are a second, independent
 * narrowing applied per file in {@link walkMarkdownFiles}.
 */
export function buildNoteWalkRules(
  vault: string,
  excludePrefixes?: ReadonlyArray<string>,
): VaultScopeRules {
  const scope = resolveVaultScope(vault);
  return {
    ignore: [
      ...scope.rules.ignore,
      // `path` (not `name`) so the hard-skip targets only the top-level
      // `<vault>/Brain/` directory; a project file like
      // `projects/Brain/notes.md` keeps being walked.
      { raw: BRAIN_ROOT_REL, kind: "path" },
      ...(excludePrefixes ?? []).map(
        (raw) => ({ raw: normalisePrefix(raw), kind: "path" }) as const,
      ),
    ],
    include: scope.rules.include,
  };
}

/**
 * Walk `<vault>/` and yield every `.md` file under one of `roots` that
 * is not excluded by `rules`, in document (stack) order.
 *
 * When `opts.maxFileSizeBytes` is set each candidate is stat-ed: a file
 * that cannot be stat-ed (races a delete) is skipped silently, and a
 * file over the cap is reported via `opts.onOversize` and skipped.
 * Without the cap no `stat` is performed.
 */
export function* walkMarkdownFiles(
  vault: string,
  roots: ReadonlyArray<string>,
  rules: VaultScopeRules,
  opts?: WalkMarkdownOptions,
): Generator<NoteWalkFile> {
  const cap = opts?.maxFileSizeBytes;
  const stack: Array<{ abs: string; rel: string }> = [{ abs: vault, rel: "" }];
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

      if (entry.isDirectory()) {
        // Include-narrowing applies only to files: descend so subtree
        // files under a root are still reached. `mayDescend` is the
        // predicate that says so for the vault-wide allowlist, and the
        // note roots below are narrowed per file for the same reason.
        if (mayDescend(relPosix, rules)) stack.push({ abs: full, rel: relPosix });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;

      if (!matchScope(relPosix, rules).inScope) continue;

      // Roots arrive through `normalisePrefix`, which is what satisfies
      // the canonical-prefix precondition of `pathCovers`.
      const underRoot = roots.some((root) => pathCovers(root, relPosix));
      if (!underRoot) continue;

      const file: NoteWalkFile = { absPath: full, relPath: relPosix };

      if (cap !== undefined) {
        let size: number;
        try {
          size = statSync(full).size;
        } catch {
          continue;
        }
        if (size > cap) {
          opts?.onOversize?.(file, size);
          continue;
        }
      }

      yield file;
    }
  }
}
