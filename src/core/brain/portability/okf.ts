/**
 * Open Knowledge Format (OKF) export / import round-trip
 * (Brain Portability & Interop suite, Unit C).
 *
 * OKF is a portable, producer-agnostic *directory* bundle for knowledge
 * interchange between wiki / second-brain systems. Where the bank bundle
 * ({@link ./bundle.ts}) is a single JSON envelope tuned for OSB-to-OSB
 * migration, an OKF bundle is a tree of plain markdown a foreign tool can
 * read without knowing OSB internals:
 *
 *   <bundle>/
 *     okf.json            machine-readable manifest (schema, producer,
 *                         per-page derived fields + preserved foreign
 *                         provenance)
 *     index.md            human-readable index, grouped by page class
 *     concepts/<slug>.md  regular knowledge pages (the default class)
 *     queries/<slug>.md   saved-question / research-report pages
 *     references/<slug>.md cited external-source pages
 *     log.md              date-grouped change log (from Brain/log/)
 *
 * Page class is derived *structurally* from the frontmatter `kind:`
 * field — never from natural-language heuristics — so the split is
 * deterministic and language-agnostic. Each bundle page file carries the
 * page's frontmatter and body **verbatim**, so a re-import is lossless;
 * the manifest carries the *derived* standard fields (kind, citations,
 * freshness) computed from current page state.
 *
 * Re-export honesty: when OSB imported a page from a *foreign* producer,
 * the page keeps that producer's raw type value (`okf_type:`) and any
 * producer-specific frontmatter (`x-*` keys) on disk. A later
 * {@link buildOkfBundle} surfaces the raw foreign type as
 * {@link OkfManifestPage.foreign_type} and the producer-specific keys as
 * {@link OkfManifestPage.producer_meta} while still deriving the standard
 * fields from the page's current state — foreign provenance is preserved,
 * never overwritten or guessed.
 *
 * Import trust gradient: by default imported pages are *staged* under
 * `OKF Review/` with `okf_review: pending` so nothing in the live vault is
 * touched until an operator promotes them. `--trusted` writes each page
 * directly to its recorded vault-relative path (a true round-trip).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import {
  EXCLUDED_DIRS,
  extractWikilinks,
  formatFrontmatter,
  parseFrontmatterText,
  writeFrontmatterAtomic,
} from "../../vault.ts";
import type { FrontmatterMap, FrontmatterValue } from "../../types.ts";
import {
  extractFrontmatterRelations,
  normalizeRelationTarget,
} from "../../graph/frontmatter-relations.ts";
import {
  BRAIN_ROOT_REL,
  BRAIN_LOG_REL,
  BRAIN_SOURCES_REL,
  BRAIN_REPORTS_REL,
  ensureInsideVault,
} from "../paths.ts";
import { isoSecond } from "../time.ts";
import { vaultDisplayName } from "../templates.ts";

export const OKF_SCHEMA_VERSION = "1";
export const OKF_PRODUCER = "open-second-brain";

/** Vault-relative root the default (untrusted) import stages pages under. */
export const OKF_REVIEW_REL = "OKF Review";

/** OKF page classes and the bundle subdirectory each maps to. */
export type OkfPageClass = "concept" | "query" | "reference";

const CLASS_DIR: Readonly<Record<OkfPageClass, string>> = {
  concept: "concepts",
  query: "queries",
  reference: "references",
};

/** `kind:` values that route a page to `queries/`. */
const QUERY_KINDS: ReadonlySet<string> = new Set(["query", "brain-report", "report"]);
/** `kind:` values that route a page to `references/`. */
const REFERENCE_KINDS: ReadonlySet<string> = new Set(["reference", "brain-source", "source"]);

/** Structural default `kind` for a page with no frontmatter `kind:`. */
const DEFAULT_KIND = "note";

