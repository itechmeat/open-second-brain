/**
 * The store record of one legacy item, for every stream mapping of the
 * migration (task 2.1). Each function is the live dual write of that item
 * replayed over what is already on disk: the same phase 1 builder
 * (`store/dual-write-records.ts`), and the same privacy judge the live
 * writer runs, so a migrated record lands in the partition the live write
 * would have chosen and has the same body shape.
 *
 * A function throws {@link LegacyItemShapeError} when the item is not the
 * shape its surface writes (a line that is valid JSON but not an object,
 * a log row without its kind). The dry run reports such an item as
 * unparseable, with its path and line.
 *
 * Judges read pages from the vault (`isPrivatePageFile` and the reference
 * resolvers) and never write.
 */

import { basename, dirname, relative, sep } from "node:path";

import { BRAIN_PENDING_REL } from "../brain/path-constants.ts";
import { continuityRowRecord } from "../brain/continuity/store.ts";
import type { ContinuityRecord } from "../brain/continuity/types.ts";
import { RECEIPT_OPAQUE_FIELDS } from "../brain/idempotency-ledger.ts";
import { DERIVED_FIELDS, normalizeDerivedKeys, withPreferenceProse } from "../brain/preference.ts";
import { ORIGIN_CHANNEL, ORIGIN_CHANNEL_FIELD } from "../origin-channel.ts";
import {
  LOG_CHAIN_FIELDS,
  logEventPrivacyContent,
  reconcileTopicPreferenceId,
  type BrainLogEntry,
} from "../brain/log.ts";
import { auditRowNamesPrivatePage, type AuditRecord } from "../reliability/audit.ts";
import type { Authority } from "../store/constants.ts";
import type { FrontmatterMap } from "../types.ts";
import {
  auditRowRecord,
  DUAL_WRITE_LEDGERS,
  isPrivatePageFile,
  isPrivatePreference,
  ledgerRowRecord,
  logEventRecord,
  pinnedRecord,
  preferenceFields,
  preferenceSetRecord,
  signalRecord,
  truthClaimRowRecord,
  type RowPartition,
} from "../store/dual-write-records.ts";
import { isRecordLabel } from "../store/envelope.ts";
import {
  callerInput,
  operationPrivacy,
  PREFERENCE_OPAQUE_FIELDS,
  SIGNAL_OPAQUE_FIELDS,
} from "../store/operation-privacy.ts";
import {
  claimSourceIsPrivate,
  logRefsNamePrivatePage,
  pinnedTextIsPrivate,
  rowNamesPrivatePage,
} from "../store/reference-privacy.ts";
import type { LegacyItem, RecordFromItem } from "./destinations.ts";

/** A legacy item that is not the shape its surface writes. */
export class LegacyItemShapeError extends Error {
  override readonly name = "LegacyItemShapeError";
}

/**
 * The authority of a preference or pinned context seeded from the legacy
 * tree. The legacy files do not record who decided each field, so a seed
 * carries the weakest authority a writer of the file had: any later human
 * record still wins over it.
 */
export const LEGACY_SEED_AUTHORITY: Authority = "agent";

type Row = Record<string, unknown>;

function rowOf(item: LegacyItem): Row {
  const value = item.shape === "line" ? item.row : item.shape === "json-file" ? item.value : null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LegacyItemShapeError("not a JSON object");
  }
  return value as Row;
}

function pageOf(item: LegacyItem): Extract<LegacyItem, { shape: "page" }> {
  if (item.shape !== "page") throw new LegacyItemShapeError("not a Markdown page");
  return item;
}

function stringField(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value === "") {
    throw new LegacyItemShapeError(`missing the string field ${field}`);
  }
  return value;
}

/** A ledger whose rows go to `shared` unless a row names a private page. */
export function sharedUnlessNamed(ledger: string): RecordFromItem {
  return (vault, item) => {
    const row = rowOf(item);
    return ledgerRowRecord(ledger, row, rowNamesPrivatePage(vault, row) ? "private" : "shared");
  };
}

/** A ledger whose rows say what this machine or its user did: `private` when held. */
export function privateWhenHeld(ledger: string): RecordFromItem {
  return (vault, item) => {
    const row = rowOf(item);
    const partition: RowPartition = rowNamesPrivatePage(vault, row)
      ? "private"
      : "private-when-held";
    return ledgerRowRecord(ledger, row, partition);
  };
}

/**
 * One row of an audit trail (`reliability/audit.ts`). Every trail shares
 * one store ledger, and the directory the week shard sits in names the
 * trail (`audit_dir`), as the live writer records it.
 */
