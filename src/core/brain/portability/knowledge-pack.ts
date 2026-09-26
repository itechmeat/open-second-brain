/**
 * Knowledge packs (Brain Portability & Interop suite; upstream task
 * t_d037251c): a SELECTED subset of Brain knowledge - rules, and the
 * pages that hold runbooks and conventions - exported as a portable,
 * privacy-scanned, integrity-sealed bundle; previewed before install;
 * installed as untrusted candidates stamped with their pack; removed as a
 * unit.
 *
 * ## Not a third import path
 *
 * A pack is an OKF bundle directory plus two files, and each half of its
 * content travels the path that already owns it:
 *
 *   - PAGES are an OKF subset ({@link buildOkfSubsetBundle}) and install
 *     through {@link importOkfBundle} in its untrusted review mode: staged
 *     under `OKF Review/` with `okf_review: pending`, machinery stripped,
 *     recorded paths walled. OKF is the carrier because it is the format
 *     that holds page bodies verbatim; the bank bundle carries only a page
 *     graph and contracts.
 *   - PREFERENCES are bank-bundle rows (`preferences.json`, the
 *     `collectExportRows` projection) and install through
 *     {@link restorePreferences} and so through the audited preference
 *     transaction. OKF deliberately excludes `Brain/preferences/`, and the
 *     bank rows are the one projection the restore already validates row
 *     by row. The restore's `knowledgePack` mode lands every row
 *     `unconfirmed` on a fresh trial window - never confirmed - with the
 *     source vault's evidence, counters, revision, pin and aliases cleared.
 *
 * `knowledge-pack.json` is the pack's own manifest: name, version,
 * selection, and a sha256 per file plus a digest over all of them. The
 * digest is what the provenance stamp (`knowledge_pack: <name>@<digest12>`,
 * see `pack-stamp.ts`) names, and what install refuses to proceed without.
 *
 * ## Not a schema pack
 *
 * `_brain.yaml`'s `schema:` block (and `schema_inspect view=packs`) is a
 * vocabulary pack - token definitions, not knowledge. Nothing here reads or
 * writes it; the CLI verb is `knowledge-pack` so the two never share a name.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, type Dirent } from "node:fs";
import { join, posix, relative } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { EXCLUDED_DIRS, parseFrontmatterText } from "../../vault.ts";
import type { FrontmatterMap } from "../../types.ts";
import { pageVisibility } from "../../graph/visibility.ts";
import {
  PRIVATE_REGION_PLACEHOLDER,
  REDACTION_PLACEHOLDER,
  scanRawOutput,
  stripPrivateRegions,
} from "../../redactor.ts";
import { appendContinuitySourceInvalidation } from "../continuity/store.ts";
import { topicKey } from "../dream-plan.ts";
import { collectExportRows, collectPreferenceRows, type ExportedPreferenceRow } from "../export.ts";
import type { RecoverabilityVerdict } from "../gates/recoverability.ts";
import { classifyRecoverability } from "../gates/recoverability.ts";
import {
  BRAIN_PREFERENCES_REL,
  BRAIN_ROOT_REL,
  ensureInsideVault,
  preferencePath,
  retiredPath,
} from "../paths.ts";
import { guardBrainContextSnippet } from "../safety/context-guard.ts";
import { withDestructiveSnapshot } from "../snapshot-gate.ts";
import { isoSecond } from "../time.ts";
import { BRAIN_SNAPSHOT_REASON } from "../types.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import {
  buildOkfSubsetBundle,
  collectOkfPages,
  importOkfBundle,
  OKF_MANIFEST_FILENAME,
  OKF_PRODUCER,
  OKF_REVIEW_REL,
  readOkfBundle,
  renderOkfManifest,
  stripOkfMachinery,
  type OkfBundleFile,
  type OkfImportResult,
  type OkfManifest,
  type OkfPage,
  type ParsedOkfBundle,
} from "./okf.ts";
import {
  formatKnowledgePackStamp,
  isKnowledgePackName,
  KNOWLEDGE_PACK_FIELD,
  KNOWLEDGE_PACK_SHA_FIELD,
  parseKnowledgePackStamp,
} from "./pack-stamp.ts";
import {
  restorePreferences,
  type PreferenceRestoreFailureRecord,
  type RestoredTopicKeyCollision,
} from "./preference-restore.ts";

export const KNOWLEDGE_PACK_SCHEMA = "1";
export const KNOWLEDGE_PACK_KIND = "osb-knowledge-pack";
/** Bundle-relative filename of the pack manifest. Not itself hashed: it holds the hashes. */
export const KNOWLEDGE_PACK_MANIFEST_FILENAME = "knowledge-pack.json";
/** Bundle-relative filename of the carried preference rows. */
export const KNOWLEDGE_PACK_PREFERENCES_FILENAME = "preferences.json";
/** Agent recorded on the audit line when the caller supplies none. */
export const KNOWLEDGE_PACK_DEFAULT_AGENT = "knowledge-pack";

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
/** Characters of each entry's text shown in a preview sample. */
const SAMPLE_CHARS = 240;

/** Raised for an invalid request or a bundle that is not a readable pack. */
export class KnowledgePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgePackError";
  }
}

export type KnowledgePackEntryKind = "preference" | "page";

export interface KnowledgePackIntegrity {
  readonly algorithm: "sha256";
  /** sha256 of every bundle file except the pack manifest, by bundle path. */
  readonly files: Readonly<Record<string, string>>;
  /** sha256 over the name, the version and the sorted file table. */
  readonly digest: string;
}

export interface KnowledgePackManifest {
  readonly schema: string;
  readonly kind: typeof KNOWLEDGE_PACK_KIND;
  readonly name: string;
  readonly version: string;
  readonly producer: string;
  readonly generated_at: string;
  /** The selectors the pack was exported with, as the operator typed them. */
  readonly selection: ReadonlyArray<string>;
  readonly integrity: KnowledgePackIntegrity;
}

