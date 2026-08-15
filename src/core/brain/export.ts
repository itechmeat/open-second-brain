/**
 * Read-only export of `Brain/preferences/` for backup, prompt
 * injection, or sharing. Only the three active statuses
 * (`confirmed | unconfirmed | quarantine`) are included; retired
 * and signal artifacts are deliberately excluded.
 *
 * llms-txt follows the [llmstxt.org](https://llmstxt.org) shape;
 * empty status sections are omitted so a single-status vault
 * renders one H2 rather than three.
 *
 * {@link BRAIN_EXPORT_SCHEMA_VERSION} versions the ENVELOPE, not the
 * row. A row gains fields additively - readers tolerate their absence
 * exactly as the frontmatter parsers do - so a consumer written against
 * an earlier export keeps working and no version dispatch is needed on
 * either side. A field that ever changes meaning or disappears is what
 * would force the version.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parsePreference } from "./preference.ts";
import { brainDirs } from "./paths.ts";
import { vaultDisplayName } from "./templates.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_PREFERENCE_STATUS, type BrainPreference } from "./types.ts";
import { parseFrontmatter } from "../vault.ts";

export const BRAIN_EXPORT_SCHEMA_VERSION = 1 as const;

export type ExportFormat = "json" | "llms-txt";

export interface ExportedPreferenceRow {
  readonly id: string;
  readonly topic: string;
  readonly scope: string | null;
  readonly status: BrainPreference["status"];
  readonly principle: string;
  readonly applied_count: number;
  readonly violated_count: number;
  readonly confidence: BrainPreference["confidence"];
  readonly confidence_value: number | null;
  readonly pinned: boolean;
  readonly last_evidence_at: string | null;
  readonly created_at: string;
  readonly confirmed_at: string | null;
  /**
   * End of the trial window. Every preference write requires it and no
   * other exported field can stand in for it, so an export without it
   * cannot be restored: the restore would have to invent a window, and
   * an invented trial window silently re-dates a rule's promotion
   * deadline. Carried so `importBankBundle` can hand it back to
   * `writePreferenceTxn` verbatim.
   */
  readonly unconfirmed_until: string;
  /**
   * Monotonic write counter (`_revision`). The only ordering that lets a
   * restore tell "this bundle is ahead of the vault" from "this bundle
   * would rewind an edit the operator has since made". Absent on disk
   * reads as `0`, the same absent-as-zero convention the parser uses.
   */
  readonly revision: number;
  readonly aliases: ReadonlyArray<string> | null;
  readonly tags: ReadonlyArray<string>;
  readonly evidenced_by: ReadonlyArray<string>;
  /**
   * Markdown body after the frontmatter — carries the `## Principle`,
   * `## Origin`, `## How to apply` (and similar) narrative sections.
   * The `principle` field above is the headline copy; the body is the
   * fuller context a consumer needs when sharing or injecting the
   * rule into a system prompt.
   */
  readonly body: string;
}

export interface ExportedPreferencesJson {
  readonly schema: typeof BRAIN_EXPORT_SCHEMA_VERSION;
  readonly generated_at: string;
  readonly vault_basename: string;
  readonly preferences: ReadonlyArray<ExportedPreferenceRow>;
}

/**
 * Walk `Brain/preferences/`, parse every `pref-*.md`, and project to
 * the export row shape sorted by `id` for deterministic output.
 * Files that fail to parse are silently skipped — the doctor surface
 * is the canonical place for surfacing those, not the read-only
 * exporter.
 */
