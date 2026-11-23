/**
 * Test fixture of the closed questions on the queue (change
 * `dream-closed-questions`): one temp store on device `dev-a` that holds
 * the dream owner role, a temp machine config and vault, and the writers
 * of the records the questions are asked about. Every path lives under
 * the fixture's own temp root, removed by `cleanup`.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  claimDreamOwner,
  claimSettled,
  readDreamOwner,
} from "../../../../src/core/brain/dream-owner/owner.ts";
import {
  dreamQueueOn,
  readDreamWork,
  type DreamQueue,
} from "../../../../src/core/brain/dream-queue/queue.ts";
import type { DreamWorkItem } from "../../../../src/core/brain/dream-queue/fold.ts";
import {
  decisionThresholdsPath,
  resetThresholdsStoreCache,
  writeThresholdEntry,
} from "../../../../src/core/decision-model/thresholds.ts";
import type { DecisionModelUse } from "../../../../src/core/decision-model/contract.ts";
import { appendRecord } from "../../../../src/core/store/appender.ts";
import { MIGRATED_FIELD } from "../../../../src/core/store-migration/migration-records.ts";
import type { StorePartition } from "../../../../src/core/store/constants.ts";
import type { StoreHandle } from "../../../../src/core/store/store-open.ts";
import { newUlid } from "../../../../src/core/store/ulid.ts";
import { TOPIC_ASSIGN_KIND, TOPIC_CREATE_KIND } from "../../../../src/core/topics/constants.ts";
import { FAKE_DECISION_KEY } from "../../../helpers/fake-credentials.ts";
import { makeMachines, type Machines } from "../../view/fixtures/machines.ts";

export const T0 = Date.UTC(2026, 11, 1, 9, 0, 0);

export interface ClosedFixture {
  readonly m: Machines;
  readonly a: StoreHandle;
  readonly vault: string;
  readonly configPath: string;
  readonly queue: DreamQueue;
  /** Advances by a second on every read. */
  readonly now: () => number;
  /** Reads without advancing. */
  readonly still: () => number;
  setClock(ms: number): void;
  signal(text: string, options?: SignalOptions): string;
  seedTopic(title: string, options?: { partition?: StorePartition; scope?: string }): string;
  seedItem(topic: string, kind: string, body: Record<string, unknown>): string;
  holdRecord(topic: string, record: string): void;
  note(text: string, ms?: number): string;
  env(uses: string): Record<string, string | undefined>;
  tune(use: string, values: Record<string, number>): void;
  items(operation?: string): DreamWorkItem[];
  cleanup(): void;
}

export interface SignalOptions {
  readonly session?: string;
  readonly project?: string | null;
  readonly partition?: StorePartition;
  /** The record's own time, as a migrated record carries it (default: its clock). */
  readonly at?: number;
}

