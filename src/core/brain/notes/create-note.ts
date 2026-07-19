/**
 * createNote primitive (Brain Portability & Interop suite, Unit D).
 *
 * The single write primitive behind the `brain_create_note` MCP tool and
 * the SDK `createNote` method. It writes one Markdown note atomically,
 * funnelled through `ensureInsideVault`, and refuses - with a typed
 * {@link CreateNoteError}, never a silent skip - any path that is not a
 * `.md` file, traverses outside the vault, lands in the Brain machinery
 * root, is excluded by the vault scope, or would clobber an existing
 * file. Refusing loudly is deliberate: a connected agent must learn its
 * write was rejected rather than believe a note exists when it does not.
 */

import { mkdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import type { FrontmatterMap } from "../../types.ts";
import { ensureInsideVault } from "../../path-safety.ts";
import { writeFrontmatterAtomic } from "../../vault.ts";
import { inspectPath, resolveVaultScope } from "../../vault-scope/index.ts";
import { BRAIN_ROOT_REL } from "../paths.ts";

/** Machine-readable reason a {@link createNote} call was refused. */
export type CreateNoteErrorCode = "invalid_path" | "excluded" | "exists" | "outside_vault";

export class CreateNoteError extends Error {
  readonly code: CreateNoteErrorCode;
  constructor(code: CreateNoteErrorCode, message: string) {
    super(message);
    this.name = "CreateNoteError";
    this.code = code;
  }
}

export interface CreateNoteInput {
  /** Vault-relative target path; must end in `.md`. */
  readonly path: string;
  /** Optional frontmatter map written above the body. */
  readonly frontmatter?: FrontmatterMap;
  /** Optional Markdown body. */
  readonly content?: string;
}

export interface CreateNoteResult {
  /** Vault-relative POSIX path of the created note. */
  readonly path: string;
  readonly created: true;
}

/** A note path resolved through the shared write safety envelope. */
export interface ResolvedNoteTarget {
  /** Normalised vault-relative path (native separators). */
  readonly relPath: string;
  /** Absolute filesystem path, guaranteed inside the vault. */
  readonly abs: string;
}

/**
 * Resolve and safety-check a vault-relative note path - the exact
 * envelope enforced by {@link createNote}: `.md` suffix, vault-relative
 * (no absolute path), no `..` traversal, not the Brain machinery root,
 * not a vault-scope-excluded location, and inside the vault. Every
 * refusal is a typed {@link CreateNoteError}. Extracted so the atomic
 * write-batch core (kernel 2) reuses the same envelope for update and
 * append operations rather than re-deriving it.
 */
export function resolveNoteTarget(vault: string, path: string): ResolvedNoteTarget {
  if (!path.toLowerCase().endsWith(".md")) {
    throw new CreateNoteError("invalid_path", `note path must end in .md: ${path}`);
  }
  // The tool addresses notes by a vault-relative path; an absolute path is
  // ambiguous (which root?) and is refused rather than silently re-rooted.
  if (path.startsWith("/") || path.startsWith("\\")) {
    throw new CreateNoteError("invalid_path", `note path must be vault-relative: ${path}`);
  }

  // inspectPath normalises the relative path and throws on `..` traversal;
  // an absolute path also has no place here. Translate both into a typed
  // CreateNoteError so callers get one error surface.
  const scope = resolveVaultScope(vault);
  let inspected;
  try {
    inspected = inspectPath(path, scope, vault);
  } catch (err) {
    throw new CreateNoteError("invalid_path", err instanceof Error ? err.message : String(err));
  }
  const relPath = inspected.relPath;
  if (relPath === "") {
    throw new CreateNoteError("invalid_path", `empty note path: ${path}`);
  }

  // The Brain machinery root is owned by the brain's own writers; a
  // free-form note tool must never author into it (default vault-scope
  // rules ignore Brain/.snapshots only, not the whole Brain root).
  const firstSegment = relPath.split("/")[0];
  if (firstSegment === BRAIN_ROOT_REL) {
    throw new CreateNoteError(
      "excluded",
      `the Brain machinery root is not writable via create_note: ${relPath}`,
    );
  }

  if (inspected.excluded) {
    throw new CreateNoteError(
      "excluded",
      `path is excluded by vault scope (${inspected.rule?.raw ?? "rule"}): ${relPath}`,
    );
  }

  let abs: string;
  try {
    abs = ensureInsideVault(join(vault, relPath), vault);
  } catch (err) {
    throw new CreateNoteError("outside_vault", err instanceof Error ? err.message : String(err));
  }
  return { relPath, abs };
}

/**
 * Create one Markdown note in the vault. Returns the created note's
 * vault-relative path; throws {@link CreateNoteError} on any refusal.
 */
export function createNote(vault: string, input: CreateNoteInput): CreateNoteResult {
  const { relPath, abs } = resolveNoteTarget(vault, input.path);

  mkdirSync(dirname(abs), { recursive: true });
  try {
    writeFrontmatterAtomic(abs, input.frontmatter ?? {}, input.content ?? "", {
      overwrite: false,
      existsErrorKind: "note",
      vaultForRelativePath: vault,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    const exists =
      code === "EEXIST" || (err instanceof Error && /already exists/.test(err.message));
    if (exists) {
      throw new CreateNoteError("exists", `note already exists: ${relPath}`);
    }
    throw err;
  }

  return { path: relPath.split(/[\\/]/).join(posix.sep), created: true };
}
