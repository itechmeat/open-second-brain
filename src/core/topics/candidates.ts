/**
 * The records topic planning groups into topics (design D9; task 3.4):
 * captured signals and the log events a person would read (notes and
 * decisions), each with its text, its project, its session and whether
 * it is private.
 *
 *  - **Project.** The `project` the record names (a signal's frontmatter,
 *    a log event's body), normalised as every scope key is
 *    (`scope-key.ts`); `null` when it names none.
 *  - **Session.** The `session` the record names, else its `session_ref`,
 *    else the device, agent and UTC day that wrote it: records of one
 *    agent on one machine on one day count as one session, so a single
 *    busy session never makes a topic on its own (spec "One busy session
 *    does not make a topic").
 *  - **Origin.** When and where the record was written: its clock and
 *    device, except for a record the store migration imported, whose
 *    clock is the migration's and whose device is the migrating machine.
 *    Such a record is dated by its legacy item instead (a log event's
 *    `timestamp`, a signal's `created_at`, else the date in the legacy
 *    file name, else the migration's clock) and placed on the device of
 *    the legacy shard it came from (`legacy_device`; a page names none,
 *    so the migrating machine stands in). The origin is the session
 *    fallback and the candidate's `at`, so a migrated history keeps its
 *    days, its order and its age. The record itself is not changed.
 *
 * A signal a `signal-removed` record forgot is left out. The text is
 * taken with every `<private>` region removed, tags and placeholder
 * included: a word that exists only inside a region never groups,
 * routes, titles or describes a topic, and never reaches a derived
 * item or a decision model, whatever the egress rule allows for the
 * record itself. A record whose text is all region is left out. Pure.
 */

import { PRIVATE_REGION_PLACEHOLDER, stripPrivateRegions } from "../redactor.ts";
import { scopeFromFrontmatter } from "../scope-key.ts";
import { LOG_EVENT_KIND, SIGNAL_KIND } from "../store/constants.ts";
import type { StoreRecord } from "../store/envelope.ts";
import { SIGNAL_REMOVED_KIND } from "../store/fold-signals.ts";
import { parseHlc } from "../store/hlc.ts";
import { valueCarriesPrivateRegion } from "../store/private-region.ts";
import { LEGACY_DEVICE_FIELD, migratedMark } from "../store-migration/migration-records.ts";

/** Log event types whose text a person would read on a topic. */
const READABLE_EVENTS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  note: ["text"],
  "decision-record": ["chosen", "decision"],
  "decision-resolved": ["choice"],
});