/** Frontmatter key prefix marking producer-specific (foreign) fields. */
const PRODUCER_META_PREFIX = "x-";
/** Frontmatter key carrying a foreign producer's raw type value. */
const FOREIGN_TYPE_KEY = "okf_type";
/** Frontmatter key carrying the producer that authored an imported page. */
const PRODUCER_KEY = "okf_producer";
/** Frontmatter key stamping the import timestamp. */
const IMPORTED_AT_KEY = "okf_imported_at";
/** Frontmatter key marking a staged (un-promoted) review candidate. */
const REVIEW_KEY = "okf_review";

const FRESHNESS_FIELDS = ["updated_at", "updated"] as const;

// ----- Export ---------------------------------------------------------------

/** A page collected for OKF export, with derived + preserved metadata. */
export interface OkfPage {
  /** Stable id (the file basename stem). */
  readonly id: string;
  /** Original vault-relative POSIX path. */
  readonly path: string;
  /** Derived OKF class (`concept` | `query` | `reference`). */
  readonly cls: OkfPageClass;
  /** Path within the bundle (`concepts/<slug>.md`, …). */
  readonly bundle_path: string;
  /** Derived standard kind (current frontmatter `kind:` else `note`). */
  readonly kind: string;
  /** Sorted-unique body wikilink + typed-relation targets. */
  readonly citations: ReadonlyArray<string>;
  /** Frontmatter `aliases`, else empty. */
  readonly aliases: ReadonlyArray<string>;
  /** Frontmatter `updated_at`/`updated`, else file mtime (ISO second). */
  readonly freshness: string | null;
  /** Preserved raw foreign type (`okf_type:`), else null. */
  readonly foreign_type: string | null;
  /** Preserved producer-specific frontmatter (`x-*` keys). */
  readonly producer_meta: Readonly<Record<string, string>>;
  /** Verbatim frontmatter of the page. */
  readonly frontmatter: FrontmatterMap;
  /** Verbatim markdown body of the page. */
  readonly body: string;
}

export interface OkfManifestPage {
  readonly id: string;
  readonly path: string;
  readonly class: OkfPageClass;
  readonly bundle_path: string;
  readonly kind: string;
  readonly citations: ReadonlyArray<string>;
  readonly aliases: ReadonlyArray<string>;
  readonly freshness: string | null;
  readonly foreign_type: string | null;
  readonly producer_meta: Readonly<Record<string, string>>;
}

export interface OkfManifest {
  readonly schema: string;
  readonly producer: string;
  readonly generated_at: string;
  readonly vault_basename: string;
  readonly pages: ReadonlyArray<OkfManifestPage>;
  /** Count of `Brain/log/<date>.md` days folded into `log.md`. */
  readonly log_days: number;
}

/** A single file in the in-memory bundle write-plan. */
export interface OkfBundleFile {
  /** Bundle-relative POSIX path. */
  readonly path: string;
  readonly contents: string;
}

export interface OkfBundle {
  readonly manifest: OkfManifest;
  /** Every file to write, including `okf.json`, sorted by path. */
  readonly files: ReadonlyArray<OkfBundleFile>;
}

