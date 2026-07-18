/**
 * Exact-title note resolver (today-operator-surface, Task 5).
 *
 * Maps a marker `note=<target>` field to exactly one vault-relative
 * note path, fail-closed. Two resolution branches:
 *
 *   - A target that contains a `/` is treated as a vault-relative
 *     path: a missing `.md` suffix is appended, containment and
 *     existence are checked via {@link resolveNotePath} - a
 *     nonexistent or out-of-vault path is a typed error, never a
 *     guess.
 *   - Otherwise the target is resolved Obsidian-style: normalized via
 *     the existing wikilink helpers and matched against note
 *     basenames (filename minus `.md`) across the configured note
 *     paths (`notes.read_paths`, filtered by `vault.ignore_paths`).
 *     Zero matches or more than one match is a typed error; more than
 *     one lists every candidate path so the caller can disambiguate
 *     rather than the resolver guessing.
 *
 * The basename walk uses the shared note walker
 * ({@link walkMarkdownFiles}): `notes.read_paths` roots,
 * `vault.ignore_paths` exclusion via `matchIgnore`, and a hard skip of
 * the `Brain/` machinery root. The per-file size cap `scanInline`
 * applies before reading marker content does not apply here - this
 * resolver only reads directory entries and filenames, never file
 * bytes, so it passes no cap.
 */

import { sep } from "node:path";

import { resolveNotePath } from "../note-path.ts";
import { ANCHORED_WIKILINK_RE, normaliseWikilinkTarget } from "../wikilink.ts";
import { buildNoteWalkRules, resolveNoteRoots, walkMarkdownFiles } from "./note-walk.ts";

/** Machine-readable reason a {@link resolveNoteTarget} call was refused. */
export type NoteTitleResolutionErrorCode =
  | "empty_target"
  | "path_not_found"
  | "not_found"
  | "ambiguous";

export class NoteTitleResolutionError extends Error {
  readonly code: NoteTitleResolutionErrorCode;
  /** Vault-relative candidate paths, populated only for `ambiguous`. */
  readonly candidates: ReadonlyArray<string>;

  constructor(
    code: NoteTitleResolutionErrorCode,
    message: string,
    candidates: ReadonlyArray<string> = [],
  ) {
    super(message);
    this.name = "NoteTitleResolutionError";
    this.code = code;
    this.candidates = Object.freeze([...candidates]);
  }
}

/**
 * Resolve a marker target (bare text or `[[wikilink]]`-wrapped) to
 * exactly one vault-relative note path. Throws
 * {@link NoteTitleResolutionError} on every refusal - a missing or
 * ambiguous target never falls back to a guess.
 */
export function resolveNoteTarget(vault: string, rawTarget: string): string {
  const raw = rawTarget ?? "";
  const body = extractTargetBody(raw);
  if (body.length === 0) {
    throw new NoteTitleResolutionError("empty_target", "note target must not be empty");
  }

  if (body.includes("/")) {
    return resolveByPath(vault, body);
  }

  const title = normaliseWikilinkTarget(raw);
  if (title.length === 0) {
    throw new NoteTitleResolutionError("empty_target", "note target must not be empty");
  }
  return resolveByTitle(vault, title);
}

/**
 * Unwrap `[[...]]` brackets (if present) and drop the `|alias` and
 * `#anchor` suffixes, WITHOUT collapsing folder segments via
 * `basename()` - this local mirror of `wikilink.ts`'s private
 * `stripBasenameDecoration` is needed so the "does this target
 * contain a folder path" check below sees the un-collapsed target.
 * `normaliseWikilinkTarget` cannot be reused for this check because it
 * always collapses to a basename.
 */
function extractTargetBody(raw: string): string {
  let s = raw.trim();
  const wm = ANCHORED_WIKILINK_RE.exec(s);
  if (wm) s = wm[1]!.trim();
  const pipe = s.indexOf("|");
  if (pipe >= 0) s = s.slice(0, pipe).trim();
  const hash = s.indexOf("#");
  if (hash >= 0) s = s.slice(0, hash).trim();
  return s;
}

function resolveByPath(vault: string, body: string): string {
  let relPath = body
    .split(sep)
    .join("/")
    .replace(/^\/+|\/+$/g, "");
  if (!relPath.toLowerCase().endsWith(".md")) {
    relPath = `${relPath}.md`;
  }
  try {
    resolveNotePath(vault, relPath, { mustExist: true });
  } catch {
    throw new NoteTitleResolutionError("path_not_found", `note not found at path: ${relPath}`);
  }
  return relPath;
}

function resolveByTitle(vault: string, title: string): string {
  const candidates = collectNoteBasenames(vault)
    .filter((entry) => entry.title === title)
    .map((entry) => entry.relPath)
    .toSorted((a, b) => a.localeCompare(b));

  if (candidates.length === 0) {
    throw new NoteTitleResolutionError(
      "not_found",
      `no note matched title "${title}" across the configured note paths`,
    );
  }
  if (candidates.length > 1) {
    throw new NoteTitleResolutionError(
      "ambiguous",
      `title "${title}" matches more than one note - candidates: ${candidates.join(", ")}`,
      candidates,
    );
  }
  return candidates[0]!;
}

interface NoteBasenameEntry {
  /** Vault-relative POSIX path of the note. */
  readonly relPath: string;
  /** Filename minus the trailing `.md` extension. */
  readonly title: string;
}

/**
 * Enumerate every `.md` file under the configured `notes.read_paths`
 * roots, honouring `vault.ignore_paths` exclusion plus a hard skip of
 * the `Brain/` machinery root - the same effective rule set
 * `scanInline` applies (see module doc for why this is a mirror, not
 * an import).
 */
function collectNoteBasenames(vault: string): ReadonlyArray<NoteBasenameEntry> {
  const roots = resolveNoteRoots(vault);
  if (roots.length === 0) return [];

  const rules = buildNoteWalkRules(vault);

  const out: NoteBasenameEntry[] = [];
  for (const { relPath } of walkMarkdownFiles(vault, roots, rules)) {
    const segments = relPath.split("/");
    const filename = segments[segments.length - 1]!;
    const title = filename.endsWith(".md") ? filename.slice(0, -".md".length) : filename;
    out.push({ relPath, title });
  }
  return out;
}