export const auditTrailRow: RecordFromItem = (vault, item) => {
  const record = rowOf(item) as unknown as AuditRecord;
  return auditRowRecord(
    DUAL_WRITE_LEDGERS.reliabilityAudit,
    { audit_dir: basename(dirname(item.path)), record },
    isRecordLabel(record.actor) ? record.actor : undefined,
    auditRowNamesPrivatePage(vault, record),
  );
};

/**
 * One Brain log JSONL row (`{ ts, kind, payload, prev, h }`). The hash
 * chain stays inside the body, beside the payload keys, as design D11
 * asks; the partition is the one `appendLogEvent` judges.
 */
export const logEventRow: RecordFromItem = (vault, item) => {
  const row = rowOf(item);
  const payload = row["payload"];
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new LegacyItemShapeError("missing the payload object");
  }
  const entry = {
    timestamp: stringField(row, "ts"),
    eventType: stringField(row, "kind"),
    body: payload as Row,
  } as BrainLogEntry;
  const guessed = reconcileTopicPreferenceId(entry);
  const isPrivate = operationPrivacy(vault, {
    inherit: [() => guessed !== undefined && logRefsNamePrivatePage(vault, [guessed], guessed)],
    content: [logEventPrivacyContent(entry.body)],
  });
  const chain: Row = {};
  for (const field of Object.values(LOG_CHAIN_FIELDS)) {
    if (field in row) chain[field] = row[field];
  }
  // The legacy renderer keeps the chain keys beside the payload in one
  // row, so they never collide with a payload key.
  return logEventRecord({ ...entry, body: { ...entry.body, ...chain } }, isPrivate());
};

/** One continuity record, partitioned as `continuity/store.ts` does. */
export const continuityRow: RecordFromItem = (vault, item) =>
  continuityRowRecord(vault, rowOf(item) as unknown as ContinuityRecord);

/** One preference-audit row: `private` when the preference it is about is private. */
export const prefAuditRow: RecordFromItem = (vault, item) => {
  const row = rowOf(item);
  const prefId = stringField(row, "pref_id");
  const agent = typeof row["agent"] === "string" ? row["agent"] : undefined;
  return auditRowRecord(
    DUAL_WRITE_LEDGERS.preferenceAudit,
    row,
    agent,
    isPrivatePreference(vault, prefId.replace(/^pref-/, "")),
  );
};

/** One recurrence event: its source is judged as a claim source is. */
export const recurrenceRow: RecordFromItem = (vault, item) => {
  const row = rowOf(item);
  const source = typeof row["sourceId"] === "string" ? row["sourceId"] : "";
  const isPrivate = claimSourceIsPrivate(vault, source) || rowNamesPrivatePage(vault, row);
  return ledgerRowRecord(DUAL_WRITE_LEDGERS.recurrence, row, isPrivate ? "private" : "shared");
};

/** One idempotency receipt; its key, hashes and stamps are never judged as references. */
export const idempotencyRow: RecordFromItem = (vault, item) => {
  const row = rowOf(item);
  const isPrivate = rowNamesPrivatePage(vault, row, RECEIPT_OPAQUE_FIELDS);
  return ledgerRowRecord(DUAL_WRITE_LEDGERS.idempotency, row, isPrivate ? "private" : "shared");
};

/** One truth claim: `private` only when its source is a private page. */
export const truthClaimRow: RecordFromItem = (vault, item) => {
  const row = rowOf(item);
  const source = typeof row["source"] === "string" ? row["source"] : "";
  return truthClaimRowRecord(row, claimSourceIsPrivate(vault, source));
};

/** One git ledger row, wrapped with its repository key (`git/store.ts`). */
export const gitCommitRow: RecordFromItem = (_vault, item) => {
  const record = rowOf(item);
  if (item.shape !== "line") throw new LegacyItemShapeError("not a ledger line");
  return ledgerRowRecord(
    DUAL_WRITE_LEDGERS.gitCommits,
    { repo_key: basename(dirname(item.path)), record },
    "private-when-held",
  );
};

/** The stem `pref-<slug>.history` of an edit-history shard name. */
const HISTORY_SHARD_RE = /^pref-(.+)\.history(?:\.[a-z0-9-]{1,32})?\.jsonl$/;

/** One edit-history entry, wrapped with its preference slug (`health/edit-history.ts`). */
export const editHistoryRow: RecordFromItem = (vault, item) => {
  const entry = rowOf(item);
  if (item.shape !== "line") throw new LegacyItemShapeError("not a ledger line");
  const slug = HISTORY_SHARD_RE.exec(basename(item.path))?.[1];
  if (slug === undefined) throw new LegacyItemShapeError("not an edit-history shard name");
  const isPrivate = rowNamesPrivatePage(vault, `pref-${slug}`) || rowNamesPrivatePage(vault, entry);
  return ledgerRowRecord(
    DUAL_WRITE_LEDGERS.editHistory,
    { slug, entry },
    isPrivate ? "private" : "shared",
  );
};