// ----- Selection ------------------------------------------------------------

type Selector =
  | { readonly kind: "id"; readonly value: string; readonly raw: string }
  | { readonly kind: "topic"; readonly value: string; readonly raw: string }
  | { readonly kind: "tag"; readonly value: string; readonly raw: string };

/**
 * Parse `--select` values. Each value may hold several comma-separated
 * selectors: `topic:<topic>`, `tag:<tag>`, or a bare id / vault path
 * (`pref-<slug>`, a page's basename stem, or its vault-relative path).
 */
export function parseKnowledgePackSelectors(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const out: string[] = [];
  for (const value of values) {
    for (const part of value.split(",")) {
      const trimmed = part.trim();
      if (trimmed !== "" && !out.includes(trimmed)) out.push(trimmed);
    }
  }
  return out;
}

function toSelector(raw: string): Selector {
  if (raw.startsWith("topic:")) return { kind: "topic", value: raw.slice(6).trim(), raw };
  if (raw.startsWith("tag:")) {
    return { kind: "tag", value: raw.slice(4).trim().replace(/^#/, ""), raw };
  }
  return { kind: "id", value: raw, raw };
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string" && value.trim() !== "") return [value];
  return [];
}

function tagSet(tags: ReadonlyArray<string>): Set<string> {
  return new Set(tags.map((t) => t.trim().replace(/^#/, "")));
}

function prefMatches(sel: Selector, row: ExportedPreferenceRow): boolean {
  if (sel.kind === "id") return row.id === sel.value;
  if (sel.kind === "topic") return topicKey(row.topic) === topicKey(sel.value);
  return tagSet(row.tags).has(sel.value);
}

function pageMatches(sel: Selector, page: OkfPage): boolean {
  if (sel.kind === "id") {
    return page.id === sel.value || page.path === sel.value || page.path === `${sel.value}.md`;
  }
  if (sel.kind === "topic") {
    const topic = page.frontmatter["topic"];
    return typeof topic === "string" && topicKey(topic) === topicKey(sel.value);
  }
  return tagSet(stringList(page.frontmatter["tags"])).has(sel.value);
}

/** Why a selected entry was left out of the pack. */
export type KnowledgePackBlockReason =
  /** The page declares `visibility:` - it is scoped, and a pack is handed to others. */
  | "visibility"
  /** The entry carries an `owner:` claim - owner-private knowledge. */
  | "owner"
  /** The page is a staged import candidate nobody has reviewed. */
  | "unreviewed";

export interface KnowledgePackBlocked {
  readonly kind: KnowledgePackEntryKind;
  readonly id: string;
  readonly reason: KnowledgePackBlockReason;
}

/** One entry's privacy / injection findings, as closed codes. */
export interface KnowledgePackWarning {
  readonly kind: KnowledgePackEntryKind;
  readonly id: string;
  readonly reasons: ReadonlyArray<string>;
}

/** A `<private>` region was present and is replaced by the redactor's placeholder. */
export const PRIVATE_REGION_WARNING = "privacy.private_region_stripped";
/** The text still carries a redaction placeholder. */
export const REDACTED_CONTENT_WARNING = "privacy.redacted_content";
/** The text carries secret-shaped content the export scan would redact. */
export const SECRET_SHAPED_WARNING = "privacy.secret_shaped_content";

export interface KnowledgePackSelection {
  readonly selection: ReadonlyArray<string>;
  /** The OKF manifest of the selected pages (no change log). */
  readonly okfManifest: OkfManifest;
  /** The selected page files, without `okf.json` (rendered at seal time). */
  readonly pageFiles: ReadonlyArray<OkfBundleFile>;
  readonly preferences: ReadonlyArray<ExportedPreferenceRow>;
  /** Entries a selector matched but the privacy rules kept out. Never written. */
  readonly blocked: ReadonlyArray<KnowledgePackBlocked>;
  readonly warnings: ReadonlyArray<KnowledgePackWarning>;
}

function injectionCodes(text: string, id: string): string[] {
  const guarded = guardBrainContextSnippet(text, { source: { id } });
  return guarded.filtered ? guarded.reasons.map((reason) => reason.code) : [];
}

function exportWarnings(text: string, id: string): string[] {
  const codes = injectionCodes(text, id);
  if (stripPrivateRegions(text) !== text) codes.push(PRIVATE_REGION_WARNING);
  return [...new Set(codes)].toSorted();
}

/**
 * Resolve the selectors against the vault and gather what a pack would
 * carry. Read-only. Throws {@link KnowledgePackError} for an empty
 * selection or for any selector that matched nothing - a pack is a
 * deliberate subset, and a selector that silently selects nothing is an
 * operator error the export must not paper over.
 *
 * Private content is blocked, not redacted: a page with `visibility:`,
 * an entry with `owner:`, and an unreviewed `OKF Review/` candidate are
 * left out and named in `blocked`. `<private>` regions inside a carried
 * entry are left for the egress scan (which replaces them) and named in
 * `warnings`. Carried preference rows drop the source vault's evidence
 * links and rendered body; carried pages drop this vault's machinery
 * frontmatter.
 */
export function selectKnowledgePack(
  vault: string,
  selectors: ReadonlyArray<string>,
): KnowledgePackSelection {
  const selection = parseKnowledgePackSelectors(selectors);
  if (selection.length === 0) {
    throw new KnowledgePackError(
      "a knowledge pack needs at least one selector (--select <id|topic:T|tag:T>)",
    );
  }
  const parsed = selection.map(toSelector);
  for (const sel of parsed) {
    if (sel.value === "") throw new KnowledgePackError(`empty selector: ${sel.raw}`);
  }

  const matched = new Set<string>();
  const blocked: KnowledgePackBlocked[] = [];
  const warnings: KnowledgePackWarning[] = [];

  const preferences: ExportedPreferenceRow[] = [];
  for (const row of collectExportRows(vault)) {
    const hits = parsed.filter((sel) => prefMatches(sel, row));
    if (hits.length === 0) continue;
    for (const sel of hits) matched.add(sel.raw);
    if (preferenceOwner(vault, row.id) !== null) {
      blocked.push({ kind: "preference", id: row.id, reason: "owner" });
      continue;
    }
    const codes = exportWarnings(row.principle, row.id);
    if (codes.length > 0) warnings.push({ kind: "preference", id: row.id, reasons: codes });
    preferences.push({ ...row, evidenced_by: [], body: "" });
  }

  const pages: OkfPage[] = [];
  for (const page of collectOkfPages(vault)) {
    const hits = parsed.filter((sel) => pageMatches(sel, page));
    if (hits.length === 0) continue;
    for (const sel of hits) matched.add(sel.raw);
    const reason = pageBlockReason(page);
    if (reason !== null) {
      blocked.push({ kind: "page", id: page.path, reason });
      continue;
    }
    const codes = exportWarnings(page.body, page.path);
    if (codes.length > 0) warnings.push({ kind: "page", id: page.path, reasons: codes });
    pages.push({ ...page, frontmatter: stripOkfMachinery(page.frontmatter) });
  }

  const unmatched = selection.filter((raw) => !matched.has(raw));
  if (unmatched.length > 0) {
    throw new KnowledgePackError(`selector(s) matched nothing: ${unmatched.join(", ")}`);
  }
  if (preferences.length === 0 && pages.length === 0) {
    throw new KnowledgePackError(
      "every selected entry was blocked as private; nothing is left to pack",
    );
  }

  const okf = buildOkfSubsetBundle(vault, pages);
  return {
    selection,
    okfManifest: okf.manifest,
    pageFiles: okf.files.filter((file) => file.path !== OKF_MANIFEST_FILENAME),
    preferences,
    blocked,
    warnings,
  };
}

function preferenceOwner(vault: string, id: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(vault, BRAIN_PREFERENCES_REL, `${id}.md`), "utf8");
  } catch {
    return null;
  }
  const owner = parseFrontmatterText(text)[0]["owner"];
  return typeof owner === "string" && owner.trim() !== "" ? owner : null;
}

function pageBlockReason(page: OkfPage): KnowledgePackBlockReason | null {
  if (pageVisibility(page.frontmatter).length > 0) return "visibility";
  const owner = page.frontmatter["owner"];
  if (typeof owner === "string" && owner.trim() !== "") return "owner";
  if (page.frontmatter["okf_review"] !== undefined) return "unreviewed";
  if (page.path === OKF_REVIEW_REL || page.path.startsWith(`${OKF_REVIEW_REL}/`)) {
    return "unreviewed";
  }
  return null;
}

// ----- Seal -----------------------------------------------------------------

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The pack digest: one sha256 over a canonical text naming the schema, the
 * pack name and version, and every file's own hash in path order. Binding
 * the name and version in means a pack cannot be renamed into another
 * pack's uninstall key without its stamp changing too.
 */
function packDigest(
  name: string,
  version: string,
  files: Readonly<Record<string, string>>,
): string {
  const lines = [
    `${KNOWLEDGE_PACK_KIND}/${KNOWLEDGE_PACK_SCHEMA}`,
    `name=${name}`,
    `version=${version}`,
  ];
  for (const path of Object.keys(files).toSorted()) lines.push(`${path}\t${files[path]}`);
  return sha256(`${lines.join("\n")}\n`);
}

function validateNameAndVersion(name: string, version: string): void {
  if (!isKnowledgePackName(name)) {
    throw new KnowledgePackError(
      `invalid pack name ${JSON.stringify(name)}: use 1-64 of [a-z0-9._-], starting with a letter or digit`,
    );
  }
  if (!VERSION_RE.test(version)) {
    throw new KnowledgePackError(
      `invalid pack version ${JSON.stringify(version)}: use 1-32 of [0-9A-Za-z._+-]`,
    );
  }
}

export interface SealKnowledgePackInput {
  readonly name: string;
  readonly version: string;
  readonly selection: ReadonlyArray<string>;
  readonly okfManifest: OkfManifest;
  readonly pageFiles: ReadonlyArray<OkfBundleFile>;
  readonly preferences: ReadonlyArray<ExportedPreferenceRow>;
  readonly now?: Date;
}

export interface SealedKnowledgePack {
  readonly manifest: KnowledgePackManifest;
  /** Every file to write, including both manifests, sorted by path. */
  readonly files: ReadonlyArray<OkfBundleFile>;
}

/**
 * Render the final bundle from ALREADY-REDACTED content and seal it: the
 * hashes are taken over the exact bytes written, so what the recipient
 * verifies is what left the vault.
 */
export function sealKnowledgePack(input: SealKnowledgePackInput): SealedKnowledgePack {
  validateNameAndVersion(input.name, input.version);
  const content: OkfBundleFile[] = [
    { path: OKF_MANIFEST_FILENAME, contents: renderOkfManifest(input.okfManifest) },
    ...input.pageFiles,
  ];
  if (input.preferences.length > 0) {
    content.push({
      path: KNOWLEDGE_PACK_PREFERENCES_FILENAME,
      contents:
        JSON.stringify({ schema: KNOWLEDGE_PACK_SCHEMA, preferences: input.preferences }, null, 2) +
        "\n",
    });
  }
  const hashes: Record<string, string> = {};
  for (const file of content) hashes[file.path] = sha256(file.contents);
  const sortedHashes: Record<string, string> = {};
  for (const path of Object.keys(hashes).toSorted()) sortedHashes[path] = hashes[path]!;
  const manifest: KnowledgePackManifest = {
    schema: KNOWLEDGE_PACK_SCHEMA,
    kind: KNOWLEDGE_PACK_KIND,
    name: input.name,
    version: input.version,
    producer: OKF_PRODUCER,
    generated_at: isoSecond(input.now ?? new Date()),
    selection: [...input.selection],
    integrity: {
      algorithm: "sha256",
      files: sortedHashes,
      digest: packDigest(input.name, input.version, sortedHashes),
    },
  };
  const files = [
    ...content,
    {
      path: KNOWLEDGE_PACK_MANIFEST_FILENAME,
      contents: JSON.stringify(manifest, null, 2) + "\n",
    },
  ].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { manifest, files };
}

// ----- Read + verify --------------------------------------------------------

export interface KnowledgePackVerification {
  /** True only when every listed file is present, unmodified, and nothing else is. */
  readonly verified: boolean;
  /** Digest the manifest declares. */
  readonly declared: string;
  /** Digest recomputed from the files on disk. */
  readonly computed: string;
  /** One line per failed check; empty when verified. */
  readonly problems: ReadonlyArray<string>;
}

export interface ReadKnowledgePack {
  readonly manifest: KnowledgePackManifest;
  readonly integrity: KnowledgePackVerification;
  /** The OKF half, parsed by the OKF reader. */
  readonly okf: ParsedOkfBundle;
  /** The carried preference rows, unvalidated (the restore guards each one). */
  readonly preferences: ReadonlyArray<unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseManifest(raw: unknown): KnowledgePackManifest {
  const m = asRecord(raw);
  if (m === null)
    throw new KnowledgePackError(`${KNOWLEDGE_PACK_MANIFEST_FILENAME} must be a JSON object`);
  if (m["kind"] !== KNOWLEDGE_PACK_KIND) {
    throw new KnowledgePackError(`not a knowledge pack: kind is ${JSON.stringify(m["kind"])}`);
  }
  if (m["schema"] !== KNOWLEDGE_PACK_SCHEMA) {
    throw new KnowledgePackError(
      `unsupported knowledge-pack schema: expected ${KNOWLEDGE_PACK_SCHEMA}, got ${String(m["schema"])}`,
    );
  }
  const name = typeof m["name"] === "string" ? m["name"] : "";
  const version = typeof m["version"] === "string" ? m["version"] : "";
  validateNameAndVersion(name, version);
  const integrity = asRecord(m["integrity"]);
  const fileTable = asRecord(integrity?.["files"]);
  const digest = integrity?.["digest"];
  if (
    integrity === null ||
    integrity["algorithm"] !== "sha256" ||
    fileTable === null ||
    typeof digest !== "string" ||
    !HEX64_RE.test(digest)
  ) {
    throw new KnowledgePackError("knowledge-pack manifest has no usable sha256 integrity block");
  }
  const files: Record<string, string> = {};
  for (const [path, hash] of Object.entries(fileTable)) {
    if (typeof hash !== "string" || !HEX64_RE.test(hash)) {
      throw new KnowledgePackError(`integrity entry for ${path} is not a sha256 hex digest`);
    }
    files[path] = hash;
  }
  return {
    schema: KNOWLEDGE_PACK_SCHEMA,
    kind: KNOWLEDGE_PACK_KIND,
    name,
    version,
    producer: typeof m["producer"] === "string" ? m["producer"] : "unknown",
    generated_at: typeof m["generated_at"] === "string" ? m["generated_at"] : "",
    selection: stringList(m["selection"]),
    integrity: { algorithm: "sha256", files, digest },
  };
}

/** Every regular file under `dir`, bundle-relative POSIX; symlinks reported. */
function listBundleFiles(dir: string, problems: string[]): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(abs, entry.name);
      const rel = relative(dir, child).split(/[\\/]/).join(posix.sep);
      if (entry.isSymbolicLink()) {
        problems.push(`symbolic link in bundle: ${rel}`);
        continue;
      }
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(dir);
  return out.toSorted();
}

/**
 * Read a pack directory and verify it against its own manifest. A missing
 * or structurally invalid `knowledge-pack.json` throws
 * {@link KnowledgePackError} (this is not a pack at all). An integrity
 * failure does NOT throw: preview reports it, install refuses on it.
 */
export function readKnowledgePack(dir: string): ReadKnowledgePack {
  const manifestPath = join(dir, KNOWLEDGE_PACK_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new KnowledgePackError(`not a knowledge pack: ${manifestPath} is missing`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (exc) {
    throw new KnowledgePackError(
      `${KNOWLEDGE_PACK_MANIFEST_FILENAME} is not valid JSON: ${(exc as Error).message}`,
    );
  }
  const manifest = parseManifest(raw);

  const problems: string[] = [];
  const listed = manifest.integrity.files;
  const computedFiles: Record<string, string> = {};
  for (const [path, expected] of Object.entries(listed)) {
    let abs: string;
    try {
      abs = ensureInsideVault(join(dir, path), dir);
    } catch {
      problems.push(`listed path escapes the bundle: ${path}`);
      continue;
    }
    let bytes: string;
    try {
      if (lstatSync(abs).isSymbolicLink()) {
        problems.push(`symbolic link in bundle: ${path}`);
        continue;
      }
      bytes = readFileSync(abs, "utf8");
    } catch {
      problems.push(`listed file is missing: ${path}`);
      continue;
    }
    const actual = sha256(bytes);
    computedFiles[path] = actual;
    if (actual !== expected) problems.push(`file content does not match its hash: ${path}`);
  }
  for (const path of listBundleFiles(dir, problems)) {
    if (path === KNOWLEDGE_PACK_MANIFEST_FILENAME) continue;
    if (!(path in listed)) problems.push(`file not covered by the integrity table: ${path}`);
  }
  if (!(OKF_MANIFEST_FILENAME in listed)) {
    problems.push(`integrity table does not cover ${OKF_MANIFEST_FILENAME}`);
  }
  const computed = packDigest(manifest.name, manifest.version, computedFiles);
  if (manifest.integrity.digest !== packDigest(manifest.name, manifest.version, listed)) {
    problems.push("declared digest does not match the declared file table");
  }

  let okf: ParsedOkfBundle;
  try {
    okf = readOkfBundle(dir);
  } catch (exc) {
    throw new KnowledgePackError(
      `knowledge pack's OKF half is unreadable: ${(exc as Error).message}`,
    );
  }
  if (okf.pages.length !== okf.manifest.pages.length) {
    problems.push(
      `okf.json lists ${okf.manifest.pages.length} page(s) but ${okf.pages.length} could be read`,
    );
  }

  let preferences: ReadonlyArray<unknown> = [];
  const prefsPath = join(dir, KNOWLEDGE_PACK_PREFERENCES_FILENAME);
  if (existsSync(prefsPath)) {
    try {
      const doc = asRecord(JSON.parse(readFileSync(prefsPath, "utf8")));
      const rows = doc?.["preferences"];
      if (!Array.isArray(rows)) throw new Error("no preferences array");
      preferences = rows;
    } catch (exc) {
      problems.push(
        `${KNOWLEDGE_PACK_PREFERENCES_FILENAME} is unreadable: ${(exc as Error).message}`,
      );
    }
  }

  return {
    manifest,
    integrity: {
      verified: problems.length === 0,
      declared: manifest.integrity.digest,
      computed,
      problems,
    },
    okf,
    preferences,
  };
}

// ----- Preview --------------------------------------------------------------

export interface KnowledgePackPreviewEntry {
  readonly kind: KnowledgePackEntryKind;
  readonly id: string;
  readonly topic: string | null;
  /** Page: the recorded vault path. Preference: null. */
  readonly path: string | null;
  /** Preference: the status it carried in the SOURCE vault (it lands `unconfirmed`). */
  readonly status: string | null;
  /** Vault-relative path the entry would be written to. */
  readonly target: string;
  /** Up to 240 chars, passed through the prompt-injection guard. */
  readonly sample: string;
}

export type KnowledgePackConflictReason =
  /** A preference with this id already exists; install skips it. */
  | "id_exists"
  /** A preference with this slug was retired here; install skips it. */
  | "previously_retired"
  /** A different local preference already claims this topic key. */
  | "topic_claimed"
  /** The review-lane target already exists; install skips it. */
  | "review_target_exists"
  /** A live page already sits at the recorded path (promotion would collide). */
  | "path_exists";

export interface KnowledgePackConflict {
  readonly kind: KnowledgePackEntryKind;
  readonly id: string;
  readonly reason: KnowledgePackConflictReason;
  readonly detail: string;
}

export interface KnowledgePackPreview {
  readonly schema: 1;
  readonly name: string;
  readonly version: string;
  readonly generated_at: string;
  readonly selection: ReadonlyArray<string>;
  /** The provenance stamp an install would write. */
  readonly stamp: string;
  readonly count: number;
  readonly counts: { readonly preferences: number; readonly pages: number };
  readonly entries: ReadonlyArray<KnowledgePackPreviewEntry>;
  readonly integrity: KnowledgePackVerification;
  readonly conflicts: ReadonlyArray<KnowledgePackConflict>;
  readonly privacyWarnings: ReadonlyArray<KnowledgePackWarning>;
}

function previewWarnings(text: string, id: string): string[] {
  const codes = injectionCodes(text, id);
  if (text.includes(REDACTION_PLACEHOLDER) || text.includes(PRIVATE_REGION_PLACEHOLDER)) {
    codes.push(REDACTED_CONTENT_WARNING);
  }
  if (scanRawOutput(text, { redactTokens: true, redactUrlCredentials: true }).text !== text) {
    // The scan also rewrites `<private>` regions; either way the content
    // is something the export boundary would not have let out verbatim.
    codes.push(SECRET_SHAPED_WARNING);
  }
  return [...new Set(codes)].toSorted();
}

function rowText(row: unknown): {
  id: string;
  topic: string | null;
  status: string | null;
  text: string;
} {
  const r = asRecord(row) ?? {};
  const id = typeof r["id"] === "string" ? r["id"] : "(no id)";
  const topic = typeof r["topic"] === "string" ? r["topic"] : null;
  const status = typeof r["status"] === "string" ? r["status"] : null;
  const principle = typeof r["principle"] === "string" ? r["principle"] : "";
  const body = typeof r["body"] === "string" ? r["body"] : "";
  return { id, topic, status, text: body === "" ? principle : `${principle}\n${body}` };
}

function slugOf(id: string): string | null {
  return id.startsWith("pref-") && id.length > 5 ? id.slice(5) : null;
}

function safePreferencePath(vault: string, slug: string): string | null {
  try {
    return preferencePath(vault, slug);
  } catch {
    return null;
  }
}

function safeRetiredPath(vault: string, slug: string): string | null {
  try {
    return retiredPath(vault, slug);
  } catch {
    return null;
  }
}

function preferenceConflicts(vault: string, id: string): KnowledgePackConflict[] {
  const slug = slugOf(id);
  if (slug === null) return [];
  const live = safePreferencePath(vault, slug);
  if (live !== null && existsSync(live)) {
    return [{ kind: "preference", id, reason: "id_exists", detail: `Brain/preferences/${id}.md` }];
  }
  const retired = safeRetiredPath(vault, slug);
  if (retired !== null && existsSync(retired)) {
    return [
      {
        kind: "preference",
        id,
        reason: "previously_retired",
        detail: `Brain/retired/ret-${slug}.md`,
      },
    ];
  }
  return [];
}

/**
 * What installing `pack` into `vault` would do, without writing anything:
 * the manifest facts, every entry with a guarded sample and its landing
 * path, the integrity verdict, conflicts with what the vault already holds,
 * and privacy / prompt-injection warnings.
 */
export function previewKnowledgePack(vault: string, pack: ReadKnowledgePack): KnowledgePackPreview {
  const entries: KnowledgePackPreviewEntry[] = [];
  const conflicts: KnowledgePackConflict[] = [];
  const warnings: KnowledgePackWarning[] = [];

  const localTopics = new Map<string, string[]>();
  for (const row of collectPreferenceRows(vault).rows) {
    const key = topicKey(row.topic);
    localTopics.set(key, [...(localTopics.get(key) ?? []), row.id]);
  }

  for (const row of pack.preferences) {
    const { id, topic, status, text } = rowText(row);
    const guarded = guardBrainContextSnippet(text, { source: { id } });
    entries.push({
      kind: "preference",
      id,
      topic,
      path: null,
      status,
      target: `${BRAIN_PREFERENCES_REL}/${id}.md`,
      sample: guarded.safeText.slice(0, SAMPLE_CHARS),
    });
    conflicts.push(...preferenceConflicts(vault, id));
    if (topic !== null) {
      const claimants = (localTopics.get(topicKey(topic)) ?? []).filter((other) => other !== id);
      if (claimants.length > 0) {
        conflicts.push({
          kind: "preference",
          id,
          reason: "topic_claimed",
          detail: claimants.toSorted().join(", "),
        });
      }
    }
    const codes = previewWarnings(text, id);
    if (codes.length > 0) warnings.push({ kind: "preference", id, reasons: codes });
  }

  for (const page of pack.okf.pages) {
    const path = page.entry.path;
    const target = posix.join(OKF_REVIEW_REL, path);
    const guarded = guardBrainContextSnippet(page.body, { source: { id: path } });
    const topic = page.frontmatter["topic"];
    entries.push({
      kind: "page",
      id: page.entry.id,
      topic: typeof topic === "string" ? topic : null,
      path,
      status: null,
      target,
      sample: guarded.safeText.slice(0, SAMPLE_CHARS),
    });
    if (vaultFileExists(vault, target)) {
      conflicts.push({ kind: "page", id: path, reason: "review_target_exists", detail: target });
    }
    if (vaultFileExists(vault, path)) {
      conflicts.push({ kind: "page", id: path, reason: "path_exists", detail: path });
    }
    const codes = previewWarnings(page.body, path);
    if (codes.length > 0) warnings.push({ kind: "page", id: path, reasons: codes });
  }

  const prefCount = pack.preferences.length;
  return {
    schema: 1,
    name: pack.manifest.name,
    version: pack.manifest.version,
    generated_at: pack.manifest.generated_at,
    selection: pack.manifest.selection,
    stamp: formatKnowledgePackStamp(pack.manifest.name, pack.manifest.integrity.digest),
    count: entries.length,
    counts: { preferences: prefCount, pages: entries.length - prefCount },
    entries,
    integrity: pack.integrity,
    conflicts,
    privacyWarnings: warnings,
  };
}

function vaultFileExists(vault: string, rel: string): boolean {
  try {
    return existsSync(ensureInsideVault(join(vault, rel), vault));
  } catch {
    return false;
  }
}

// ----- Install --------------------------------------------------------------

export interface KnowledgePackInstallResult {
  readonly name: string;
  readonly version: string;
  readonly stamp: string;
  readonly preferences: {
    readonly carried: number;
    /** Ids written, each `unconfirmed` on a fresh trial window. */
    readonly installed: ReadonlyArray<string>;
    /** Rows skipped because the vault already holds (or retired) the id. */
    readonly conflicts: ReadonlyArray<KnowledgePackConflict>;
    /** Rows the audited restore refused, with its reason. */
    readonly failed: ReadonlyArray<PreferenceRestoreFailureRecord>;
    readonly topicKeyCollisions: ReadonlyArray<RestoredTopicKeyCollision>;
  };
  readonly pages: Pick<OkfImportResult, "written" | "skipped" | "errors">;
  readonly privacyWarnings: ReadonlyArray<KnowledgePackWarning>;
}

export interface InstallKnowledgePackOptions {
  readonly agent?: string;
  readonly now?: Date;
}

/**
 * Install a verified pack. Refuses (throws {@link KnowledgePackError})
 * when the integrity check failed - a pack whose bytes differ from what
 * its author sealed is not installed in part.
 *
 * Nothing lands trusted. Pages go to the OKF review lane with machinery
 * stripped; preferences land `unconfirmed` on a fresh trial window with the
 * source vault's lifecycle cleared. Both are stamped `knowledge_pack:
 * <name>@<digest12>` by this installer. A preference whose id the vault
 * already holds, or once retired, is skipped and reported - an install
 * never overwrites a local rule or resurrects a rejected one.
 */
export function installKnowledgePack(
  vault: string,
  pack: ReadKnowledgePack,
  opts: InstallKnowledgePackOptions = {},
): KnowledgePackInstallResult {
  if (!pack.integrity.verified) {
    throw new KnowledgePackError(
      `refusing to install ${pack.manifest.name}: integrity check failed (${pack.integrity.problems.join("; ")})`,
    );
  }
  assertVaultIdentityForWrite(vault);
  const now = opts.now ?? new Date();
  const stamp = formatKnowledgePackStamp(pack.manifest.name, pack.manifest.integrity.digest);
  const preview = previewKnowledgePack(vault, pack);

  const conflicts: KnowledgePackConflict[] = [];
  const rows: unknown[] = [];
  for (const row of pack.preferences) {
    const found = preferenceConflicts(vault, rowText(row).id);
    if (found.length > 0) conflicts.push(...found);
    else rows.push(row);
  }
  const restored = restorePreferences(vault, rows, {
    agent: opts.agent?.trim() ? opts.agent.trim() : KNOWLEDGE_PACK_DEFAULT_AGENT,
    knowledgePack: stamp,
    now: () => now,
  });

  const pages = importOkfBundle(vault, pack.okf, {
    trusted: false,
    now,
    provenance: { [KNOWLEDGE_PACK_FIELD]: stamp },
  });
  for (const rel of pages.written) recordStagedFingerprint(join(vault, rel));

  return {
    name: pack.manifest.name,
    version: pack.manifest.version,
    stamp,
    preferences: {
      carried: pack.preferences.length,
      installed: restored.restored,
      conflicts,
      failed: restored.failed,
      topicKeyCollisions: restored.topicKeyCollisions,
    },
    pages: { written: pages.written, skipped: pages.skipped, errors: pages.errors },
    privacyWarnings: preview.privacyWarnings,
  };
}

// ----- Staged-page fingerprint ----------------------------------------------

/** JSON with object keys sorted at every level, so key order is not content. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .toSorted()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * What an operator edit changes on a staged page: its body and every
 * frontmatter key except this system's machinery (the review flag, the
 * pack stamp and fingerprint, lifecycle and write-accounting keys).
 * Trailing whitespace of the body does not count.
 */
function stagedPageFingerprint(text: string): string {
  const [meta, body] = parseFrontmatterText(text);
  const authored = canonicalJson(stripOkfMachinery(meta));
  return sha256(`${authored}\n---\n${body.replace(/\s+$/u, "")}`);
}

/**
 * Write the fingerprint of a page the installer just staged into its
 * frontmatter, as one line after the stamp. Inserted as text rather than
 * re-serialised, so nothing the fingerprint covers changes on the way.
 */
function recordStagedFingerprint(abs: string): void {
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return;
  }
  const stampLine = new RegExp(`^${KNOWLEDGE_PACK_FIELD}:.*$`, "mu");
  const match = stampLine.exec(text);
  if (match === null) return;
  const at = match.index + match[0].length;
  const line = `\n${KNOWLEDGE_PACK_SHA_FIELD}: ${stagedPageFingerprint(text)}`;
  atomicWriteFileSync(abs, `${text.slice(0, at)}${line}${text.slice(at)}`);
}

/**
 * Has the operator changed a staged page since install? A page without a
 * recorded fingerprint counts as changed: nothing proves it is untouched,
 * and keeping a page is the recoverable side of the choice.
 */
function stagedPageEdited(text: string, meta: FrontmatterMap): boolean {
  const recorded = meta[KNOWLEDGE_PACK_SHA_FIELD];
  if (typeof recorded !== "string" || !HEX64_RE.test(recorded.trim())) return true;
  return stagedPageFingerprint(text) !== recorded.trim();
}

// ----- Installed entries: list + uninstall ----------------------------------

export interface KnowledgePackInstalledEntry {
  readonly kind: KnowledgePackEntryKind;
  readonly id: string;
  /** Vault-relative POSIX path. */
  readonly path: string;
  /** The full stamp (`<name>@<digest12>`). */
  readonly stamp: string;
  /**
   * Page: `staged` while under `OKF Review/`, `promoted` once moved out of
   * it. Preference: its current lifecycle status.
   */
  readonly state: string;
  /** Preference only: evidence links it has gained in THIS vault. */
  readonly localEvidence: number;
  /**
   * Staged page only: its content differs from what the installer wrote
   * (or no install fingerprint is recorded). Always false otherwise.
   */
  readonly edited: boolean;
}

function evidenceLinks(meta: FrontmatterMap): string[] {
  const managed = stringList(meta["_evidenced_by"]);
  return managed.length > 0 ? managed : stringList(meta["evidenced_by"]);
}

function readStamped(abs: string): { meta: FrontmatterMap; stamp: string; text: string } | null {
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  if (!text.includes(KNOWLEDGE_PACK_FIELD)) return null;
  const meta = parseFrontmatterText(text)[0];
  const stamp = parseKnowledgePackStamp(meta[KNOWLEDGE_PACK_FIELD]);
  return stamp === null ? null : { meta, stamp: `${stamp.name}@${stamp.digest}`, text };
}

function toPosix(p: string): string {
  return p.split(/[\\/]/).join(posix.sep);
}

/** Every entry in the vault carrying a knowledge-pack stamp. Read-only. */
function scanInstalled(vault: string): KnowledgePackInstalledEntry[] {
  const out: KnowledgePackInstalledEntry[] = [];
  const prefDir = join(vault, BRAIN_PREFERENCES_REL);
  let names: string[] = [];
  try {
    names = readdirSync(prefDir);
  } catch {
    names = [];
  }
  for (const name of names.toSorted()) {
    if (!name.startsWith("pref-") || !name.endsWith(".md")) continue;
    const found = readStamped(join(prefDir, name));
    if (found === null) continue;
    const status = found.meta["_status"] ?? found.meta["status"];
    out.push({
      kind: "preference",
      id: name.slice(0, -3),
      path: `${BRAIN_PREFERENCES_REL}/${name}`,
      stamp: found.stamp,
      state: typeof status === "string" ? status : "unknown",
      localEvidence: evidenceLinks(found.meta).length,
      edited: false,
    });
  }

  // Pages: everything outside Brain/ - the review lane and wherever an
  // operator promoted a candidate to.
  const skip = new Set<string>(EXCLUDED_DIRS);
  const walk = (dir: string, top: boolean): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name) || (top && entry.name === BRAIN_ROOT_REL)) continue;
        walk(abs, false);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const found = readStamped(abs);
      if (found === null) continue;
      const rel = toPosix(relative(vault, abs));
      const staged = rel.startsWith(`${OKF_REVIEW_REL}/`);
      out.push({
        kind: "page",
        id: rel,
        path: rel,
        stamp: found.stamp,
        state: staged ? "staged" : "promoted",
        localEvidence: 0,
        edited: staged && stagedPageEdited(found.text, found.meta),
      });
    }
  };
  walk(vault, true);
  return out;
}

