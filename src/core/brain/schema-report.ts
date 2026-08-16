import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { listVaultPages } from "../vault.ts";
import { loadBrainConfig } from "./policy.ts";
import { hostPathFreeReason } from "./host-path-free.ts";
import { brainDirs, vaultRelative } from "./paths.ts";
import { parsePreference, parseRetired } from "./preference.ts";
import {
  DEFAULT_SCHEMA_VOCAB,
  SCHEMA_VOCAB_CATEGORIES,
  normalizeSchemaToken,
  resolveSchemaVocabulary,
  type BrainSchemaVocabulary,
  type SchemaVocabularyCategory,
} from "./schema-vocab.ts";
import { parseSignal } from "./signal.ts";

export interface SchemaTokenUsage {
  readonly token: string;
  readonly count: number;
}

export type SchemaReportFinding =
  | {
      readonly kind: "unknown-token";
      readonly category: SchemaVocabularyCategory;
      readonly token: string;
      readonly path: string;
    }
  | {
      readonly kind: "unused-declaration";
      readonly category: SchemaVocabularyCategory;
      readonly token: string;
    }
  | {
      /**
       * A typed edge whose endpoint page types violate the schema
       * pack's `link_constraints`; the indexer's materialization
       * post-pass blocked it (write-time-integrity-governance).
       */
      readonly kind: "link-constraint-violation";
      readonly relation: string;
      readonly source: string;
      readonly target: string;
      readonly source_type: string | null;
      readonly target_type: string | null;
    }
  | {
      /**
       * An artifact this report could not read or parse
       * (a-label-is-not-a-boundary, U12).
       *
       * The scans used to let a parse failure escape the whole report,
       * so ONE malformed file cost the caller every finding in the
       * vault - from the two views (`lint`, `orphans`) whose entire
       * purpose is to report malformed files. The log scan had the
       * opposite failure and the same effect: a bare `catch { continue }`
       * over the read, so an unreadable shard contributed nothing and
       * said nothing.
       *
       * It is a FINDING rather than a raise because it is also a caveat
       * on the rest of the report: a token used only inside an artifact
       * that could not be read is invisible to the usage maps, so an
       * `unused-declaration` verdict computed beside one of these is not
       * final. Both views carry these for that reason.
       *
       * `path` is vault-relative like every other finding's, which is
       * also what keeps the absolute host path out of a payload that
       * lands in model context; `detail` is the failure with no location
       * in it, so a renderer supplies the location once.
       */
      readonly kind: "unreadable-artifact";
      readonly category: SchemaVocabularyCategory;
      readonly path: string;
      readonly detail: string;
    };

export interface BrainSchemaUsage {
  readonly preference_types: ReadonlyArray<SchemaTokenUsage>;
  readonly signal_types: ReadonlyArray<SchemaTokenUsage>;
  readonly page_types: ReadonlyArray<SchemaTokenUsage>;
  readonly log_event_kinds: ReadonlyArray<SchemaTokenUsage>;
}

export interface BrainSchemaReport {
  readonly schema_version: 1;
  readonly vocabulary: BrainSchemaVocabulary;
  readonly usage: BrainSchemaUsage;
  readonly findings: ReadonlyArray<SchemaReportFinding>;
}

export function buildSchemaReport(vault: string): BrainSchemaReport {
  const cfg = loadBrainConfig(vault);
  const vocabulary = resolveSchemaVocabulary(cfg.schema);
  const usageMaps = emptyUsageMaps();
  const findings: SchemaReportFinding[] = [];

  scanPreferences(vault, vocabulary, usageMaps.preference_types, findings);
  scanSignals(vault, vocabulary, usageMaps.signal_types, findings);
  scanPageTypes(vault, vocabulary, usageMaps.page_types, findings);
  scanLogEventKinds(vault, vocabulary, usageMaps.log_event_kinds, findings);
  addUnusedDeclarationFindings(cfg.schema ?? {}, usageMaps, findings);

  return deepFreezeReport({
    schema_version: 1,
    vocabulary,
    usage: {
      preference_types: freezeUsage(usageMaps.preference_types),
      signal_types: freezeUsage(usageMaps.signal_types),
      page_types: freezeUsage(usageMaps.page_types),
      log_event_kinds: freezeUsage(usageMaps.log_event_kinds),
    },
    findings: Object.freeze(findings.toSorted(compareFindings)),
  });
}

