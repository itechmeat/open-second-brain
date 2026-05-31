import { createHash } from "node:crypto";

import { collectExportRows } from "../export.ts";
import { contextSafetyReport, guardBrainContextSnippet } from "../safety/context-guard.ts";

export interface KnowledgePackPreviewEntry {
  readonly id: string;
  readonly topic: string;
  readonly status: string;
  readonly provenance: string;
  readonly sample: string;
}

export interface KnowledgePackPrivacyWarning {
  readonly id: string;
  readonly reasons: ReadonlyArray<string>;
}

export interface KnowledgePackPreview {
  readonly schema: 1;
  readonly count: number;
  readonly entries: ReadonlyArray<KnowledgePackPreviewEntry>;
  readonly privacyWarnings: ReadonlyArray<KnowledgePackPrivacyWarning>;
  readonly integrity: { readonly sha256: string };
}

export function buildKnowledgePackPreview(
  vault: string,
  opts: { readonly ids?: ReadonlyArray<string> } = {},
): KnowledgePackPreview {
  const selected = new Set(opts.ids ?? []);
  const rows = collectExportRows(vault)
    .filter((row) => selected.size === 0 || selected.has(row.id))
    .toSorted((a, b) => a.id.localeCompare(b.id));

  const warnings: KnowledgePackPrivacyWarning[] = [];
  const entries: KnowledgePackPreviewEntry[] = [];
  for (const row of rows) {
    const guarded = guardBrainContextSnippet(`${row.principle}\n${row.body}`, {
      source: {
        id: row.id,
        metadata: { topic: row.topic, principle: row.principle },
      },
    });
    const safety = contextSafetyReport(guarded);
    if (safety?.filtered) {
      warnings.push({
        id: row.id,
        reasons: Object.freeze(safety.reasons.map((reason) => reason.code)),
      });
    }
    entries.push({
      id: row.id,
      topic: row.topic,
      status: row.status,
      provenance: `Brain/preferences/${row.id}.md`,
      sample: guarded.safeText.slice(0, 240),
    });
  }

  const integrityBody = JSON.stringify(entries);
  return Object.freeze({
    schema: 1,
    count: entries.length,
    entries: Object.freeze(entries),
    privacyWarnings: Object.freeze(warnings),
    integrity: Object.freeze({
      sha256: createHash("sha256").update(integrityBody, "utf8").digest("hex"),
    }),
  });
}
