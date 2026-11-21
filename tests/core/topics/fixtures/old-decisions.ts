/**
 * Two decisions as the release before decision events carried a title
 * wrote them (recorded with that build in a linked project directory
 * `тема-четыре`): the legacy decision pages and log lines byte for byte,
 * and the store records its dual write kept beside them on an unswitched
 * machine. The events name only the page and the option chosen; the
 * pages hold the titles, one of them pure Cyrillic and so stored under the
 * hashed fallback slug that release gave such a title.
 */
import { appendRecord } from "../../../../src/core/store/appender.ts";
import { logEventRecord } from "../../../../src/core/store/dual-write-records.ts";
import { laneEntryRecord } from "../../../../src/core/store/lane-records.ts";
import type { StoreHandle } from "../../../../src/core/store/store-open.ts";

export const OLD_PROJECT = "тема-четыре";

export interface OldDecision {
  readonly slug: string;
  readonly title: string;
  readonly chosen: string;
  readonly timestamp: string;
}

export const OLD_DECISIONS: ReadonlyArray<OldDecision> = [
  {
    slug: "release-format-t4",
    title: "Тема-четыре release format t4",
    chosen: "одна страница",
    timestamp: "2026-11-21T09:00:00Z",
  },
  {
    slug: "unnamed-36a1ef95",
    title: "Формат заметок релиза",
    chosen: "таблица",
    timestamp: "2026-11-21T09:05:00Z",
  },
];

/** The page fields that release wrote, in its order. */
function pageFields(d: OldDecision, assumption: string): Record<string, string> {
  return {
    type: "decision",
    id: `decision-${d.slug}`,
    title: d.title,
    chosen: d.chosen,
    assumption,
    review_date: "2027-01-01",
    outcome: "",
    created_at: d.timestamp,
    agent: "t4",
  };
}

const ASSUMPTIONS = ["a", "b"] as const;

/** `Brain/decisions/decision-<slug>.md` as that release wrote it. */
function legacyPage(d: OldDecision, assumption: string): string {
  return [
    "---",
    "type: decision",
    `id: decision-${d.slug}`,
    `title: ${JSON.stringify(d.title)}`,
    `chosen: ${JSON.stringify(d.chosen)}`,
    `assumption: ${JSON.stringify(assumption)}`,
    "review_date: 2027-01-01",
    'outcome: ""',
    `created_at: ${d.timestamp}`,
    'agent: "t4"',
    "---",
    "",
    "",
    "",
  ].join("\n");
}

/** The event payload that release logged: no `title`. */
function eventPayload(d: OldDecision): Record<string, string> {
  return {
    decision: `[[decision-${d.slug}]]`,
    chosen: d.chosen,
    review_date: "2027-01-01",
    obligation: d.slug === "unnamed-36a1ef95" ? "review-decision" : `review-decision-${d.slug}`,
    agent: "t4",
    project: OLD_PROJECT,
    origin_channel: "unset",
  };
}

/**
 * That release's log of the day, line for line: each `decision-record`
 * with the change receipt it chained after it.
 */
const LEGACY_LOG_LINES = [
  '{"ts":"2026-11-21T09:00:00Z","kind":"decision-record","payload":{"decision":"[[decision-release-format-t4]]","chosen":"одна страница","review_date":"2027-01-01","obligation":"review-decision-release-format-t4","agent":"t4","project":"тема-четыре","origin_channel":"unset"},"prev":null,"h":"2c701a9ec151c6ea25f3b0f57c6770bd7a91cbf649401c87bf4d15f26cf15fde"}',
  '{"ts":"2026-11-21T09:00:00Z","kind":"decision-change-receipt","payload":{"subject":"[[decision-release-format-t4]]","reason_code":"decision-record","idempotency_key":"22f30afa819ee8a3ff81d099ac7b47b17f78331c2cf75cdfc1fd9872ff521389","agent":"t4","origin_channel":"unset"},"prev":"2c701a9ec151c6ea25f3b0f57c6770bd7a91cbf649401c87bf4d15f26cf15fde","h":"ae74dbcce1bb97b8b74814effc90ce9663e468cfd2ffcaac0752efbe0a902853"}',
  '{"ts":"2026-11-21T09:05:00Z","kind":"decision-record","payload":{"decision":"[[decision-unnamed-36a1ef95]]","chosen":"таблица","review_date":"2027-01-01","obligation":"review-decision","agent":"t4","project":"тема-четыре","origin_channel":"unset"},"prev":"ae74dbcce1bb97b8b74814effc90ce9663e468cfd2ffcaac0752efbe0a902853","h":"a9e8ff5ba4b9b844217c58f2eef67de35171ca72916be5c9fb06ba513a4380c5"}',
  '{"ts":"2026-11-21T09:05:00Z","kind":"decision-change-receipt","payload":{"subject":"[[decision-unnamed-36a1ef95]]","reason_code":"decision-record","idempotency_key":"6cd50c6de48af129a77ca62e650ecddb5b575dcda5353d33e8c68ad42ddc72d1","agent":"t4","origin_channel":"unset"},"prev":"a9e8ff5ba4b9b844217c58f2eef67de35171ca72916be5c9fb06ba513a4380c5","h":"817fd2821f0a7994cf1df6d8780bcff13ddfff013b93804428ec9093a33c3dec"}',
];

/** The device whose legacy log day file holds the two events. */
export const OLD_DEVICE = "dev-old";

/**
 * The legacy files that release wrote for both decisions, by vault-relative
 * path: the two pages and that day's log file of the device that recorded them.
 */
export function oldLegacyFiles(): Record<string, string> {
  return {
    [`Brain/decisions/decision-${OLD_DECISIONS[0]!.slug}.md`]: legacyPage(OLD_DECISIONS[0]!, "a"),
    [`Brain/decisions/decision-${OLD_DECISIONS[1]!.slug}.md`]: legacyPage(OLD_DECISIONS[1]!, "b"),
    [`Brain/log/2026-11-21.${OLD_DEVICE}.jsonl`]: `${LEGACY_LOG_LINES.join("\n")}\n`,
  };
}

/** The records that release's dual write appended on an unswitched machine. */
export function appendOldDualWrites(store: StoreHandle): void {
  OLD_DECISIONS.forEach((d, i) => {
    for (const record of [
      laneEntryRecord({
        lane: "decisions",
        entry: `decision-${d.slug}`,
        fields: pageFields(d, ASSUMPTIONS[i]!),
        text: "",
        authority: "agent",
        agent: "t4",
        private: false,
      }),
      logEventRecord({
        timestamp: d.timestamp,
        eventType: "decision-record",
        body: eventPayload(d),
      }),
    ]) {
      appendRecord(store, {
        partition: "shared",
        stream: record.stream,
        kind: record.kind,
        agent: record.agent ?? "t4",
        scope: record.scope ?? null,
        body: record.body,
      });
    }
  });
}

/** Each decision as every surface must name it: its title with the option chosen. */
export const OLD_DECISION_LINES = OLD_DECISIONS.map((d) => `${d.title}: ${d.chosen}`);
