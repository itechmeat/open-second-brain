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
 * page's frontmatter and body **verbatim** plus the OKF v0.2 derived
 * keys (`type`, `status`, `sources`, `generated` — recomputed on every
 * export; `type` is the spec's one always-required per-concept key) and
 * the `okf_raw` marker declaring the raw native keys riding beside
 * them; the manifest carries the *derived* standard fields (kind,
 * citations, status, sources, freshness) computed from current page
 * state.
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
 *
 * The bundle's self-declared `producer` is a LABEL, never a credential:
 * any bundle can write `"producer": "open-second-brain"` into its
 * manifest. It decides only provenance stamping. Every security decision
 * - whether machinery frontmatter survives, whether the Brain page lanes
 * are writable - keys on the operator's explicit `--trusted` instead.
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
import { listLogShardFiles } from "../log-jsonl.ts";
import {
  BRAIN_ROOT_REL,
  BRAIN_SOURCES_REL,
  BRAIN_REPORTS_REL,
  ensureInsideVault,
  isInBrainLane,
  isUnderBrainRoot,
} from "../paths.ts";
import { isoSecond } from "../time.ts";
import { vaultDisplayName } from "../templates.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { KNOWLEDGE_PACK_FIELD, KNOWLEDGE_PACK_SHA_FIELD } from "./pack-stamp.ts";
import { OPEN_SECOND_BRAIN_VERSION } from "../../version.ts";

export const OKF_SCHEMA_VERSION = "1";
export const OKF_PRODUCER = "open-second-brain";

/**
 * The OKF spec version this export emits, declared as
 * `okf_version: "0.2"` in the bundle-root `index.md` frontmatter (a MAY
 * per the spec, and the only frontmatter an index file may carry). This
 * is the INTERCHANGE version, not the manifest dialect: Open Second
 * Brain's own `okf.json` keeps its `schema: "1"` field beside it.
 */
export const OKF_VERSION = "0.2";

/** The OKF v0.2 `generated.by` actor string for pages this system exports. */
const OKF_GENERATED_BY = `${OKF_PRODUCER}/${OPEN_SECOND_BRAIN_VERSION}`;

/**
 * Bundle-relative filename of the machine-readable manifest. Named
 * because three sites spelled it as a literal and a fourth - the export
 * verb, which re-serialises this one file after redacting the manifest
 * tree - would have made four.
 */
export const OKF_MANIFEST_FILENAME = "okf.json";

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

/**
 * Frontmatter keys carrying a page's NATIVE `status` / `sources` /
 * `generated` / `type` values beside the derived v0.2 block. The v0.2
 * status enum is closed (`draft | stable | deprecated`) and the derived
 * sources are re-translated from citations, so exporting the native
 * values in place would silently rewrite them: a quarantined page would
 * export as `stable` and un-quarantine on import, workflow statuses like
 * `done` or `active` would be lost, and user-written source lists would
 * be replaced. The same holds for `type`, the spec's one always-required
 * per-concept key: the export emits it DERIVED (the preserved foreign
 * type, else the structural kind), so a native `type` the operator wrote
 * rides the raw namespace instead of being shadowed by the projection.
 * The raw keys ride the same `okf_` producer namespace as
 * {@link FOREIGN_TYPE_KEY} / {@link PRODUCER_KEY}; an own-producer
 * import restores them and drops the derived block (see
 * {@link restoreRawOkfKeys}) - trusted round-trip and review staging
 * alike - while foreign bundles import as-is and shed the keys.
 */
const RAW_STATUS_KEY = "okf_status_raw";
const RAW_SOURCES_KEY = "okf_sources_raw";
const RAW_GENERATED_KEY = "okf_generated_raw";
const RAW_TYPE_KEY = "okf_type_raw";

/**
 * The raw/native key pairs the producer namespace carries beside the
 * derived v0.2 block, in one list: `raw` is the exported carrier,
 * `native` the frontmatter field it preserves. The export's carry and
 * strip, the foreign shed and the import restore all walk THIS, so the
 * set cannot drift between the sites that must agree on it.
 */
const RAW_OKF_KEYS: ReadonlyArray<{ readonly raw: string; readonly native: string }> =
  Object.freeze([
    { raw: RAW_STATUS_KEY, native: "status" },
    { raw: RAW_SOURCES_KEY, native: "sources" },
    { raw: RAW_GENERATED_KEY, native: "generated" },
    { raw: RAW_TYPE_KEY, native: "type" },
  ]);

/**
 * The per-page marker that says "this bundle page was written by a
 * raw-carrying exporter", stamped on EVERY page of a fresh export
 * beside the derived block - raw keys or not. It is what lets the
 * import distinguish a page the current exporter wrote with no native
 * status / sources / generated (absent raw keys mean "the field never
 * had a value": strip the derived block, the page lands plain) from a
 * LEGACY bundle's page (no marker: the frontmatter already is the
 * native state, leave it as-is). Without the marker, a fresh-export
 * plain page took the legacy early-return and landed WITH the derived
 * block - `status: stable` materializing where none existed - and the
 * next export carried the materialized status as a raw native,
 * permanent.
 *
 * The marker IS its coverage: the exporter stamps the list of native
 * names it manages, and the restore drops a derived value only for a
 * pair the marker declares (see {@link rawCarryDeclaredNatives}). A
 * bare `true` is what the pre-list exporters stamped, so it reads as
 * the legacy shape and covers only the old status/sources/generated
 * set - never `type`, whose pair did not exist yet when those exports
 * carried a native type verbatim beside the marker.
 */
const RAW_CARRY_KEY = "okf_raw";

/**
 * The native fields a bare {@link RAW_CARRY_KEY} `true` covers: the
 * three the exporters that stamped the bare shape managed. The `type`
 * pair did not exist yet in those exports - a native `type` rode the
 * page verbatim beside the marker - so `true` must never name it, or
 * the restore would read a legacy page's absent `okf_type_raw` as "the
 * field never had a value" and delete the real type.
 */
const RAW_CARRY_TRUE_NATIVES: ReadonlySet<string> = new Set(["status", "sources", "generated"]);

const FRESHNESS_FIELDS = ["updated_at", "updated"] as const;

// ----- Export ---------------------------------------------------------------

/**
 * The OKF v0.2 concept lifecycle enum - the spec's CLOSED status
 * vocabulary (`draft | stable | deprecated`; an absent status means
 * stable). Open Second Brain's own page statuses land on it through the
 * conservative map in {@link okfStatusOf}.
 */
export type OkfStatus = "draft" | "stable" | "deprecated";

/** One OKF v0.2 per-page source (a frontmatter `sources:` entry). */
export interface OkfSource {
  /**
   * REQUIRED per the spec: a path or URL identifying the source. A
   * citation that resolves to neither is dropped rather than guessed.
   */
  readonly resource: string;
  /**
   * Optional stable key. Carried when the citation resolves to a bundle
   * page, whose id is that stable key.
   */
  readonly id?: string;
}

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
  /** Mapped OKF v0.2 lifecycle (`draft` | `stable` | `deprecated`). */
  readonly status: OkfStatus;
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
  /** Mapped OKF v0.2 lifecycle (`draft` | `stable` | `deprecated`). */
  readonly status: OkfStatus;
  /** OKF v0.2 per-page sources translated from `citations`. */
  readonly sources: ReadonlyArray<OkfSource>;
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
  /**
   * Count of DAYS folded into `log.md`, across every markdown shard of
   * `Brain/log/` - `<date>.md` and `<date>.<deviceId>.md` alike. Two
   * shards of one day are one day here, not two.
   */
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

/**
 * Frontmatter `status:` values that mean "no longer current" and map to
 * the OKF `deprecated` value. Deliberately NARROW: the OKF enum has no
 * room for nuance, and a conservative producer prefers understating.
 */
const OKF_DEPRECATED_STATUSES: ReadonlySet<string> = new Set([
  "deprecated",
  "retired",
  "superseded",
  "archived",
  "terminal",
]);

/**
 * Map a page onto the OKF v0.2 concept lifecycle, which admits ONLY
 * `draft | stable | deprecated`.
 *
 * PINNED SOURCE FIELD: the page's frontmatter `status:` value - the
 * operator-declared page state - and nothing else. The system-managed
 * `_lifecycle` axis is not consulted: its `verified`/`disputed` values
 * have no OKF counterpart, and a conservative map must not guess one.
 * Completion states (`done` / `closed` / `resolved`) map to `stable` -
 * completion is not deprecation, never the reverse - and a status the
 * vocabulary does not name (including no status at all) lands on
 * `stable`, which is also the OKF default for an absent status.
 */
function okfStatusOf(meta: FrontmatterMap): OkfStatus {
  const raw = stringField(meta, "status");
  if (raw === null) return "stable";
  const status = raw.trim().toLowerCase();
  if (status === "draft") return "draft";
  if (OKF_DEPRECATED_STATUSES.has(status)) return "deprecated";
  return "stable";
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
      status: okfStatusOf(meta),
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

/**
 * Read and date-group the markdown side of `Brain/log/` into one change
 * log.
 *
 * Days come from {@link listLogShardFiles}, the recogniser in the module
 * that owns the log layout, rather than from a pattern of this module's
 * own. The local pattern here matched `<date>.md` only, while every
 * default install has written the per-device `<date>.<deviceId>.md` since
 * sharding landed - so a vault with a full change log exported an empty
 * `log.md` and a manifest reading `0 log day(s)`, with nothing to
 * distinguish that from a vault that had never logged anything.
 *
 * Shards of one day fold into ONE dated section, ordered by shard id
 * (`listLogShardFiles` sorts by name), so the bundle is byte-identical
 * whatever order Syncthing delivered the shards in.
 */
function buildLog(vault: string): { contents: string; days: number } {
  const bodiesByDate = new Map<string, string[]>();
  for (const shard of listLogShardFiles(vault)) {
    // The bundle is markdown; the JSONL sidecar of a day carries the same
    // entries in machine form and would duplicate every line.
    if (shard.ext !== "md") continue;
    let body: string;
    try {
      body = readFileSync(shard.path, "utf8").trimEnd();
    } catch (err) {
      // Never `continue`: a shard the export could not read is a day of
      // the change log missing from the bundle, and a bundle that is
      // silently short a day is exactly what this export must not produce.
      throw new Error(
        `okf export: cannot read log shard ${shard.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (body.length === 0) continue;
    const bodies = bodiesByDate.get(shard.date);
    if (bodies === undefined) bodiesByDate.set(shard.date, [body]);
    else bodies.push(body);
  }
  const sections = [...bodiesByDate.keys()]
    .toSorted()
    .map((date) => `## ${date}\n\n${bodiesByDate.get(date)!.join("\n\n")}`);
  return { contents: sections.join("\n\n"), days: bodiesByDate.size };
}

function renderIndex(manifest: OkfManifest): string {
  const lines: string[] = [
    "---",
    // OKF v0.2's version declaration. Per the spec it is a MAY in the
    // bundle-root index, and the ONLY frontmatter an index file carries.
    `okf_version: "${OKF_VERSION}"`,
    "---",
    "",
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
 * Serialise a manifest to the exact bytes `okf.json` carries. Exported
 * because the export verb redacts the manifest as a TREE - a pass over
 * serialised JSON can eat a closing quote - and then has to re-render
 * this one file from the redacted result.
 */
export function renderOkfManifest(manifest: OkfManifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

/** A citation target that names an absolute resource, not a vault page. */
const URL_TARGET_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * Build the resolver that turns citation targets into OKF v0.2
 * `sources:` entries. It keys on the page walk's own bundle_path
 * assignment, so a resolved source names exactly the file the bundle
 * wrote for the cited page. Resolution order:
 *
 * 1. a URL target is carried as-is;
 * 2. a path-shaped target must name a collected page (with or without
 *    the `.md` suffix) - otherwise it is dropped, never guessed. The
 *    entry carries the page's id only when that stem is unique; a
 *    colliding basename has no stable id to name;
 * 3. a bare basename resolves only when EXACTLY ONE page carries that
 *    stem: the colliding-basename case (two `Dup.md` pages) is dropped
 *    rather than guessed.
 *
 * Anything else is dangling and dropped - consumers must tolerate
 * broken links, and a wrong source is worse than no source.
 */
function sourceResolver(pages: ReadonlyArray<OkfPage>): (citation: string) => OkfSource | null {
  const byPath = new Map<string, OkfPage>();
  const byStem = new Map<string, OkfPage[]>();
  for (const p of pages) {
    byPath.set(p.path, p);
    const stems = byStem.get(p.id);
    if (stems === undefined) byStem.set(p.id, [p]);
    else stems.push(p);
  }
  return (citation: string): OkfSource | null => {
    if (URL_TARGET_RE.test(citation)) return { resource: citation };
    if (citation.includes("/")) {
      const direct = byPath.get(citation) ?? byPath.get(`${citation}.md`);
      if (direct === undefined) return null;
      // The path resolves the page, but its stem names an id only when it
      // is unique: two colliding basenames are both id "Dup", and the id
      // field is a stable key. The entry carries the bundle path alone -
      // same refuse-to-guess rule as the basename branch.
      const stems = byStem.get(direct.id);
      if (stems !== undefined && stems.length > 1) return { resource: direct.bundle_path };
      return { resource: direct.bundle_path, id: direct.id };
    }
    // The stem map keys on stems, but a citation may keep its extension
    // (`[[Dup.md]]` names the same page `[[Dup]]` does), so a direct miss
    // falls back to stem(citation). Exact-unique either way: the
    // colliding-basename case still drops rather than guess.
    const stems = byStem.get(citation) ?? byStem.get(stem(citation));
    if (stems === undefined || stems.length !== 1) return null;
    return { resource: stems[0]!.bundle_path, id: stems[0]!.id };
  };
}

/** Translate a page's citations into de-duplicated source entries. */
function translateSources(
  page: OkfPage,
  resolveSource: (citation: string) => OkfSource | null,
): OkfSource[] {
  const out: OkfSource[] = [];
  const seen = new Set<string>();
  for (const citation of page.citations) {
    const source = resolveSource(citation);
    if (source === null || seen.has(source.resource)) continue;
    seen.add(source.resource);
    out.push(source);
  }
  return out;
}

/**
 * Render one scalar inside a YAML flow mapping (`{resource: …, id: …}`).
 * EVERY value is emitted as a JSON string literal: JSON string syntax is
 * valid YAML double-quoted style, so the scalar always parses back as a
 * string — a bare-looking id like `2024` would be an integer to a strict
 * YAML reader, bare `true` / `null` / `~` would be a boolean or null, and
 * a hand-rolled escape covers nothing like the full metacharacter set
 * (control characters included) JSON.stringify handles. The flow shapes
 * around the scalars are kept.
 */
function okfFlowScalar(value: string): string {
  return JSON.stringify(value);
}

/**
 * Serialise one bundle page file: the page's own frontmatter and body
 * verbatim, plus the OKF v0.2 per-page keys (`type`, `status`,
 * `sources`, `generated`) as DERIVED fields. The derived keys are
 * recomputed from current page state on every export and never carried
 * through from a previous bundle, so re-exporting an imported page
 * re-derives them instead of stacking a foreign bundle's values a second
 * time. Because the derived block is a projection - a closed status
 * enum, sources re-translated from citations, a type taken from the
 * preserved foreign type or the structural kind - the page's NATIVE
 * values ride beside it under the producer namespace (`okf_status_raw`,
 * `okf_sources_raw`, `okf_generated_raw`, `okf_type_raw`), so a trusted
 * own-producer import can restore what the projection cannot name. The
 * derived `type` is the spec's one always-required per-concept key, so
 * every page carries it even when its frontmatter never did.
 *
 * The derived block is rendered by hand in YAML flow style because the
 * shared frontmatter writer emits scalars and inline arrays only - and
 * the flow shapes chosen (one line per source entry, one line for
 * `generated`) keep the page parseable by consumers with full YAML
 * parsers while never producing a line this system's own scanner would
 * misread as a top-level key.
 */
function renderOkfPageFile(
  page: OkfPage,
  sources: ReadonlyArray<OkfSource>,
  generatedAt: string,
): string {
  const carried: FrontmatterMap = {};
  for (const [key, value] of Object.entries(page.frontmatter)) {
    // Both sides of every pair are skipped: the native field is re-derived
    // below, and the raw carrier is re-stamped from the current state - the
    // pair list is the one source of what must not ride through verbatim.
    if (RAW_OKF_KEYS.some(({ raw, native }) => raw === key || native === key)) continue;
    if (key === RAW_CARRY_KEY) continue;
    carried[key] = value;
  }
  // The native values ride the producer namespace beside the derived
  // block: the derived status maps onto a closed enum and the derived
  // sources are re-translated from citations, so exporting them in place
  // would rewrite what the operator wrote. Recomputed from current page
  // state on every export and never carried through from a previous
  // bundle - the same honesty rule as the derived block. A value is
  // carried on PRESENCE alone (the rule sources and generated follow):
  // a non-string status - a number from a hand-built frontmatter map, a
  // list - is exactly the value the closed enum cannot name, so reading
  // it through the string-only field would drop the one raw key that
  // preserves it.
  for (const { raw, native } of RAW_OKF_KEYS) {
    if (page.frontmatter[native] !== undefined) carried[raw] = page.frontmatter[native];
  }
  // The raw-carrying declaration, stamped fresh on every page of every
  // export: this is what tells the own-producer import that absent raw
  // keys mean "the field never had a value" rather than "a legacy
  // bundle's page - leave the frontmatter alone". It names exactly the
  // natives this exporter manages - the derived `type` included - so
  // the restore drops the whole derived block from a page that never
  // carried one natively, and a bare `true` stays what it always was:
  // a LEGACY page's marker, covering the pre-type-pair set only.
  carried[RAW_CARRY_KEY] = RAW_OKF_KEYS.map(({ native }) => native);
  // formatFrontmatter with an empty body is exactly "---\n<keys>---\n";
  // drop the closing fence, append the derived block, re-close.
  let out = formatFrontmatter(carried, "").slice(0, -"---\n".length);
  // `type` is the spec's only always-required per-concept key (non-empty),
  // so the derived block opens with it: the preserved foreign type when
  // the page was imported from a foreign producer, else the page's own
  // structural kind - the honest fields the page walk collected. A native
  // `type` is NOT shadowed by this projection: it rode out under
  // okf_type_raw above, and the own-producer restore puts it back.
  out += `type: ${okfFlowScalar(page.foreign_type ?? page.kind)}\n`;
  out += `status: ${page.status}\n`;
  if (sources.length > 0) {
    out += "sources:\n";
    for (const source of sources) {
      out += `  - {resource: ${okfFlowScalar(source.resource)}`;
      if (source.id !== undefined) out += `, id: ${okfFlowScalar(source.id)}`;
      out += "}\n";
    }
  }
  out += `generated: {by: ${okfFlowScalar(OKF_GENERATED_BY)}, at: "${generatedAt}"}\n`;
  out += "---\n";
  if (page.body.length > 0) out += `\n${page.body}\n`;
  return out;
}

/**
 * Build an OKF bundle write-plan from the vault. Pure and read-only:
 * returns the manifest plus every file to write. Content is
 * deterministic across runs (pages and log days are sorted); the only
 * value that varies is the single shared generated instant, which the
 * manifest's `generated_at` and every page's `generated.at` carry.
 */
export function buildOkfBundle(vault: string): OkfBundle {
  return assembleOkfBundle(vault, collectOkfPages(vault), buildLog(vault));
}

/**
 * Build an OKF bundle write-plan over a caller-chosen SUBSET of pages and
 * no change log. The knowledge-pack export is the caller: a pack carries
 * the pages an operator selected, never the vault's whole history, so the
 * date-grouped `log.md` a full bundle folds in is left out (the manifest
 * says `log_days: 0`). Pure; the pages are written as given.
 */
export function buildOkfSubsetBundle(vault: string, pages: ReadonlyArray<OkfPage>): OkfBundle {
  return assembleOkfBundle(vault, pages, null);
}

function assembleOkfBundle(
  vault: string,
  pages: ReadonlyArray<OkfPage>,
  log: { contents: string; days: number } | null,
): OkfBundle {
  // ONE instant for the whole bundle: the manifest's `generated_at` and
  // every page's `generated.at` share it, so whole-bundle byte equality
  // modulo that single value stays the determinism contract.
  const generatedAt = isoSecond();
  const resolveSource = sourceResolver(pages);
  const derived = pages.map((p) => ({ page: p, sources: translateSources(p, resolveSource) }));
  const manifest: OkfManifest = {
    schema: OKF_SCHEMA_VERSION,
    producer: OKF_PRODUCER,
    generated_at: generatedAt,
    vault_basename: vaultDisplayName(vault),
    pages: derived.map(({ page, sources }) => ({
      id: page.id,
      path: page.path,
      class: page.cls,
      bundle_path: page.bundle_path,
      kind: page.kind,
      citations: page.citations,
      status: page.status,
      sources,
      aliases: page.aliases,
      freshness: page.freshness,
      foreign_type: page.foreign_type,
      producer_meta: page.producer_meta,
    })),
    log_days: log?.days ?? 0,
  };

  const files: OkfBundleFile[] = [
    { path: OKF_MANIFEST_FILENAME, contents: renderOkfManifest(manifest) },
    { path: "index.md", contents: renderIndex(manifest) },
  ];
  if (log !== null) files.push({ path: "log.md", contents: log.contents });
  for (const { page, sources } of derived) {
    files.push({ path: page.bundle_path, contents: renderOkfPageFile(page, sources, generatedAt) });
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

/** Parse a manifest `sources` entry; entries without a resource are dropped. */
function asOkfSource(value: unknown): OkfSource | null {
  if (value === null || typeof value !== "object") return null;
  const resource = (value as Record<string, unknown>)["resource"];
  if (typeof resource !== "string" || resource.length === 0) return null;
  const id = (value as Record<string, unknown>)["id"];
  return typeof id === "string" && id.length > 0 ? { resource, id } : { resource };
}

function asManifestPage(value: unknown): OkfManifestPage | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v["bundle_path"] !== "string" || typeof v["path"] !== "string") return null;
  const cls = v["class"];
  const klass: OkfPageClass =
    cls === "query" || cls === "reference" || cls === "concept" ? cls : "concept";
  const status = v["status"];
  return {
    id: typeof v["id"] === "string" ? v["id"] : stem(v["path"]),
    path: v["path"],
    class: klass,
    bundle_path: v["bundle_path"],
    kind: typeof v["kind"] === "string" ? v["kind"] : DEFAULT_KIND,
    citations: Array.isArray(v["citations"]) ? (v["citations"] as string[]) : [],
    status: status === "draft" || status === "deprecated" ? status : "stable",
    sources: Array.isArray(v["sources"])
      ? v["sources"].map(asOkfSource).filter((s): s is OkfSource => s !== null)
      : [],
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
 * Read the bundle-root index's `okf_version` declaration, or null when
 * the index is missing, unreadable, or declares no version. Consulted
 * only when the manifest does not carry the dialect schema, so the
 * schema-"1" path (sealed knowledge-pack halves included) never grows a
 * dependency on an index file being present.
 */
function indexOkfVersion(dir: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "index.md"), "utf8");
  } catch {
    return null;
  }
  const [meta] = parseFrontmatterText(raw);
  const value = meta["okf_version"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The bundle-directory names that map onto page classes, derived from
 * {@link CLASS_DIR} so the export's lanes and the import's reading of
 * them cannot drift.
 */
const SPEC_DIR_CLASS: Readonly<Record<string, OkfPageClass>> = Object.freeze(
  Object.fromEntries(Object.entries(CLASS_DIR).map(([cls, dir]) => [dir, cls as OkfPageClass])),
);

/**
 * Reserved bundle-root files per the OKF v0.2 spec: the version-
 * declaring index and the change log. The reservation is a ROOT one -
 * the spec reserves the two names at the top of the bundle tree, so a
 * foreign bundle's nested `concepts/index.md` or a per-project
 * `notes/log.md` is a real page. The walk matches these against the
 * page's full bundle-relative path, lowercased - never the basename,
 * which would skip real pages at any depth.
 */
const SPEC_RESERVED_PATHS: ReadonlySet<string> = new Set(["index.md", "log.md"]);

/**
 * The producer label a manifest-less spec bundle reports: there is no
 * manifest to declare one, so the parsed manifest names the walk
 * honestly instead of guessing a producer from the tree. Named because
 * the bundle is FOREIGN by construction - a walk with no manifest can
 * never be this system's own dialect - and the old inline comparison
 * against {@link OKF_PRODUCER} restated that fact as a tautology.
 */
const SPEC_BUNDLE_PRODUCER = "unknown";

/**
 * Read a manifest-less, spec-shaped OKF v0.2 bundle: the spec defines a
 * bundle as a plain directory tree of markdown and requires NO machine
 * manifest, so the page list is built by walking the tree. Reserved
 * bundle-root files (index.md, log.md) are skipped, the class comes from
 * the page's top-level directory when it names a class lane (concepts /
 * queries / references) and defaults to `concept` everywhere else, and
 * each walked page's own `type` frontmatter is recorded as its foreign
 * type - the producer's raw type value, which the import's provenance
 * stamp preserves. There is no manifest to declare a producer, so the
 * parsed manifest reports {@link SPEC_BUNDLE_PRODUCER} and the bundle is
 * FOREIGN by construction: every page imports through the foreign path
 * (machinery stripped, raw keys shed, provenance stamped, review-staged
 * by default) - the walk never restores machinery keys on a spec
 * bundle's word.
 */
function readSpecOkfBundle(dir: string): ParsedOkfBundle {
  const producer = SPEC_BUNDLE_PRODUCER;
  const entries: OkfManifestPage[] = [];
  const pages: ParsedOkfPage[] = [];
  for (const abs of listMarkdown(dir, [])) {
    const rel = relative(dir, abs).split(/[\\/]/).join(posix.sep);
    if (SPEC_RESERVED_PATHS.has(rel.toLowerCase())) continue;
    // Same wall the manifest path applies: a walked file that is not
    // (symlink-)inside the bundle is skipped, never read.
    try {
      ensureInsideVault(abs, dir);
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
    const topDir = rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : "";
    const entry: OkfManifestPage = {
      id: stem(rel),
      path: rel,
      class: SPEC_DIR_CLASS[topDir] ?? "concept",
      bundle_path: rel,
      kind: stringField(frontmatter, "kind") ?? DEFAULT_KIND,
      citations: [],
      status: "stable",
      sources: [],
      aliases: [],
      freshness: null,
      foreign_type: stringField(frontmatter, "type"),
      producer_meta: {},
    };
    entries.push(entry);
    pages.push({ entry, frontmatter, body });
  }
  return {
    manifest: {
      schema: "",
      producer,
      generated_at: "",
      vault_basename: "",
      pages: entries,
      log_days: 0,
    },
    // No manifest, no own-producer claim to honour: the walk's output is
    // foreign by construction - stating it directly instead of resting
    // on a literal-vs-constant comparison that could only ever be true.
    foreign: true,
    pages,
  };
}

/**
 * Read an OKF bundle directory: parse `okf.json`, validate the schema,
 * then parse each manifest-listed page file. Three bundle generations
 * are accepted: a manifest carrying the Open Second Brain dialect
 * `schema: "1"`, a bundle whose manifest declares NO schema while its
 * bundle-root `index.md` declares `okf_version: "0.2"` (the OKF v0.2
 * marker this export writes beside the dialect schema), and - the spec
 * shape - a bundle with NO manifest at all whose bundle-root index
 * declares the same version, which is read by walking the tree (see
 * {@link readSpecOkfBundle}). A PRESENT non-dialect schema is refused
 * whatever the index says: this export's own index always declares the
 * version, so treating the declaration as sufficient on its own would
 * admit every future dialect bump under v1 assumptions. Everything else
 * is refused by name. A page whose file is missing or unreadable is
 * skipped (the manifest is the source of truth for what *should* be
 * there; a partial bundle still imports what it has). An unsupported
 * schema or an absent manifest without a v0.2 index declaration throws
 * {@link OkfError}.
 */
export function readOkfBundle(dir: string): ParsedOkfBundle {
  const manifestPath = join(dir, OKF_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    // No manifest at all. The v0.2 spec requires none, so the spec shape
    // - a v0.2 declaration on the bundle-root index - is accepted and
    // read as a tree; everything else is refused exactly as before.
    if (indexOkfVersion(dir) === OKF_VERSION) return readSpecOkfBundle(dir);
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
  // A null schema declares nothing, exactly like an absent or empty one:
  // a writer that nulls the field is not naming a schema, and falling
  // through to the by-name refusal would report "expected 1, got null"
  // even beside a v0.2 index declaration.
  const schemaAbsent =
    parsed.schema === undefined || parsed.schema === null || parsed.schema === "";
  if (parsed.schema === OKF_SCHEMA_VERSION) {
    // The dialect path. Sealed knowledge-pack halves exported before
    // v0.2 emission take it, so it never depends on an index file.
  } else if (schemaAbsent && indexOkfVersion(dir) === OKF_VERSION) {
    // The version-declaration path: no manifest schema, and the bundle
    // root says OKF v0.2. Version-level only - the gate never reads the
    // producer.
  } else if (schemaAbsent) {
    throw new OkfError(
      `unsupported OKF schema: no schema ${OKF_SCHEMA_VERSION} in ${OKF_MANIFEST_FILENAME} ` +
        `and no okf_version ${OKF_VERSION} declaration in index.md`,
    );
  } else {
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
      // Preserve the ON-DISK schema value rather than stamping this
      // module's constant: a reader inspecting the parsed manifest must
      // see which declaration the bundle actually made (a v0.2-accepted
      // bundle may name a non-dialect schema, or none at all).
      schema: typeof parsed.schema === "string" ? parsed.schema : "",
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
   *
   * This flag is the operator's vouch, and the only one the import
   * honours: without it machinery frontmatter (`_status`, `owner`,
   * `origin_channel`, ...) is stripped and the Brain page lanes are not
   * writable, whatever `producer` the bundle's manifest declares.
   */
  readonly trusted?: boolean;
  /** Wall clock for the import stamp. Tests pin this. */
  readonly now?: Date;
  /**
   * Server-side provenance written onto every landed page AFTER the
   * machinery strip, so the bundle can neither supply nor forge it. The
   * knowledge-pack installer passes its `knowledge_pack` stamp here.
   */
  readonly provenance?: Readonly<Record<string, string>>;
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
 * Frontmatter keys an imported page may not carry across the trust
 * boundary. These are the machinery fields this system's own writers
 * stamp server-side - the `_status`/`_confidence` lifecycle, the
 * `_revision`/`_content_hash` write accounting, the `origin_channel`
 * transport stamp, the `owner` scope claim, and the `okf_review` staging
 * marker - so a bundle supplying them verbatim would mint pages that
 * read as system-authored the moment an operator promotes them out of
 * the review lane.
 *
 * Stripped on every import the operator did not vouch for with
 * `--trusted`, whatever the manifest's `producer` says: the producer
 * field is bundle-supplied and a forged `open-second-brain` must not
 * carry `_status: confirmed` through. A trusted import of a bundle that
 * declares a foreign producer strips them too - nothing a foreign tool
 * wrote is this system's machinery. The one lossless path is a trusted
 * import of a bundle that declares this producer: the operator's own
 * round-trip, vouched for by the operator, not by the bundle.
 *
 * `visibility` is deliberately NOT in this set. It is the page's
 * read-scope, and every token it can carry only NARROWS reach (a page
 * with no `visibility:` is reachable by every consumer; see
 * `graph/visibility.ts`). Stripping it could only widen what a page
 * exposes - a private page in the operator's own bundle would land
 * public in the review lane - while preserving it can at worst hide a
 * staged page from a remote read, which the review lane survives.
 */
const FOREIGN_MACHINERY_KEYS: ReadonlySet<string> = new Set([
  "_status",
  "_confidence",
  "_confidence_value",
  "_revision",
  "_content_hash",
  "_force_confirmed_via",
  "origin_channel",
  "owner",
  "okf_review",
  // The knowledge-pack provenance stamp: written by the pack installer
  // after this strip, so a bundle cannot enrol a page in a pack's uninstall.
  KNOWLEDGE_PACK_FIELD,
  // The staged page's install-time fingerprint, same rule as the stamp.
  KNOWLEDGE_PACK_SHA_FIELD,
]);

/**
 * A copy of `meta` without this system's machinery keys (see
 * {@link FOREIGN_MACHINERY_KEYS}). The knowledge-pack export runs every
 * selected page through it: a pack is handed to someone else, and this
 * vault's lifecycle, write-accounting, transport and owner stamps are not
 * knowledge the recipient can use - the recipient's import strips them
 * anyway, so leaving them in would only widen what the file leaks.
 */
export function stripOkfMachinery(meta: FrontmatterMap): FrontmatterMap {
  const out: FrontmatterMap = { ...meta };
  for (const key of FOREIGN_MACHINERY_KEYS) delete out[key];
  return out;
}

/**
 * The Brain directories an OKF bundle carries pages for: exactly the two
 * lanes {@link buildOkfBundle} exports (`sources/` as references,
 * `reports/` as queries).
 */
const OKF_BRAIN_PAGE_LANES: ReadonlyArray<string> = Object.freeze([
  BRAIN_SOURCES_REL,
  BRAIN_REPORTS_REL,
]);

/**
 * The refusal reason for a recorded page path, or `null` when the path may
 * proceed into its lane. Two walls:
 *
 * 1. A recorded path is a vault-relative POSIX path: absolute, empty,
 *    backslash, `.`, and `..` segments are refused before any join.
 *    Refusing `..` is what keeps the review lane unescapable -
 *    `posix.join("OKF Review", "../Brain/standing-rules.md")` normalizes
 *    to `Brain/standing-rules.md`, which would let a hostile manifest
 *    plant machinery files straight into the live vault. Backslash is
 *    refused as a character because it is a separator on the Windows
 *    filesystems this project ships on, where a posix-string check would
 *    not see the escape.
 * 2. In trusted mode `Brain/` is machinery, not pages: only the two page
 *    lanes the exporter emits (`sources/`, `reports/`) are writable, and
 *    only because the operator passed `--trusted` - the bundle's
 *    `producer` claim plays no part. The Brain segment is compared
 *    case-insensitively (`brain/` opens `Brain/` on macOS and Windows).
 *    Review mode needs no such wall - wall 1 already guarantees staging
 *    stays under `OKF Review/`, where a Brain-shaped subpath is inert.
 */
function okfTargetRefusal(entryPath: string, trusted: boolean): string | null {
  if (
    entryPath.length === 0 ||
    entryPath.startsWith("/") ||
    entryPath.includes("\\") ||
    entryPath.split("/").some((s) => s.length === 0 || s === "." || s === "..")
  ) {
    return `recorded path must be a relative POSIX path with no empty, '.', '..', or backslash segments: ${entryPath}`;
  }
  if (trusted && isUnderBrainRoot(entryPath) && !isInBrainLane(entryPath, OKF_BRAIN_PAGE_LANES)) {
    return (
      `trusted import refuses Brain machinery paths except the ` +
      `${BRAIN_SOURCES_REL}/ and ${BRAIN_REPORTS_REL}/ page lanes: ${entryPath}`
    );
  }
  return null;
}

/**
 * Read the native-key coverage a page's {@link RAW_CARRY_KEY} marker
 * declares. A bare `true` - the shape every exporter stamped before the
 * marker could carry a list - covers exactly the old three-key set
 * ({@link RAW_CARRY_TRUE_NATIVES}); a list of native names covers what
 * it names, so an exporter managing a different set declares it instead
 * of the import guessing. An unrecognized shape still says legacy
 * raw-carrying. An ABSENT marker (a page whose raw keys survived while
 * the marker was lost) declares nothing extra: the present raw keys
 * restore their own pairs, and nothing else is dropped.
 */
function rawCarryDeclaredNatives(marker: FrontmatterValue | undefined): ReadonlySet<string> {
  if (marker === undefined) return new Set();
  if (Array.isArray(marker)) {
    return new Set(marker.filter((item): item is string => typeof item === "string"));
  }
  return RAW_CARRY_TRUE_NATIVES;
}

/**
 * Restore the native frontmatter an own-producer export carried under
 * the producer namespace (the `okf_*_raw` keys), dropping the derived
 * v0.2 block the export wrote beside it. The operator's round-trip is
 * "restore the recorded state": a page quarantined before export lands
 * quarantined again instead of silently promoted to the enum's
 * `stable`, a completion status comes back itself, user-written sources
 * survive, and a page that never carried a status (or sources) again
 * does not. A raw key restores its native verbatim; a MISSING raw key
 * drops its derived value only when the page's marker declared that
 * pair (see {@link rawCarryDeclaredNatives}) - a fresh-export plain
 * page comes back without the derived status it never had, while a
 * legacy marker-bearing page keeps the native `type` its export rode
 * verbatim beside a marker that predates the type pair.
 *
 * The restore runs only on a page that declares raw-carrying: the
 * {@link RAW_CARRY_KEY} marker, or - saying the same thing when the
 * marker went missing - any present raw key, which no legacy bundle
 * ever wrote. A page with NEITHER is a legacy bundle's (exported
 * before the raw-carrying declaration existed - sealed knowledge-pack
 * halves accepted on purpose included), its natives are the
 * frontmatter already in place, and reading their absence as "never
 * had a value" deleted them. The restore is skipped for such a page,
 * so a legacy quarantine survives its own round-trip; a page that kept
 * its raw keys but lost the marker is restored anyway, instead of
 * stranding the keys beside the derived block they were written to
 * replace.
 */
function restoreRawOkfKeys(meta: FrontmatterMap): void {
  const marked =
    meta[RAW_CARRY_KEY] !== undefined || RAW_OKF_KEYS.some(({ raw }) => meta[raw] !== undefined);
  if (!marked) return;
  const declared = rawCarryDeclaredNatives(meta[RAW_CARRY_KEY]);
  delete meta[RAW_CARRY_KEY];
  for (const { raw, native } of RAW_OKF_KEYS) {
    // Presence, not shape: the raw value round-tripped through the page
    // file is whatever the export carried, and the restore replaces the
    // derived value with it verbatim - a numeric or whitespace status
    // included.
    if (meta[raw] !== undefined) meta[native] = meta[raw];
    else if (declared.has(native)) delete meta[native];
    delete meta[raw];
  }
}

/**
 * Compose the frontmatter a page lands with. Standard fields are taken
 * from the bundle file verbatim. This system's machinery keys (they are
 * server-stamped, not caller-supplied - see
 * {@link FOREIGN_MACHINERY_KEYS}) are stripped unless the operator
 * vouched for an own-producer bundle with `--trusted`. The native values
 * the export carried under the producer namespace are restored on every
 * OWN-producer path - the trusted round-trip and review staging alike,
 * where the staged page's `okf_review: pending` already keeps it out of
 * the live vault (see {@link restoreRawOkfKeys}). A bundle that declares
 * a foreign producer imports verbatim instead, shedding the raw keys so
 * no foreign page lands speaking this system's machinery namespace, and
 * gets provenance stamped (producer + raw foreign type) without
 * clobbering any such key the page already carries - preserving, never
 * overwriting, producer-specific metadata. Review-staged pages also get
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
  if (!trusted || foreign) {
    for (const key of FOREIGN_MACHINERY_KEYS) delete meta[key];
  }
  if (!foreign) {
    // The raw keys are this system's namespace, so the restore keys on
    // the producer alone - not on the operator's vouch. A forged
    // own-producer claim without --trusted still lands in the review
    // lane, where restoring the recorded status promotes nothing.
    restoreRawOkfKeys(meta);
  } else {
    // A foreign bundle's pages shed the raw keys and the raw-carry
    // marker: honoured on no path, kept on none either - a foreign
    // bundle must not plant stray restore machinery into the vault.
    for (const { raw } of RAW_OKF_KEYS) delete meta[raw];
    delete meta[RAW_CARRY_KEY];
  }
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
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const trusted = opts.trusted === true;
  const nowIso = isoSecond(opts.now ?? new Date());
  const written: string[] = [];
  const skipped: string[] = [];
  const errors: { path: string; message: string }[] = [];

  for (const page of bundle.pages) {
    // The lane check runs BEFORE any join: a recorded path that is not a
    // clean vault-relative POSIX path (or, in trusted mode, reaches into
    // Brain machinery) is reported as an error and never touches disk.
    const refusal = okfTargetRefusal(page.entry.path, trusted);
    if (refusal !== null) {
      errors.push({ path: page.entry.path, message: refusal });
      continue;
    }
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
    const meta: FrontmatterMap = {
      ...importFrontmatter(page, bundle.manifest.producer, bundle.foreign, trusted, nowIso),
      ...opts.provenance,
    };
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
