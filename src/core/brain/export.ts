/**
 * Read-only export of `Brain/preferences/` for backup, prompt
 * injection, or sharing. Only the three active statuses
 * (`confirmed | unconfirmed | quarantine`) are included; retired
 * and signal artifacts are deliberately excluded.
 *
 * A preference the privacy deny markers reserve (`visibility: private`,
 * or an informal `access` / `confidentiality` / `sensitivity` marker) is
 * still collected and reported - in {@link PreferenceCollection.denied} -
 * but the shared lanes built on this module leave it out and name the
 * omission; there is no flag that carries a reserved rule through.
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

import { toPosix } from "../path-safety.ts";
import type { FrontmatterMap } from "../types.ts";
import { hostPathFreeReason } from "./host-path-free.ts";
import { parsePreference } from "./preference.ts";
import { brainDirs } from "./paths.ts";
import { vaultDisplayName } from "./templates.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_PREFERENCE_STATUS, type BrainPreference } from "./types.ts";
import {
  hasPrivacyDenyMarker,
  PRIVACY_DENY_MARKER_VALUES,
  PRIVACY_MARKER_KEYS,
} from "../graph/privacy-markers.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN, normToken, pageVisibility } from "../graph/visibility.ts";
import { parseFrontmatter } from "../vault.ts";

export const BRAIN_EXPORT_SCHEMA_VERSION = 1 as const;

/**
 * Why the collector denied a preference from the shared lanes. One value
 * today, matching `pageBlockReason`'s vocabulary in
 * `portability/knowledge-pack.ts`: a deny here is a visibility
 * reservation - the reserved token declared under `visibility:`, or an
 * informal privacy marker saying the same thing - and never a content
 * class, which this lane does not read.
 */
export const PREFERENCE_DENY_REASON = "visibility" as const;

/**
 * The frontmatter key whose value denied a shared lane a preference.
 *
 * `visibility` names the reserved token's own key; the other three are the
 * informal marker keys of {@link PRIVACY_MARKER_KEYS} (kept in sync by
 * construction - the runtime list below is built from that constant, and a
 * key added there flows into the denial vocabulary with it).
 */
export type PreferenceDenyKey = "visibility" | "access" | "confidentiality" | "sensitivity";

/** The denial keys, in the order the docs list them. */
export const PREFERENCE_DENY_KEYS: ReadonlyArray<PreferenceDenyKey> = Object.freeze([
  "visibility",
  ...PRIVACY_MARKER_KEYS,
]) as ReadonlyArray<PreferenceDenyKey>;

/** One preference a shared lane leaves out, named the way the rows name them. */
export interface PreferenceDenial {
  /** The denied row's id (`pref-<slug>`), as it appears in `rows`. */
  readonly id: string;
  /**
   * The reason CLASS, always the reserved-token class: a deny here is a
   * visibility reservation, never a content class. Kept verbatim so the
   * machine readers of the json envelope's `omitted`, the bundle's
   * `preferences_omitted` and the knowledge pack's `blocked` list keep
   * their vocabulary; the key below is the specific half.
   */
  readonly reason: typeof PREFERENCE_DENY_REASON;
  /**
   * The frontmatter key whose value made the denial, named `denied_by`
   * rather than `key` because the egress guard redacts every value under
   * a field name containing "key" - a denial report must survive its own
   * boundary. `visibility` when the reserved token under `visibility:`
   * denied, or the informal marker key (`access` / `confidentiality` /
   * `sensitivity`) that said the same thing. Canonical lower-case
   * spelling, whatever case the file used.
   */
  readonly denied_by: PreferenceDenyKey;
}

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
  /**
   * The preferences the privacy deny markers kept out of this export,
   * each named with its id and reason. Absent when empty, so a vault
   * with no reservation serialises byte-identically to the field-less
   * envelope and the schema stays 1 - an additive field, per the module's
   * own versioning rule. There is no override: the field reports what a
   * shared lane must never carry, so no flag fills it back in.
   */
  readonly omitted?: ReadonlyArray<PreferenceDenial>;
}

/**
 * Every row the walk produced, every file it could not read, and every
 * row the privacy deny markers keep out of the SHARED lanes.
 *
 * The triple, never one of them alone: a caller holding this has been
 * told how much it got, how much it missed, and what it must not carry.
 * `rows` stays complete on purpose - the import-side topic maps
 * (`preference-restore.ts`, `knowledge-pack.ts`) read the DESTINATION
 * vault to learn which topics existing rules claim, and a marker on a
 * rule does not unmake the rule - so denial is a report beside the rows,
 * not a filter inside the collector. The shared lanes filter at their
 * own composition seam and name what they leave out.
 */
