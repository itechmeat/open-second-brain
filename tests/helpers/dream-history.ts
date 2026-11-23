import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { appendApplyEvidence } from "../../src/core/brain/apply-evidence.ts";
import { dream } from "../../src/core/brain/dream.ts";
import { brainConfigPath, preferencePath } from "../../src/core/brain/paths.ts";
import { setBrainSetting } from "../../src/core/brain/policy/settings-write.ts";
import {
  moveToRetired,
  writePreference,
  type WritePreferenceInput,
} from "../../src/core/brain/preference.ts";
import { BRAIN_RETIRED_REASON, type BrainRetiredReason } from "../../src/core/brain/types.ts";
import { writeSignal, type WriteSignalInput } from "../../src/core/brain/signal.ts";
import { canonicalJson, sha256Hex } from "../../src/core/integrity/digest.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { makeStoreEnv } from "../core/store/fixtures/store-env.ts";
import { switchDevice } from "../core/brain/store-only/fixtures.ts";

const FIRST_DAY = "2026-04-01";
const DAY_COUNT = 5;
const SEEDS = [1, 7, 19, 42] as const;
/** The kinds the daily baseline of `dream-window-context` dumps. */
const DREAM_RECORD_KINDS = new Set([
  "log-event",
  "preference-evidence",
  "preference-remove",
  "preference-set",
  "signal",
  "signal-removed",
  "signal-state",
]);

/**
 * The kinds an equivalence comparison dumps: the baseline's, plus the
 * ledgers the pass keeps in the store and the model work it queues.
 * Admission, plan and coverage records are left out: they carry byte
 * positions, which differ between a daily and a replaying machine.
 */
const EQUIVALENCE_RECORD_KINDS = new Set([
  ...DREAM_RECORD_KINDS,
  "dream-cross-topic-spent",
  "dream-rollup-baseline",
  "dream-work-item",
]);

/** Body fields that name a run, never compared. */
const RUN_FIELDS = ["run", "run_id"] as const;

/** Fields the replay adds to an audit event, left out of the daily baseline. */
const REPLAY_AUDIT_FIELDS = ["window", "effect"] as const;
export type HistoryEvent =
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
      readonly input: {
        readonly slug: string;
        readonly supersededBy?: string;
        readonly reason?: BrainRetiredReason;
      };
    }
  | {
      readonly admitOn: number;
      readonly eventAt: string;
      /** Any other change a person makes, through the product's own writer. */
      readonly kind: "human";
      readonly apply: (vault: string, storeRoot: string) => void;
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
      /**
       * Written on its event day by this other device, whose shards reach
       * the machine only on `admitOn` (a late sync).
       */
      readonly device?: string;
      readonly input: {
        readonly pref_id: string;
        readonly artifact: string;
        readonly result: "applied" | "violated";
        readonly agent: string;
      };
    };

