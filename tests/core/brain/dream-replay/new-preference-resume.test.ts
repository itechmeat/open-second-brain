/**
 * A new preference a window planned converges across a resume (design
 * D4.2): the write of its records and the write of its idempotency
 * receipt are two writes, and a pass that fails between them leaves the
 * preference without its receipt. The resumed window applies the same
 * frozen effect and must finish the window, not refuse the preference it
 * created itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { dream } from "../../../../src/core/brain/dream.ts";
import { setBrainSetting } from "../../../../src/core/brain/policy/settings-write.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { storePreferenceEntry } from "../../../../src/core/brain/preference-store.ts";
import {
  makeDreamReplayFixture,
  type DreamReplayFixture,
} from "../../../helpers/dream-replay-fixtures.ts";
import { at, dateOf } from "../../../helpers/dream-replay-scenarios.ts";
import { CHMOD_CANNOT_DENY } from "../../../helpers/platform.ts";

const opened: DreamReplayFixture[] = [];
const locked: string[] = [];
afterEach(() => {
  for (const dir of locked.splice(0)) chmodSync(dir, 0o755);
  for (const f of opened.splice(0).toReversed()) f.cleanup();
});

/** Three signals of one topic from three agents: window 1 promotes them. */
function promotingBrain(): DreamReplayFixture {
  const f = makeDreamReplayFixture();
  opened.push(f);
  f.cover(dateOf(0));
  for (const [slug, agent] of [
    ["s1", "claude"],
    ["s2", "codex"],
    ["s3", "hermes"],
  ] as const) {
    writeSignal(f.vault, {
      topic: "tabs",
      signal: "positive",
      agent,
      principle: "Indent with tabs in every source file.",
      created_at: at(1, 9),
      date: dateOf(1),
      slug,
      scope: "coding",
    });
  }
  return f;
}

/** Make this device's idempotency receipts unwritable: the receipt write fails, the records land. */
function lockReceipts(f: DreamReplayFixture): void {
  for (const partition of ["shared", "private"]) {
    const dir = join(f.storeRoot, partition, "ledgers", "idempotency", "dev-a");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555);
    locked.push(dir);
  }
}

// The receipt write is made to fail by a directory this user cannot write.
describe.skipIf(CHMOD_CANNOT_DENY)("dream replay: a new preference across a resume", () => {
  test("a pass that fails between the preference and its receipt is finished by the next", () => {
    const f = promotingBrain();
    lockReceipts(f);
    expect(() => dream(f.vault, { now: new Date(`${dateOf(2)}T23:00:00.000Z`) })).toThrow();
    // The records of the preference landed; its receipt did not.
    expect(storePreferenceEntry("tabs")).toBeDefined();
    expect(f.replayState().open).not.toBeNull();
    for (const dir of locked.splice(0)) chmodSync(dir, 0o755);
    dream(f.vault, { now: new Date(`${dateOf(2)}T23:00:00.000Z`) });
    expect(f.replayState().lastCovered).toBe(dateOf(2));
    expect(f.replayState().open).toBeNull();
  });

  test("the resume keeps the owner the create stamped, whoever runs it", () => {
    const f = promotingBrain();
    setBrainSetting(
      { vault: f.vault, authority: "human", agent: "test" },
      "integrity.owner_scope_delivery",
      "warn",
    );
    const saved = process.env["VAULT_AGENT_NAME"];
    try {
      process.env["VAULT_AGENT_NAME"] = "@alice-agent";
      lockReceipts(f);
      expect(() => dream(f.vault, { now: new Date(`${dateOf(2)}T23:00:00.000Z`) })).toThrow();
      expect(storePreferenceEntry("tabs")?.state.fields["owner"]).toBe("@alice-agent");
      for (const dir of locked.splice(0)) chmodSync(dir, 0o755);
      process.env["VAULT_AGENT_NAME"] = "@bob-agent";
      dream(f.vault, { now: new Date(`${dateOf(2)}T23:00:00.000Z`) });
    } finally {
      if (saved === undefined) delete process.env["VAULT_AGENT_NAME"];
      else process.env["VAULT_AGENT_NAME"] = saved;
    }
    expect(f.replayState().lastCovered).toBe(dateOf(2));
    expect(storePreferenceEntry("tabs")?.state.fields["owner"]).toBe("@alice-agent");
  });
});
