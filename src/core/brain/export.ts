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
import { join, relative } from "node:path";

import { hostPathFreeReason } from "./host-path-free.ts";
import { parsePreference } from "./preference.ts";
import { brainDirs } from "./paths.ts";
import { vaultDisplayName } from "./templates.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_PREFERENCE_STATUS, type BrainPreference } from "./types.ts";
import { parseFrontmatter } from "../vault.ts";

export const BRAIN_EXPORT_SCHEMA_VERSION = 1 as const;

/** How many unreadable files the error names before it stops listing. */
const MAX_NAMED_PARSE_FAILURES = 10;

/**
 * One preference file the collector could not turn into a row, named the
 * way the operator sees it - relative to the vault, so the message is the
 * path they can open. Same shape as `ExplorerParseFailure`, because the
 * two surfaces report the same event over the same directory.
 */
export interface PreferenceParseFailure {
  readonly path: string;
  readonly reason: string;
}

/**
 * A preference file that could not be read into a row.
 *
 * Raised rather than skipped. The collector used to `continue` past a
 * caught parse error, which produced `"preferences": []` on a vault that
 * held rules, under exit code 0 and an empty stderr - an export that omits
 * a rule reads exactly like a vault that never had it, and the file that
 * would say otherwise is the one the recipient does not have. Every caller
 * of {@link collectExportRows} is composing something for a reader
 * (a bundle, a context pack, the topic map an import merges against), so
 * there is no caller for whom a shorter list is the right answer.
 */
export class PreferenceParseError extends Error {
  /** Vault-relative paths that failed, with the parser's own message. */
  readonly failures: ReadonlyArray<PreferenceParseFailure>;
  constructor(failures: ReadonlyArray<PreferenceParseFailure>) {
    const named = failures
      .slice(0, MAX_NAMED_PARSE_FAILURES)
      .map((f) => `${f.path} (${f.reason})`)
      .join("; ");
    const rest =
      failures.length > MAX_NAMED_PARSE_FAILURES
        ? ` and ${failures.length - MAX_NAMED_PARSE_FAILURES} more`
        : "";
    super(
      // Not "this export": the same collector backs the import's
      // topic map, and an import told its EXPORT is incomplete sends
      // the operator to the wrong end of the round trip.
      `${failures.length} preference file(s) could not be parsed, so Brain/preferences/ ` +
        `cannot be read completely: ${named}${rest}. Repair or remove them, then re-run; ` +
        "`o2b brain doctor` reports the same files.",
    );
    this.name = "PreferenceParseError";
    this.failures = failures;
  }
}

/**
 * What `o2b brain export --format` accepts.
 *
 * Closed, and a vocabulary rather than the type alias it used to be: the
 * alias was declared here and imported by nobody, while the verb compared
 * the raw argv string against two inline literals. A contract with nothing
 * behind it is not a contract - adding a third format meant editing a
 * comparison in the CLI and hoping this line was noticed. The guard is now
 * the boundary the argv value crosses, and the object's key set is what the
 * verb's dispatch table is typed against, so a format with no handler is a
 * compile error.
 *
 * `transcripts-jsonl` names its shape on purpose. `json` and `llms-txt`
 * each produce ONE document; this one produces a stream of records, and an
 * operator who redirects it into a `.json` file learns that from the flag
 * rather than from a parse error downstream.
 */
export const EXPORT_FORMAT = Object.freeze({
  json: "json",
  llmsTxt: "llms-txt",
  transcriptsJsonl: "transcripts-jsonl",
} as const);

export type ExportFormat = (typeof EXPORT_FORMAT)[keyof typeof EXPORT_FORMAT];

/** The formats, in the order the help text and the refusal message list them. */
export const EXPORT_FORMATS: ReadonlyArray<ExportFormat> = Object.freeze([
  EXPORT_FORMAT.json,
  EXPORT_FORMAT.llmsTxt,
  EXPORT_FORMAT.transcriptsJsonl,
]);

