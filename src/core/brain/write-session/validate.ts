/**
 * Write-session artifact validation and target policy
 * (Agent Write Contract Suite, t_bc36a8a2).
 *
 * Fail-closed by construction: every check returns machine-readable
 * `{code, path, message}` errors, and the engine commits ONLY a clean
 * artifact. The correction prompt is derived from the error list so
 * the calling agent receives exactly what to fix - the session keeps
 * the target and schema, the agent resubmits the full artifact.
 *
 * Target policy is an allow-list, not a deny-list: under `Brain/` a
 * session writes only the lanes that hold agent-authored pages
 * ({@link WRITE_SESSION_LANES_REL}). Everything else there - config,
 * standing rules, the active context, preferences, logs, session and
 * payload stores - is owned by the Brain's own writers. The lane test
 * reads the path the way the filesystem does (case-folded, trailing
 * dots dropped), so `Brain/Preferences/` or `Brain/log./` is not a way
 * around it.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, posix, sep } from "node:path";

import { ORIGIN_CHANNEL_FIELD } from "../../origin-channel.ts";
import { parseFrontmatterText } from "../../vault.ts";
import {
  BRAIN_DECISIONS_REL,
  BRAIN_PAGE_LANES_REL,
  BRAIN_ROOT_REL,
  isInBrainLane,
  isUnderBrainRoot,
} from "../path-constants.ts";
import { isKnownSchemaToken, type BrainSchemaVocabulary } from "../schema-vocab.ts";
import type { ExistingTargetInfo, WriteSessionError } from "./types.ts";

/** Hard cap on artifact size - a note, not a payload dump. */
export const ARTIFACT_MAX_BYTES = 262_144;

/**
 * The `Brain/` lanes a write session may commit into:
 *
 * - the page lanes ({@link BRAIN_PAGE_LANES_REL}: sources, reports,
 *   distillations) every caller-named writer may reach;
 * - `Brain/decisions/panels/`, where a decision-panel session commits
 *   its synthesis note by default;
 * - `Brain/notes/`, the free-form agent note lane the artifact kind is
 *   documented and tested against (handoffs, ADR drafts). No Brain
 *   writer owns it and nothing reads it as machinery.
 */
export const WRITE_SESSION_LANES_REL: ReadonlyArray<string> = Object.freeze([
  ...BRAIN_PAGE_LANES_REL,
  posix.join(BRAIN_DECISIONS_REL, "panels"),
  posix.join(BRAIN_ROOT_REL, "notes"),
]);

/**
 * The refusal for a `Brain/`-relative landing path outside
 * {@link WRITE_SESSION_LANES_REL}, or `null` when a session may write
 * there. Shared by the open-time check and the commit-time re-check of
 * where the bytes actually land.
 */
export function writeSessionLaneRefusal(relPath: string): WriteSessionError | null {
  if (!isUnderBrainRoot(relPath)) {
    return err("target-outside-brain", "target", `${relPath} is not under ${BRAIN_ROOT_REL}/`);
  }
  if (isInBrainLane(relPath, WRITE_SESSION_LANES_REL)) return null;
  return err(
    "target-reserved",
    "target",
    `${relPath} is Brain machinery; a write session commits only under ` +
      WRITE_SESSION_LANES_REL.map((lane) => `${lane}/`).join(", "),
  );
}

function err(code: string, path: string, message: string): WriteSessionError {
  return Object.freeze({ code, path, message });
}

/**
 * C0 controls except \t (0x09), \n (0x0A), \r (0x0D). A char-code walk
 * instead of a regex keeps the no-control-regex lint baseline intact.
 */
function hasForbiddenControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
}

/**
 * Validate a vault-relative commit target. Returns `[]` when the path
 * is acceptable; every violation is a coded error.
 */
export function validateTargetPath(targetPath: string): ReadonlyArray<WriteSessionError> {
  const errors: WriteSessionError[] = [];
  if (typeof targetPath !== "string" || !targetPath.startsWith("Brain/")) {
    return Object.freeze([
      err("target-outside-brain", "target", "target must be a vault-relative path under Brain/"),
    ]);
  }
  if (targetPath.includes("..") || targetPath.includes("\\") || targetPath.includes("\x00")) {
    return Object.freeze([
      err("target-traversal", "target", "target must not contain '..', backslashes, or NUL"),
    ]);
  }
  // normalize() collapses any remaining oddities; a path that changes
  // under normalization is suspicious enough to reject outright.
  if (normalize(targetPath).split(sep).join("/") !== targetPath) {
    return Object.freeze([
      err("target-traversal", "target", "target must be a normalized relative path"),
    ]);
  }
  const laneRefusal = writeSessionLaneRefusal(targetPath);
  if (laneRefusal !== null) errors.push(laneRefusal);
  if (errors.length === 0 && !targetPath.endsWith(".md")) {
    errors.push(err("target-extension", "target", "target must be a .md note"));
  }
  return Object.freeze(errors);
}