export interface TopicCandidate {
  readonly id: string;
  readonly text: string;
  /** The project the record names, or `null`. */
  readonly project: string | null;
  readonly session: string;
  /** When the record was written, in ms: its physical clock, or a migrated record's original time. */
  readonly at: number;
  readonly private: boolean;
  /** The envelope `topic` the record was written under, or `null`. */
  readonly topic: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A `YYYY-MM-DD` day in a legacy file name (`2026-09-01.dev-a.jsonl`, `sig-2026-09-01-x.md`). */
const FILE_DAY_RE = /(?:^|[^0-9])(\d{4}-\d{2}-\d{2})(?![0-9])/;

/**
 * An ISO 8601 day, or a time with its zone. A time without a zone is left
 * out: `Date.parse` would read it in the machine's own zone, and every
 * machine must make the same plan from the same records.
 */
const ZONED_TIME_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** `value` as a time in ms when it is such a date string, else null. */
function timeOf(value: unknown): number | null {
  if (typeof value !== "string" || !ZONED_TIME_RE.test(value.trim())) return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? ms : null;
}

/** The time a legacy item carries for itself: a log event's `timestamp`, a signal's `created_at`. */
function legacyItemTime(record: StoreRecord): number | null {
  if (record.kind === LOG_EVENT_KIND) return timeOf(record.body["timestamp"]);
  if (record.kind === SIGNAL_KIND) return timeOf(obj(record.body["frontmatter"])["created_at"]);
  return null;
}

/** When and where `record` was written (the module comment, "Origin"). */
function originOf(record: StoreRecord): { readonly at: number; readonly device: string } {
  const clock = parseHlc(record.hlc)!.physical;
  const mark = migratedMark(record);
  if (mark === null) return { at: clock, device: record.device };
  const name = mark.key.split("#", 1)[0]!.split("/").pop()!;
  const day = FILE_DAY_RE.exec(name)?.[1];
  const at = legacyItemTime(record) ?? (day !== undefined ? timeOf(day) : null);
  return { at: at ?? clock, device: str(record.body[LEGACY_DEVICE_FIELD]) ?? record.device };
}

function fallbackSession(record: StoreRecord, origin: ReturnType<typeof originOf>): string {
  return `${origin.device}/${record.agent}/${new Date(origin.at).toISOString().slice(0, 10)}`;
}

function candidateOf(record: StoreRecord, isPrivate: boolean): TopicCandidate | null {
  const origin = originOf(record);
  let text: string | null = null;
  let meta: Record<string, unknown> = {};
  if (record.kind === SIGNAL_KIND) {
    meta = obj(record.body["frontmatter"]);
    text = str(meta["principle"]) ?? str(record.body["raw"]);
  } else if (record.kind === LOG_EVENT_KIND) {
    const type = String(record.body["event_type"]);
    // Own keys only: `constructor` or `toString` must not resolve to Object's.
    if (!Object.hasOwn(READABLE_EVENTS, type)) return null;
    const fields = READABLE_EVENTS[type]!;
    meta = obj(record.body["body"]);
    text = fields.map((f) => str(meta[f])).find((t) => t !== null) ?? null;
  }
  if (text !== null) text = withoutPrivateRegions(text);
  if (text === null || text === "") return null;
  const scope = scopeFromFrontmatter(meta);
  return {
    id: record.id,
    text,
    project: scope.project,
    session: scope.session ?? str(meta["session_ref"]) ?? fallbackSession(record, origin),
    at: origin.at,
    private: isPrivate,
    topic: record.topic,
  };
}

/** `text` with every `<private>` region cut out, no placeholder left behind. */
function withoutPrivateRegions(text: string): string {
  const stripped = stripPrivateRegions(text);
  if (stripped === text) return text;
  return stripped
    .split(PRIVATE_REGION_PLACEHOLDER)
    .join(" ")
    .replaceAll(/[ \t]{2,}/g, " ")
    .trim();
}

/** The candidates among `records`; `privateIds` names those of the `private` partition. */
export function topicCandidates(
  records: ReadonlyArray<StoreRecord>,
  privateIds: ReadonlySet<string>,
): TopicCandidate[] {
  const removed = new Set(
    records.filter((r) => r.kind === SIGNAL_REMOVED_KIND).map((r) => String(r.body["signal"])),
  );
  const out: TopicCandidate[] = [];
  for (const record of records) {
    if (record.kind === SIGNAL_KIND && removed.has(String(record.body["id"]))) continue;
    // A shared record that carries a `<private>` region (a legacy or
    // foreign writer) counts as private: its text must not seed a shared topic.
    const isPrivate = privateIds.has(record.id) || valueCarriesPrivateRegion(record.body);
    const candidate = candidateOf(record, isPrivate);
    if (candidate !== null) out.push(candidate);
  }
  return out;
}

/** Common words of no use for telling subjects apart. */
const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "about after again also always because been before being both could does doing done each " +
    "even every from have having here into just like made make many more most much must never " +
    "only other over same should since some such than that their them then there these they " +
    "this those through under until very want were what when where which while will with " +
    "within without would your"
  ).split(" "),
);

/** The distinct words of `text` that can tell subjects apart, in any script. */
export function subjectTokens(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => [...w].length >= 4 && !STOPWORDS.has(w)),
  );
}