export function collectExportRows(vault: string): ReadonlyArray<ExportedPreferenceRow> {
  const dir = brainDirs(vault).preferences;
  if (!existsSync(dir)) return [];
  const rows: ExportedPreferenceRow[] = [];
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (!name.startsWith("pref-") || !name.endsWith(".md")) continue;
    const abs = join(dir, name);
    let pref: BrainPreference;
    try {
      pref = parsePreference(abs);
    } catch {
      continue;
    }
    // `parsePreference` deliberately drops the body. We re-parse the
    // file here to capture the markdown sections the agent wrote
    // (`## Principle`, `## Origin`, …) — those are the bytes a
    // consumer wants when sharing or system-prompt-injecting the
    // rule. A read failure here drops the row entirely.
    let body = "";
    try {
      const [, parsedBody] = parseFrontmatter(abs);
      body = parsedBody;
    } catch {
      continue;
    }
    rows.push(toRow(pref, body));
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}

function toRow(p: BrainPreference, body: string): ExportedPreferenceRow {
  return Object.freeze({
    id: p.id,
    topic: p.topic,
    scope: p.scope ?? null,
    status: p.status,
    principle: p.principle,
    applied_count: p.applied_count,
    violated_count: p.violated_count,
    confidence: p.confidence,
    confidence_value: p.confidence_value,
    pinned: p.pinned,
    last_evidence_at: p.last_evidence_at,
    created_at: p.created_at,
    confirmed_at: p.confirmed_at,
    unconfirmed_until: p.unconfirmed_until,
    // Absent-as-zero, the convention `BrainPreference.revision`'s reader
    // already uses: a file written before `_revision` existed is at 0,
    // which is behind every later write and ahead of nothing.
    revision: p.revision ?? 0,
    aliases: p.aliases ? Object.freeze([...p.aliases]) : null,
    tags: Object.freeze([...p.tags]),
    evidenced_by: Object.freeze([...p.evidenced_by]),
    body,
  });
}

export function exportPreferencesJson(vault: string): ExportedPreferencesJson {
  return Object.freeze({
    schema: BRAIN_EXPORT_SCHEMA_VERSION,
    generated_at: isoSecond(),
    vault_basename: vaultDisplayName(vault),
    preferences: collectExportRows(vault),
  });
}

const LLMS_TXT_SECTION_ORDER: ReadonlyArray<BrainPreference["status"]> = [
  BRAIN_PREFERENCE_STATUS.confirmed,
  BRAIN_PREFERENCE_STATUS.unconfirmed,
  BRAIN_PREFERENCE_STATUS.quarantine,
];

const LLMS_TXT_SECTION_LABEL: Readonly<Record<BrainPreference["status"], string>> = {
  [BRAIN_PREFERENCE_STATUS.confirmed]: "Confirmed",
  [BRAIN_PREFERENCE_STATUS.unconfirmed]: "Unconfirmed",
  [BRAIN_PREFERENCE_STATUS.quarantine]: "Quarantine",
};

/**
 * Render the export as an [llmstxt.org](https://llmstxt.org) markdown
 * file: H1 title, blockquote summary, then an H2 per non-empty
 * status. Each preference becomes one bullet line of the form
 * `- <id> (topic: <topic>[, scope: <scope>]): <principle>`. Status
 * sections without any rows are omitted entirely.
 */
export function exportPreferencesLlmsTxt(vault: string): string {
  const rows = collectExportRows(vault);
  const name = vaultDisplayName(vault);
  const lines: string[] = [
    `# ${name} — Brain preferences`,
    "",
    `> Active preferences captured by Open Second Brain. Auto-generated`,
    `> by \`o2b brain export --format llms-txt\`. The canonical files`,
    `> live under \`<vault>/Brain/preferences/\`.`,
    "",
  ];
  for (const status of LLMS_TXT_SECTION_ORDER) {
    const subset = rows.filter((r) => r.status === status);
    if (subset.length === 0) continue;
    lines.push(`## ${LLMS_TXT_SECTION_LABEL[status]}`);
    lines.push("");
    for (const r of subset) {
      const scopeBit = r.scope ? `, scope: ${r.scope}` : "";
      lines.push(`- ${r.id} (topic: ${r.topic}${scopeBit}): ${r.principle}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
