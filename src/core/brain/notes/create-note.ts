/**
 * createNote primitive (Brain Portability & Interop suite, Unit D;
 * authoring modes from provenance-at-the-boundary, Unit C).
 *
 * The single write primitive behind the `brain_create_note` MCP tool and
 * the SDK `createNote` method. It writes one Markdown note atomically,
 * funnelled through `ensureInsideVault`, and refuses - with a typed
 * {@link CreateNoteError}, never a silent skip - any path that is not a
 * `.md` file, traverses outside the vault, spells its separators in a
 * way this host would read differently, lands in the Brain machinery
 * root, is excluded by the vault scope, falls outside the operator's
 * declared write binding, or would clobber an existing file. A vault
 * whose own `Brain/_brain.yaml` does not load is refused the same way
 * rather than raising an untyped fault. Refusing loudly is deliberate: a
 * connected agent must learn its write was rejected rather than believe
 * a note exists when it does not.
 *
 * The path this primitive REPORTS is the path the bytes are at. That is
 * a property of the envelope, not a coincidence: the reported string is
 * the one `inspectPath` normalised and the one every guard judged, and
 * the two shapes that used to break it - a caller separator rewritten on
 * the way out, and a symlinked directory redirecting the write past the
 * binding - are refused rather than reported.
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
import { dirname, join, posix, sep, win32 } from "node:path";

import type { FrontmatterMap } from "../../types.ts";
import { ensureInsideVault } from "../../path-safety.ts";
import { formatFrontmatter, writeFrontmatterAtomic } from "../../vault.ts";
import { inspectPath, resolveVaultScope } from "../../vault-scope/index.ts";
import { BRAIN_CONFIG_FILE, BRAIN_ROOT_REL } from "../paths.ts";
import { requireNextStep } from "../next-step.ts";
import { BrainConfigError } from "../policy.ts";
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
  | "write_binding"
  // The vault's own `Brain/_brain.yaml` exists and does not validate, so
  // neither the vault scope nor the write binding can be determined.
  // Distinct from every other code here because it is NOT about the path
  // the caller named: no argument the caller could send would succeed,
  // and the operator - not the caller - holds the fix.
  | "config_invalid";

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
  /**
   * Normalised vault-relative path, POSIX. `inspectPath` joins its
   * segments with `/` on every platform, and {@link resolveNoteTarget}
   * refuses any caller path this host would read differently, so this is
   * the path the surfaces report AND the path the bytes are at — the two
   * cannot diverge.
   */
  readonly relPath: string;
  /** Absolute filesystem path, guaranteed inside the vault. */
  readonly abs: string;
}

/**
 * The separator that is structure on Windows and an ordinary filename
 * character everywhere else. Named once because the reason it matters is
 * that this host's answer differs from the other host's.
 */
const WINDOWS_SEP = win32.sep;

/**
 * Registry code for a vault whose Brain config does not load, resolved
 * at module scope so registry drift fails at import rather than inside
 * the refusal it was meant to explain (same rule as the write binding's
 * own exit).
 */
export const NOTE_CONFIG_INVALID_CODE = "config-invalid";
const CONFIG_INVALID_EXIT = requireNextStep(NOTE_CONFIG_INVALID_CODE).nextCommand;

/** Vault-relative spelling of the config file every refusal here names. */
const BRAIN_CONFIG_REL = posix.join(BRAIN_ROOT_REL, BRAIN_CONFIG_FILE);

/**
 * Refuse a caller-named path whose separators this host does not read
 * the way the caller wrote them.
 *
 * THE DECISION, and why it is a refusal rather than a normalisation.
 * On POSIX a backslash is an ordinary filename character, and three
 * layers of this envelope disagreed about that: the write-binding
 * matcher split on it (so a binding on `Projects` admitted
 * `Projects\evil.md`), the result renderer rewrote it to `/` (so the
 * tool reported `Projects/evil.md`), and `inspectPath`, the `..`
 * traversal guard, the `Brain/` machinery-root check and every
 * POSIX-written vault-scope ignore rule treated it as literal (so the
 * bytes landed in ONE file at the vault ROOT, named `Projects\evil.md`).
 *
 * Picking a reading is the tempting fix and the wrong one. Normalising
 * `\` to `/` silently reinterprets the caller's string into a different
 * path than the one it sent, and treating it as literal leaves a
 * boundary that a caller can talk past. This repository forbids the
 * quiet reinterpretation, so the path is refused and the caller is told
 * which character made it ambiguous. A caller that meant a subdirectory
 * re-sends it with `/`; a caller that genuinely meant a backslash in a
 * filename has asked for something no surface here can report
 * faithfully.
 *
 * On Windows this never fires: `\` IS the separator there, and
 * `inspectPath` converts it to POSIX before anything downstream sees it.
 */