/** Takes `unknown`: the value arrives as a raw `--format` argument. */
export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === "string" && (EXPORT_FORMATS as ReadonlyArray<string>).includes(value);
}

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
 * Every row the walk produced, and every file it could not read.
 *
 * The pair, never one of them: a caller holding this has been told both
 * how much it got and how much it missed, which is the property
 * {@link collectExportRows}' refusal enforces for callers that cannot use
 * a partial answer.
 */
export interface PreferenceCollection {
  readonly rows: ReadonlyArray<ExportedPreferenceRow>;
  readonly failures: ReadonlyArray<PreferenceParseFailure>;
}

/**
 * Walk `Brain/preferences/`, parse every `pref-*.md`, and project to
 * the export row shape sorted by `id` for deterministic output.
 *
 * A file that cannot be read raises {@link PreferenceParseError} rather
 * than being skipped. Every failure in the directory is collected first,
 * so one run names all of them instead of making the operator repair one
 * file per re-run.
 *
 * @throws PreferenceParseError when any `pref-*.md` in the directory
 * cannot be parsed into a row.
 */
export function collectExportRows(vault: string): ReadonlyArray<ExportedPreferenceRow> {
  const { rows, failures } = collectPreferenceRows(vault);
  if (failures.length > 0) throw new PreferenceParseError(failures);
  return rows;
}

/**
 * The same walk, reporting its failures instead of raising them.
 *
 * Reserved for a caller that has a use for a partial answer AND reports
 * the gap. There is exactly one - the bank import's prior-topic map, which
 * reads the DESTINATION vault to learn which topics existing rules already
 * claim. `collectExportRows`' refusal is right for an export and wrong
 * there: one malformed rule already sitting in the destination would abort
 * an entire import, wholesale, on a condition unrelated to the bundle
 * being carried.
 *
 * Taking the failures without rendering them is the silent-drop defect
 * this module's refusal exists to prevent, so
 * {@link PreferenceRestoreResult.topicScanUnreadable} carries them all the
 * way to the operator's terminal.
 *
 * The directory LISTING failure still raises: it is a permission or
 * filesystem fault over the whole directory, not a per-file parse, and no
 * partial answer exists to give.
 */
export function collectPreferenceRows(vault: string): PreferenceCollection {
  const dir = brainDirs(vault).preferences;
  if (!existsSync(dir)) return { rows: [], failures: [] };
  const rows: ExportedPreferenceRow[] = [];
  const failures: PreferenceParseFailure[] = [];
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    // The directory exists - `existsSync` just said so - so a listing
    // failure is a permission or filesystem fault, not an empty Brain.
    // Returning `[]` here reported the second while the first was true.
    // Named vault-relative for the same reason the per-file failures are:
    // this collector is reachable from an MCP error path.
    const rel = relative(vault, dir);
    throw new Error(`cannot list ${rel}: ${hostPathFreeReason(err, vault, dir, rel)}`, {
      cause: err,
    });
  }
  for (const name of entries) {
    if (!name.startsWith("pref-") || !name.endsWith(".md")) continue;
    const abs = join(dir, name);
    const record = (err: unknown): void => {
      const rel = relative(vault, abs);
      // The parser's own message carries the absolute host path
      // (`BrainParseError` composes `<detail> (<path>)`, and a raw `node:fs`
      // failure embeds it too), and this refusal is reachable from an MCP
      // error path, where `src/mcp/tools.ts` forbids one. The `path` field
      // beside it is already vault-relative; the reason now matches.
      failures.push({ path: rel, reason: hostPathFreeReason(err, vault, abs, rel) });
    };
    let pref: BrainPreference;
    try {
      pref = parsePreference(abs);
    } catch (err) {
      record(err);
      continue;
    }
    // `parsePreference` deliberately drops the body. We re-parse the
    // file here to capture the markdown sections the agent wrote
    // (`## Principle`, `## Origin`, …) — those are the bytes a
    // consumer wants when sharing or system-prompt-injecting the
    // rule. A read failure here is the same defect as a frontmatter
    // one: the row would go out missing what the agent wrote.
    let body = "";
    try {
      const [, parsedBody] = parseFrontmatter(abs);
      body = parsedBody;
    } catch (err) {
      record(err);
      continue;
    }
    rows.push(toRow(pref, body));
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return { rows, failures };
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