export interface InstalledKnowledgePack {
  readonly name: string;
  /** Distinct stamps (builds) of this pack present in the vault. */
  readonly stamps: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<KnowledgePackInstalledEntry>;
}

/** The packs installed in `vault`, by name, with every stamped entry. Read-only. */
export function listInstalledKnowledgePacks(vault: string): ReadonlyArray<InstalledKnowledgePack> {
  const byName = new Map<string, KnowledgePackInstalledEntry[]>();
  for (const entry of scanInstalled(vault)) {
    const name = entry.stamp.slice(0, entry.stamp.lastIndexOf("@"));
    byName.set(name, [...(byName.get(name) ?? []), entry]);
  }
  return [...byName.keys()].toSorted().map((name) => {
    const entries = byName.get(name)!;
    return {
      name,
      stamps: [...new Set(entries.map((e) => e.stamp))].toSorted(),
      entries,
    };
  });
}

export type KnowledgePackKeptReason =
  /** The preference gained evidence links in this vault; it is no longer only the pack's. */
  | "local_evidence"
  /** The page was promoted out of the review lane by an operator. */
  | "promoted"
  /** The page is still staged, but its content changed since install. */
  | "edited";

export interface KnowledgePackUninstallPlan {
  readonly name: string;
  readonly confirmed: boolean;
  /** Entries removed (or, on a dry run, that would be). */
  readonly remove: ReadonlyArray<KnowledgePackInstalledEntry>;
  /** Stamped entries reported but left in place, with why. */
  readonly kept: ReadonlyArray<{
    readonly entry: KnowledgePackInstalledEntry;
    readonly reason: KnowledgePackKeptReason;
  }>;
  /** Paths actually removed this run (empty on a dry run). */
  readonly deleted: ReadonlyArray<string>;
  readonly snapshotRunId: string | null;
  readonly snapshotPath: string | null;
  /** What the recovery point is worth: staged pages live outside `Brain/`. */
  readonly recoverability: RecoverabilityVerdict;
  readonly auditRecordId: string | null;
}

