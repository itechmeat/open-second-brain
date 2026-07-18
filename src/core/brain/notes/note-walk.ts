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
 *   - `vault.ignore_paths` exclusion via {@link resolveVaultScope} /
 *     {@link matchIgnore}.
 *   - A hard skip of the top-level `Brain/` machinery root (the derived
 *     layer must never be walked as note content), added as a `path`
 *     rule so a nested `projects/Brain/` folder keeps being walked.
 *   - Optional extra `exclude` prefixes, classified as `path` rules.
 *   - `.md` files only; `.git` / `node_modules` and friends fall out of
 *     the shared `vault.ignore_paths` defaults.
 *   - Include-narrowing: a file is yielded only when its vault-relative
 *     path sits under one of the resolved roots.
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
import { matchIgnore, resolveVaultScope, type VaultIgnoreRule } from "../../vault-scope/index.ts";

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
 * {@link matchIgnore} expects POSIX rel-paths.
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
 * Build the effective ignore-rule set for a note walk: the shared
 * `vault.ignore_paths` scope, plus the hard `Brain/` root skip, plus any
 * caller `exclude` prefixes (classified as `path` rules).
 */
export function buildNoteWalkRules(
  vault: string,
  excludePrefixes?: ReadonlyArray<string>,
): VaultIgnoreRule[] {
  const scope = resolveVaultScope(vault);
  return [
    ...scope.rules,
    // `path` (not `name`) so the hard-skip targets only the top-level
    // `<vault>/Brain/` directory; a project file like
    // `projects/Brain/notes.md` keeps being walked.
    { raw: BRAIN_ROOT_REL, kind: "path" },
    ...(excludePrefixes ?? []).map(
      (raw): VaultIgnoreRule => ({ raw: normalisePrefix(raw), kind: "path" }),
    ),
  ];
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
  rules: ReadonlyArray<VaultIgnoreRule>,
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

      if (matchIgnore(relPosix, rules).excluded) continue;

      if (entry.isDirectory()) {
        // Include-narrowing applies only to files: descend so subtree
        // files under a root are still reached.
        stack.push({ abs: full, rel: relPosix });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;

      const underRoot = roots.some((p) => relPosix === p || relPosix.startsWith(p + "/"));
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