export function closedFixture(options: { readonly bindOwner?: boolean } = {}): ClosedFixture {
  let clock = T0;
  const now = (): number => (clock += 1000);
  const still = (): number => clock;
  const m = makeMachines(["dev-a", "dev-b"], "o2b-closed-");
  const a = m.open("dev-a");
  if (options.bindOwner !== false) {
    claimDreamOwner(a, "claude", { writer: "o2b", authority: "human", now });
    claimSettled(a, readDreamOwner(a, now));
  }
  const tmp = mkdtempSync(join(m.parent, "cfg-"));
  const vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `store_root: ${m.root("dev-a")}\ndevice_id: dev-a\n`);
  process.env["VAULT_DIR"] = vault;
  // The test setup pins the store root by environment: point it at this store.
  const storeRootBefore = process.env["OPEN_SECOND_BRAIN_STORE_ROOT"];
  process.env["OPEN_SECOND_BRAIN_STORE_ROOT"] = m.root("dev-a");
  resetThresholdsStoreCache();
  const queue = dreamQueueOn(a, { vault: null, writer: "o2b", now: still });
  let seq = 0;
  return {
    m,
    a,
    vault,
    configPath,
    queue,
    now,
    still,
    setClock: (ms) => {
      clock = ms;
    },
    signal(text, opts = {}) {
      clock += 1000;
      seq += 1;
      // A record's clock never runs back: an older time is the one a
      // migrated record carries for itself.
      const origin =
        opts.at === undefined
          ? {}
          : {
              [MIGRATED_FIELD]: { key: `Brain/inbox/c${seq}.md`, sum: "0" },
            };
      return appendRecord(
        a,
        {
          partition: opts.partition ?? "shared",
          stream: "events",
          kind: "signal",
          agent: "agent-1",
          body: {
            id: `sig-2026-12-01-c${seq}`,
            path: `Brain/inbox/c${seq}.md`,
            staged: false,
            ...origin,
            frontmatter: {
              ...(opts.at === undefined ? {} : { created_at: new Date(opts.at).toISOString() }),
              principle: text,
              ...(opts.project === null ? {} : { project: opts.project ?? "o2b" }),
              session: opts.session ?? "s1",
            },
            raw: null,
            raw_shape: "bare",
          },
        },
        { now },
      ).record.id;
    },
    seedTopic(title, opts = {}) {
      clock += 1000;
      const topic = newUlid(clock);
      appendRecord(
        a,
        {
          partition: opts.partition ?? "shared",
          stream: "topics",
          kind: TOPIC_CREATE_KIND,
          agent: "seed",
          topic,
          body: { authority: "agent", title, scope: opts.scope ?? "project:o2b" },
        },
        { now },
      );
      return topic;
    },
    seedItem(topic, kind, body) {
      clock += 1000;
      const item = `i${seq++}x${clock % 100000}`;
      appendRecord(
        a,
        {
          partition: "shared",
          stream: "topics",
          kind,
          agent: "seed",
          topic,
          body: { authority: "agent", item, ...body },
        },
        { now },
      );
      return item;
    },
    holdRecord(topic, record) {
      appendRecord(
        a,
        {
          partition: "shared",
          stream: "topics",
          kind: TOPIC_ASSIGN_KIND,
          agent: "seed",
          topic,
          body: { authority: "agent", record },
        },
        { now },
      );
    },
    note(text, ms) {
      clock += 1000;
      const at = ms ?? clock;
      return appendRecord(
        a,
        {
          partition: "shared",
          stream: "log",
          kind: "log-event",
          agent: "seed",
          body: { timestamp: new Date(at).toISOString(), event_type: "note", body: { text } },
        },
        { now: () => at },
      ).record.id;
    },
    env(uses) {
      return {
        OPEN_SECOND_BRAIN_DECISION_MODEL_ENABLED: "true",
        OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER: "compatible",
        OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL: "https://decide.invalid/v1",
        OPEN_SECOND_BRAIN_DECISION_MODEL_ID: "decide-model",
        OPEN_SECOND_BRAIN_DECISION_MODEL_ENV_KEY: "O2B_TEST_DECIDE_KEY",
        OPEN_SECOND_BRAIN_DECISION_MODEL_USES: uses,
        O2B_TEST_DECIDE_KEY: FAKE_DECISION_KEY,
        OPEN_SECOND_BRAIN_CONFIG: configPath,
      };
    },
    tune(use, values) {
      writeThresholdEntry(
        decisionThresholdsPath(configPath),
        "decide-model",
        use as DecisionModelUse,
        {
          values,
          source: "set",
        },
      );
      resetThresholdsStoreCache();
    },
    items(operation) {
      const state = readDreamWork(a, { now: clock });
      return state.order
        .map((id) => state.items.get(id)!)
        .filter((item) => operation === undefined || item.body.operation === operation);
    },
    cleanup() {
      delete process.env["VAULT_DIR"];
      if (storeRootBefore === undefined) delete process.env["OPEN_SECOND_BRAIN_STORE_ROOT"];
      else process.env["OPEN_SECOND_BRAIN_STORE_ROOT"] = storeRootBefore;
      resetThresholdsStoreCache();
      m.cleanup();
    },
  };
}