/**
 * The failure text with no host location in it.
 *
 * A {@link BrainParseError} already separates the two - `detail` is the
 * prose, `path` is the location - but the scans also meet plain
 * `node:fs` and YAML errors, and those carry the absolute path INSIDE
 * the message (`ENOENT: … open '/home/…/Brain/log/x.md'`). This report
 * states its locations as vault-relative paths in a `path` field, so the
 * detail is rewritten to match rather than trusted to be clean.
 *
 * The rewrite itself is {@link hostPathFreeReason}: the export collector
 * needs the identical guarantee for the identical reason, and two copies
 * would let one of them go stale on the next error shape.
 */
function locationFreeDetail(
  err: unknown,
  vault: string,
  absolutePath: string,
  rel: string,
): string {
  return hostPathFreeReason(err, vault, absolutePath, rel);
}

/**
 * Read one artifact, or record why it could not be read and move on.
 *
 * The scans reach files whose bytes this report does not control, which
 * is the point of the two views built on it: `lint` and `orphans` exist
 * to REPORT malformed artifacts. Letting the parse escape made one bad
 * file cost the caller every finding in the vault; swallowing it (the
 * log scan's `catch { continue }`) made the same file invisible. Neither
 * is an answer, so the failure becomes a row.
 */
function readArtifact<T>(
  vault: string,
  path: string,
  category: SchemaVocabularyCategory,
  findings: SchemaReportFinding[],
  read: (path: string) => T,
): T | undefined {
  try {
    return read(path);
  } catch (err) {
    const rel = vaultRelative(path, vault);
    findings.push({
      kind: "unreadable-artifact",
      category,
      path: rel,
      detail: locationFreeDetail(err, vault, path, rel),
    });
    return undefined;
  }
}

function scanPreferences(
  vault: string,
  vocabulary: BrainSchemaVocabulary,
  counts: Map<string, number>,
  findings: SchemaReportFinding[],
): void {
  const dirs = brainDirs(vault);
  for (const path of listMarkdown(dirs.preferences, "pref-")) {
    const pref = readArtifact(vault, path, "preference_types", findings, parsePreference);
    if (pref === undefined) continue;
    recordSchemaType(
      vault,
      path,
      "preference_types",
      pref.schema_type,
      vocabulary,
      counts,
      findings,
    );
  }
  for (const path of listMarkdown(dirs.retired, "ret-")) {
    const retired = readArtifact(vault, path, "preference_types", findings, parseRetired);
    if (retired === undefined) continue;
    recordSchemaType(
      vault,
      path,
      "preference_types",
      retired.schema_type,
      vocabulary,
      counts,
      findings,
    );
  }
}

function scanSignals(
  vault: string,
  vocabulary: BrainSchemaVocabulary,
  counts: Map<string, number>,
  findings: SchemaReportFinding[],
): void {
  const dirs = brainDirs(vault);
  for (const dir of [dirs.inbox, dirs.processed]) {
    for (const path of listMarkdown(dir, "sig-")) {
      const signal = readArtifact(vault, path, "signal_types", findings, parseSignal);
      if (signal === undefined) continue;
      recordSchemaType(
        vault,
        path,
        "signal_types",
        signal.schema_type,
        vocabulary,
        counts,
        findings,
      );
    }
  }
}