/** The id a signal page carries, or its file name. */
function signalId(page: Extract<LegacyItem, { shape: "page" }>): string {
  const id = page.frontmatter["id"];
  return typeof id === "string" && id !== "" ? id : basename(page.path, ".md");
}

/** One signal page, judged as `writeSignal` judges the signal it writes. */
export const signalPage: RecordFromItem = (vault, item) => {
  const page = pageOf(item);
  const isPrivate = operationPrivacy(vault, {
    target: () => isPrivatePageFile(page.path),
    content: [callerInput(page.frontmatter, SIGNAL_OPAQUE_FIELDS), { value: page.body }],
  });
  const staged = vaultRelDir(vault, page.path) === BRAIN_PENDING_REL;
  return signalRecord({
    vault,
    path: page.path,
    id: signalId(page),
    staged,
    frontmatter: page.frontmatter,
    raw: page.body.trim() === "" ? undefined : page.body,
    rawShape: "page",
    private: isPrivate(),
  });
};

function vaultRelDir(vault: string, path: string): string {
  return relative(vault, dirname(path)).split(sep).join("/");
}

/** `pref-<slug>` for an active (`pref-x.md`) or retired (`ret-x.md`) page. */
function preferenceId(page: Extract<LegacyItem, { shape: "page" }>): string {
  const stem = basename(page.path, ".md");
  return `pref-${stem.replace(/^(pref|ret)-/, "")}`;
}

/**
 * Whether a legacy page records a human decision: it was written through
 * the CLI (`origin_channel: cli`, the channel `authorityFromOrigin` reads
 * as human), or it is pinned, which only the CLI-only `o2b brain pin` sets.
 */
export function pageRecordsHumanDecision(frontmatter: Readonly<Record<string, unknown>>): boolean {
  return frontmatter[ORIGIN_CHANNEL_FIELD] === ORIGIN_CHANNEL.cli || frontmatter["pinned"] === true;
}

const DERIVED = new Set(DERIVED_FIELDS);

function canonicalFrontmatter(
  frontmatter: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  try {
    return normalizeDerivedKeys({ ...frontmatter });
  } catch {
    return { ...frontmatter }; // both spellings present: keep the page as it is
  }
}

/**
 * One preference page (active or retired), as seed `preference-set`
 * records: one at agent authority, or, when the page records a human
 * decision, the human fields at human authority and the fields the dream
 * pass derives at agent authority (as `preference.ts` splits a human write).
 */
export const preferencePage: RecordFromItem = (vault, item) => {
  const page = pageOf(item);
  // The page's prose rides as the `text` field (FORMAT.md, Preferences), so
  // a rebuilt or rolled-back page keeps the body the fields do not render.
  const frontmatter = withPreferenceProse(
    canonicalFrontmatter(page.frontmatter),
    page.frontmatter as FrontmatterMap,
    page.body,
    page.frontmatter["kind"] === "brain-retired",
  );
  const fields = preferenceFields(frontmatter);
  const isPrivate =
    isPrivatePageFile(page.path) || rowNamesPrivatePage(vault, fields, PREFERENCE_OPAQUE_FIELDS);
  const id = preferenceId(page);
  if (!pageRecordsHumanDecision(frontmatter)) {
    return preferenceSetRecord({
      id,
      frontmatter,
      authority: LEGACY_SEED_AUTHORITY,
      private: isPrivate,
    });
  }
  const own: Record<string, unknown> = {};
  const derived: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(frontmatter)) {
    (DERIVED.has(name) ? derived : own)[name] = value;
  }
  const scope = typeof fields["scope"] === "string" ? fields["scope"] : null;
  return [
    preferenceSetRecord({ id, frontmatter: own, authority: "human", private: isPrivate }),
    preferenceSetRecord({ id, frontmatter: derived, authority: "agent", private: isPrivate }),
  ].flatMap((record) => (record === null ? [] : [{ ...record, scope }]));
};

/** The pinned context file, as one `pinned-set` (an empty file as a `pinned-clear`). */
export const pinnedText: RecordFromItem = (vault, item) => {
  if (item.shape !== "text") throw new LegacyItemShapeError("not a text file");
  const content = item.text.trimEnd();
  if (content === "") return pinnedRecord(null, LEGACY_SEED_AUTHORITY, false);
  return pinnedRecord(content, LEGACY_SEED_AUTHORITY, pinnedTextIsPrivate(vault, content));
};
