import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendApplyEvidence } from "../../src/core/brain/apply-evidence.ts";
import { dream } from "../../src/core/brain/dream.ts";
import { brainConfigPath, preferencePath } from "../../src/core/brain/paths.ts";
import {
  moveToRetired,
  writePreference,
  type WritePreferenceInput,
} from "../../src/core/brain/preference.ts";
import { writeSignal, type WriteSignalInput } from "../../src/core/brain/signal.ts";
import { canonicalJson, sha256Hex } from "../../src/core/integrity/digest.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { makeStoreEnv } from "../core/store/fixtures/store-env.ts";
import { switchDevice } from "../core/brain/store-only/fixtures.ts";

const FIRST_DAY = "2026-04-01";
const DAY_COUNT = 5;
const SEEDS = [1, 7, 19, 42] as const;
const DREAM_RECORD_KINDS = new Set([
  "log-event",
  "preference-evidence",
  "preference-remove",
  "preference-set",
  "signal",
  "signal-removed",
  "signal-state",
]);

type HistoryEvent =
  | {
      readonly admitOn: number;
      readonly eventAt: string;
      readonly kind: "preference";
      readonly input: WritePreferenceInput;
    }
  | {
      readonly admitOn: number;
      readonly eventAt: string;
      readonly kind: "retire";
      readonly input: { readonly slug: string; readonly supersededBy: string };
    }
  | {
      readonly admitOn: number;
      readonly eventAt: string;
      readonly kind: "signal";
      readonly input: WriteSignalInput;
    }
  | {
      readonly admitOn: number;
      readonly eventAt: string;
      readonly kind: "evidence";
      readonly input: {
        readonly pref_id: string;
        readonly artifact: string;
        readonly result: "applied" | "violated";
        readonly agent: string;
      };
    };

interface DumpRow {
  readonly partition: "private" | "shared";
  readonly kind: string;
  readonly agent: string;
  readonly scope: string | null;
  readonly body: Record<string, unknown>;
}

export interface DreamHistoryResult {
  readonly dump: string;
  readonly hash: string;
}

function historyFor(seed: number): HistoryEvent[] {
  let state = seed >>> 0;
  const random = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
  const topic = (stem: string): string => `${stem}-${random().toString(36).slice(0, 4)}`;
  const alpha = topic("alpha");
  const beta = topic("beta");
  const events: HistoryEvent[] = [];
  for (const [index, slug] of [
    `trial-before-${seed}`,
    `trial-after-${seed}`,
    `chain-old-${seed}`,
    `chain-new-${seed}`,
    `cluster-a-${seed}`,
    `cluster-b-${seed}`,
  ].entries()) {
    const trial = slug.startsWith("trial-");
    const chain = slug.startsWith("chain-");
    const topicName = trial
      ? `trial-topic-${seed}`
      : chain
        ? `chain-topic-${seed}`
        : `cluster-topic-${seed}-${index}`;
    const unconfirmedUntil =
      slug === `trial-after-${seed}` ? "2026-04-03T08:00:00Z" : "2026-04-03T12:00:00Z";
    events.push({
      kind: "preference",
      admitOn: 0,
      eventAt: `${FIRST_DAY}T${String(index).padStart(2, "0")}:00:00Z`,
      input: {
        ...preference(seed, slug, topicName, `${FIRST_DAY}T00:00:00Z`),
        status: trial ? "unconfirmed" : "confirmed",
        confirmed_at: trial ? null : `${FIRST_DAY}T00:00:00Z`,
        unconfirmed_until: trial ? unconfirmedUntil : "2026-04-05T12:00:00Z",
      },
    });
  }
  events.push({
    kind: "retire",
    admitOn: 0,
    eventAt: `${FIRST_DAY}T06:00:00Z`,
    input: { slug: `chain-old-${seed}`, supersededBy: `pref-chain-new-${seed}` },
  });
  for (let day = 0; day < 3; day++) {
    for (const [index, name] of [alpha, beta].entries()) {
      const date = new Date(Date.parse(`${FIRST_DAY}T00:00:00Z`) + day * 86_400_000)
        .toISOString()
        .slice(0, 10);
      events.push({
        kind: "signal",
        admitOn: day,
        eventAt: `${date}T${String(9 + index).padStart(2, "0")}:00:00Z`,
        input: {
          topic: name,
          signal: "negative",
          agent: random() % 2 === 0 ? "claude" : "codex",
          principle: "Prefer deterministic generated histories.",
          created_at: `${date}T${String(9 + index).padStart(2, "0")}:00:00Z`,
          date,
          slug: `seed-${seed}-${name}-${day}`,
          scope: "coding",
          ...(day === 0 && index === 0 ? { expiration_date: `${date}` } : {}),
        },
      });
    }
  }
  // A late-synced signal retains its event date but is admitted on day 3.
  const lateDate = FIRST_DAY;
  events.push({
    kind: "signal",
    admitOn: 3,
    eventAt: `${lateDate}T07:00:00Z`,
    input: {
      topic: alpha,
      signal: "negative",
      agent: "hermes",
      principle: "Prefer deterministic generated histories.",
      created_at: `${lateDate}T07:00:00Z`,
      date: lateDate,
      slug: `seed-${seed}-late-sync`,
      scope: "coding",
    },
  });
  for (const [pref_id, admitOn, hour] of [
    [`pref-trial-before-${seed}`, 1, "18"],
    [`pref-trial-after-${seed}`, 2, "20"],
  ] as const) {
    const date = new Date(Date.parse(`${FIRST_DAY}T00:00:00Z`) + admitOn * 86_400_000)
      .toISOString()
      .slice(0, 10);
    events.push({
      kind: "evidence",
      admitOn,
      eventAt: `${date}T${hour}:00:00Z`,
      input: { pref_id, artifact: `Daily/${date}.md`, result: "applied", agent: "claude" },
    });
  }
  return events.toSorted((a, b) => a.admitOn - b.admitOn || a.eventAt.localeCompare(b.eventAt));
}