export interface DumpRow {
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

export function dreamAdmissionDay(
  eventDay: number,
  coveredDay: number,
  arrivedDuringGap: boolean,
): number {
  return arrivedDuringGap && eventDay <= coveredDay ? coveredDay + 1 : eventDay;
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
  // A signal dated in the covered day is admitted on the first open day.
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

export function generatedDreamHistory(seed: number): HistoryEvent[] {
  return historyFor(seed);
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

/** What a dump compares: the daily baseline's records, or the equivalence set. */
export type DumpMode = "baseline" | "equivalence";

function normalizedBody(record: Record<string, unknown>, mode: DumpMode): Record<string, unknown> {
  const body = structuredClone(record["body"] as Record<string, unknown>);
  delete body["vault_id"];
  for (const field of RUN_FIELDS) delete body[field];
  // The application time the replay added to evidence records postdates
  // the daily baseline of `dream-window-context`.
  if (mode === "baseline" && record["kind"] === "preference-evidence") delete body["at"];
  if (record["kind"] === "log-event") {
    delete body["timestamp"];
    const eventBody = body["body"];
    if (eventBody !== null && typeof eventBody === "object" && !Array.isArray(eventBody)) {
      const inner = eventBody as Record<string, unknown>;
      delete inner["run_id"];
      if (mode === "baseline") for (const field of REPLAY_AUDIT_FIELDS) delete inner[field];
    }
  }
  return body;
}

function canonicalDump(storeRoot: string, mode: DumpMode): string {
  const kinds = mode === "baseline" ? DREAM_RECORD_KINDS : EQUIVALENCE_RECORD_KINDS;
  const rows: DumpRow[] = [];
  for (const partition of ["shared", "private"] as const) {
    for (const shard of readPartition(join(storeRoot, partition))) {
      for (const record of shard.records) {
        if (!kinds.has(record.kind)) continue;
        if (record.kind === "log-event" && record.body["event_type"] === "snapshot") continue;
        rows.push({
          partition,
          kind: record.kind,
          agent: record.agent,
          scope: record.scope ?? null,
          body: normalizedBody(record as unknown as Record<string, unknown>, mode),
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

/** One run of a history: daily passes through `coveredDay`, then the gap. */
export interface HistoryRunOptions {
  readonly seed: number;
  readonly events: ReadonlyArray<HistoryEvent>;
  /** The last day the machine ran daily (C). */
  readonly coveredDay: number;
  /** The day of the replay (R), at or after C. */
  readonly replayDay: number;
  /** `true`: one pass on R after C; `false`: a pass every day. */
  readonly replay: boolean;
  /**
   * Shared settings written to the store before the first pass, by name
   * (`guardrails.promotion_min_age_days`). A store-only machine reads its
   * settings from the store, not from `_brain.yaml`.
   */
  readonly settings?: Readonly<Record<string, unknown>>;
  /**
   * When in the day each pass runs: `minute` (23:59, the baseline of
   * `dream-window-context`) or `end` (the last millisecond, the instant a
   * replay evaluates a past window at).
   */
  readonly passAt?: "minute" | "end";
  /** Allow a record dated after the pass that admits it (a clock ahead). */
  readonly allowFuture?: boolean;
  readonly dump?: DumpMode;
}

/**
 * The day a record becomes visible to the daily driver. A change a person
 * made during the gap is held fixed (spec: "The reference is daily runs
 * over the same admission history"): both drivers apply it before the
 * first window of the gap.
 */
function dailyAdmission(event: HistoryEvent, coveredDay: number): number {
  const human = event.kind === "preference" || event.kind === "retire" || event.kind === "human";
  return human && event.admitOn > coveredDay ? coveredDay + 1 : event.admitOn;
}

/** Every shard folder of `device` under `root` (`<partition>/<stream>[/<ledger>]/<device>`). */
function deviceFolders(root: string, device: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (!existsSync(dir) || depth > 3) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "blobs") continue;
      const path = join(dir, entry.name);
      if (entry.name === device) out.push(path);
      else walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** Move `device`'s shard folders from `from` to `to`, keeping their paths. */
function moveDeviceShards(from: string, to: string, device: string): void {
  for (const folder of deviceFolders(from, device)) {
    const target = join(to, relative(from, folder));
    mkdirSync(dirname(target), { recursive: true });
    renameSync(folder, target);
  }
}

function passInstant(day: number, passAt: "minute" | "end"): Date {
  return new Date(`${dayOf(day)}T${passAt === "end" ? "23:59:59.999" : "23:59:00"}Z`);
}

function runHistory(options: HistoryRunOptions): DreamHistoryResult {
  const { seed, coveredDay, replayDay } = options;
  const passAt = options.passAt ?? "minute";
  const env = makeStoreEnv(`osb-dream-history-${seed}-`);
  try {
    switchDevice(env.storeRoot);
    // The baseline of `dream-window-context` wrote this file; a store-only
    // machine does not read it, so it changes nothing and stays for that
    // baseline's bytes.
    writeFileSync(brainConfigPath(env.vault), "schema_version: 1\ncross_topic:\n  enabled: true\n");
    for (const [name, value] of Object.entries(options.settings ?? {})) {
      setBrainSetting(
        { vault: env.vault, authority: "human", agent: "dream-history" },
        name,
        value,
      );
    }

    const scheduled = options.events.filter((item) => item.admitOn <= replayDay);
    // Records another device wrote on their day and that sync late: held
    // outside the store until their admission day.
    const held = join(env.parent, "held");
    const synced = scheduled.filter(
      (item): item is Extract<HistoryEvent, { kind: "evidence" }> =>
        item.kind === "evidence" && item.device !== undefined,
    );
    const writeSynced = (day: number): void => {
      for (const event of synced) {
        if (Date.parse(event.eventAt.slice(0, 10)) !== Date.parse(dayOf(day))) continue;
        // Another machine: its own device id and its own device-local state.
        const keys = ["O2B_DEVICE_ID", "XDG_STATE_HOME", "LOCALAPPDATA"] as const;
        const saved = keys.map((key) => process.env[key]);
        process.env["O2B_DEVICE_ID"] = event.device!;
        process.env["XDG_STATE_HOME"] = join(env.parent, `state-${event.device!}`);
        process.env["LOCALAPPDATA"] = join(env.parent, `state-${event.device!}`);
        try {
          // The other device writes as a switched machine; its own records
          // (this one included) travel with its shards.
          switchDevice(env.storeRoot, event.device!);
          appendApplyEvidence(env.vault, event.input, { now: new Date(event.eventAt) });
        } finally {
          keys.forEach((key, index) => {
            const value = saved[index];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          });
        }
        moveDeviceShards(env.storeRoot, held, event.device!);
      }
    };
    const releaseSynced = (admitted: (event: HistoryEvent) => boolean): void => {
      for (const device of new Set(synced.filter(admitted).map((event) => event.device!))) {
        moveDeviceShards(held, env.storeRoot, device);
      }
    };
    const writeEvents = (visible: ReadonlyArray<HistoryEvent>): void => {
      for (const event of visible) {
        if (event.kind === "evidence" && event.device !== undefined) continue;
        if (event.kind === "preference") writePreference(env.vault, event.input);
        else if (event.kind === "retire") {
          moveToRetired(
            env.vault,
            preferencePath(env.vault, event.input.slug),
            event.input.reason ?? BRAIN_RETIRED_REASON.supersededByContext,
            {
              now: new Date(event.eventAt),
              retired_by: "dream-history",
              ...(event.input.supersededBy !== undefined
                ? { superseded_by: event.input.supersededBy }
                : {}),
            },
          );
        } else if (event.kind === "human") event.apply(env.vault, env.storeRoot);
        else if (event.kind === "signal") writeSignal(env.vault, event.input);
        else appendApplyEvidence(env.vault, event.input, { now: new Date(event.eventAt) });
      }
    };
    const dailyPass = (day: number): void => {
      const visible = scheduled.filter((item) => dailyAdmission(item, coveredDay) === day);
      writeSynced(day);
      releaseSynced((event) => event.admitOn === day);
      writeEvents(visible);
      const now = passInstant(day, passAt);
      if (options.allowFuture !== true) {
        for (const event of visible) {
          // A person's change during the gap is applied before the gap.
          if (event.admitOn > coveredDay && dailyAdmission(event, coveredDay) !== event.admitOn) {
            continue;
          }
          if (Date.parse(event.eventAt) > now.getTime()) {
            throw new Error(`history seed ${seed} admits a future event: ${event.eventAt}`);
          }
        }
      }
      dream(env.vault, { now });
    };
    if (options.replay) {
      for (let day = 0; day <= coveredDay; day++) dailyPass(day);
      if (replayDay > coveredDay) {
        for (let day = coveredDay + 1; day <= replayDay; day++) writeSynced(day);
        releaseSynced((event) => event.admitOn > coveredDay);
        writeEvents(scheduled.filter((item) => item.admitOn > coveredDay));
        dream(env.vault, { now: passInstant(replayDay, passAt) });
      }
    } else {
      for (let day = 0; day <= replayDay; day++) dailyPass(day);
    }
    const dump = canonicalDump(env.storeRoot, options.dump ?? "baseline");
    return { dump, hash: sha256Hex(dump) };
  } finally {
    env.cleanup();
  }
}

/**
 * The equivalence comparison of one history (dream replay task 1.1): daily
 * passes, and daily passes through C followed by one pass on R, both at
 * the end of each day and dumped with the ledgers.
 */
export function compareReplay(options: Omit<HistoryRunOptions, "replay" | "passAt" | "dump">): {
  readonly daily: DreamHistoryResult;
  readonly replay: DreamHistoryResult;
} {
  if (options.coveredDay < 0 || options.replayDay < options.coveredDay) {
    throw new RangeError("dream history requires 0 <= coveredDay <= replayDay");
  }
  const base = {
    ...options,
    settings: { "cross_topic.enabled": true, ...options.settings },
    passAt: "end" as const,
    dump: "equivalence" as const,
  };
  return {
    daily: runHistory({ ...base, replay: false }),
    replay: runHistory({ ...base, replay: true }),
  };
}

/** The rows of a dump, parsed. */
export function dumpRows(dump: string): DumpRow[] {
  return JSON.parse(dump) as DumpRow[];
}

/** Daily passes over a generated seed, as the baseline of `dream-window-context` runs them. */
export function runDreamHistory(seed: number): DreamHistoryResult {
  return runHistory({
    seed,
    events: historyFor(seed),
    coveredDay: 2,
    replayDay: DAY_COUNT - 1,
    replay: false,
  });
}

/** Daily passes against one replay for a generated seed (C = 2, R = 4). */
export function compareSeedReplay(seed: number): ReturnType<typeof compareReplay> {
  return compareReplay({ seed, events: historyFor(seed), coveredDay: 2, replayDay: DAY_COUNT - 1 });
}

export function firstDreamHistoryDifference(left: string, right: string): string | null {
  const leftRows = (JSON.parse(left) as unknown[]).toSorted((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
  const rightRows = (JSON.parse(right) as unknown[]).toSorted((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
  if (JSON.stringify(leftRows) === JSON.stringify(rightRows)) return null;
  const length = Math.max(leftRows.length, rightRows.length);
  for (let index = 0; index < length; index++) {
    if (JSON.stringify(leftRows[index]) !== JSON.stringify(rightRows[index])) {
      return `record ${index}: daily=${JSON.stringify(leftRows[index] ?? null)} replay=${JSON.stringify(rightRows[index] ?? null)}`;
    }
  }
  return "record ordering differs";
}

export const DREAM_HISTORY_SEEDS = SEEDS;

/** The equivalence dump of the store at `storeRoot` (ledgers and audit fields included). */
export function dumpStore(storeRoot: string): string {
  return canonicalDump(storeRoot, "equivalence");
}
