/**
 * Ids minted on switched machines are unique across devices: two devices
 * that share one store mint a signal and a write session from the same
 * input before their shards meet, and once the shards meet the fold holds
 * both, with no capture lost.
 */
import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { writeSignal } from "../../../src/core/brain/signal.ts";
import {
  createWriteSession,
  listWriteSessions,
} from "../../../src/core/brain/write-session/store.ts";
import type { WriteSessionRecord } from "../../../src/core/brain/write-session/types.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import { readSignals } from "../../../src/core/store/read/signals.ts";
import { DEVICE_SWITCHED_KIND } from "../../../src/core/store/store-only.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const AT = "2026-11-06T10:00:00.000Z";

const SIGNAL = {
  topic: "tabs",
  signal: "positive" as const,
  agent: "claude",
  principle: "Use tabs",
  created_at: "2026-11-06T10:00:00Z",
  date: "2026-11-06",
  slug: "tabs",
};

const session = (id: string): WriteSessionRecord => ({
  id,
  kind: "artifact",
  status: "needs-llm-step",
  step: "artifact",
  agent: "@t",
  createdAt: AT,
  updatedAt: AT,
  expiresAt: "2026-11-09T12:00:00Z",
  attempts: 0,
  retryCap: 3,
  targetPath: "notes/x.md",
  intent: "create",
  requireReview: false,
  prompt: "Write it.",
  schemaType: null,
  topic: null,
  personas: [],
  responses: {},
  pendingArtifact: null,
  lastErrors: [],
  failReason: null,
});

/** Every file below `from` that `to` lacks, copied: the other device's shards arriving. */
function syncShards(from: string, to: string): void {
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const target = join(to, relative(from, path));
        if (!existsSync(target)) cpSync(path, target);
      }
    }
  };
  walk(from);
}

test("two switched devices minting from one input both keep their records", () => {
  env = makeStoreEnv("osb-cross-device-ids-", { dualWrite: false, legacyTree: false });
  const store = openStore({ root: env.storeRoot, device: "dev-a" });
  for (const device of ["dev-a", "dev-b"]) {
    appendRecord(store, {
      partition: "shared",
      stream: "settings",
      kind: DEVICE_SWITCHED_KIND,
      agent: "o2b",
      body: { authority: "human", vault_id: null, device },
    });
  }
  // Device B's copy of the store before either mints: the two will not see
  // each other's new records until the shards meet.
  const rootB = join(env.parent, "store-b");
  cpSync(env.storeRoot, rootB, { recursive: true });

  process.env["O2B_DEVICE_ID"] = "dev-a";
  const a = writeSignal(env.vault, SIGNAL);
  const sa = createWriteSession(env.vault, AT, session);

  process.env["O2B_DEVICE_ID"] = "dev-b";
  process.env[STORE_ROOT_ENV] = rootB;
  const b = writeSignal(env.vault, SIGNAL);
  const sb = createWriteSession(env.vault, AT, session);

  expect(a.id).not.toBe(b.id);
  expect(sa.id).not.toBe(sb.id);

  // The shards meet on device A.
  syncShards(rootB, env.storeRoot);
  process.env["O2B_DEVICE_ID"] = "dev-a";
  process.env[STORE_ROOT_ENV] = env.storeRoot;
  expect(
    readSignals({ vault: env.vault })
      .map((s) => s.id)
      .toSorted(),
  ).toEqual([a.id, b.id].toSorted());
  expect(
    listWriteSessions(env.vault, AT)
      .map((s) => s.id)
      .toSorted(),
  ).toEqual([sa.id, sb.id].toSorted());
});
