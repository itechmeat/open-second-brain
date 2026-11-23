/**
 * A store-only brain with hand-built replay records (dream replay task
 * 3.0): coverage, admission and plan records seeded directly, so the
 * admission, the ledgers and the loop are tested before the bootstrap of
 * section 6 exists. Every path lives under the fixture's temp parent.
 */

import type { AppendInput } from "../../src/core/store/appender.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import { foldDreamReplay, type DreamReplayState } from "../../src/core/brain/dream-replay/fold.ts";
import {
  DREAM_COVERAGE_KIND,
  DREAM_REPLAY_STREAM,
} from "../../src/core/brain/dream-replay/records.ts";
import type { StoreRecord } from "../../src/core/store/envelope.ts";
import { readReplayRecords } from "../../src/core/brain/dream-replay/pass.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { makeStoreEnv } from "../core/store/fixtures/store-env.ts";
import { switchDevice } from "../core/brain/store-only/fixtures.ts";

export interface DreamReplayFixture {
  readonly vault: string;
  readonly storeRoot: string;
  readonly parent: string;
  readonly configPath: string;
  append(kind: string, body: Record<string, unknown>, stream?: string): void;
  /** Seed a coverage record of `day`, as if a pass had covered it. */
  cover(day: string): void;
  /** The records of the `dream-replay` stream. */
  replayRecords(): StoreRecord[];
  /** The folded `dream-replay` stream. */
  replayState(): DreamReplayState;
  cleanup(): void;
}

export function makeDreamReplayFixture(prefix = "osb-dream-replay-"): DreamReplayFixture {
  const env = makeStoreEnv(prefix);
  let store: ReturnType<typeof openStore>;
  try {
    switchDevice(env.storeRoot);
    store = openStore({ root: env.storeRoot, device: "dev-a" });
  } catch (error) {
    env.cleanup();
    throw error;
  }
  const append = (kind: string, body: Record<string, unknown>, stream = DREAM_REPLAY_STREAM) => {
    appendRecord(store, {
      partition: "shared",
      stream: stream as AppendInput["stream"],
      kind,
      agent: "o2b",
      body,
    });
  };
  const replayRecords = (): StoreRecord[] => [...readReplayRecords(store).records];
  return {
    vault: env.vault,
    storeRoot: env.storeRoot,
    parent: env.parent,
    configPath: env.configPath,
    append,
    cover(day) {
      append(DREAM_COVERAGE_KIND, {
        day,
        window: day,
        admission: "",
        plan: "",
        owner: null,
        run: "fixture",
        behind: 0,
      });
    },
    replayRecords,
    replayState: () => foldDreamReplay(replayRecords()),
    cleanup: env.cleanup,
  };
}