function scanPageTypes(
  vault: string,
  vocabulary: BrainSchemaVocabulary,
  counts: Map<string, number>,
  findings: SchemaReportFinding[],
): void {
  for (const page of listVaultPages(vault)) {
    const rel = vaultRelative(page.path, vault);
    if (rel === "Brain" || rel.startsWith("Brain/")) continue;
    const raw = page.metadata["schema_type"];
    if (typeof raw !== "string") continue;
    recordSchemaType(vault, page.path, "page_types", raw, vocabulary, counts, findings);
  }
}

const LOG_EVENT_HEADER_RE = /^##\s+\d{2}:\d{2}:\d{2}\s+([\p{L}][\p{L}\p{N}_-]*)\s*$/u;

function scanLogEventKinds(
  vault: string,
  vocabulary: BrainSchemaVocabulary,
  counts: Map<string, number>,
  findings: SchemaReportFinding[],
): void {
  for (const path of listMarkdown(brainDirs(vault).log, "")) {
    const text = readArtifact(vault, path, "log_event_kinds", findings, (p) =>
      readFileSync(p, "utf8"),
    );
    if (text === undefined) continue;
    for (const line of text.split(/\r?\n/)) {
      const match = LOG_EVENT_HEADER_RE.exec(line.trim());
      if (!match) continue;
      recordSchemaType(vault, path, "log_event_kinds", match[1]!, vocabulary, counts, findings);
    }
  }
}

function recordSchemaType(
  vault: string,
  path: string,
  category: SchemaVocabularyCategory,
  rawToken: string | undefined,
  vocabulary: BrainSchemaVocabulary,
  counts: Map<string, number>,
  findings: SchemaReportFinding[],
): void {
  if (rawToken === undefined) return;
  const token = normalizeSchemaToken(rawToken);
  counts.set(token, (counts.get(token) ?? 0) + 1);
  if (!vocabulary[category].includes(token)) {
    findings.push({
      kind: "unknown-token",
      category,
      token,
      path: vaultRelative(path, vault),
    });
  }
}

function addUnusedDeclarationFindings(
  declarations: Partial<Record<SchemaVocabularyCategory, ReadonlyArray<string>>>,
  usageMaps: Record<SchemaVocabularyCategory, Map<string, number>>,
  findings: SchemaReportFinding[],
): void {
  for (const category of SCHEMA_VOCAB_CATEGORIES) {
    const declared = declarations[category] ?? [];
    const builtin = new Set(DEFAULT_SCHEMA_VOCAB[category]);
    const used = usageMaps[category];
    for (const raw of declared) {
      const token = normalizeSchemaToken(raw);
      if (builtin.has(token)) continue;
      if (!used.has(token)) {
        findings.push({ kind: "unused-declaration", category, token });
      }
    }
  }
}

function listMarkdown(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".md"))
    .toSorted()
    .map((name) => join(dir, name));
}

function emptyUsageMaps(): Record<SchemaVocabularyCategory, Map<string, number>> {
  return {
    preference_types: new Map<string, number>(),
    signal_types: new Map<string, number>(),
    page_types: new Map<string, number>(),
    log_event_kinds: new Map<string, number>(),
  };
}

function freezeUsage(counts: Map<string, number>): ReadonlyArray<SchemaTokenUsage> {
  return Object.freeze(
    [...counts.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([token, count]) => Object.freeze({ token, count })),
  );
}

function compareFindings(a: SchemaReportFinding, b: SchemaReportFinding): number {
  return (
    a.kind.localeCompare(b.kind) ||
    ("category" in a ? a.category : "").localeCompare("category" in b ? b.category : "") ||
    ("token" in a ? a.token : "").localeCompare("token" in b ? b.token : "") ||
    ("path" in a ? a.path : "").localeCompare("path" in b ? b.path : "")
  );
}

function deepFreezeReport(report: BrainSchemaReport): BrainSchemaReport {
  Object.freeze(report.usage);
  return Object.freeze(report);
}
