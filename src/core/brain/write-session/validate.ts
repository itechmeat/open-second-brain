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
 * Target policy mirrors the design doc's reserved-deny list: writes
 * land inside `Brain/` but never in machine-owned or dream-owned
 * namespaces (`preferences/`, `log/`, `.sessions/`, `.payloads/`,
 * `_brain.yaml`).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";

import { parseFrontmatterText } from "../../vault.ts";
import { isKnownSchemaToken, type BrainSchemaVocabulary } from "../schema-vocab.ts";
import type { ExistingTargetInfo, WriteSessionError } from "./types.ts";

/** Hard cap on artifact size - a note, not a payload dump. */
export const ARTIFACT_MAX_BYTES = 262_144;

/** Reserved vault-relative prefixes (and exact files) sessions may never touch. */
const RESERVED_PREFIXES: ReadonlyArray<string> = Object.freeze([
  "Brain/preferences/",
  "Brain/log/",
  "Brain/.sessions/",
  "Brain/.payloads/",
]);

const RESERVED_FILES: ReadonlySet<string> = new Set(["Brain/_brain.yaml"]);

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
  if (RESERVED_FILES.has(targetPath)) {
    errors.push(err("target-reserved", "target", `${targetPath} is machine-owned`));
  }
  for (const prefix of RESERVED_PREFIXES) {
    if (targetPath.startsWith(prefix)) {
      errors.push(err("target-reserved", "target", `${prefix} is a reserved namespace`));
    }
  }
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
  if (Object.keys(meta).length === 0) {
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