function preference(
  seed: number,
  slug: string,
  topic: string,
  createdAt: string,
): WritePreferenceInput {
  return {
    slug,
    topic,
    principle: "Keep deterministic state in Open Second Brain.",
    created_at: createdAt,
    unconfirmed_until: "2026-04-05T12:00:00Z",
    status: "confirmed",
    confirmed_at: createdAt,
    evidenced_by: [],
    scope: "coding",
    supersedes: slug === `chain-new-${seed}` ? `ret-chain-old-${seed}` : undefined,
  };
}

function normalizedBody(record: Record<string, unknown>): Record<string, unknown> {
  const body = structuredClone(record["body"] as Record<string, unknown>);
  delete body["vault_id"];
  if (record["kind"] === "log-event") {
    delete body["timestamp"];
    delete body["run_id"];
    const eventBody = body["body"];
    if (eventBody !== null && typeof eventBody === "object" && !Array.isArray(eventBody)) {
      delete (eventBody as Record<string, unknown>)["run_id"];
    }
  }
  return body;
}

function canonicalDump(storeRoot: string): string {
  const rows: DumpRow[] = [];
  for (const partition of ["shared", "private"] as const) {
    for (const shard of readPartition(join(storeRoot, partition))) {
      for (const record of shard.records) {
        if (!DREAM_RECORD_KINDS.has(record.kind)) continue;
        if (record.kind === "log-event" && record.body["event_type"] === "snapshot") continue;
        rows.push({
          partition,
          kind: record.kind,
          agent: record.agent,
          scope: record.scope ?? null,
          body: normalizedBody(record as unknown as Record<string, unknown>),
        });
      }
    }
  }
  return canonicalJson(rows);
}

function dayOf(index: number): string {
  return new Date(Date.parse(`${FIRST_DAY}T00:00:00Z`) + index * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function runDreamHistory(seed: number): DreamHistoryResult {
  const env = makeStoreEnv(`osb-dream-history-${seed}-`);
  try {
    switchDevice(env.storeRoot);
    writeFileSync(brainConfigPath(env.vault), "schema_version: 1\ncross_topic:\n  enabled: true\n");

    const events = historyFor(seed);
    for (let day = 0; day < DAY_COUNT; day++) {
      for (const event of events.filter((item) => item.admitOn === day)) {
        if (event.kind === "preference") writePreference(env.vault, event.input);
        else if (event.kind === "retire") {
          moveToRetired(
            env.vault,
            preferencePath(env.vault, event.input.slug),
            "superseded-by-context",
            {
              now: new Date(event.eventAt),
              retired_by: "dream-history",
              superseded_by: event.input.supersededBy,
            },
          );
        } else if (event.kind === "signal") writeSignal(env.vault, event.input);
        else appendApplyEvidence(env.vault, event.input, { now: new Date(event.eventAt) });
      }
      const now = new Date(`${dayOf(day)}T23:59:00Z`);
      // Every generated record is admitted only after its event date; late
      // sync is the deliberate exception to admission order, not event time.
      for (const event of events.filter((item) => item.admitOn === day)) {
        if (Date.parse(event.eventAt) > now.getTime()) {
          throw new Error(`history seed ${seed} admits a future event on ${dayOf(day)}`);
        }
      }
      dream(env.vault, { now });
    }
    const dump = canonicalDump(env.storeRoot);
    return { dump, hash: sha256Hex(dump) };
  } finally {
    env.cleanup();
  }
}

export const DREAM_HISTORY_SEEDS = SEEDS;
