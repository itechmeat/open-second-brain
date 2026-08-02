/**
 * createNote primitive (Brain Portability & Interop suite, Unit D;
 * authoring modes from provenance-at-the-boundary, Unit C).
 *
 * The single write primitive behind the `brain_create_note` MCP tool and
 * the SDK `createNote` method. It writes one Markdown note atomically,
 * funnelled through `ensureInsideVault`, and refuses - with a typed
 * {@link CreateNoteError}, never a silent skip - any path that is not a
 * `.md` file, traverses outside the vault, lands in the Brain machinery
 * root, is excluded by the vault scope, or would clobber an existing
 * file. Refusing loudly is deliberate: a connected agent must learn its
 * write was rejected rather than believe a note exists when it does not.
 *
 * Three opt-in authoring modes sit on top of that envelope, each inert
 * when its field is absent:
 *
 *   - `ifExists: "skip"` turns the existing-target refusal into a
 *     DISCRIMINATED no-op. The result says `outcome: "skipped"`, so a
 *     caller that skipped can never read as a caller that created -
 *     returning the same shape for both would be precisely the silent
 *     fallback this project spent two releases removing. The default
 *     stays `"refuse"`.
 *   - `strict` runs the shared write-session artifact validator over the
 *     document that would be written and reports its coded violations.
 *     It is wiring, not new machinery: the validator and its schema
 *     vocabulary binding already exist.
 *   - `template` + `templateVariables` author the body through the
 *     closed two-construct grammar in `./note-template.ts`.
 *
 * The batch surface (`../write-batch.ts`) deliberately exposes NONE of
 * these. A batch is all-or-nothing, and a per-operation skip would make
 * one `applied` count mean two different things in one result list.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import type { FrontmatterMap } from "../../types.ts";
import { ensureInsideVault } from "../../path-safety.ts";
import { formatFrontmatter, writeFrontmatterAtomic } from "../../vault.ts";
import { inspectPath, resolveVaultScope } from "../../vault-scope/index.ts";
import { BRAIN_ROOT_REL } from "../paths.ts";
import { loadSchemaPack } from "../schema-pack.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { checkWriteBinding } from "../../write-binding/index.ts";
import { validateArtifact } from "../write-session/validate.ts";
import type { WriteSessionError } from "../write-session/types.ts";
import {
  NoteTemplateError,
  renderNoteTemplate,
  type NoteTemplateVariables,
} from "./note-template.ts";

/** Machine-readable reason a {@link createNote} call was refused. */
export type CreateNoteErrorCode =
  | "invalid_path"
  | "excluded"
  | "exists"
  | "outside_vault"
  | "invalid_document"
  | "invalid_template"
  // provenance-at-the-boundary, unit B. The operator's declared
  // boundary over caller-named destinations, kept distinct from
  // `excluded` on purpose: vault scope says a path is not part of the
  // vault at all, the binding says it is a real vault path that this
  // write surface may not author into.
  | "write_binding";

export class CreateNoteError extends Error {
  readonly code: CreateNoteErrorCode;
  /**
   * Coded validator violations. Populated only for `invalid_document`,
   * where the caller needs the fix list rather than one sentence; empty
   * for every other code.
   */
  readonly violations: ReadonlyArray<WriteSessionError>;
  constructor(
    code: CreateNoteErrorCode,
    message: string,
    violations: ReadonlyArray<WriteSessionError> = [],
  ) {
    super(message);
    this.name = "CreateNoteError";
    this.code = code;
    this.violations = violations;
  }
}

/** What to do when the target path is already occupied. */
export const CREATE_NOTE_IF_EXISTS = Object.freeze(["refuse", "skip"] as const);

/** Policy for an occupied target; `refuse` is the default and the pre-existing behaviour. */
export type CreateNoteIfExists = (typeof CREATE_NOTE_IF_EXISTS)[number];

export interface CreateNoteInput {
  /** Vault-relative target path; must end in `.md`. */
  readonly path: string;
  /** Optional frontmatter map written above the body. */
  readonly frontmatter?: FrontmatterMap;
  /** Optional Markdown body. Mutually exclusive with `template`. */
  readonly content?: string;
  /** Occupied-target policy; absent means `refuse`. */
  readonly ifExists?: CreateNoteIfExists;
  /** Run the shared artifact validator before writing. Absent means no validation. */
  readonly strict?: boolean;
  /** Body template rendered through the closed two-construct grammar. */
  readonly template?: string;
  /** Variables the template may reference; requires `template`. */
  readonly templateVariables?: NoteTemplateVariables;
}

/** What a {@link createNote} call actually did. */
export type CreateNoteOutcome = "created" | "skipped";

/** A note written by this call. */
export interface CreatedNoteResult {
  /** Vault-relative POSIX path of the created note. */
  readonly path: string;
  readonly outcome: "created";
  readonly created: true;
}

/** An occupied target left exactly as it was, under `ifExists: "skip"`. */
export interface SkippedNoteResult {
  /** Vault-relative POSIX path of the note that was left alone. */
  readonly path: string;
  readonly outcome: "skipped";
  readonly created: false;
}

