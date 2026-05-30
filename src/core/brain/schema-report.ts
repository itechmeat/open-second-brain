import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { listVaultPages } from "../vault.ts";
import { loadBrainConfig } from "./policy.ts";
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

function scanPreferences(
  vault: string,
  vocabulary: BrainSchemaVocabulary,
  counts: Map<string, number>,
  findings: SchemaReportFinding[],
): void {
  const dirs = brainDirs(vault);
  for (const path of listMarkdown(dirs.preferences, "pref-")) {
    const pref = parsePreference(path);
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
    const retired = parseRetired(path);
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
  for (const path of listMarkdown(dirs.inbox, "sig-")) {
    const signal = parseSignal(path);
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
  for (const path of listMarkdown(dirs.processed, "sig-")) {
    const signal = parseSignal(path);
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
    recordSchemaType(
      vault,
      page.path,
      "page_types",
      raw,
      vocabulary,
      counts,
      findings,
    );
  }
}

const LOG_EVENT_HEADER_RE =
  /^##\s+\d{2}:\d{2}:\d{2}\s+([\p{L}][\p{L}\p{N}_-]*)\s*$/u;

function scanLogEventKinds(
  vault: string,
  vocabulary: BrainSchemaVocabulary,
  counts: Map<string, number>,
  findings: SchemaReportFinding[],
): void {
  for (const path of listMarkdown(brainDirs(vault).log, "")) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = LOG_EVENT_HEADER_RE.exec(line.trim());
      if (!match) continue;
      recordSchemaType(
        vault,
        path,
        "log_event_kinds",
        match[1]!,
        vocabulary,
        counts,
        findings,
      );
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
  declarations: Partial<
    Record<SchemaVocabularyCategory, ReadonlyArray<string>>
  >,
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

function emptyUsageMaps(): Record<
  SchemaVocabularyCategory,
  Map<string, number>
> {
  return {
    preference_types: new Map<string, number>(),
    signal_types: new Map<string, number>(),
    page_types: new Map<string, number>(),
    log_event_kinds: new Map<string, number>(),
  };
}

function freezeUsage(
  counts: Map<string, number>,
): ReadonlyArray<SchemaTokenUsage> {
  return Object.freeze(
    [...counts.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([token, count]) => Object.freeze({ token, count })),
  );
}

function compareFindings(
  a: SchemaReportFinding,
  b: SchemaReportFinding,
): number {
  return (
    a.kind.localeCompare(b.kind) ||
    a.category.localeCompare(b.category) ||
    a.token.localeCompare(b.token) ||
    ("path" in a ? a.path : "").localeCompare("path" in b ? b.path : "")
  );
}

function deepFreezeReport(report: BrainSchemaReport): BrainSchemaReport {
  Object.freeze(report.usage);
  return Object.freeze(report);
}