function stringField(meta: FrontmatterMap, key: string): string | null {
  const value: FrontmatterValue | undefined = meta[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function aliasField(meta: FrontmatterMap): ReadonlyArray<string> {
  const value: FrontmatterValue | undefined = meta["aliases"];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function classifyKind(kind: string): OkfPageClass {
  if (REFERENCE_KINDS.has(kind)) return "reference";
  if (QUERY_KINDS.has(kind)) return "query";
  return "concept";
}

function collectCitations(meta: FrontmatterMap, body: string): string[] {
  const targets: string[] = [];
  for (const raw of extractWikilinks(body)) {
    const norm = normalizeRelationTarget(raw);
    if (norm !== null) targets.push(norm);
  }
  for (const edge of extractFrontmatterRelations(meta)) targets.push(edge.target);
  return [...new Set(targets.filter((v) => v.length > 0))].toSorted();
}

function freshnessOf(meta: FrontmatterMap, absPath: string): string | null {
  for (const field of FRESHNESS_FIELDS) {
    const stamp = stringField(meta, field);
    if (stamp !== null) return stamp;
  }
  try {
    return isoSecond(statSync(absPath).mtime);
  } catch {
    return null;
  }
}

function producerMeta(meta: FrontmatterMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key.startsWith(PRODUCER_META_PREFIX)) out[key] = String(value);
  }
  return out;
}

/** POSIX vault-relative path for an absolute file under the vault. */
function vaultRel(vault: string, abs: string): string {
  return relative(vault, abs).split(/[\\/]/).join(posix.sep);
}

/** Basename stem of a POSIX-or-native path (drops one trailing extension). */
function stem(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Walk the vault and collect every exportable page. Three sources feed
 * the bundle: ordinary user pages (everything outside `Brain/`), the
 * ingested source pages under `Brain/sources/` (references), and the
 * research-report pages under `Brain/reports/` (queries). All other
 * Brain machinery (preferences, inbox, entities, log, …) is excluded —
 * the log feeds `log.md` separately, the rest is not knowledge content.
 */
export function collectOkfPages(vault: string): ReadonlyArray<OkfPage> {
  const seenBundlePaths = new Set<string>();
  const out: OkfPage[] = [];

  const consider = (abs: string, forceClass?: OkfPageClass): void => {
    let raw: string;
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      return;
    }
    const [meta, body] = parseFrontmatterText(raw);
    const kind = stringField(meta, "kind") ?? DEFAULT_KIND;
    const cls = forceClass ?? classifyKind(kind);
    const path = vaultRel(vault, abs);
    const id = stem(path);
    // De-duplicate within the bundle's class subdir; suffix on collision.
    let slug = id;
    let bundlePath = posix.join(CLASS_DIR[cls], `${slug}.md`);
    for (let n = 2; seenBundlePaths.has(bundlePath); n++) {
      slug = `${id}-${n}`;
      bundlePath = posix.join(CLASS_DIR[cls], `${slug}.md`);
    }
    seenBundlePaths.add(bundlePath);
    out.push({
      id,
      path,
      cls,
      bundle_path: bundlePath,
      kind,
      citations: collectCitations(meta, body),
      aliases: aliasField(meta),
      freshness: freshnessOf(meta, abs),
      foreign_type: stringField(meta, FOREIGN_TYPE_KEY),
      producer_meta: producerMeta(meta),
      frontmatter: meta,
      body,
    });
  };

  // 1. User pages (outside Brain). listing is sorted by path below.
  for (const abs of listMarkdown(vault, [...EXCLUDED_DIRS, BRAIN_ROOT_REL])) consider(abs);
  // 2. References: Brain/sources/*.md.
  for (const abs of listMarkdown(join(vault, BRAIN_SOURCES_REL), [])) consider(abs, "reference");
  // 3. Queries: Brain/reports/*.md.
  for (const abs of listMarkdown(join(vault, BRAIN_REPORTS_REL), [])) consider(abs, "query");

  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** Recursively list `.md` files under `root`, skipping `skipDirs` names. */
function listMarkdown(root: string, skipDirs: ReadonlyArray<string>): string[] {
  const skip = new Set(skipDirs);
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skip.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  found.sort();
  return found;
}

/** Read and date-group `Brain/log/<date>.md` into a single change log. */
function buildLog(vault: string): { contents: string; days: number } {
  const dir = join(vault, BRAIN_LOG_REL);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { contents: "", days: 0 };
  }
  const dateRe = /^(\d{4}-\d{2}-\d{2})\.md$/;
  const days = entries
    .map((name) => dateRe.exec(name)?.[1])
    .filter((d): d is string => typeof d === "string")
    .toSorted();
  const sections: string[] = [];
  for (const date of days) {
    let body: string;
    try {
      body = readFileSync(join(dir, `${date}.md`), "utf8").trimEnd();
    } catch {
      continue;
    }
    sections.push(`## ${date}\n\n${body}`);
  }
  return { contents: sections.join("\n\n"), days: days.length };
}

function renderIndex(manifest: OkfManifest): string {
  const lines: string[] = [
    `# ${manifest.vault_basename} — Open Knowledge Format bundle`,
    "",
    `> Portable knowledge bundle produced by \`${manifest.producer}\`.`,
    `> Schema ${manifest.schema}. ${manifest.pages.length} page(s),`,
    `> ${manifest.log_days} log day(s). See \`okf.json\` for machine-readable`,
    `> metadata and \`log.md\` for the change log.`,
    "",
  ];
  const order: ReadonlyArray<[OkfPageClass, string]> = [
    ["concept", "Concepts"],
    ["query", "Queries"],
    ["reference", "References"],
  ];
  for (const [cls, label] of order) {
    const subset = manifest.pages.filter((p) => p.class === cls);
    if (subset.length === 0) continue;
    lines.push(`## ${label}`, "");
    for (const p of subset) {
      const foreign = p.foreign_type ? ` (foreign type: ${p.foreign_type})` : "";
      lines.push(`- [${p.id}](${p.bundle_path}) — \`${p.path}\`${foreign}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Build an OKF bundle write-plan from the vault. Pure and read-only:
 * returns the manifest plus every file to write. Content is
 * deterministic across runs (pages and log days are sorted); only
 * `manifest.generated_at` varies.
 */
export function buildOkfBundle(vault: string): OkfBundle {
  const pages = collectOkfPages(vault);
  const log = buildLog(vault);
  const manifest: OkfManifest = {
    schema: OKF_SCHEMA_VERSION,
    producer: OKF_PRODUCER,
    generated_at: isoSecond(),
    vault_basename: vaultDisplayName(vault),
    pages: pages.map((p) => ({
      id: p.id,
      path: p.path,
      class: p.cls,
      bundle_path: p.bundle_path,
      kind: p.kind,
      citations: p.citations,
      aliases: p.aliases,
      freshness: p.freshness,
      foreign_type: p.foreign_type,
      producer_meta: p.producer_meta,
    })),
    log_days: log.days,
  };

  const files: OkfBundleFile[] = [
    { path: "okf.json", contents: JSON.stringify(manifest, null, 2) + "\n" },
    { path: "index.md", contents: renderIndex(manifest) },
    { path: "log.md", contents: log.contents },
  ];
  for (const p of pages) {
    files.push({ path: p.bundle_path, contents: formatFrontmatter(p.frontmatter, p.body) });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { manifest, files };
}

/**
 * Write a bundle to `dir`. Refuses to clobber a non-empty existing
 * directory unless `force` is set. Creates parent subdirectories as
 * needed; each file is written atomically.
 */
export function writeOkfBundle(
  dir: string,
  bundle: OkfBundle,
  opts: { force?: boolean } = {},
): void {
  if (existsSync(dir)) {
    let existing: string[] = [];
    try {
      existing = readdirSync(dir);
    } catch {
      /* treat unreadable as empty */
    }
    if (existing.length > 0 && !opts.force) {
      throw new OkfError(`${dir} is not empty; pass --force to overwrite`);
    }
  }
  for (const file of bundle.files) {
    const abs = ensureInsideVault(resolve(dir, file.path), dir);
    mkdirSync(dirname(abs), { recursive: true });
    atomicWriteFileSync(abs, file.contents);
  }
}

// ----- Import ---------------------------------------------------------------

/** Raised when an OKF bundle is structurally invalid or unsupported. */
export class OkfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OkfError";
  }
}

/** A page parsed back out of a bundle on disk. */
export interface ParsedOkfPage {
  readonly entry: OkfManifestPage;
  readonly frontmatter: FrontmatterMap;
  readonly body: string;
}

export interface ParsedOkfBundle {
  readonly manifest: OkfManifest;
  /** True when the bundle was produced by some tool other than OSB. */
  readonly foreign: boolean;
  readonly pages: ReadonlyArray<ParsedOkfPage>;
}

interface ManifestInput {
  readonly schema?: unknown;
  readonly producer?: unknown;
  readonly generated_at?: unknown;
  readonly vault_basename?: unknown;
  readonly log_days?: unknown;
  readonly pages?: unknown;
}

function asManifestPage(value: unknown): OkfManifestPage | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v["bundle_path"] !== "string" || typeof v["path"] !== "string") return null;
  const cls = v["class"];
  const klass: OkfPageClass =
    cls === "query" || cls === "reference" || cls === "concept" ? cls : "concept";
  return {
    id: typeof v["id"] === "string" ? v["id"] : stem(v["path"]),
    path: v["path"],
    class: klass,
    bundle_path: v["bundle_path"],
    kind: typeof v["kind"] === "string" ? v["kind"] : DEFAULT_KIND,
    citations: Array.isArray(v["citations"]) ? (v["citations"] as string[]) : [],
    aliases: Array.isArray(v["aliases"]) ? (v["aliases"] as string[]) : [],
    freshness: typeof v["freshness"] === "string" ? v["freshness"] : null,
    foreign_type: typeof v["foreign_type"] === "string" ? v["foreign_type"] : null,
    producer_meta:
      v["producer_meta"] && typeof v["producer_meta"] === "object"
        ? (v["producer_meta"] as Record<string, string>)
        : {},
  };
}

/**
 * Read an OKF bundle directory: parse `okf.json`, validate the schema,
 * then parse each manifest-listed page file. A page whose file is
 * missing or unreadable is skipped (the manifest is the source of truth
 * for what *should* be there; a partial bundle still imports what it
 * has). An unsupported schema or absent manifest throws {@link OkfError}.
 */
export function readOkfBundle(dir: string): ParsedOkfBundle {
  const manifestPath = join(dir, "okf.json");
  if (!existsSync(manifestPath)) {
    throw new OkfError(`not an OKF bundle: ${manifestPath} is missing`);
  }
  let parsed: ManifestInput;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestInput;
  } catch (exc) {
    throw new OkfError(`okf.json is not valid JSON: ${(exc as Error).message ?? exc}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new OkfError("okf.json must be a JSON object");
  }
  if (parsed.schema !== OKF_SCHEMA_VERSION) {
    throw new OkfError(
      `unsupported OKF schema: expected ${OKF_SCHEMA_VERSION}, got ${String(parsed.schema)}`,
    );
  }
  const producer = typeof parsed.producer === "string" ? parsed.producer : "unknown";
  const rawPages = Array.isArray(parsed.pages) ? parsed.pages : [];
  const entries = rawPages.map(asManifestPage).filter((p): p is OkfManifestPage => p !== null);

  const pages: ParsedOkfPage[] = [];
  for (const entry of entries) {
    // Validate the bundle-relative path stays inside the bundle dir
    // before reading — a hostile manifest cannot make us read outside.
    let abs: string;
    try {
      abs = ensureInsideVault(join(dir, entry.bundle_path), dir);
    } catch {
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const [frontmatter, body] = parseFrontmatterText(raw);
    pages.push({ entry, frontmatter, body });
  }

  return {
    manifest: {
      schema: OKF_SCHEMA_VERSION,
      producer,
      // Preserve the bundle's own metadata instead of synthesizing
      // placeholders: readOkfBundle is a reader, and a caller that
      // inspects the parsed manifest should see what is on disk.
      generated_at: typeof parsed.generated_at === "string" ? parsed.generated_at : "",
      vault_basename: typeof parsed.vault_basename === "string" ? parsed.vault_basename : "",
      pages: entries,
      log_days:
        typeof parsed.log_days === "number" && Number.isFinite(parsed.log_days)
          ? parsed.log_days
          : 0,
    },
    foreign: producer !== OKF_PRODUCER,
    pages,
  };
}

export interface OkfImportOptions {
  /**
   * When true, write each page directly to its recorded vault-relative
   * path (a true round-trip). When false (default), stage every page
   * under `OKF Review/` with `okf_review: pending` so the live vault is
   * untouched until an operator promotes the candidates.
   */
  readonly trusted?: boolean;
  /** Wall clock for the import stamp. Tests pin this. */
  readonly now?: Date;
}

export interface OkfImportResult {
  /** Vault-relative paths written. */
  readonly written: ReadonlyArray<string>;
  /** Paths skipped because the target already existed (review mode). */
  readonly skipped: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<{ path: string; message: string }>;
  /** True when the bundle producer was foreign (provenance was stamped). */
  readonly foreign: boolean;
  /** `"trusted"` (direct write) or `"review"` (staged). */
  readonly mode: "trusted" | "review";
}

/**
 * Compose the frontmatter a page lands with. Standard fields are taken
 * from the bundle file verbatim; for a foreign bundle we additionally
 * stamp provenance (producer + raw foreign type) without clobbering any
 * such key the page already carries — preserving, never overwriting,
 * producer-specific metadata. Review-staged pages also get
 * `okf_review: pending`.
 */
function importFrontmatter(
  page: ParsedOkfPage,
  producer: string,
  foreign: boolean,
  trusted: boolean,
  nowIso: string,
): FrontmatterMap {
  const meta: FrontmatterMap = { ...page.frontmatter };
  if (foreign) {
    if (meta[PRODUCER_KEY] === undefined) meta[PRODUCER_KEY] = producer;
    // Preserve the raw foreign type: prefer the bundle's recorded
    // foreign_type, else the page's declared kind at import time.
    if (meta[FOREIGN_TYPE_KEY] === undefined) {
      meta[FOREIGN_TYPE_KEY] = page.entry.foreign_type ?? page.entry.kind;
    }
    meta[IMPORTED_AT_KEY] = nowIso;
  }
  if (!trusted) meta[REVIEW_KEY] = "pending";
  return meta;
}

/**
 * Import a parsed bundle into the vault. See {@link OkfImportOptions} for
 * the trust gradient. Each target path is funnelled through
 * {@link ensureInsideVault} so a hostile recorded path cannot escape the
 * vault root. In review mode an existing target is left untouched
 * (reported under `skipped`); in trusted mode it is overwritten (the
 * round-trip contract is "restore the recorded state").
 */
export function importOkfBundle(
  vault: string,
  bundle: ParsedOkfBundle,
  opts: OkfImportOptions = {},
): OkfImportResult {
  const trusted = opts.trusted === true;
  const nowIso = isoSecond(opts.now ?? new Date());
  const written: string[] = [];
  const skipped: string[] = [];
  const errors: { path: string; message: string }[] = [];

  for (const page of bundle.pages) {
    const targetRel = trusted ? page.entry.path : posix.join(OKF_REVIEW_REL, page.entry.path);
    let abs: string;
    try {
      abs = ensureInsideVault(join(vault, targetRel), vault);
    } catch (exc) {
      errors.push({ path: targetRel, message: (exc as Error).message ?? String(exc) });
      continue;
    }
    if (!trusted && existsSync(abs)) {
      skipped.push(targetRel);
      continue;
    }
    const meta = importFrontmatter(page, bundle.manifest.producer, bundle.foreign, trusted, nowIso);
    try {
      mkdirSync(dirname(abs), { recursive: true });
      // overwrite: trusted closes the TOCTOU window in review mode: if a
      // file appears between the existsSync check above and this write,
      // the exclusive create throws EEXIST instead of clobbering it.
      writeFrontmatterAtomic(abs, meta, page.body, { overwrite: trusted });
      written.push(targetRel);
    } catch (exc) {
      if (!trusted && (exc as NodeJS.ErrnoException).code === "EEXIST") {
        skipped.push(targetRel);
        continue;
      }
      errors.push({ path: targetRel, message: (exc as Error).message ?? String(exc) });
    }
  }

  return {
    written,
    skipped,
    errors,
    foreign: bundle.foreign,
    mode: trusted ? "trusted" : "review",
  };
}