function assertHostPathSeparators(path: string): void {
  if (WINDOWS_SEP === sep) return;
  if (!path.includes(WINDOWS_SEP)) return;
  throw new CreateNoteError(
    "invalid_path",
    `note path must use '${posix.sep}' to separate segments; on this host ` +
      `'${WINDOWS_SEP}' is an ordinary filename character, so the path would not ` +
      `mean what it looks like: ${path}`,
  );
}

/**
 * Translate a Brain config failure into this surface's typed refusal.
 *
 * The raw {@link BrainConfigError} names the config by its ABSOLUTE host
 * path, which is the one thing no other refusal on this surface leaks
 * and which a connected agent cannot act on. The re-raised error keeps
 * the validator's own diagnosis, renames the source to its vault-
 * relative spelling, and appends the registered exit, so a caller that
 * hits it learns what to run instead of receiving a bare fault.
 */
function configFault(err: BrainConfigError): CreateNoteError {
  const source = err.source;
  const prefix = source === null ? null : `${source}: `;
  const detail =
    prefix !== null && err.message.startsWith(prefix)
      ? err.message.slice(prefix.length)
      : err.message;
  return new CreateNoteError(
    "config_invalid",
    `${BRAIN_CONFIG_REL}: ${detail}; ${CONFIG_INVALID_EXIT}`,
  );
}

/**
 * Run `read`, translating a Brain config failure into {@link configFault}.
 * Shared by the two config-backed checks in the envelope — the vault
 * scope and the write binding — so a malformed config reads the same on
 * whichever of them reaches it first.
 */
function withConfigFault<T>(read: () => T): T {
  try {
    return read();
  } catch (err) {
    if (err instanceof BrainConfigError) throw configFault(err);
    throw err;
  }
}

/**
 * Resolve and safety-check a vault-relative note path - the exact
 * envelope enforced by {@link createNote}: `.md` suffix, vault-relative
 * (no absolute path), separators this host reads the way the caller
 * wrote them, no `..` traversal, not the Brain machinery root, not a
 * vault-scope-excluded location, inside the operator's declared write
 * binding, and inside the vault. Every refusal is a typed
 * {@link CreateNoteError} - including the one case that is not about the
 * path at all, a `Brain/_brain.yaml` that does not load. Extracted so the
 * atomic write-batch core (kernel 2) reuses the same envelope for update
 * and append operations rather than re-deriving it.
 *
 * Order is load-bearing. The separator check runs FIRST, before anything
 * normalises the string, because every guard after it reads segments and
 * they must all be reading the same segments the caller meant.
 */
export function resolveNoteTarget(vault: string, path: string): ResolvedNoteTarget {
  if (!path.toLowerCase().endsWith(".md")) {
    throw new CreateNoteError("invalid_path", `note path must end in .md: ${path}`);
  }
  // The tool addresses notes by a vault-relative path; an absolute path is
  // ambiguous (which root?) and is refused rather than silently re-rooted.
  if (path.startsWith(posix.sep) || path.startsWith(WINDOWS_SEP)) {
    throw new CreateNoteError("invalid_path", `note path must be vault-relative: ${path}`);
  }
  // Before any normalisation reads the string: refuse a separator this
  // host would not read the way the caller wrote it. See the function.
  assertHostPathSeparators(path);

  // inspectPath normalises the relative path and throws on `..` traversal;
  // an absolute path also has no place here. Translate both into a typed
  // CreateNoteError so callers get one error surface.
  const scope = withConfigFault(() => resolveVaultScope(vault));
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
  const firstSegment = relPath.split(posix.sep)[0];
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
  const refusal = withConfigFault(() => checkWriteBinding(vault, relPath));
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

/**
 * The one no-op result. Built in a single place because it is reached
 * from two arms - the pre-write existence check and the exclusive-link
 * refusal that closes the race behind it - and the two must not be able
 * to drift into reporting a skip differently.
 *
 * `relPath` is reported verbatim. It used to be re-split on `[\\/]` and
 * re-joined with `/`, which was the only place the reported path could
 * differ from the path that holds the bytes: on POSIX that rewrote a
 * file literally named `Projects\evil.md` at the vault root into the
 * report `Projects/evil.md`. Such a path is now refused at the envelope,
 * and {@link ResolvedNoteTarget.relPath} is already POSIX, so there is
 * nothing left to convert.
 */
function skippedResult(relPath: string): SkippedNoteResult {
  return { path: relPath, outcome: "skipped", created: false };
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

  return { path: relPath, outcome: "created", created: true };
}