/**
 * Discriminated on `outcome`. `created` is the boolean the MCP surface
 * has returned since the tool shipped and is kept in lockstep with it;
 * `outcome` is what new callers should branch on, because it stays
 * readable if a third disposition is ever added.
 */
export type CreateNoteResult = CreatedNoteResult | SkippedNoteResult;

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

  // The operator's declared write binding (provenance-at-the-boundary,
  // unit B). This function is the ONE envelope every caller-named write
  // shares - `createNote` and the batch core's create / update / append
  // arms all resolve their target here - so the boundary is checked
  // exactly once, before any directory is created or byte written. The
  // refusal is composed in the binding module, never here; absent
  // declaration returns null and this whole branch is inert.
  const refusal = checkWriteBinding(vault, relPath);
  if (refusal !== null) {
    throw new CreateNoteError("write_binding", refusal.message);
  }

  let abs: string;
  try {
    abs = ensureInsideVault(join(vault, relPath), vault);
  } catch (err) {
    throw new CreateNoteError("outside_vault", err instanceof Error ? err.message : String(err));
  }
  return { relPath, abs };
}

/** Vault-relative path in POSIX form, the shape both results carry. */
function reportedPath(relPath: string): string {
  return relPath.split(/[\\/]/).join(posix.sep);
}

/**
 * The one no-op result. Built in a single place because it is reached
 * from two arms - the pre-write existence check and the exclusive-link
 * refusal that closes the race behind it - and the two must not be able
 * to drift into reporting a skip differently.
 */
function skippedResult(relPath: string): SkippedNoteResult {
  return { path: reportedPath(relPath), outcome: "skipped", created: false };
}

/**
 * Resolve the body to write. Exactly one of `content` and `template` may
 * be supplied; providing both, or variables with no template, is a
 * caller fault named rather than resolved by letting one win.
 */
function resolveBody(input: CreateNoteInput): string {
  if (input.template === undefined) {
    if (input.templateVariables !== undefined) {
      throw new CreateNoteError(
        "invalid_template",
        "templateVariables requires 'template'; supply a template or drop the variables",
      );
    }
    return input.content ?? "";
  }
  if (input.content !== undefined) {
    throw new CreateNoteError(
      "invalid_template",
      "provide either 'content' or 'template', not both",
    );
  }
  try {
    return renderNoteTemplate(input.template, input.templateVariables ?? {});
  } catch (err) {
    if (err instanceof NoteTemplateError) {
      throw new CreateNoteError("invalid_template", `${err.code}: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Run the shared write-session artifact validator over the document that
 * would be written. The schema type is whatever the frontmatter itself
 * declares, checked against the vault's `page_types` vocabulary - the
 * same binding `validateArtifactForSession` uses, so `strict` here and a
 * write session there judge a document identically.
 *
 * Note this is the CLI's `--strict` in name only: there it escalates
 * warnings into an exit code, here it is a pre-write gate. The two never
 * meet, because no command-line verb reaches this primitive.
 */
function assertValidDocument(vault: string, frontmatter: FrontmatterMap, body: string): void {
  const declaredType = frontmatter["type"];
  const schemaType = typeof declaredType === "string" ? declaredType : null;
  const violations = validateArtifact(formatFrontmatter(frontmatter, body), {
    schemaType,
    vocabulary: loadSchemaPack(vault).vocabulary,
  });
  if (violations.length > 0) {
    throw new CreateNoteError(
      "invalid_document",
      `note failed strict validation: ${violations.map((v) => v.code).join(", ")}`,
      violations,
    );
  }
}

/**
 * Create one Markdown note in the vault. Returns a discriminated
 * {@link CreateNoteResult}; throws {@link CreateNoteError} on any
 * refusal.
 */
export function createNote(vault: string, input: CreateNoteInput): CreateNoteResult {
  // Vault-identity write guard (context-integrity-gates, Unit J). This
  // backs `brain_create_note`, `brain_append_note`, and
  // `brain_update_note` - the headline note writers.
  assertVaultIdentityForWrite(vault);
  const { relPath, abs } = resolveNoteTarget(vault, input.path);
  const frontmatter = input.frontmatter ?? {};
  const body = resolveBody(input);
  // Validation judges the INPUT, so it runs before the target is
  // consulted: a caller must not learn that its document is invalid
  // only on the runs where the path happened to be free.
  if (input.strict === true) assertValidDocument(vault, frontmatter, body);

  const skipOccupied = input.ifExists === "skip";
  // Return before mkdirSync so a no-op leaves no parent directories
  // behind. The authoritative decision is still the exclusive-link
  // refusal below, which closes the residual TOCTOU race race-free.
  if (skipOccupied && existsSync(abs)) {
    return skippedResult(relPath);
  }

  mkdirSync(dirname(abs), { recursive: true });
  try {
    writeFrontmatterAtomic(abs, frontmatter, body, {
      overwrite: false,
      existsErrorKind: "note",
      vaultForRelativePath: vault,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    const exists =
      code === "EEXIST" || (err instanceof Error && /already exists/.test(err.message));
    if (exists) {
      if (skipOccupied) {
        return skippedResult(relPath);
      }
      throw new CreateNoteError("exists", `note already exists: ${relPath}`);
    }
    throw err;
  }

  return { path: reportedPath(relPath), outcome: "created", created: true };
}
