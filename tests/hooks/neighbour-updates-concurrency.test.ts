/**
 * The neighbour-updates hook under concurrent writers (owner check of
 * five concurrent agents): a turn shows what other sessions recorded on
 * its topics even while another process holds the search index's writer
 * lock (a catch-up of another hook or MCP server, a reindex, a view
 * render).
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import {
  injected,
  LOCAL_DEVICE,
  NEIGHBOUR_AGENT,
  neighbourHarness,
  REMOTE_DEVICE,
} from "../helpers/neighbour-hook.ts";
import { acquireWriterLockSync } from "../../src/core/search/store/writer-lock.ts";
import { newUlid } from "../../src/core/store/ulid.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const h = neighbourHarness("osb-neighbour-conc-");

describe("neighbour updates while another process writes the index", () => {
  test("a decision that arrives while the index writer lock is held is shown in that turn", async () => {
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the session's own decision");
    await h.reindex();
    await h.runHook(h.payload("Shared work.", "s1"));
    const release = acquireWriterLockSync(h.fx().config().dbPath);
    try {
      // Written after the index was last brought up to date: only the
      // store's shard holds it while the lock is held.
      h.decision(REMOTE_DEVICE, topic, "decided while the index was busy", {
        agent: NEIGHBOUR_AGENT,
      });
      const turn = await h.runHook(h.payload("Shared work.", "s1"));
      expect(turn.exit).toBe(0);
      expect(injected(turn.stdout)).toContain("decided while the index was busy");
    } finally {
      release();
    }
    // Shown once: not again on the next turn.
    const next = await h.runHook(h.payload("Shared work.", "s1"));
    expect(next.stdout).toBe("");
  });
});