export interface PreferenceCollection {
  readonly rows: ReadonlyArray<ExportedPreferenceRow>;
  readonly failures: ReadonlyArray<PreferenceParseFailure>;
  readonly denied: ReadonlyArray<PreferenceDenial>;
}

/**
 * Which frontmatter key, if any, denies this preference a shared lane?
 *
 * The same judgment `pageBlockReason` makes for pages in the knowledge
 * pack, read once here from the frontmatter map the collector already
 * parsed: a `visibility:` declaration carrying the reserved token, or an
 * informal privacy marker (`access: private` and its siblings) saying
 * what the reserved token says. A preference that declares only a
 * caller-scope token is a shared decision, not a reservation, and is
 * carried. The answer is the KEY that spoke, not just the fact of a
 * denial, so the stderr notice can name what the docs promise - the
 * reservation key that denied the row.
 */
export function deniedReservationKey(meta: FrontmatterMap): PreferenceDenyKey | null {
  if (pageVisibility(meta).includes(REMOTE_DENY_VISIBILITY_TOKEN)) return "visibility";
  if (!hasPrivacyDenyMarker(meta)) return null;
  // `hasPrivacyDenyMarker` just said some informal marker denies; name the
  // key that carries the deny value. The value reading mirrors the marker
  // module's own (a string, or an array of strings, normalised the same
  // way) - that reader is not exported there, and this module needs it
  // once, to answer WHICH key spoke rather than only whether one did.
  for (const key of Object.keys(meta)) {
    const canonical = PRIVACY_MARKER_KEYS.find((k) => normToken(k) === normToken(key));
    if (canonical === undefined) continue;
    const raw = meta[key];
    const values =
      typeof raw === "string"
        ? [raw]
        : Array.isArray(raw)
          ? raw.filter((v): v is string => typeof v === "string")
          : [];
    if (values.some((v) => PRIVACY_DENY_MARKER_VALUES.includes(normToken(v)))) {
      return canonical as PreferenceDenyKey;
    }
  }
  // Unreachable: `hasPrivacyDenyMarker` was true, so one of the marker
  // keys above carries a deny value and the loop already returned it.
  return null;
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
 *
 * A row the privacy deny markers reserve is reported in `denied` while
 * still parsed whole into `rows`; see {@link PreferenceCollection} for
 * why the split lives beside the rows and not inside them.
 */
export function collectPreferenceRows(vault: string): PreferenceCollection {
  const dir = brainDirs(vault).preferences;
  if (!existsSync(dir)) return { rows: [], failures: [], denied: [] };
  const rows: ExportedPreferenceRow[] = [];
  const failures: PreferenceParseFailure[] = [];
  const denied: PreferenceDenial[] = [];
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    // The directory exists - `existsSync` just said so - so a listing
    // failure is a permission or filesystem fault, not an empty Brain.
    // Returning `[]` here reported the second while the first was true.
    // Named vault-relative for the same reason the per-file failures are:
    // this collector is reachable from an MCP error path. Forward-slash on
    // every host, the one spelling a vault-relative path has on the wire.
    const rel = toPosix(relative(vault, dir));
    throw new Error(`cannot list ${rel}: ${hostPathFreeReason(err, vault, dir, rel)}`, {
      cause: err,
    });
  }
  for (const name of entries) {
    if (!name.startsWith("pref-") || !name.endsWith(".md")) continue;
    const abs = join(dir, name);
    const record = (err: unknown): void => {
      const rel = toPosix(relative(vault, abs));
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
    // The frontmatter map is already in hand at this line, so the
    // deny judgment reads it here rather than paying a second read.
    let body = "";
    let meta: FrontmatterMap = {};
    try {
      const [parsedMeta, parsedBody] = parseFrontmatter(abs);
      meta = parsedMeta;
      body = parsedBody;
    } catch (err) {
      record(err);
      continue;
    }
    const denyKey = deniedReservationKey(meta);
    if (denyKey !== null) {
      denied.push({ id: pref.id, reason: PREFERENCE_DENY_REASON, denied_by: denyKey });
    }
    rows.push(toRow(pref, body));
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  // The denial list sorts like the rows: it rides the json envelope's
  // `omitted`, the bank bundle's `preferences_omitted` and the stderr
  // notice, and a byte-deterministic export cannot leave it in
  // readdir order.
  denied.sort((a, b) => a.id.localeCompare(b.id));
  return { rows, failures, denied };
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

/**
 * The denying detail path beside {@link collectExportRows}: the same
 * walk, the same parse-failure refusal, and the denial list handed back
 * with `rows` still complete. For a caller that must see every row to
 * answer - the knowledge pack's selector resolution, which reports a
 * reserved rule as a named block rather than an unmatched selector.
 */
export function collectExportRowsWithDenials(vault: string): {
  readonly rows: ReadonlyArray<ExportedPreferenceRow>;
  readonly denied: ReadonlyArray<PreferenceDenial>;
} {
  const { rows, failures, denied } = collectPreferenceRows(vault);
  if (failures.length > 0) throw new PreferenceParseError(failures);
  return { rows, denied };
}

/**
 * The composition seam for everything handed to another reader - the
 * json envelope, the llms-txt document, the bank bundle: the denying
 * walk with `rows` narrowed to what a shared lane may carry. The
 * collector keeps `rows` complete for the import topic maps; the shared
 * lanes narrow here, where the omission is at hand to be named.
 */
export function collectSharedExportRows(vault: string): {
  readonly rows: ReadonlyArray<ExportedPreferenceRow>;
  readonly denied: ReadonlyArray<PreferenceDenial>;
} {
  const { rows, denied } = collectExportRowsWithDenials(vault);
  const reserved = new Set(denied.map((d) => d.id));
  return { rows: rows.filter((row) => !reserved.has(row.id)), denied };
}

/**
 * The stderr note naming the preferences a shared lane left out on a
 * visibility reservation, in the `contentClassOmissionNotice` shape:
 * counted, each item named with the reservation key that denied it, and a
 * remedy. The remedy names the reservation itself rather than an export
 * flag - a reserved rule never rides a shared lane, so the only way to
 * share it is to clear the reservation on the file, and the keys listed
 * are the ones this module reads.
 */
export function preferenceDenialNotice(denied: ReadonlyArray<PreferenceDenial>): string {
  const list = denied.map((d) => `${d.id} (${d.denied_by})`).join(", ");
  return (
    `note: ${denied.length} preference(s) left out on a visibility reservation: ${list}; ` +
    "no export flag carries them - clear the reservation " +
    "(visibility / access / confidentiality / sensitivity) on the preference file to share it\n"
  );
}

export function exportPreferencesJson(vault: string): ExportedPreferencesJson {
  const { rows, denied } = collectSharedExportRows(vault);
  return Object.freeze({
    schema: BRAIN_EXPORT_SCHEMA_VERSION,
    generated_at: isoSecond(),
    vault_basename: vaultDisplayName(vault),
    preferences: rows,
    // Absent-when-empty keeps a reservation-free vault's bytes exactly
    // what they always were.
    ...(denied.length > 0 ? { omitted: denied } : {}),
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

/** The llms-txt document beside the omissions its privacy policy made. */
export interface LlmsTxtExport {
  readonly text: string;
  readonly omitted: ReadonlyArray<PreferenceDenial>;
}

/**
 * Render the export as an [llmstxt.org](https://llmstxt.org) markdown
 * file: H1 title, blockquote summary, then an H2 per non-empty
 * status. Each preference becomes one bullet line of the form
 * `- <id> (topic: <topic>[, scope: <scope>]): <principle>`. Status
 * sections without any rows are omitted entirely.
 *
 * Reserved preferences (see {@link PreferenceCollection.denied}) appear
 * in neither the sections nor the bullets; the detailed variant returns
 * the omissions beside the text so a caller can name them, the same
 * additive report the json envelope carries.
 */
export function exportPreferencesLlmsTxtDetailed(vault: string): LlmsTxtExport {
  const { rows, denied } = collectSharedExportRows(vault);
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
  return { text: lines.join("\n"), omitted: denied };
}

/**
 * The stable string signature, kept for the SDK façade and every
 * existing reader: the detailed variant's text, unchanged in shape and
 * byte-for-byte identical when nothing is denied. The string variant
 * carries no denial report - visibility-reserved rows are left out
 * silently - so a caller that must name what stayed out uses
 * {@link exportPreferencesLlmsTxtDetailed}.
 */
export function exportPreferencesLlmsTxt(vault: string): string {
  return exportPreferencesLlmsTxtDetailed(vault).text;
}