export interface UninstallKnowledgePackOptions {
  /** Required true to delete; absent = dry run. */
  readonly confirm?: boolean;
  readonly now?: Date;
  readonly agent?: string;
}

/**
 * Remove the entries one pack installed - every build of it, since the
 * name is the unit. DRY-RUN BY DEFAULT, like `forget-source`.
 *
 * Removed: stamped preferences carrying no evidence links, and stamped
 * pages still staged under `OKF Review/`. Kept and reported: a preference
 * that has gained evidence in this vault (the same "a shared fold is
 * reported, never deleted" line `forget-source` draws for foreign
 * evidence), a page an operator promoted out of the review lane, and a
 * staged page whose content changed since install (its body or authored
 * frontmatter no longer match the fingerprint the installer recorded).
 * The destructive snapshot archives `Brain/` only, so a staged page is
 * deleted only when its content is what re-installing the pack restores.
 * A confirmed run removes behind the destructive-snapshot gate and
 * records a `source_invalidation` continuity record naming `pack:<name>`.
 */
export function uninstallKnowledgePack(
  vault: string,
  name: string,
  opts: UninstallKnowledgePackOptions = {},
): KnowledgePackUninstallPlan {
  if (!isKnowledgePackName(name)) {
    throw new KnowledgePackError(`invalid pack name ${JSON.stringify(name)}`);
  }
  const confirm = opts.confirm === true;
  if (confirm) assertVaultIdentityForWrite(vault);

  const remove: KnowledgePackInstalledEntry[] = [];
  const kept: { entry: KnowledgePackInstalledEntry; reason: KnowledgePackKeptReason }[] = [];
  for (const entry of scanInstalled(vault)) {
    if (entry.stamp.slice(0, entry.stamp.lastIndexOf("@")) !== name) continue;
    if (entry.kind === "preference" && entry.localEvidence > 0) {
      kept.push({ entry, reason: "local_evidence" });
    } else if (entry.kind === "page" && entry.state === "promoted") {
      kept.push({ entry, reason: "promoted" });
    } else if (entry.kind === "page" && entry.edited) {
      kept.push({ entry, reason: "edited" });
    } else {
      remove.push(entry);
    }
  }

  const blastRadius = {
    brainTopLevel: remove.some((e) => e.kind === "preference"),
    outsideBrainRoot: remove.some((e) => e.kind === "page"),
  };
  const base = { name, remove, kept };
  if (!confirm || remove.length === 0) {
    return {
      ...base,
      confirmed: confirm,
      deleted: [],
      snapshotRunId: null,
      snapshotPath: null,
      recoverability: classifyRecoverability({ recoveryPoint: false, blastRadius: {} }),
      auditRecordId: null,
    };
  }

  const deleted: string[] = [];
  const gated = withDestructiveSnapshot(
    vault,
    BRAIN_SNAPSHOT_REASON.knowledgePackUninstall,
    () => {
      for (const entry of remove) {
        const abs = ensureInsideVault(join(vault, entry.path), vault);
        rmSync(abs, { force: true });
        deleted.push(entry.path);
      }
    },
    { ...(opts.now !== undefined ? { now: opts.now } : {}), blastRadius },
  );
  const agent = opts.agent?.trim() ? opts.agent.trim() : KNOWLEDGE_PACK_DEFAULT_AGENT;
  const record = appendContinuitySourceInvalidation(vault, {
    createdAt: isoSecond(opts.now ?? new Date()),
    source: { id: `pack:${name}`, path: `pack:${name}`, kind: "knowledge-pack" },
    reason: `${agent}: uninstalled ${deleted.length} knowledge-pack entr${deleted.length === 1 ? "y" : "ies"}`,
  });
  return {
    ...base,
    confirmed: true,
    deleted,
    snapshotRunId: gated.snapshot.runId,
    snapshotPath: gated.snapshot.path,
    recoverability: gated.recoverability,
    auditRecordId: record.id,
  };
}