export interface ValidateArtifactOptions {
  /** Schema-pack page type the artifact must declare, if any. */
  readonly schemaType?: string | null;
  /** Resolved vocabulary; required when `schemaType` is set. */
  readonly vocabulary?: BrainSchemaVocabulary;
}

/**
 * Frontmatter keys the AUTHOR of a document put there — every key except
 * the server-derived stamps no caller supplies and no caller can remove.
 */
function authoredFrontmatterKeyCount(meta: Readonly<Record<string, unknown>>): number {
  return Object.keys(meta).filter((key) => key !== ORIGIN_CHANNEL_FIELD).length;
}

/**
 * Validate a submitted artifact body. Order matters: cheap structural
 * checks first so the error list reads top-down like a fix list.
 */
export function validateArtifact(
  artifact: string,
  options: ValidateArtifactOptions,
): ReadonlyArray<WriteSessionError> {
  const errors: WriteSessionError[] = [];
  if (typeof artifact !== "string" || artifact.trim() === "") {
    return Object.freeze([err("artifact-empty", "body", "artifact is empty")]);
  }
  if (Buffer.byteLength(artifact, "utf8") > ARTIFACT_MAX_BYTES) {
    errors.push(err("artifact-too-large", "body", `artifact exceeds ${ARTIFACT_MAX_BYTES} bytes`));
  }
  if (hasForbiddenControlChar(artifact)) {
    errors.push(err("artifact-control-chars", "body", "artifact carries raw control characters"));
  }

  if (!artifact.startsWith("---\n")) {
    errors.push(err("frontmatter-missing", "frontmatter", "artifact has no frontmatter block"));
    return Object.freeze(errors);
  }
  let meta: Readonly<Record<string, unknown>>;
  try {
    [meta] = parseFrontmatterText(artifact);
  } catch (exc) {
    errors.push(err("frontmatter-malformed", "frontmatter", (exc as Error).message));
    return Object.freeze(errors);
  }
  // "No keys" means no AUTHORED keys. The origin channel is stamped by
  // `createNote` on every note it writes (Unit C), so counting it here
  // would make this violation unreachable from the surface that produces
  // most of the documents it judges - a check that cannot fire is worse
  // than no check, because the receipt still says the lint ran.
  if (authoredFrontmatterKeyCount(meta) === 0) {
    errors.push(err("frontmatter-missing", "frontmatter", "frontmatter block has no keys"));
    return Object.freeze(errors);
  }

  const schemaType = options.schemaType?.trim();
  if (schemaType) {
    const vocab = options.vocabulary;
    if (vocab === undefined || !isKnownSchemaToken(vocab, "page_types", schemaType)) {
      errors.push(
        err(
          "schema-type-unknown",
          "type",
          `schema type '${schemaType}' is not declared in page_types`,
        ),
      );
    } else {
      const declared = typeof meta["type"] === "string" ? meta["type"].trim().toLowerCase() : "";
      if (declared !== schemaType.toLowerCase()) {
        errors.push(
          err("schema-type-mismatch", "type", `frontmatter must declare type: ${schemaType}`),
        );
      }
    }
  }
  if (
    meta["tags"] !== undefined &&
    (!Array.isArray(meta["tags"]) || !meta["tags"].every((t) => typeof t === "string"))
  ) {
    errors.push(err("tags-malformed", "tags", "tags must be an array of strings"));
  }
  return Object.freeze(errors);
}

/**
 * Compact correction prompt for the `needs-correction` envelope. One
 * line per error; the closing instruction asks for the FULL artifact
 * so a partial patch never half-lands.
 */
export function buildCorrectionPrompt(errors: ReadonlyArray<WriteSessionError>): string {
  const lines = errors.map((e) => `- [${e.code}] ${e.path}: ${e.message}`);
  return [
    "The previous submission failed validation. Fix every issue below and resubmit the full corrected artifact:",
    ...lines,
  ].join("\n");
}

/**
 * Collision metadata for an occupied target. Returns null when the
 * path is free; the engine attaches the result to envelopes so the
 * caller can decide on overwrite/merge intent with evidence in hand.
 */
export function inspectExistingTarget(
  vault: string,
  targetPath: string,
): ExistingTargetInfo | null {
  const absolute = join(vault, targetPath);
  if (!existsSync(absolute)) return null;
  let content: string;
  try {
    if (!statSync(absolute).isFile()) return null;
    content = readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
  const heading = /^#{1,6}\s+(.+)$/m.exec(content);
  return Object.freeze({
    bytes: Buffer.byteLength(content, "utf8"),
    content_hash: createHash("sha256").update(content, "utf8").digest("hex"),
    first_heading: heading?.[1]?.trim() ?? null,
  });
}
